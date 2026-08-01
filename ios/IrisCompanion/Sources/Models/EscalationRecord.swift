import Foundation

/// Mirrors `public.kb_escalations` (sql/003_knowledge.sql) — a row is written the
/// instant Iris's knowledge gate declines to answer, while the caller is still on
/// the line. The founder's answer goes back onto the same row (`owner_answer`),
/// where the server picks it up and speaks it into the live call.
struct EscalationRecord: Codable, Sendable, Equatable, Identifiable {
  var id: UUID
  var createdAt: Date
  var vapiCallId: String?
  var callerNumber: String?
  var question: String
  var reason: String
  /// disclosure='context_only' KB material. For the WEARER only — never spoken to callers.
  var contextForWearer: String?
  /// Pre-filled draft so the founder can tap "Send this" instead of composing.
  var suggestedAnswer: String?
  var status: String
  var ownerAnswer: String?

  enum CodingKeys: String, CodingKey {
    case id
    case createdAt = "created_at"
    case vapiCallId = "vapi_call_id"
    case callerNumber = "caller_number"
    case question
    case reason
    case contextForWearer = "context_for_wearer"
    case suggestedAnswer = "suggested_answer"
    case status
    case ownerAnswer = "owner_answer"
  }
}
