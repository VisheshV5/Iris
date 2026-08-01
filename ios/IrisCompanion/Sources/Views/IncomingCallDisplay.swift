import MWDATDisplay

/// The card rendered on the glasses display when a call comes in.
enum IncomingCallDisplay {
  /// Minimal heads-up card: no buttons, just "taking call" (per the founder's ask —
  /// glance-and-move-on, not a decision point).
  static func takingCall(callerNumber: String?) -> FlexBox {
    FlexBox(direction: .column) {
      Text("📞 Taking call", style: .heading)
      Text(callerNumber ?? "Unknown number", style: .meta, color: .secondary)
    }
    .padding(24)
    .background(.card)
  }

  /// Post-call card: one-glance summary of the message Iris took.
  static func callSummary(callerName: String?, reason: String?) -> FlexBox {
    FlexBox(direction: .column) {
      Text("✅ Message taken", style: .heading)
      Text(callerName ?? "Unknown caller", style: .body)
      Text(reason ?? "No reason captured", style: .meta, color: .secondary)
    }
    .padding(24)
    .background(.card)
  }

  static func view(
    callerNumber: String?,
    onClaim: @escaping @Sendable () -> Void,
    onDecline: @escaping @Sendable () -> Void
  ) -> FlexBox {
    FlexBox(direction: .column, spacing: 12) {
      FlexBox(direction: .column) {
        Text("Incoming call", style: .heading)
        Text(callerNumber ?? "Unknown number", style: .meta, color: .secondary)
      }
      .padding(24)
      .background(.card)

      FlexBox(direction: .row, spacing: 8, alignment: .center, crossAlignment: .center) {
        Button(label: "I've got it", style: .primary, onClick: onClaim)
        Button(label: "Let Iris handle it", style: .secondary, onClick: onDecline)
      }
    }
  }
}
