# Native mobile tests

Use the same `run` command for websites, iOS Simulator, and Android Emulator. Jev chooses controls from native accessibility snapshots; the runner checks your expectations independently. This is native app automation, rather than a phone-sized browser.

## Quick start

```sh
git clone https://github.com/perixtar/jev-e2e.git
cd jev-e2e
npm ci && npm run build
npm link
jev-e2e doctor --platform ios
jev-e2e devices --platform ios
jev-e2e run --platform ios --device EXACT_ID \
  --app com.example.app --cases mobile.cases --fixtures fixtures.json
```

An installed bundle/package ID is easiest. A simulator `.app` or emulator `.apk` path also works; it is installed on the selected device. Device names work only when unique. Ambiguous names and physical devices are BLOCKED.

| Target | Local prerequisites | App build |
| --- | --- | --- |
| iOS | macOS, Xcode selected by `xcode-select`, installed iOS runtime | Simulator `.app`, or installed bundle ID |
| Android | Java, Android SDK, `adb` on PATH, booted emulator | Emulator `.apk`, or installed package ID |
| Website | Node and Chromium (`jev-e2e setup`) | HTTP(S) URL |

Mobile requires Node >=22.12 and the pinned optional `agent-device@0.21.6` package. A source checkout must use the documented `npm ci` before building because the compiler reads the SDK types. After `npm pack` produces a prebuilt tarball, a browser-only consumer may install that tarball with `--omit=optional`; native commands then give an actionable missing-SDK error. Browser-only use needs neither Xcode nor Android tools.

`doctor` checks local tools without opening your app. It does not install host toolchains or open accounts. For Android, export `ANDROID_HOME` and add `$ANDROID_HOME/platform-tools` to PATH **before** the first run; the local SDK daemon retains its startup environment.

## Describe a case

For free-form goals, leave the optional planner on:

```text
Case: A lamp survives a restart
Goal: Fill "Email" using @email, fill "Password" using @password, then tap "Sign in". Tap "Open Desk Lamp", tap "Add to cart", relaunch the app, then tap "Cart".
Expect: text "Desk Lamp" is visible
Expect: text "Quantity: 1" is visible
```

Review it without opening your app:

```sh
jev-e2e plan --platform ios --app com.example.app \
  --cases mobile.cases --fixtures fixtures.json --out reviewed.json
jev-e2e run --plan reviewed.json --device EXACT_ID
```

Keep each `Goal:` on one physical line. A wrapped continuation, including an unprefixed action or credential, blocks before any provider call; use explicit `Step:` lines when a flow is long.
Free-form actions need their supported verb each time: `tap "Increase", then tap "Increase"` means two taps. A bare repeated label such as `tap "Increase", "Increase"` cannot express a second action safely. Use two `Step:` lines if repetition matters.

For explicit steps, use `--planner off`. Explicit cases and saved plans need no prose-planner call. An unchanged saved flow can run with zero model calls; a stale target uses Jev for repair. Live discovery uses Jev through `OPENROUTER_API_KEY`; a separate OpenAI key is unnecessary.

```text
Case: Quantity and persistence
Goal: Two lamps should cost 72 and survive a restart
Step: Fill "Email" with @email
Step: Fill "Password" with @password
Step: Tap "Sign in"
Step: Tap "Open Desk Lamp"
Step: Tap "Add to cart"
Expect: text "Quantity: 1" is visible
Step: Tap "Increase Desk Lamp quantity"
Expect: text "Quantity: 2" is visible
Expect: number in id "cart-total" equals 72
Step: Relaunch
Step: Tap "Cart"
Expect: text "Quantity: 2" is visible
```

Each Expect is checked after the preceding Step, before a later screen hides the evidence. A failed milestone stops that case. Other cases remain independent; the runner never turns navigation success into a passing verdict.
With explicit cases, the `Step:` lines define the required actions and `Goal:` summarizes them. If the Goal also names a supported `Tap`/`Fill`/`Check` action, that action must appear in order among the Steps. An extra imperative that cannot be bound safely blocks; write it as an explicit supported Step instead. The compiler cannot infer an unlisted action from a broad Goal summary.

