import Contacts
import CoreLocation
import Foundation
import Supabase

/// One candidate from the on-device contact search. Only the single contact the
/// founder confirms (or the unambiguous sole match) is ever sent to the server.
struct ContactMatch: Identifiable, Equatable, Sendable {
  let id: String
  let name: String
  let phone: String
}

/// Sends founder commands ("set up a meeting with Sarah tomorrow at 2") to
/// `POST {serverBaseURL}/iris/command` and drives the Ask Iris sheet through its
/// states. The server does all parsing; this class only handles transport,
/// on-device contact resolution when the server asks for one, and a one-shot
/// coarse location ("City, ST") to bias business lookups.
@MainActor
@Observable
final class CommandService {
  enum Phase: Equatable {
    case idle
    case sending(status: String)
    case pickContact(name: String, matches: [ContactMatch])
    case success(message: String)
    case failure(message: String)
  }

  private(set) var phase: Phase = .idle

  private let client: SupabaseClient
  private let location = LocationProvider()
  /// The command text kept around so a contact pick can re-POST it unchanged.
  private var pendingText: String?

  init(client: SupabaseClient) {
    self.client = client
  }

  func reset() {
    phase = .idle
    pendingText = nil
  }

  enum SelfCallResult { case success, failure(String) }

  /// "Talk to Iris": asks the server to phone the founder so they can speak to her
  /// hands-free (the Meta glasses are already the phone's Bluetooth headset).
  func requestSelfCall() async -> SelfCallResult {
    guard let token = client.auth.currentSession?.accessToken else {
      return .failure("Sign in first.")
    }
    var request = URLRequest(url: Config.serverBaseURL.appending(path: "iris/talk"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = "{}".data(using: .utf8)
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(code) { return .success }
      let detail = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      return .failure((detail?["howTo"] ?? detail?["message"] ?? detail?["error"]) as? String ?? "Couldn't start the call (\(code)).")
    } catch {
      return .failure(error.localizedDescription)
    }
  }

  /// First pass: always send with no contact. If the server needs a phone number
  /// it answers `error: "contact_required"` and we resolve locally.
  func send(_ text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    pendingText = trimmed
    phase = .sending(status: "Asking Iris…")
    let city = await location.cityState()
    await post(text: trimmed, contact: nil, location: city)
  }

  /// Founder picked one of several matching contacts.
  func choose(_ match: ContactMatch) async {
    guard let text = pendingText else { return }
    phase = .sending(status: "Iris is calling \(match.name)…")
    // cityState() returns the cached value instantly after the first lookup.
    let city = await location.cityState()
    await post(text: text, contact: match, location: city)
  }

  // MARK: - Wire format

  private struct ContactPayload: Encodable {
    let name: String
    let phone: String
  }

  private struct CommandRequest: Encodable {
    let text: String
    let contact: ContactPayload?
    let location: String?
  }

  private struct NeedsContact: Decodable {
    let name: String
  }

  private struct CommandResponse: Decodable {
    let message: String?
    let error: String?
    let contactName: String?
    let needsContact: NeedsContact?
    let howTo: String?

    enum CodingKeys: String, CodingKey {
      case message, error, needsContact, howTo
      case contactName = "contact_name"
    }
  }

  private func post(text: String, contact: ContactMatch?, location city: String?) async {
    guard let token = client.auth.currentSession?.accessToken else {
      phase = .failure(message: "You're signed out — sign in again and retry.")
      return
    }
    var request = URLRequest(url: Config.serverBaseURL.appendingPathComponent("iris/command"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONEncoder().encode(
        CommandRequest(
          text: text,
          contact: contact.map { ContactPayload(name: $0.name, phone: $0.phone) },
          location: city
        )
      )
      let (data, response) = try await URLSession.shared.data(for: request)
      await handle(data: data, response: response)
    } catch {
      phase = .failure(message: "Couldn't reach Iris: \(error.localizedDescription)")
    }
  }

  private func handle(data: Data, response: URLResponse) async {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let decoded = try? JSONDecoder().decode(CommandResponse.self, from: data)

    if let decoded {
      // Server needs a phone number: resolve the named contact on-device.
      if decoded.error == "contact_required" || decoded.needsContact != nil {
        let name = decoded.contactName ?? decoded.needsContact?.name ?? ""
        await resolveContact(named: name)
        return
      }
      // A1 compliance gate: surface the server's how-to steps verbatim.
      if decoded.error == "number_not_verified" {
        phase = .failure(
          message: decoded.howTo
            ?? decoded.message
            ?? "That number isn't verified for outbound calls yet."
        )
        return
      }
      if let error = decoded.error {
        phase = .failure(message: decoded.message ?? error)
        return
      }
      if (200..<300).contains(status) {
        phase = .success(message: decoded.message ?? "On it — Iris is making the call.")
        return
      }
    }

    if (200..<300).contains(status) {
      phase = .success(message: "On it — Iris is making the call.")
    } else {
      phase = .failure(message: "Iris couldn't handle that (server error \(status)). Try again in a moment.")
    }
  }

  private func resolveContact(named name: String) async {
    guard !name.isEmpty else {
      phase = .failure(message: "Iris needs a name or phone number for that — try again with one.")
      return
    }
    do {
      let matches = try await ContactMatcher.matches(for: name)
      switch matches.count {
      case 0:
        phase = .failure(message: "No contact named \(name) with a phone number on this device.")
      case 1:
        await choose(matches[0])
      default:
        phase = .pickContact(name: name, matches: matches)
      }
    } catch ContactMatcher.MatchError.accessDenied {
      phase = .failure(
        message: "Iris needs Contacts access to find \(name)'s number. Allow it in Settings, or repeat the request with the phone number included."
      )
    } catch {
      phase = .failure(message: "Couldn't search your contacts: \(error.localizedDescription)")
    }
  }
}

// MARK: - Contact matching helper

/// Searches the device address book for a name the server asked about. The full
/// book never leaves the device — the search runs locally and only the one
/// confirmed match is posted back.
enum ContactMatcher {
  enum MatchError: Error {
    case accessDenied
  }

  /// Case-insensitive givenName/familyName contains-match. Every whitespace
  /// token of `name` must hit either name component ("Sarah Chen" matches
  /// given: Sarah, family: Chen; plain "Sarah" matches any Sarah).
  static func matches(for name: String) async throws -> [ContactMatch] {
    let store = CNContactStore()
    if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
      _ = try? await store.requestAccess(for: .contacts)
    }
    guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else {
      throw MatchError.accessDenied
    }

    let query = name
    // Enumeration can touch a large local database; keep it off the main actor.
    return try await Task.detached(priority: .userInitiated) {
      let request = CNContactFetchRequest(keysToFetch: [
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
      ])
      let tokens = query.split(separator: " ").map(String.init)
      var results: [ContactMatch] = []
      try CNContactStore().enumerateContacts(with: request) { contact, _ in
        let matchesAll = tokens.allSatisfy { token in
          contact.givenName.localizedCaseInsensitiveContains(token)
            || contact.familyName.localizedCaseInsensitiveContains(token)
        }
        guard matchesAll,
          let phone = contact.phoneNumbers.first?.value.stringValue,
          !phone.isEmpty
        else { return }
        let fullName = [contact.givenName, contact.familyName]
          .filter { !$0.isEmpty }
          .joined(separator: " ")
        results.append(
          ContactMatch(
            id: contact.identifier,
            name: fullName.isEmpty ? query : fullName,
            phone: phone
          )
        )
      }
      return results
    }.value
  }
}

// MARK: - One-shot coarse location (Phase 5)

/// Requests When-In-Use authorization once, grabs a single coarse fix, and
/// reverse-geocodes it to "City, ST". No continuous tracking — the result is
/// cached for the life of the service. Denied permission just means commands go
/// out without a location.
@MainActor
private final class LocationProvider: NSObject, @preconcurrency CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private var cached: String?
  private var authContinuation: CheckedContinuation<Void, Never>?
  private var locationContinuation: CheckedContinuation<CLLocation?, Never>?

  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyKilometer
  }

  func cityState() async -> String? {
    if let cached { return cached }
    if manager.authorizationStatus == .notDetermined {
      await withCheckedContinuation { continuation in
        authContinuation = continuation
        manager.requestWhenInUseAuthorization()
      }
    }
    guard manager.authorizationStatus == .authorizedWhenInUse
      || manager.authorizationStatus == .authorizedAlways
    else { return nil }

    let fix: CLLocation? = await withCheckedContinuation { continuation in
      locationContinuation = continuation
      manager.requestLocation()
    }
    guard let fix,
      let placemark = try? await CLGeocoder().reverseGeocodeLocation(fix).first
    else { return nil }

    let parts = [placemark.locality ?? placemark.subAdministrativeArea, placemark.administrativeArea]
      .compactMap { $0 }
    guard !parts.isEmpty else { return nil }
    cached = parts.joined(separator: ", ")
    return cached
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    authContinuation?.resume()
    authContinuation = nil
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    locationContinuation?.resume(returning: locations.last)
    locationContinuation = nil
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    locationContinuation?.resume(returning: nil)
    locationContinuation = nil
  }
}
