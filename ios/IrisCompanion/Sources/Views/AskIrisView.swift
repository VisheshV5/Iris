import SwiftUI

/// The founder command sheet: type (or dictate via the keyboard mic — that IS the
/// voice path, no in-app speech recognition) a natural-language instruction and
/// send it to the server. The sheet shows the request lifecycle inline; the call
/// itself finishes later and lands in the Messages tab.
struct AskIrisView: View {
  var command: CommandService

  @State private var text = ""
  @FocusState private var editorFocused: Bool
  @Environment(\.dismiss) private var dismiss

  private static let examples = [
    "Set up a meeting with Sarah Chen tomorrow at 2pm",
    "Book a table for 4 at Nopa on Friday at 7",
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          TextField(
            "What should Iris do? Tap the mic on your keyboard to dictate.",
            text: $text,
            axis: .vertical
          )
          .lineLimit(4...8)
          .textFieldStyle(.plain)
          .focused($editorFocused)
          .padding(12)
          .background(.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))

          if case .idle = command.phase {
            VStack(alignment: .leading, spacing: 8) {
              Text("Try something like")
                .font(.caption)
                .foregroundStyle(.secondary)
              ForEach(Self.examples, id: \.self) { example in
                Button {
                  text = example
                } label: {
                  Text("“\(example)”")
                    .font(.subheadline)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
              }
            }
          }

          statusSection

          Button {
            Task { await command.send(text) }
          } label: {
            Label("Send", systemImage: "paperplane.fill")
              .font(.headline)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 6)
          }
          .buttonStyle(.borderedProminent)
          .disabled(sendDisabled)
        }
        .padding()
      }
      .navigationTitle("Ask Iris")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
      .onAppear { editorFocused = true }
    }
  }

  private var sendDisabled: Bool {
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
    switch command.phase {
    case .sending, .pickContact: return true
    default: return false
    }
  }

  @ViewBuilder
  private var statusSection: some View {
    switch command.phase {
    case .idle:
      EmptyView()

    case .sending(let status):
      HStack(spacing: 10) {
        ProgressView()
        Text(status)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding()
      .background(.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))

    case .pickContact(let name, let matches):
      VStack(alignment: .leading, spacing: 10) {
        Label("Which \(name)?", systemImage: "person.crop.circle.badge.questionmark")
          .font(.headline)
        Text("More than one contact matched — pick the right one. Only that one contact is shared with Iris.")
          .font(.caption)
          .foregroundStyle(.secondary)
        ForEach(matches) { match in
          Button {
            Task { await command.choose(match) }
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Text(match.name).font(.subheadline.bold())
              Text(match.phone).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
          }
          .buttonStyle(.plain)
        }
      }
      .padding()
      .background(.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))

    case .success(let message):
      VStack(alignment: .leading, spacing: 8) {
        Label(message, systemImage: "checkmark.circle.fill")
          .font(.subheadline.bold())
          .foregroundStyle(.green)
        Text("I'll ping you when the call wraps up — the outcome shows up in the Messages tab.")
          .font(.caption)
          .foregroundStyle(.secondary)
        Button("Ask something else") {
          text = ""
          command.reset()
        }
        .font(.subheadline)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding()
      .background(.green.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))

    case .failure(let message):
      VStack(alignment: .leading, spacing: 8) {
        Label("Iris couldn't do that", systemImage: "exclamationmark.triangle.fill")
          .font(.subheadline.bold())
          .foregroundStyle(.red)
        // number_not_verified howTo steps (among others) surface verbatim here.
        Text(message)
          .font(.subheadline)
          .textSelection(.enabled)
        Button("Try again") { command.reset() }
          .font(.subheadline)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding()
      .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }
  }
}