| Step | Meaning |
| --- | --- |
| `Tap "Add to cart"` | Tap a named observed control |
| `Fill "Search" with "lamp"` | Replace field text, rather than append |
| `Fill "Password" with @password` | Resolve a credential locally |
| `Check "Notifications"` / `Uncheck "Notifications"` | Set a readable switch/checkbox state |
| `Scroll down` / `up` / `left` / `right` | One bounded scroll pass |
| `Back` | Native back navigation |
| `Dismiss keyboard` | Observed dismiss control or the platform's supported dismiss action |
| `Wait for text "Ready"` | Wait for exact visible accessibility text |
| `Relaunch` | Terminate and reopen the app, preserving data |

Relaunch is different from browser Reload. Mobile plans reject web Reload/Select and browser Auth/storageState. Native menus should use their observed option buttons.

Supported expectations: exact text visibility/absence, readable field values, strict numeric values, switch state, identifiers (`Expect: id "cart-screen" is visible`), and counts with a complete visible accessibility tree. Semantic record checks need actual accessible record containers. Scroll-hidden or truncated trees cannot prove absence or whole-collection counts. Missing/ambiguous evidence is BLOCKED; an observed contradiction is FAIL.
The pinned iOS SDK can omit its optional quality verdict. In that case the runner requires two fresh, matching app-owned XCTest trees with explicit nontruncation and complete visibility metadata. A sparse tree, missing completeness metadata, or a warning about hierarchy limits blocks the check. Custom-rendered content that never appears in accessibility remains outside this proof.

Use `Expect: number in id "cart-total" equals 72` when an app exposes a stable accessibility identifier. Native backends can expose different labels for the same value; an identifier avoids guessing or matching a nearby number.
For switches, use `Expect: switch id "notifications" is checked` (or `unchecked`) when the state is exposed under an identifier.
The pinned Android SDK omits the checked flag. For switches/checkboxes, the driver supplements the snapshot with `adb uiautomator` evidence and accepts it only when the app, identifier, class, and bounds uniquely agree. Android permits one accessibility reader: the driver temporarily pauses the SDK snapshot helper on its leased device, then the SDK restarts it on the next capture. The tested app and its data stay intact. Missing or conflicting state blocks; `selected=false` is never treated as unchecked.

On Android, clearing a controlled text field can replace its native input connection. For a populated field with a stable ID, jev-e2e clears once, confirms the same field is empty and focused with exact accessibility evidence, then types once through the new connection and verifies the final value. Any unconfirmed stage blocks; it does not retry the mutation.

## Fixtures and baseline

```json
{
  "inputs": {
    "email": { "env": "E2E_TEST_EMAIL" },
    "password": { "env": "E2E_TEST_PASSWORD" }
  },
  "auth": {}
}
```

Keep actual credentials in local environment variables. Fixture values never belong in cases or saved plans. Even a field labeled only `Code` requires a fixture: it may be a one-time password. Field-name checks cannot recognize every app-specific secret label, so always use a fixture for credentials and private values. Native tests sign in through the UI; browser storageState cannot preload native authentication.
Do not assert the literal value of a credential field, even a short code; check a non-secret success/error state instead.

Prepare your app's baseline yourself before each independent case. Opening or relaunching preserves data; uninstalling an iOS app does not guarantee Keychain reset. The CLI does not run arbitrary reset shell commands or clear user data automatically. Use dedicated test devices and test accounts.

## Reports, replay, limits, and Stop

```sh
jev-e2e run --platform android --device emulator-5554 \
  --app com.example.app --cases mobile.cases --planner off \
  --fixtures fixtures.json --record --out ./local-report
jev-e2e run --replay ./local-report/plan.json --device emulator-5554
```

