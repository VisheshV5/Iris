import Foundation
import Supabase

/// Email-OTP auth via Supabase (no extra Apple entitlements needed, which matters
/// because this build is signed with a manually-pinned provisioning profile that
/// can't gain capabilities without a paid team).
@MainActor
@Observable
final class AuthService {
  enum State: Equatable {
    case loading
    case signedOut
    case codeSent(email: String)
    case signedIn(userId: UUID)
  }

  private(set) var state: State = .loading
  private(set) var profile: FounderProfile?
  private(set) var errorMessage: String?

  private let client: SupabaseClient
  private var authWatchTask: Task<Void, Never>?

  init(client: SupabaseClient) {
    self.client = client
    authWatchTask = Task { [weak self] in
      guard let client = self?.client else { return }
      for await change in client.auth.authStateChanges {
        guard let self else { return }
        if let session = change.session {
          self.state = .signedIn(userId: session.user.id)
          await self.loadProfile(userId: session.user.id)
        } else if case .codeSent = self.state {
          // keep the enter-code screen up
        } else {
          self.state = .signedOut
          self.profile = nil
        }
      }
    }
  }

  func sendCode(to email: String) async {
    errorMessage = nil
    do {
      // Magic link, not code: the project can't customize email templates without
      // custom SMTP, and the default template only contains a link. The link
      // deep-links back into this app (iriscompanion://auth-callback).
      try await client.auth.signInWithOTP(email: email, redirectTo: URL(string: "iriscompanion://auth-callback"))
      state = .codeSent(email: email)
    } catch {
      errorMessage = "Couldn't send sign-in email: \(error.localizedDescription)"
    }
  }

  /// Completes sign-in when the magic link reopens the app.
  func handleAuthCallback(_ url: URL) async {
    do {
      let session = try await client.auth.session(from: url)
      // Google OAuth callbacks carry provider tokens exactly once, in this session
      // object — Supabase does not store them server-side. Grab the refresh token
      // now or calendar access dies when the access token expires (~1h).
      await captureProviderRefreshToken(from: session)
    } catch {
      errorMessage = "Sign-in link didn't work: \(error.localizedDescription)"
    }
  }

  /// Persists `session.providerRefreshToken` (present only immediately after an
  /// OAuth redirect; nil for magic-link sign-ins) to the founder's profile row.
  /// Returns true when a token was actually captured and stored.
  @discardableResult
  func captureProviderRefreshToken(from session: Session) async -> Bool {
    guard let token = session.providerRefreshToken, !token.isEmpty else { return false }
    struct TokenRow: Encodable {
      let id: UUID
      let googleRefreshToken: String
      let googleCalendarConnected: Bool
      enum CodingKeys: String, CodingKey {
        case id
        case googleRefreshToken = "google_refresh_token"
        case googleCalendarConnected = "google_calendar_connected"
      }
    }
    do {
      // Partial upsert: every other profiles column is nullable, so this works even
      // if the OAuth flow completes before onboarding has saved a full profile.
      try await client.from("profiles")
        .upsert(TokenRow(id: session.user.id, googleRefreshToken: token, googleCalendarConnected: true))
        .execute()
      await loadProfile(userId: session.user.id)
      return true
    } catch {
      errorMessage = "Google connected, but saving the calendar token failed: \(error.localizedDescription)"
      return false
    }
  }

  func verify(email: String, code: String) async {
    errorMessage = nil
    do {
      try await client.auth.verifyOTP(email: email, token: code, type: .email)
      // authStateChanges moves us to .signedIn
    } catch {
      errorMessage = "That code didn't work: \(error.localizedDescription)"
    }
  }

  func signOut() async {
    try? await client.auth.signOut()
    state = .signedOut
    profile = nil
  }

  func loadProfile(userId: UUID) async {
    do {
      let rows: [FounderProfile] = try await client
        .from("profiles")
        .select()
        .eq("id", value: userId)
        .execute()
        .value
      profile = rows.first
    } catch {
      errorMessage = "Couldn't load profile: \(error.localizedDescription)"
    }
  }

  func saveProfile(_ updated: FounderProfile) async -> Bool {
    errorMessage = nil
    do {
      // Always write as the CURRENT session's user: the Google Calendar OAuth flow
      // can swap the session to a different (Google-linked) user mid-edit, and RLS
      // rejects rows whose id doesn't match auth.uid().
      var row = updated
      if let uid = client.auth.currentSession?.user.id { row.id = uid }
      try await client.from("profiles").upsert(row).execute()
      profile = row
      if case .signedIn(let stateId) = state, stateId != row.id {
        state = .signedIn(userId: row.id)
      }
      return true
    } catch {
      errorMessage = "Couldn't save profile: \(error.localizedDescription)"
      return false
    }
  }
}
