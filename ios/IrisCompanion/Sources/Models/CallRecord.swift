import Foundation

/// Mirrors the `public.calls` row shape (see sql/001_calls.sql, sql/002_call_status.sql).
struct CallRecord: Codable, Identifiable, Sendable {
  enum Status: String, Codable, Sendable {
    case ringing
    case completed
  }

  enum WearerResponse: String, Codable, Sendable {
    case claimed
    case declined
  }

  var id: UUID
  var vapiCallId: String?
  var callerNumber: String?
  var callerName: String?
  var callbackNumber: String?
  var reason: String?
  var summary: String?
  var transcript: String?
  var branch: String
  /// "inbound" (someone called us) or "outbound" (Iris placed the call).
  var direction: String?
  var status: Status
  var wearerResponse: WearerResponse?
  var startedAt: Date?
  var endedAt: Date?
  var createdAt: Date

  enum CodingKeys: String, CodingKey {
    case id
    case vapiCallId = "vapi_call_id"
    case callerNumber = "caller_number"
    case callerName = "caller_name"
    case callbackNumber = "callback_number"
    case reason
    case summary
    case transcript
    case branch
    case direction
    case status
    case wearerResponse = "wearer_response"
    case startedAt = "started_at"
    case endedAt = "ended_at"
    case createdAt = "created_at"
  }
}
