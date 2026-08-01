import Supabase
import SwiftUI

@main
struct IrisCompanionApp: App {
  private let client: SupabaseClient
  @State private var supabase: SupabaseService
  @State private var auth: AuthService
  @State private var escalations: EscalationService
  @State private var command: CommandService
  @StateObject private var voiceWake: VoiceWakeService
  @State private var glasses = GlassesService()
  @Environment(\.scenePhase) private var scenePhase

  init() {
    let client = SupabaseService.makeClient()
    self.client = client
    _supabase = State(wrappedValue: SupabaseService(client: client))
    _auth = State(wrappedValue: AuthService(client: client))
    _escalations = State(wrappedValue: EscalationService(client: client))
    let command = CommandService(client: client)
    _command = State(wrappedValue: command)
    _voiceWake = StateObject(wrappedValue: VoiceWakeService(command: command))
    NotificationService.requestAuthorization()
  }

  var body: some Scene {
    WindowGroup {
      ZStack {
        switch auth.state {
        case .loading:
          ProgressView()
        case .signedOut, .codeSent:
          AuthView(auth: auth)
        case .signedIn(let userId):
          if auth.profile == nil {
            NavigationStack {
              ProfileView(auth: auth, userId: userId, client: client)
            }
          } else {
            TabView {
              HomeView(supabase: supabase, glasses: glasses, command: command, voiceWake: voiceWake)
                .tabItem { Label("Home", systemImage: "house.fill") }

              CallHistoryView(supabase: supabase)
                .tabItem { Label("Messages", systemImage: "tray.fill") }

              NavigationStack {
                ProfileView(auth: auth, userId: userId, client: client)
              }
              .tabItem { Label("Profile", systemImage: "person.crop.circle") }
            }
          }
        }
        RegistrationCallbackView()
      }
      // Urgent hold-and-ask flow: a caller is literally waiting on the line, so
      // this covers whatever is showing, sign-in screens included.
      .fullScreenCover(item: Binding(get: { escalations.pending }, set: { _ in })) { record in
        EscalationAlertView(escalations: escalations, record: record)
      }
      // Subscribe immediately — call alerts must work even while the founder is
      // still mid-onboarding (the calls table is anon-readable by design).
      .onAppear {
        supabase.start()
        escalations.start()
        // Hands-free escalation: Iris speaks the question, then listens for the
        // founder's spoken answer and sends it straight back into the live call.
        escalations.onSpeakQuestion = { _ in
          DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) {
            voiceWake.captureAnswer { spoken in
              Task { await escalations.send(answer: spoken) }
              SpeechService.announce("Got it — telling them now.")
            }
          }
        }
      }
      // iOS suspends the Realtime websocket in the background; on return, re-sync
      // so a call that started while the phone was locked still shows up.
      .onChange(of: scenePhase) { _, phase in
        if phase == .active {
          supabase.resync()
          escalations.resync()
        }
      }
      .onOpenURL { url in
        // Supabase magic-link callback; Meta glasses URLs are handled separately
        // by RegistrationCallbackView (it filters on its own query param).
        if url.host == "auth-callback" || url.absoluteString.contains("access_token") {
          Task { await auth.handleAuthCallback(url) }
        }
      }
    }
  }
}
