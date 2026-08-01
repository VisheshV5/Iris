import Foundation
import Supabase

/// Talks to Supabase with the anon key only — this binary ships to end-user devices,
/// so the service-role key (used by the backend) must never appear here. Anon access
/// is scoped by the RLS policies in sql/002_call_status.sql (read all, update only
/// wearer_response).
@MainActor
@Observable
final class SupabaseService {
  private(set) var ringingCall: CallRecord?
  /// Most recent call to finish while the app was open — drives the founder's
  /// brief spoken summary. Distinct from history so launch-time fetches don't
  /// replay announcements for old calls.
  private(set) var justCompleted: CallRecord?
  private(set) var history: [CallRecord] = []
  private(set) var connectionError: String?

  private let client: SupabaseClient
  private var watchTask: Task<Void, Never>?

  init(client: SupabaseClient) {
    self.client = client
  }

  static func makeClient() -> SupabaseClient {
    SupabaseClient(
      supabaseURL: Config.supabaseURL,
      supabaseKey: Config.supabaseAnonKey,
      options: SupabaseClientOptions(db: .init(decoder: Self.decoder))
    )
  }

  func start() {
    watchTask?.cancel()
    watchTask = Task { [weak self] in
      await self?.watchCalls()
    }
    Task { await refreshHistory() }
    Task { await fetchCurrentRinging() }
    startPolling()
  }

  func stop() {
    watchTask?.cancel()
    watchTask = nil
    pollTask?.cancel()
    pollTask = nil
  }

  private var pollTask: Task<Void, Never>?

  /// Realtime websockets have proven unreliable on physical devices, so the active
  /// call state is ALSO polled every 3s while the app is foregrounded — the card can
  /// be at most one poll late, no matter what the socket does. History refreshes on
  /// every ringing→idle transition so completions (and their spoken summaries via
  /// `justCompleted`) surface promptly too.
  private func startPolling() {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        let hadRinging = self.ringingCall?.vapiCallId
        await self.fetchCurrentRinging()
        if hadRinging != nil, self.ringingCall == nil {
          // Call just ended: pull the completed row so the summary announcement fires.
          await self.refreshHistory()
          if let done = self.history.first(where: { $0.vapiCallId == hadRinging }) {
            self.justCompleted = done
          }
        }
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  private func watchCalls() async {
    let channel = client.channel("calls-changes")
    let changes = channel.postgresChange(AnyAction.self, schema: "public", table: "calls")
    await channel.subscribe()

    for await change in changes {
      guard !Task.isCancelled else { return }
      do {
        switch change {
        case .insert(let insert):
          try handle(insert.decodeRecord(as: CallRecord.self, decoder: Self.decoder))
        case .update(let update):
          try handle(update.decodeRecord(as: CallRecord.self, decoder: Self.decoder))
        case .delete:
          break
        }
      } catch {
        connectionError = "Failed to decode call row: \(error.localizedDescription)"
      }
    }
  }

  private func handle(_ record: CallRecord) {
    switch record.status {
    case .ringing:
      ringingCall = record
    case .completed:
      if ringingCall?.vapiCallId == record.vapiCallId { ringingCall = nil }
      history.removeAll { $0.vapiCallId == record.vapiCallId }
      history.insert(record, at: 0)
      justCompleted = record
    }
  }

  /// A call already in progress when the app opens (or returns to foreground —
  /// iOS suspends the websocket in the background) would otherwise be invisible.
  func fetchCurrentRinging() async {
    do {
      let rows: [CallRecord] = try await client
        .from("calls")
        .select()
        .eq("status", value: "ringing")
        .order("created_at", ascending: false)
        .limit(1)
        .execute()
        .value
      // Calls that died before their end-of-call report leave permanent "ringing"
      // rows; anything older than 3 minutes can't be a live call.
      if let live = rows.first, Date().timeIntervalSince(live.startedAt ?? live.createdAt) < 180 {
        ringingCall = live
      } else {
        ringingCall = nil
      }
    } catch {
      connectionError = "Failed to check for live calls: \(error.localizedDescription)"
    }
  }

  /// Call when the app returns to the foreground: re-sync missed state and let the
  /// Realtime socket re-establish.
  func resync() {
    Task { await fetchCurrentRinging() }
    Task { await refreshHistory() }
  }

  func refreshHistory() async {
    do {
      let rows: [CallRecord] = try await client
        .from("calls")
        .select()
        .eq("status", value: "completed")
        .order("created_at", ascending: false)
        .limit(50)
        .execute()
        .value
      history = rows
    } catch {
      connectionError = "Failed to load call history: \(error.localizedDescription)"
    }
  }

  /// Records what the wearer chose in the app. Note: this does not yet reroute the
  /// live call to the wearer's phone — see README "Known limitation".
  func respond(to call: CallRecord, response: CallRecord.WearerResponse) async {
    guard let vapiCallId = call.vapiCallId else { return }
    do {
      try await client
        .from("calls")
        .update(["wearer_response": response.rawValue])
        .eq("vapi_call_id", value: vapiCallId)
        .execute()
    } catch {
      connectionError = "Failed to save your response: \(error.localizedDescription)"
    }
    if ringingCall?.vapiCallId == vapiCallId { ringingCall = nil }
  }

  private static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .supabaseTimestamp
    return decoder
  }()
}

extension JSONDecoder.DateDecodingStrategy {
  /// Postgres returns microsecond precision ("2026-08-01T00:56:45.418273+00:00"),
  /// but ISO8601DateFormatter's .withFractionalSeconds accepts only milliseconds and
  /// returns nil on six digits — which silently failed EVERY row decode: no history,
  /// no live-call card, no spoken announcements. Truncate to milliseconds first, and
  /// fall back to a no-fractional parse.
  static var supabaseTimestamp: JSONDecoder.DateDecodingStrategy {
    .custom { decoder in
      let container = try decoder.singleValueContainer()
      let raw = try container.decode(String.self)

      // Clamp any fractional part to 3 digits.
      var normalized = raw
      if let dot = raw.firstIndex(of: ".") {
        let afterDot = raw.index(after: dot)
        let digits = raw[afterDot...].prefix { $0.isNumber }
        if digits.count > 3 {
          let keep = raw.index(afterDot, offsetBy: 3)
          let dropEnd = raw.index(afterDot, offsetBy: digits.count)
          normalized = String(raw[..<keep]) + String(raw[dropEnd...])
        }
      }

      let withFraction = ISO8601DateFormatter()
      withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = withFraction.date(from: normalized) { return date }

      let plain = ISO8601DateFormatter()
      plain.formatOptions = [.withInternetDateTime]
      if let date = plain.date(from: normalized) { return date }
      // Last resort: strip the fractional part entirely.
      if let dot = normalized.firstIndex(of: "."),
         let tzStart = normalized[dot...].firstIndex(where: { $0 == "+" || $0 == "-" || $0 == "Z" }) {
        let stripped = String(normalized[..<dot]) + String(normalized[tzStart...])
        if let date = plain.date(from: stripped) { return date }
      }
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unparseable timestamp: \(raw)")
    }
  }
}
