import AVFoundation
import Combine
import Foundation
import Speech

/// Always-on "Hey Iris" listener.
///
/// IMPORTANT — why this file uses no Swift concurrency at all (no @MainActor, no
/// @Observable, no Task): Swift 6 language mode inserts *runtime* actor-isolation
/// assertions, and Apple's Speech/AVAudioEngine callbacks arrive on their own audio
/// threads, which crashed the app as `_dispatch_assert_queue_fail` (EXC_BREAKPOINT)
/// no matter how the isolation was arranged. The target is now Swift 5 mode (see
/// project.yml) AND this class is a plain ObservableObject hopping to the main queue
/// with DispatchQueue.main.async — the classic pattern from Apple's SpokenWord
/// sample — so there is no isolation check left to fail.
///
/// With Meta glasses connected as the Bluetooth headset, their mic feeds the
/// recognizer and SpeechService's replies play through their speakers.
final class VoiceWakeService: NSObject, ObservableObject {
  enum State: Equatable {
    case off
    case listening
    case capturing
    case processing
    case denied(String)
  }

  @Published private(set) var state: State = .off
  @Published private(set) var lastCommand: String?
  /// Live transcript, surfaced in the UI: if this stays empty while speaking, audio
  /// isn't reaching the recognizer at all — a different problem than a missed wake.
  @Published private(set) var heard: String = ""

  private let command: CommandService
  private let audioEngine = AVAudioEngine()
  private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var capturedSinceWake = ""
  private var lastPartialAt = Date()
  private var captureTimer: Timer?
  private var cycleTimer: Timer?
  private var diagTimer: Timer?
  /// Written by the realtime audio thread, read on main for the watchdog only.
  private var tapBuffers = 0
  private var passCount = 0
  private var lastPassError = ""
  private var lastFormat = "?"
  private var sessionConfigured = false
  private var passStartedAt = Date.distantPast
  private var lastSeenBuffers = 0
  /// When set, the next captured utterance answers an escalation instead of
  /// being treated as a command.
  private var answerHandler: ((String) -> Void)?
  /// Ignore transcripts until this moment — her replies contain "Iris" and would
  /// otherwise wake her. Time-boxed on purpose: an `isSpeaking` flag that sticks
  /// true (which happens when the session is busy with the mic) would deafen her
  /// permanently after the first reply.
  private var muteUntil = Date.distantPast

  /// Speak, and mute the wake check for roughly as long as the words take.
  private func speak(_ text: String) {
    let seconds = min(6.0, 1.0 + Double(text.split(separator: " ").count) * 0.32)
    muteUntil = Date().addingTimeInterval(seconds)
    SpeechService.announce(text)
  }

  /// Fuzzy wake matching. Exact-substring matching on "iris" missed constantly —
  /// the transcriber renders the name as Irish, Ires, Eris, Iras, Iris's, even "I
  /// rest". Each spoken word is instead compared to "iris" by edit distance, so
  /// anything within one or two characters counts. A false trigger costs a "Yes?";
  /// a missed trigger costs the whole interaction, so this leans permissive.
  private static let wakeTargets = ["iris", "irus", "irish", "iras"]

  private static func isWakeWord(_ word: String) -> Bool {
    guard word.count >= 3, word.count <= 7 else { return false }
    for target in wakeTargets {
      let allowed = word.count <= 4 ? 1 : 2
      if editDistance(word, target) <= allowed { return true }
    }
    // "iri…" / "iru…" prefixes catch clipped or run-together renderings.
    return word.hasPrefix("iri") || word.hasPrefix("iru")
  }

  private static func editDistance(_ a: String, _ b: String) -> Int {
    let a = Array(a), b = Array(b)
    if a.isEmpty { return b.count }
    if b.isEmpty { return a.count }
    var prev = Array(0...b.count)
    var cur = [Int](repeating: 0, count: b.count + 1)
    for i in 1...a.count {
      cur[0] = i
      for j in 1...b.count {
        let cost = a[i - 1] == b[j - 1] ? 0 : 1
        cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      }
      prev = cur
    }
    return prev[b.count]
  }

  /// Returns the range of everything AFTER the wake word, or nil if not heard.
  private static func wakeRange(in transcript: String) -> Range<String.Index>? {
    let lower = transcript.lowercased()
    var wordStart: String.Index? = nil
    var idx = lower.startIndex
    while idx < lower.endIndex {
      let ch = lower[idx]
      if ch.isLetter || ch == "\u{2019}" || ch == "'" {
        if wordStart == nil { wordStart = idx }
      } else if let ws = wordStart {
        let word = String(lower[ws..<idx]).filter { $0.isLetter }
        if isWakeWord(word) { return idx..<lower.endIndex }
        wordStart = nil
      }
      idx = lower.index(after: idx)
    }
    if let ws = wordStart {
      let word = String(lower[ws...]).filter { $0.isLetter }
      if isWakeWord(word) { return lower.endIndex..<lower.endIndex }
    }
    return nil
  }

