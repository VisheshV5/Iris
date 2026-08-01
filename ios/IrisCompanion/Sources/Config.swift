import Foundation

/// The anon key is safe to ship in a client binary by design (Supabase RLS is the
/// actual security boundary — see sql/002_call_status.sql). Never put the service
/// role key here.
enum Config {
  static let supabaseURL = URL(string: "https://wacgfjfhneiidbpxhgqt.supabase.co")!
  static let supabaseAnonKey =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhY2dmamZobmVpaWRicHhoZ3F0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MTUwNjksImV4cCI6MjEwMTA5MTA2OX0.3e5KyYBfLmlYsIFzg9nTIDL68v_GYDLxmAwEaXx79tk"

  /// Iris backend (ngrok tunnel in dev). All app → server calls build off this,
  /// so a tunnel change is a one-line edit.
  static let serverBaseURL = URL(string: "https://avenue-unbend-sprout.ngrok-free.dev")!
}
