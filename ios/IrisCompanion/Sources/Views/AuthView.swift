import SwiftUI

struct AuthView: View {
  var auth: AuthService
  @State private var email = ""

  var body: some View {
    VStack(spacing: 24) {
      Spacer()
      Image(systemName: "waveform.circle.fill")
        .font(.system(size: 64))
        .foregroundStyle(.tint)
      Text("Iris")
        .font(.largeTitle.bold())
      Text("Your AI receptionist. Sign in to set her up for your business.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)

      if case .codeSent(let sentTo) = auth.state {
        VStack(spacing: 14) {
          Image(systemName: "envelope.open.fill")
            .font(.system(size: 40))
            .foregroundStyle(.tint)
          Text("Check your email")
            .font(.headline)
          Text("We sent a sign-in link to \(sentTo). Open it on this phone and you'll land right back here, signed in.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
          Button("Use a different email") {
            Task { await auth.signOut() }
          }
          .font(.footnote)
        }
      } else {
        VStack(spacing: 12) {
          TextField("you@company.com", text: $email)
            .keyboardType(.emailAddress)
            .textContentType(.emailAddress)
            .autocapitalization(.none)
            .autocorrectionDisabled()
            .textFieldStyle(.roundedBorder)
          Button {
            Task { await auth.sendCode(to: email) }
          } label: {
            Text("Send sign-in code").frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .disabled(!email.contains("@"))
        }
      }

      if let error = auth.errorMessage {
        Text(error).font(.caption).foregroundStyle(.red)
      }
      Spacer()
      Spacer()
    }
    .padding(28)
  }
}
