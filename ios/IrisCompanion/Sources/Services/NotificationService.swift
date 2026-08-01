import UserNotifications

/// Local notifications only — these fire while the app process is alive (foreground
/// or freshly backgrounded). True background delivery when the app is force-quit
/// needs APNs, which this pass intentionally skips (see README).
enum NotificationService {
  static func requestAuthorization() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  static func notifyIncomingCall(from callerNumber: String?) {
    let content = UNMutableNotificationContent()
    content.title = "Incoming call for you"
    content.body = callerNumber.map { "From \($0) — Iris will pick up shortly." }
      ?? "Iris will pick up shortly."
    content.sound = .default

    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }

  /// Iris has a caller on hold and needs the founder's answer right now.
  static func notifyEscalation(question: String) {
    let content = UNMutableNotificationContent()
    content.title = "Iris needs you"
    content.body = question
    content.sound = .default

    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }
}