Reports include expected/observed milestones, unchecked expectations, confirmed or uncertain action dispatches, versions, model usage/cost, and planning/setup/observation/model/action/check/artifact/cleanup timings. A target rejected by the final freshness check is not reported as dispatched. Version-2 native replay plans bind app, platform, and a preserve-data baseline. They store semantic controls and accessibility identifiers, rather than coordinates or ephemeral refs. A successful run from a `.app` or `.apk` path also pins the installed bundle/package ID; replay blocks before an action if the build at that path now installs a different app. Older build-path plans without a pinned identity must be run with `--plan` once to create a new replay artifact. A stale missing control may be repaired by Jev; ambiguous or unsafe controls block. Existing version-1 web plans retain browser behavior.

| Outcome | Exit | Meaning |
| --- | --- | --- |
| PASS | 0 | All required actions and expectations checked |
| FAIL | 1 | Observed behavior contradicted an expectation |
| BLOCKED | 2 | Setup, missing evidence/control, ambiguity, deadline, or limit |
| Canceled | 130 | Ctrl-C stopped owned work |

Defaults: 60 seconds/case, 30 actions/case, 100 requests/run, $0.05/run. Override with `--timeout`, `--max-actions`, `--max-requests`, `--max-cost`. Request reservations enforce the budget before dispatch. Unknown billing is conservatively reserved. Stop closes the owned worker connection, cancels its native request, then releases its uniquely named session. The runner never retries an uncertain mutation or closes another user's session.

## Workbench and recording

`jev-e2e ui` offers Website/iOS/Android target selection, a device inventory, reviewed plans, Stop, a large portrait preview, local video playback, and report links. Changing the app, device, platform, recording preference, or saved source invalidates the review.

`--record` is explicit and local. Recording begins only after the last fixture/credential-entry step and after a screen without private fields/known values. Credential-entry segments are excluded. If a later screen exposes an input or known secret, the entire clip is discarded. Native screenshots conservatively omit screens containing text fields or known secrets. Raw SDK logs/recordings remain private local artifacts; nothing uploads automatically. Inspect footage before sharing: text redaction alone cannot remove secrets from pixels.

## Reproduce the owned shopping fixture

The fixture is React Native with Expo SDK 57. Its build dependencies are separate from the CLI. It has a fixed catalog and evaluator-only fault/reset service.

```sh
cd examples/mobile-app
npm ci
npx expo prebuild --no-install
# iOS
cd ios && pod install
xcodebuild -workspace JevShop.xcworkspace -scheme JevShop \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO
# Android, from examples/mobile-app/android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Start `node examples/mobile-app/control.mjs` from the repository root for manual tests. Synthetic credentials: `demo@example.test` / `correct-horse`; wrong password: `wrong-horse`. Export these into the variables in `examples/mobile.fixtures.example.json`. Install the builds on dedicated devices and use the cases in `examples/mobile.cases`.

Run one platform at a time, as in the published acceptance cohort. The evaluator owns its baseline service and retains every first attempt:

```sh
npm run build
node scripts/evaluate-mobile.mjs --live --platform ios \
  --ios-device IOS_ID --rounds 10 --max-cost 2 \
  --out .jev-e2e/mobile-evaluation/ios
node scripts/evaluate-mobile.mjs --live --platform android \
  --android-device emulator-5554 --rounds 10 --max-cost 2 \
  --out .jev-e2e/mobile-evaluation/android
```

It verifies that each trial consumed its intended baseline/fault configuration. Healthy execution, bug detection, and replay are reported separately; BLOCKED is never counted as detected failure.

Current scope: local virtual devices and accessible native/React Native controls. Physical phones, hosted devices, complex WebViews, arbitrary canvas controls, subjective appearance, biometrics, and payments require separate validation.
Free-form goals fail closed when an action cannot be bound to the supported verbs, including some read-only phrases with words such as “confirm” or “filter.” In that case, put concrete actions in `Step:` lines and keep the `Goal:` a short summary.
