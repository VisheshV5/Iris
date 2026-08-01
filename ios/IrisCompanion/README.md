# Iris Companion (iOS)

The wearer-side app: alerts you the instant a call comes in (phone notification +
Meta glasses display, if paired) and lists the messages Iris has taken.

## One-time machine setup

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
brew install xcodegen   # already done if you're reading this after the first run
```

## Build & run

```bash
cd ios/IrisCompanion
xcodegen generate                 # regenerates IrisCompanion.xcodeproj from project.yml
open IrisCompanion.xcodeproj
```

In Xcode: select your iPhone as the run destination (Simulator works for the
Supabase/notification half; glasses pairing needs a real device), pick your Apple ID
under **Signing & Capabilities → Team**, then Run.

## Pairing with your glasses

1. On your phone, open the **Meta AI** app → **Settings → App Info** → tap the version
   number 5 times → enable **Developer Mode**. This lets an unpublished app (this one)
   register and talk to your glasses without going through Meta's app review.
2. Make sure your Ray-Ban Meta / Ray-Ban Display glasses are already paired to the
   Meta AI app.
3. Launch Iris Companion → tap **Connect glasses** on the Home tab → follow the
   handoff into the Meta AI app and back.
4. The custom-display card (with "I've got it" / "Let Iris handle it" buttons) only
   renders on **Ray-Ban Display** glasses — the DAT SDK's Display capability needs an
   actual screen. On non-display Ray-Ban Meta glasses, everything else (phone
   notification, in-app alert, call history) still works; the glasses-display relay
   silently no-ops rather than erroring.

`project.yml`'s `META_APP_ID` / `CLIENT_TOKEN` build settings are intentionally blank —
Developer Mode doesn't require them. Only fill those in (from the
[Wearables Developer Center](https://wearables.developer.meta.com/)) if you later want
to distribute past the 100-tester developer-preview cap.

## Architecture

- `Sources/Services/SupabaseService.swift` — Realtime subscription to `public.calls`
  (anon key only; RLS policies in `sql/002_call_status.sql` are the actual security
  boundary) + call-history fetch + writing the wearer's response.
- `Sources/Services/GlassesService.swift` — DAT SDK registration + Display session
  lifecycle, adapted from Meta's own `DisplayAccess` sample app. Best-effort: never
  crashes the app if glasses aren't connected or aren't a Display model.
- `Sources/Services/NotificationService.swift` — local `UNUserNotificationCenter`
  alerts. These fire while the app process is alive; true background delivery when
  the app is force-quit would need APNs (a paid Apple Developer Program enrollment +
  push certs), intentionally out of scope for this pass.
- `Sources/Views/IncomingCallDisplay.swift` — the card rendered on the glasses screen
  (`MWDATDisplay`'s `FlexBox`/`Text`/`Button` API).
- `Sources/Views/HomeView.swift`, `CallHistoryView.swift` — the phone-side UI.

## Backend changes this required

- `sql/002_call_status.sql` — adds `calls.status` (`ringing` → `completed`) and
  `calls.wearer_response`, plus RLS policies so the app's anon key can read the table
  and update only its own response, and enables Realtime on `calls`.
- `src/server.ts` / `src/bridge.ts` — write a `status: "ringing"` row the instant a
  call is answered (previously the DB was only touched at the *end* of a call), so
  the app has something to subscribe to.
