import SwiftUI

struct CallHistoryView: View {
  var supabase: SupabaseService

  var body: some View {
    NavigationStack {
      List(supabase.history) { call in
        NavigationLink {
          CallDetailView(call: call)
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(call.callerName ?? call.callerNumber ?? "Unknown caller")
              .font(.headline)
            Text(call.reason ?? "No reason recorded")
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }
      .overlay {
        if supabase.history.isEmpty {
          ContentUnavailableView(
            "No messages yet",
            systemImage: "tray",
            description: Text("Calls Iris finishes handling will show up here.")
          )
        }
      }
      .safeAreaInset(edge: .top) {
        if let problem = supabase.connectionError {
          Text(problem)
            .font(.caption)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(.red.opacity(0.1))
        }
      }
      .navigationTitle("Messages")
      .refreshable { await supabase.refreshHistory() }
    }
  }
}

private struct CallDetailView: View {
  let call: CallRecord

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        LabeledContent("Caller", value: call.callerName ?? "Unknown")
        LabeledContent("Callback number", value: call.callbackNumber ?? call.callerNumber ?? "—")
        LabeledContent("Reason", value: call.reason ?? "—")
        if let response = call.wearerResponse {
          LabeledContent("Your response", value: response == .claimed ? "You took it" : "Let Iris handle it")
        }

        if let summary = call.summary {
          Text("Summary").font(.headline).padding(.top, 8)
          Text(summary)
        }

        if let transcript = call.transcript {
          Text("Transcript").font(.headline).padding(.top, 8)
          Text(transcript).font(.footnote).foregroundStyle(.secondary)
        }
      }
      .padding()
    }
    .navigationTitle(call.callerName ?? "Call")
    .navigationBarTitleDisplayMode(.inline)
  }
}
