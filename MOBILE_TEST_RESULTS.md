# Native mobile validation

Measured September 19, 2026 on implementation commit `96a275e8c452fbc40ad5b52d83c538664edc0b64`. **The local native alpha met the [prewritten mobile exit criteria](TEST_PLAN.md#native-mobile-alpha-exit-criteria) on the owned Jev Shop fixture.** This is evidence for those five accessible flows on dedicated virtual devices, not a reliability claim for arbitrary apps or physical phones.

The complete, sanitized [60-suite / 300-case first-attempt record](docs/benchmarks/native-mobile-2026-09-19.json) includes each trial's baseline, verdict, checked counts, timings, requests, model, and billed API cost. It comprises two isolated 30-suite runs; every first attempt within those runs is included without retry or replacement. Earlier diagnostic runs on other simulator and concurrent-device setups hit host/SDK failures and are not pooled into this cohort.

| Platform and mode | First attempts | PASS | Correct FAIL | BLOCKED | Per-case median / p95 | Jev requests | Billed API cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| iOS · healthy discovery | 50 | 50 | — | 0 | 27.21 / 30.24 s | 250 | $0.014207 |
| iOS · seeded faults | 50 | **0** | **50** | 0 | 29.17 / 31.66 s | 250 | $0.014238 |
| iOS · saved replay | 50 | 50 | — | 0 | 25.24 / 36.57 s | 30 | $0.001677 |
| Android · healthy discovery | 50 | 50 | — | 0 | 10.44 / 13.10 s | 259 | $0.012789 |
| Android · seeded faults | 50 | **0** | **50** | 0 | 12.36 / 14.94 s | 261 | $0.012835 |
| Android · saved replay | 50 | 50 | — | 0 | 8.70 / 11.12 s | **0** | **$0** |

Every row has ten runs for each of five cases. Healthy and replay reached 10/10 per case; all five seeded faults produced 10/10 observed, correct FAIL. The aggregate billed provider cost was **$0.055746222**. The median is per-case elapsed time; suite setup and aggregate artifact phases are retained in the trial record. Warm healthy medians were 27.20 s on iOS and 10.57 s on Android, below the 60-second gate.

Replay made **zero prose-planner requests** on both platforms. iOS made 30 Jev repair requests across 50 replay cases because an extra accessibility ancestor changed the saved control context; the runner refused to treat that target as an exact match and selected it again from fresh evidence. Android replay made zero model requests. Replay on iOS is therefore **not** model-free. The original evaluation script mistakenly also required zero Jev calls and marked its iOS summary failed. The [written gate](TEST_PLAN.md#native-mobile-alpha-exit-criteria) requires zero **planner** requests, while the [replay behavior](docs/MOBILE.md#reports-replay-limits-and-stop) allows Jev to repair a stale control. The raw script result is preserved; the published aggregate recomputes the written gate from the immutable trials, records `originalStrictEvaluatorPassed: false` and `strictZeroJevReplayDiagnosticPassed: false`, and the script's predicate has been corrected for future runs. The correction changes only evaluation reporting, not any mobile trial or runner behavior.

## Method and other gates

- Five authored cases in [examples/mobile.cases](examples/mobile.cases): invalid login rejection, filtered catalog search, quantity/total, cart removal, and cart persistence after relaunch. The fault run independently seeds invalid-login, wrong-filter, wrong-total, ineffective-removal, and lost-persistence variants. The local control service confirmed that every one of the 60 suites consumed its intended baseline before actions.
- One platform ran at a time: dedicated iOS Simulator with iOS 26.5, then Android Emulator with Android 16. Each run used the same app, cases, limits, `--planner off`, OpenRouter's `typesafe/jev-1.13-20260917`, and pinned `agent-device@0.21.6`. The runner used real native accessibility/actions and independent expectation checks. The 50 replay cases per platform reused only a complete healthy flow, after a fresh baseline reset.
- A separate final-SHA interpretation cohort compiled **40/40** independently authored prose cases faithfully (20 per platform). It made 40 `openai/gpt-4.1-mini` requests via OpenRouter, zero Jev requests, and billed $0.0248056. These planner-only checks are separate from the planner-off 300-case matrix.
- Real SDK checks passed on both platforms: owned-device selection and competing lease, fresh references, Unicode text replacement, readable switch state, safe recording/discard, and cancellation during selection, snapshot, fill, and press/settle. Android's SDK check preceded the final iOS-specific quality-verdict change; Android's full 150-case matrix ran at the final implementation SHA.
- A clean `npm pack` install with the optional SDK ran one healthy PASS (exit 0) and one seeded login FAIL (exit 1) on **each** device. CLI JSON and saved JSON/HTML agreed. A second install with `--omit=optional` compiled an explicit native plan offline and returned exit 2 with missing-SDK guidance from `doctor`. The local workbench rendered Android PASS and FAIL reports with matching JSON verdicts and no page errors. Type checks, the build, and all 53 contract/browser tests passed.

The [10-second video](docs/assets/mobile-demo-10s.mp4) and [real-time recorded segments](docs/assets/mobile-demo-real-time.mp4) show an additional, longer 12-check cart journey on both devices, captured from the same implementation SHA. Full case elapsed time was 54.535 s / $0.000603498 on iOS and 70.640 s / $0.000615846 on Android. Both passed 12/12. The 10-second edit uses **3.47×** iOS and **11.25×** Android playback for the eligible clips; full-run timers jump over private input and relaunch gaps. The 58.93-second companion plays only the shareable segments at 1×. Neither video is a claim that the full tests ran in 10 seconds. The recorded segments start after credential/search entry, and the artifact verifier plus manual frame inspection excluded input/known-secret screens.

To reproduce the controlled matrix after [building and installing the fixture](docs/MOBILE.md#reproduce-the-owned-shopping-fixture), use the opt-in command below. It makes paid calls and needs your own OpenRouter key, booted dedicated devices, and a running local fixture baseline. The exact device IDs, OS versions, source SHA, phases, and first attempts are retained in the linked result data.

```sh
npm run build
node scripts/evaluate-mobile.mjs --live --platform both \
  --ios-device IOS_ID --android-device emulator-5554 \
  --rounds 10 --max-cost 2 --out .jev-e2e/mobile-evaluation
```

Native accessibility is still a boundary: sparse or incomplete trees, ambiguous controls, unexposed switch state, and unsupported custom surfaces produce BLOCKED rather than a guessed PASS. Intermittent host simulator startup/lease trouble occurred while preparing the benchmark; the published 300-case run used healthy isolated devices and includes every first attempt in those registered rounds. No claims are made for hosted devices, physical phones, payments, biometrics, or complex WebViews.
