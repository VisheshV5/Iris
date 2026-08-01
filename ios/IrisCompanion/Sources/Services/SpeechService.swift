import AVFoundation

/// Brief spoken announcements. When the Meta glasses are connected as the phone's
/// audio device (which they are whenever worn + paired), this speaks directly into
/// the wearer's ears — no extra glasses-audio API needed.
/// Not main-actor isolated on purpose: the wake-word listener calls this from GCD
/// main-queue callbacks (see VoiceWakeService), which the Swift 6 isolation checker
/// cannot prove are the main actor. AVSpeechSynthesizer is safe to drive this way.
enum SpeechService {
  // Only ever touched from the main queue; `nonisolated(unsafe)` documents that
  // invariant rather than forcing actor isolation the GCD callers can't satisfy.
  nonisolated(unsafe) private static let synthesizer = AVSpeechSynthesizer()

  /// True while a reply is playing — the wake listener uses this to ignore its own
  /// voice (her announcements contain the word "Iris").
  static var isSpeaking: Bool { synthesizer.isSpeaking }

  static func announce(_ text: String) {
    // When the "Hey Iris" loop holds the session in .playAndRecord, leave it be —
    // yanking the category mid-listen kills the mic tap. Playback works either way.
    let session = AVAudioSession.sharedInstance()
    if session.category != .playAndRecord {
      try? session.setCategory(.playback, options: [.duckOthers, .allowBluetoothA2DP])
      try? session.setActive(true)
    }
    let utterance = AVSpeechUtterance(string: text)
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate
    synthesizer.speak(utterance)
  }
}
