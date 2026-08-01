import SwiftUI

struct HomeView: View {
  var supabase: SupabaseService
  var glasses: GlassesService
  var command: CommandService
  @ObservedObject var voiceWake: VoiceWakeService
  @State private var showAskIris = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 20) {
          Button {
            showAskIris = true
          } label: {
            Label("Ask Iris", systemImage: "mic.fill")
              .font(.headline)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 10)
          }
          .buttonStyle(.borderedProminent)

          VoiceWakeCard(voiceWake: voiceWake)

          // Surfaced rather than swallowed: a failed read here is exactly why the
          // live card / Messages / announcements would all appear "broken".
          if let problem = supabase.connectionError {
            Label(problem, systemImage: "exclamationmark.triangle.fill")
              .font(.caption)
              .foregroundStyle(.red)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(10)
              .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
          }

          if let call = supabase.ringingCall {
            IncomingCallCard(call: call) { response in
              Task {
                await supabase.respond(to: call, response: response)
                glasses.clearDisplay()
              }
            }
            .transition(.move(edge: .top).combined(with: .opacity))
          } else {
            ContentUnavailableView(
              "No active calls",
              systemImage: "phone.circle",
              description: Text("You'll see an alert here the moment someone calls Iris.")
            )
            .padding(.top, 60)
          }

          GlassesStatusCard(glasses: glasses)
        }
        .padding()
      }
      .navigationTitle("Iris")
      .sheet(isPresented: $showAskIris, onDismiss: { command.reset() }) {
        AskIrisView(command: command)
      }
      .onChange(of: supabase.ringingCall?.vapiCallId) { _, newValue in
        guard newValue != nil, let call = supabase.ringingCall else { return }
        guard call.direction != "outbound" else { return } // she placed this one
        NotificationService.notifyIncomingCall(from: call.callerNumber)
        SpeechService.announce("Iris is taking a call.")
        Task { await glasses.show(IncomingCallDisplay.takingCall(callerNumber: call.callerNumber)) }
      }
      .onChange(of: supabase.justCompleted?.vapiCallId) { _, newValue in
        guard newValue != nil, let call = supabase.justCompleted else { return }
        let who = call.callerName ?? "an unknown caller"
        let why = call.reason ?? "no reason given"
        SpeechService.announce("Message from \(who): \(why)")
        Task { await glasses.show(IncomingCallDisplay.callSummary(callerName: call.callerName, reason: call.reason)) }
      }
    }
  }
}

private struct VoiceWakeCard: View {
  @ObservedObject var voiceWake: VoiceWakeService

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: voiceWake.state == .off ? "ear.trianglebadge.exclamationmark" : "ear.fill")
        .font(.title3)
        .foregroundStyle(voiceWake.state == .off ? .secondary : Color.accentColor)
      VStack(alignment: .leading, spacing: 2) {
        Text("\u{201C}Hey Iris\u{201D}")
          .font(.headline)
        Text(statusText)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if voiceWake.state != .off {
        Button {
          voiceWake.captureNow()
        } label: {
          Image(systemName: "mic.circle.fill").font(.title)
        }
        .buttonStyle(.plain)
      }
      Toggle("", isOn: Binding(get: { voiceWake.state != .off }, set: { _ in voiceWake.toggle() }))
        .labelsHidden()
    }
    .padding()
    .background(.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
    .overlay(alignment: .bottom) {
      if voiceWake.state != .off, !voiceWake.heard.isEmpty {
        Text("\u{201C}\(voiceWake.heard)\u{201D}")
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .padding(.horizontal, 12)
          .padding(.vertical, 4)
          .background(.thinMaterial, in: Capsule())
          .offset(y: 14)
      }
    }
  }

  private var statusText: String {
    switch voiceWake.state {
    case .off: return "Off — flip on to talk to Iris through your glasses"
    case .listening: return "Listening — say \u{201C}Iris\u{201D}"
    case .capturing: return "Go ahead — I'm listening"
    case .processing: return "Working on it…"
    case .denied(let why): return why
    }
  }
}

private struct IncomingCallCard: View {
  let call: CallRecord
  let onRespond: (CallRecord.WearerResponse) -> Void

  private var isOutbound: Bool { call.direction == "outbound" }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label(
        isOutbound ? "Iris is on a call" : "Incoming call",
        systemImage: isOutbound ? "phone.connection.fill" : "phone.arrow.up.right.fill"
      )
      .font(.headline)
      .foregroundStyle(isOutbound ? .blue : .orange)

      Text(call.callerName ?? call.callerNumber ?? "Unknown number")
        .font(.title2.bold())

      Text(isOutbound
        ? "She's calling on your behalf — you'll get the outcome when she's done."
        : "Iris will pick up shortly unless you take it.")
        .font(.subheadline)
        .foregroundStyle(.secondary)

      // Claiming only makes sense for a call someone made TO us.
      if !isOutbound {
        HStack(spacing: 12) {
          Button {
            onRespond(.claimed)
          } label: {
            Label("I've got it", systemImage: "checkmark.circle.fill")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)

          Button {
            onRespond(.declined)
          } label: {
            Label("Let Iris handle it", systemImage: "waveform")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
        }
      }
    }
    .padding()
    .background((isOutbound ? Color.blue : Color.orange).opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
  }
}

private struct GlassesStatusCard: View {
  var glasses: GlassesService

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("Meta glasses", systemImage: "eyeglasses")
        .font(.headline)

      Text(statusText)
        .font(.subheadline)
        .foregroundStyle(.secondary)

      if glasses.registrationState != .available {
        Button("Connect glasses") {
          Task { await glasses.connect() }
        }
        .buttonStyle(.bordered)
      }

      if let error = glasses.lastError {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding()
    .background(.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
  }

  private var statusText: String {
    if glasses.displayUnsupported {
      return "Audio mode — announcements play through your glasses' speakers (no display on this model)"
    }
    switch glasses.registrationState {
    case .available: return glasses.isDisplayConnected ? "Connected — display ready" : "Connected"
    case .registering: return "Connecting…"
    case .unavailable: return "Not connected"
    default: return "Unknown"
    }
  }
}
