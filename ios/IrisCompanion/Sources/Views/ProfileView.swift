import SwiftUI
import Supabase

struct ProfileView: View {
  var auth: AuthService
  let userId: UUID
  let client: SupabaseClient
  /// Present in onboarding mode (no existing profile) or edit mode.
  var onDone: (() -> Void)?

  @State private var draft: FounderProfile
  @State private var saving = false
  @State private var calendarMessage: String?

  init(auth: AuthService, userId: UUID, client: SupabaseClient, onDone: (() -> Void)? = nil) {
    self.auth = auth
    self.userId = userId
    self.client = client
    self.onDone = onDone
    _draft = State(initialValue: auth.profile ?? .empty(id: userId))
  }

  var body: some View {
    Form {
      Section("About you") {
        TextField("Full name", text: $draft.fullName)
        TextField("Company", text: $draft.company)
        TextField("Your role (e.g. Founder & CEO)", text: $draft.role)
        TextField("Your cell number (for call handoffs)", text: $draft.phone)
          .keyboardType(.phonePad)
      }

      Section {
        TextField(
          "What does your company do? Who usually calls, and what do they want?",
          text: $draft.about,
          axis: .vertical
        )
        .lineLimit(4...10)
      } header: {
        Text("Brief Iris")
      } footer: {
        Text("Iris reads this before answering every call — it's how she introduces your business and talks about what you do.")
      }

      Section("Google Calendar") {
        if draft.googleCalendarConnected {
          Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        } else {
          Button {
            connectCalendar()
          } label: {
            Label("Connect Google Calendar", systemImage: "calendar.badge.plus")
          }
          if let message = calendarMessage {
            Text(message).font(.caption).foregroundStyle(.secondary)
          }
        }
      }

      Section {
        Button {
          Task {
            saving = true
            let ok = await auth.saveProfile(draft)
            saving = false
            if ok { onDone?() }
          }
        } label: {
          if saving { ProgressView().frame(maxWidth: .infinity) } else { Text("Save").frame(maxWidth: .infinity) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(draft.fullName.isEmpty || draft.company.isEmpty)
      }

      Section {
        Button("Sign out", role: .destructive) {
          Task { await auth.signOut() }
        }
      }

      if let error = auth.errorMessage {
        Text(error).font(.caption).foregroundStyle(.red)
      }
    }
    .navigationTitle(auth.profile == nil ? "Set up Iris" : "Profile")
  }

  private func connectCalendar() {
    // Google OAuth through Supabase. Requires the Google provider to be configured
    // in the Supabase dashboard with a Google Cloud OAuth client — until then this
    // surfaces the error rather than pretending.
    Task {
      do {
        // access_type=offline + prompt=consent are what make Google include a
        // refresh token in the redirect; without them, repeat sign-ins return
        // only a short-lived access token.
        let session = try await client.auth.signInWithOAuth(
          provider: .google,
          redirectTo: URL(string: "iriscompanion://auth-callback"),
          scopes: "https://www.googleapis.com/auth/calendar.events",
          queryParams: [
            (name: "access_type", value: "offline"),
            (name: "prompt", value: "consent"),
          ]
        )
        // "Connected" only counts if we actually hold the refresh token — an
        // access token alone dies within the hour and can't be renewed later.
        if let token = session.providerRefreshToken, !token.isEmpty {
          draft.googleRefreshToken = token
          draft.googleCalendarConnected = true
          draft.id = session.user.id
          _ = await auth.saveProfile(draft)
        } else {
          calendarMessage = "Google signed in but didn't return a refresh token. Try again — you may need to re-approve access."
        }
      } catch {
        calendarMessage = "Google isn't configured yet: \(error.localizedDescription)"
      }
    }
  }
}
