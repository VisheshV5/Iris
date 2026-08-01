import SwiftUI

/// Full-screen "Iris needs you" card — presented over everything when a caller is
/// on hold waiting for the founder's answer. Two reply paths: one-tap approve of
/// Iris's suggested answer, or a freeform field whose keyboard mic (dictation) is
/// the founder-responds-by-voice path for glasses wearers.
struct EscalationAlertView: View {
  var escalations: EscalationService
  let record: EscalationRecord

  @State private var reply = ""
  @FocusState private var replyFocused: Bool

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          header

          Text(record.question)
            .font(.title2.bold())
            .fixedSize(horizontal: false, vertical: true)

          if let context = record.contextForWearer, !context.isEmpty {
            contextCard(context)
          }

          if let suggested = record.suggestedAnswer, !suggested.isEmpty {
            suggestedCard(suggested)
          }

          replySection

          if let error = escalations.connectionError {
            Text(error)
              .font(.caption)
              .foregroundStyle(.red)
          }
        }
        .padding()
      }
      .safeAreaInset(edge: .bottom) {
        Button {
          escalations.dismiss()
        } label: {
          Label("Let Iris handle it", systemImage: "waveform")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .padding(.horizontal)
        .padding(.bottom, 8)
        .background(.bar)
      }
      .navigationTitle("Caller on hold")
      .navigationBarTitleDisplayMode(.inline)
      .interactiveDismissDisabled()
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Iris needs you", systemImage: "exclamationmark.bubble.fill")
        .font(.headline)
        .foregroundStyle(.orange)
      Text(callerLine)
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding()
    .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
  }

  private var callerLine: String {
    if let number = record.callerNumber, !number.isEmpty {
      return "A caller (\(number)) is holding while Iris checks with you."
    }
    return "A caller is holding while Iris checks with you."
  }

  private func contextCard(_ context: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("For your eyes only", systemImage: "lock.fill")
        .font(.caption.bold())
        .foregroundStyle(.purple)
      Text(context)
        .font(.subheadline)
      Text("Iris will never read this to the caller.")
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding()
    .background(.purple.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
  }

  private func suggestedCard(_ suggested: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("Iris suggests", systemImage: "sparkles")
        .font(.caption.bold())
        .foregroundStyle(.secondary)
      Text(suggested)
        .font(.body)
      Button {
        Task { await escalations.send(answer: suggested) }
      } label: {
        if escalations.sending {
          ProgressView().frame(maxWidth: .infinity)
        } else {
          Label("Send this", systemImage: "paperplane.fill")
            .frame(maxWidth: .infinity)
        }
      }
      .buttonStyle(.borderedProminent)
      .disabled(escalations.sending)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding()
    .background(.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
  }

  private var replySection: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(record.suggestedAnswer == nil ? "Your answer" : "Or answer in your own words")
        .font(.caption.bold())
        .foregroundStyle(.secondary)

      TextField("Tap the mic to dictate…", text: $reply, axis: .vertical)
        .lineLimit(2...6)
        .textFieldStyle(.roundedBorder)
        .focused($replyFocused)

      Button {
        Task { await escalations.send(answer: reply) }
      } label: {
        if escalations.sending {
          ProgressView().frame(maxWidth: .infinity)
        } else {
          Label("Send", systemImage: "paperplane")
            .frame(maxWidth: .infinity)
        }
      }
      .buttonStyle(.borderedProminent)
      .disabled(escalations.sending || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
  }
}
