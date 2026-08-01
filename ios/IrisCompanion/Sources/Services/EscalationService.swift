import Foundation
import Supabase

/// Watches `kb_escalations` for moments when Iris has put a caller on hold and
/// needs the founder's answer RIGHT NOW. Same dual pattern as SupabaseService's
/// calls handling: a Realtime subscription for rows that appear while the app is
/// open, plus a refetch on foreground because iOS suspends the websocket in the
/// background.
///
/// Urgency model (no APNs on the free Apple team — see ROADMAP constraint 3):
/// full-screen cover + local notification + spoken announcement through the
/// glasses, repeated once after 30 seconds if still unanswered.
@MainActor
@Observable
final class EscalationService {
  /// The escalation currently demanding the founder's attention. Non-nil drives
  /// the full-screen cover.
  private(set) var pending: EscalationRecord?
  /// Set by the app so a spoken escalation can also start voice capture.
  var onSpeakQuestion: ((EscalationRecord) -> Void)?
  private(set) var sending = false
  private(set) var connectionError: String?

  /// Only escalations younger than this get presented — an unanswered row from
  /// ten minutes ago belongs to a caller who already hung up.
  static let freshnessWindow: TimeInterval = 120

  private let client: SupabaseClient
  private var watchTask: Task<Void, Never>?
  private var repeatAnnounceTask: Task<Void, Never>?
  /// Locally dismissed ("Let Iris handle it") — the row stays pending in the DB
  /// (owner_answer stays null; the server's timeout handles the caller), we just
  /// stop re-presenting it on this device.
  private var dismissedIds: Set<UUID> = []
  /// Rows already announced once, so a Realtime update (e.g. delivered_at being
  /// stamped) doesn't retrigger the notification and speech.
  private var announcedIds: Set<UUID> = []

  init(client: SupabaseClient) {
    self.client = client
  }

  func start() {
    watchTask?.cancel()
    watchTask = Task { [weak self] in
      await self?.watchEscalations()
    }
    Task { await fetchPending() }
  }

  func stop() {
    watchTask?.cancel()
    watchTask = nil
    repeatAnnounceTask?.cancel()
    repeatAnnounceTask = nil
  }

  /// Call on return to foreground: re-sync missed rows and let Realtime re-establish.
  func resync() {
    Task { await fetchPending() }
  }

  // MARK: - Intake

  private func watchEscalations() async {
    let channel = client.channel("kb-escalations-changes")
    let changes = channel.postgresChange(AnyAction.self, schema: "public", table: "kb_escalations")
    await channel.subscribe()

    for await change in changes {
      guard !Task.isCancelled else { return }
      do {
        switch change {
        case .insert(let insert):
          consider(try insert.decodeRecord(as: EscalationRecord.self, decoder: Self.decoder))
        case .update(let update):
          consider(try update.decodeRecord(as: EscalationRecord.self, decoder: Self.decoder))
        case .delete:
          break
        }
      } catch {
        connectionError = "Failed to decode escalation row: \(error.localizedDescription)"
      }
    }
  }

  /// An escalation already pending when the app opens (or returns to foreground)
  /// would otherwise be invisible until the next Realtime event.
  func fetchPending() async {
    do {
      let rows: [EscalationRecord] = try await client
        .from("kb_escalations")
        .select()
        .eq("status", value: "pending")
        .order("created_at", ascending: false)
        .limit(5)
        .execute()
        .value
      if let fresh = rows.first(where: { isPresentable($0) }) {
        present(fresh)
      }
    } catch {
      connectionError = "Failed to check for escalations: \(error.localizedDescription)"
    }
  }

  private func consider(_ record: EscalationRecord) {
    // Resolved elsewhere (answered on another device, expired by the server)?
    // Tear down the cover rather than letting the founder answer a dead question.
    guard record.ownerAnswer == nil, record.status == "pending" else {
      if pending?.id == record.id { clearPresentation() }
      return
    }
    guard isPresentable(record) else { return }
    present(record)
  }

  private func isPresentable(_ record: EscalationRecord) -> Bool {
    record.ownerAnswer == nil
      && record.status == "pending"
      && !dismissedIds.contains(record.id)
      && Date().timeIntervalSince(record.createdAt) < Self.freshnessWindow
  }

  // MARK: - Presentation & urgency

  private func present(_ record: EscalationRecord) {
    pending = record
    guard !announcedIds.contains(record.id) else { return }
    announcedIds.insert(record.id)

    NotificationService.notifyEscalation(question: record.question)
    // Glasses-wearers hear this even with the phone in a pocket.
    SpeechService.announce("Iris needs you: \(record.question)")
    // ...and listen for the spoken reply, so the founder never has to touch the
    // phone: answer out loud and it goes straight back into the live call.
    onSpeakQuestion?(record)
    scheduleRepeatAnnounce(for: record)
  }

  private func scheduleRepeatAnnounce(for record: EscalationRecord) {
    repeatAnnounceTask?.cancel()
    repeatAnnounceTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(30))
      guard let self, !Task.isCancelled, self.pending?.id == record.id else { return }
      SpeechService.announce("Iris still needs you: \(record.question)")
    }
  }

  // MARK: - Founder actions

  /// Writes the founder's answer onto the row (anon-key update — RLS in
  /// sql/003_knowledge.sql allows exactly this). The server watches for
  /// owner_answer and injects it into the live call.
  func send(answer: String) async {
    guard let record = pending else { return }
    let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    sending = true
    defer { sending = false }
    do {
      try await client
        .from("kb_escalations")
        .update([
          "owner_answer": text,
          "status": "answered",
          "answered_at": ISO8601DateFormatter().string(from: Date()),
        ])
        .eq("id", value: record.id)
        .execute()
      dismissedIds.insert(record.id)
      clearPresentation()
    } catch {
      connectionError = "Couldn't send your answer: \(error.localizedDescription)"
    }
  }

  /// "Let Iris handle it": leaves owner_answer null (the server's hold-timeout
  /// takes a message from the caller instead) and stops re-presenting the row here.
  func dismiss() {
    if let id = pending?.id { dismissedIds.insert(id) }
    clearPresentation()
  }

  private func clearPresentation() {
    pending = nil
    connectionError = nil
    repeatAnnounceTask?.cancel()
    repeatAnnounceTask = nil
  }

  private static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .supabaseTimestamp
    return decoder
  }()
}

// Same strategy SupabaseService uses for `calls` rows (fileprivate there, so
// re-declared rather than shared — both are fileprivate and don't collide).
