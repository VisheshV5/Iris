import Foundation

/// Mirrors `public.profiles` (sql/004_profiles.sql).
struct FounderProfile: Codable, Sendable, Equatable {
  var id: UUID
  var fullName: String
  var company: String
  var role: String
  var about: String
  var phone: String
  var googleCalendarConnected: Bool
  /// Google OAuth refresh token, captured client-side immediately after the OAuth
  /// redirect (Supabase never stores it server-side — see ROADMAP Phase 1). Optional
  /// so profiles saved before sql/005_calendar.sql still decode; nil is simply
  /// omitted from upserts, leaving any stored token untouched.
  var googleRefreshToken: String?

  enum CodingKeys: String, CodingKey {
    case id
    case fullName = "full_name"
    case company
    case role
    case about
    case phone
    case googleCalendarConnected = "google_calendar_connected"
    case googleRefreshToken = "google_refresh_token"
  }

  static func empty(id: UUID) -> FounderProfile {
    FounderProfile(id: id, fullName: "", company: "", role: "", about: "", phone: "", googleCalendarConnected: false, googleRefreshToken: nil)
  }
}
