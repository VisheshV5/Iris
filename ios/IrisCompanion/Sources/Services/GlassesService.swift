import Foundation
import MWDATCore
import MWDATDisplay
import Observation

/// Wraps Meta Wearables DAT SDK registration + a Display session, adapted from
/// Meta's own DisplayAccess sample (WearablesViewModel + DisplayViewModel).
///
/// Every DAT call is best-effort: if the paired glasses don't have a display (or
/// aren't connected, or Developer Mode isn't enabled yet), this degrades to a no-op
/// rather than crashing — the phone-side notification in NotificationService always
/// works regardless of glasses model.
@MainActor
@Observable
final class GlassesService {
  private(set) var registrationState: RegistrationState
  private(set) var isDisplayConnected = false
  /// True on display-less glasses (e.g. Wayfarer Gen 2) — expected hardware truth,
  /// not an error. Announcements fall back to audio through the glasses' speakers.
  private(set) var displayUnsupported = false
  private(set) var lastError: String?

  private let wearables: WearablesInterface
  private var deviceSelector: AutoDeviceSelector
  private var deviceSession: DeviceSession?
  private var display: Display?

  private var registrationTask: Task<Void, Never>?
  private var sessionStateTask: Task<Void, Never>?
  private var sessionErrorTask: Task<Void, Never>?
  private var displayStateTask: Task<Void, Never>?
  private var displayStateContinuation: AsyncStream<DisplayState>.Continuation?
  private var stateListenerToken: AnyListenerToken?
  private var pendingAction: (() async -> Void)?

  init() {
    do {
      try Wearables.configure()
    } catch {
      #if DEBUG
      NSLog("[Iris] Failed to configure Wearables SDK: \(error)")
      #endif
    }
    wearables = Wearables.shared
    registrationState = wearables.registrationState
    deviceSelector = AutoDeviceSelector(wearables: wearables, filter: { $0.supportsDisplay() })

    registrationTask = Task { [weak self] in
      guard let wearables = self?.wearables else { return }
      for await state in wearables.registrationStateStream() {
        guard let self, !Task.isCancelled else { return }
        self.registrationState = state
      }
    }
  }

  func connect() async {
    guard registrationState != .registering else { return }
    do {
      try await wearables.startRegistration()
    } catch {
      lastError = "\(error)"
    }
  }

  func disconnect() async {
    do {
      try await wearables.startUnregistration()
    } catch {
      lastError = "\(error)"
    }
  }

  /// Renders a card on the glasses display, if one's attached.
  /// Attaching is async (it waits on a device session + display capability to come
  /// up), so if we're not connected yet, queue this as a pending action — the same
  /// pattern Meta's own DisplayAccess sample uses — instead of silently no-op'ing.
  func show(_ view: some DisplayableView) async {
    guard !displayUnsupported else { return }
    let sendNow: () async -> Void = { [weak self] in
      guard let self, let cap = self.display else { return }
      do {
        try await cap.send(view)
      } catch {
        self.lastError = "\(error)"
      }
    }

    if display != nil, isDisplayConnected {
      await sendNow()
      return
    }
    pendingAction = sendNow
    if display == nil { await attachToDisplay() }
  }

  func clearDisplay() {
    display?.stop()
  }

  private func attachToDisplay() async {
    guard deviceSession == nil else { return }
    do {
      let session = try wearables.createSession(deviceSelector: deviceSelector)
      deviceSession = session

      sessionStateTask = Task { [weak self] in
        for await state in session.stateStream() {
          guard let self, !Task.isCancelled else { return }
          if state == .started { await self.setupDisplay(on: session) }
        }
      }
      sessionErrorTask = Task { [weak self] in
        for await error in session.errorStream() {
          guard let self, !Task.isCancelled else { return }
          self.classify(error)
        }
      }
      try session.start()
    } catch {
      classify(error)
    }
  }

  /// noEligibleDevice on display attach means the paired glasses have no screen —
  /// record that as a capability, not a failure.
  private func classify(_ error: some Error) {
    if "\(error)".localizedCaseInsensitiveContains("noEligibleDevice") {
      displayUnsupported = true
    } else {
      lastError = "\(error)"
    }
  }

  private func setupDisplay(on session: DeviceSession) async {
    guard display == nil else { return }
    do {
      let capability = try session.addDisplay()

      let (stateStream, continuation) = AsyncStream.makeStream(of: DisplayState.self)
      displayStateContinuation = continuation
      stateListenerToken = capability.statePublisher.listen { state in
        continuation.yield(state)
      }
      displayStateTask = Task { [weak self] in
        for await state in stateStream {
          guard let self, !Task.isCancelled else { return }
          self.isDisplayConnected = (state == .started)
          if state == .started, let action = self.pendingAction {
            self.pendingAction = nil
            await action()
          }
        }
      }

      capability.start()
      display = capability
    } catch {
      classify(error)
    }
  }
}
