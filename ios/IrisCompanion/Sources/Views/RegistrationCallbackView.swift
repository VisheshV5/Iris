import MWDATCore
import SwiftUI

/// Invisible view that catches the deep-link callback the Meta AI app sends back
/// into this app during glasses pairing (matches Meta's own DisplayAccess sample).
struct RegistrationCallbackView: View {
  var body: some View {
    EmptyView()
      .onOpenURL { url in
        guard
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
        else { return }
        Task {
          _ = try? await Wearables.shared.handleUrl(url)
        }
      }
  }
}