  init(command: CommandService) {
    self.command = command
    super.init()
    // A route change (glasses connecting, AirPods, speaker) invalidates the tap's
    // format — rebuild the pass instead of going silently deaf.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleRouteChange),
      name: AVAudioSession.routeChangeNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleInterruption),
      name: AVAudioSession.interruptionNotification,
      object: nil
    )
  }

  @objc private func handleRouteChange(_ note: Notification) {
    // Our own setActive() emits route changes; reacting to those created an
    // infinite restart loop (engine torn down before the tap ever delivered a
    // buffer). Only real device arrivals/departures matter, and never sooner
    // than 2s after a pass began.
    let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    guard let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
          reason == .newDeviceAvailable || reason == .oldDeviceUnavailable else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.state == .listening else { return }
      guard Date().timeIntervalSince(self.passStartedAt) > 2 else { return }
      self.beginPass()
    }
  }

  @objc private func handleInterruption(_ note: Notification) {
    let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
    guard AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.state == .listening else { return }
      self.sessionConfigured = false
      self.beginPass()
    }
  }

  /// Called when Iris has a caller holding and needs the founder's answer: skips
  /// the wake phrase entirely and listens for the next thing said, handing the
  /// transcript to `onAnswer` instead of the command engine.
  func captureAnswer(onAnswer: @escaping (String) -> Void) {
    answerHandler = onAnswer
    guard state != .off else { return } // listener not running; app UI handles it
    state = .capturing
    capturedSinceWake = ""
    lastPartialAt = Date()
    armCaptureWindow()
  }

  /// Tap-to-talk: start capturing immediately, no wake word required. Always
  /// available so a missed wake word never blocks the founder.
  func captureNow() {
    guard state == .listening || state == .capturing else { return }
    capturedSinceWake = ""
    heard = ""
    lastPartialAt = Date()
    muteUntil = .distantPast
    state = .capturing
    speak("Yes?")
    armCaptureWindow()
  }

  // MARK: - Public control (always called from the main thread by SwiftUI)

  func toggle() {
    if state == .off { start() } else { stop() }
  }

  func start() {
    SFSpeechRecognizer.requestAuthorization { [weak self] auth in
      DispatchQueue.main.async {
        guard let self else { return }
        guard auth == .authorized else {
          self.state = .denied("Enable Speech Recognition for Iris in Settings.")
          return
        }
        AVAudioApplication.requestRecordPermission { granted in
          DispatchQueue.main.async {
            guard granted else {
              self.state = .denied("Enable Microphone access for Iris in Settings.")
              return
            }
            self.startDiagnostics()
            self.beginPass()
          }
        }
      }
    }
  }

  func stop() {
    diagTimer?.invalidate()
    diagTimer = nil
    cycleTimer?.invalidate()
    cycleTimer = nil
    captureTimer?.invalidate()
    captureTimer = nil
    endPass()
    sessionConfigured = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    state = .off
  }

  /// Watchdog: the audio stack can be knocked down by interruptions with no error
  /// surfaced. If we think we're listening but the engine is dead — or it's alive
  /// but no audio has arrived — rebuild the pass rather than sit deaf.
  private func startDiagnostics() {
    diagTimer?.invalidate()
    diagTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self else { return }
        if self.state == .listening, Date().timeIntervalSince(self.passStartedAt) > 3 {
          let starved = self.tapBuffers == self.lastSeenBuffers
          if !self.audioEngine.isRunning || starved {
            self.sessionConfigured = false
            self.beginPass()
          }
        }
        self.lastSeenBuffers = self.tapBuffers
        if !self.lastPassError.isEmpty {
          NSLog("[VoiceWake] \(self.lastPassError)")
        }
      }
    }
  }

  // MARK: - Recognition pass

  private func beginPass() {
    endPass()
    do {
      // Session setup happens once per listening session, not per pass: each
      // setActive() emits a route-change notification, and doing it every pass
      // fed the restart loop described in handleRouteChange.
      if !sessionConfigured {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        sessionConfigured = true
      }
      passStartedAt = Date()

      let req = SFSpeechAudioBufferRecognitionRequest()
      req.shouldReportPartialResults = true
      request = req

      let input = audioEngine.inputNode
      input.removeTap(onBus: 0)
      // inputFormat (not outputFormat) is the live hardware format. Right after a
      // route change — Bluetooth glasses connecting, for instance — it can briefly
      // report 0Hz/0ch, and installing a tap with that throws "format mismatch".
      let format = input.inputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        lastPassError = "bad input format (\(Int(format.sampleRate))Hz/\(format.channelCount)ch)"
        restartSoon(after: 0.4) // route still settling; try again shortly
        return
      }
      lastFormat = "\(Int(format.sampleRate))Hz/\(format.channelCount)ch"
      // Realtime audio thread: appends to the locally captured request, nothing else.
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        req.append(buffer)
        self?.tapBuffers += 1 // watchdog counter
      }
      audioEngine.prepare()
      try audioEngine.start()

      task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
        // Recognition thread: copy plain values out, then hop to main. No state here.
        let text = result?.bestTranscription.formattedString
        let failed = error != nil
        DispatchQueue.main.async {
          guard let self else { return }
          if let text { self.handlePartial(text) }
          if failed, self.state != .off { self.restartSoon(after: 1.0) }
        }
      }

      passCount += 1
      lastPassError = ""
      if state == .off || state == .processing { state = .listening }
      // Apple caps a single pass at ~60s — recycle before it expires.
      cycleTimer?.invalidate()
      cycleTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
        DispatchQueue.main.async {
          guard let self, self.state == .listening else { return }
          self.beginPass()
        }
      }
    } catch {
      // Transient audio-stack failures are normal around route changes; retry
      // quietly rather than dead-ending the listener.
      lastPassError = error.localizedDescription
      NSLog("[VoiceWake] pass failed: \(error.localizedDescription)")
      restartSoon(after: 1.0)
    }
  }

  private func endPass() {
    task?.cancel()
    task = nil
    request?.endAudio()
    request = nil
    if audioEngine.isRunning { audioEngine.stop() }
    audioEngine.inputNode.removeTap(onBus: 0)
  }

  private func restartSoon(after seconds: TimeInterval) {
    cycleTimer?.invalidate()
    cycleTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.state != .off else { return }
        self.beginPass()
      }
    }
  }

  // MARK: - Wake phrase + command capture (main thread only)

  private func handlePartial(_ transcript: String) {
    // Her own replies say "Iris" out loud; without this the speaker would wake her.
    if state == .listening, Date() < muteUntil { return }
    lastPartialAt = Date()
    heard = transcript

    switch state {
    case .listening:
      guard let after = Self.wakeRange(in: transcript) else { return }
      state = .capturing
      capturedSinceWake = String(transcript[after])
        .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
      if capturedSinceWake.isEmpty { speak("Yes?") }
      armCaptureWindow()

    case .capturing:
      if let after = Self.wakeRange(in: transcript) {
        capturedSinceWake = String(transcript[after])
          .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
      } else {
        capturedSinceWake = transcript.trimmingCharacters(in: .whitespaces)
      }

    default:
      break
    }
  }

  /// The command ends after ~1.6s of quiet (hard cap 12s).
  private func armCaptureWindow() {
    captureTimer?.invalidate()
    let start = Date()
    captureTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
      DispatchQueue.main.async {
        guard let self else { timer.invalidate(); return }
        let quiet = Date().timeIntervalSince(self.lastPartialAt) > 1.6
        let tooLong = Date().timeIntervalSince(start) > 12
        guard quiet || tooLong else { return }
        timer.invalidate()
        self.finishCapture()
      }
    }
  }

  private func finishCapture() {
    let text = capturedSinceWake.trimmingCharacters(in: .whitespacesAndNewlines)
    capturedSinceWake = ""
    guard !text.isEmpty else {
      state = .listening
      return
    }

    if let handler = answerHandler {
      answerHandler = nil
      state = .listening
      handler(text)
      beginPass() // fresh pass so the answer text doesn't linger in the transcript
      return
    }

    state = .processing
    lastCommand = text
    speak("On it.")

    let cmd = command
    Task { @MainActor in
      await cmd.send(text)
      switch cmd.phase {
      case .success(let message): self.speak(message)
      case .failure(let message): self.speak(message)
      case .pickContact(let name, _): self.speak("I found more than one \(name) — open the app to pick.")
      default: break
      }
      DispatchQueue.main.async { [weak self] in
        guard let self, self.state != .off else { return }
        self.capturedSinceWake = ""
        self.heard = ""
        self.state = .listening
        // Fresh pass so her own reply isn't transcribed as a command, and so the
        // next wake word is matched against a clean transcript.
        self.beginPass()
      }
    }
  }
}
