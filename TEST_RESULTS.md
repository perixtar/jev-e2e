# Implementation validation

September 18, 2026 · `jev-e2e@0.1.0-alpha.1` · local alpha

The CLI, local workbench, demo, fixtures, optional planner, Jev decisions, guarded Playwright execution, cancellation, saved-plan/flow replay, and private JSON/HTML/screenshot reports are implemented. The product remains an alpha for testing on real applications; the following measurements use one controlled demo application.

## Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Type checks, build, focused regression checks | PASS | Strict TypeScript check/build; all 23 Node 22 tests pass, including real Chromium flows |
| Explicit interpretation without a generative planner | PASS | All 30 supported format fixtures parse faithfully; malformed, unsupported, incomplete, or credential-bearing cases block |
| Freeform interpretation | PASS on controlled prompts | 30/30 retained plans preserve manually authored actions in order, literals, fixture bindings, auth setup, and expectations; three phrasings of each of ten journeys |
| Healthy discovery, planner off | PASS | 100/100 PASS; 10/10 for each benchmark case; zero planning requests |
| Observable broken behavior, planner off | PASS | 100/100 FAIL; zero PASS or BLOCKED; 10/10 detections per mutant |
| Healthy discovery, planner on | PASS | 100/100 PASS; 10/10 for each case; fresh interpretation for every trial |
| Observable broken behavior, planner on | PASS | 100/100 FAIL; zero PASS or BLOCKED; 10/10 detections per mutant |
| Saved-flow replay | PASS | 100/100 PASS; every original assertion checked; zero planner or Jev requests |
| UI author/review/run/evidence/save/replay/Stop | PASS | Real-browser workbench integration, live-provider UI run, and manual screenshot inspection |
| Cancellation, limits, and uncertain mutations | PASS in controlled checks | Stop during planner HTTP, Jev HTTP, and browser waits cleans up within 5s; no subsequent actions; unknown mutations dispatched once; deadline and spending limits block |
| Secrets and ownership | PASS in controlled checks | Fake-secret scans cover text, clipped values, URL/control metadata, and escaped plans; masked inputs, private file modes, frontend-key exclusion, server-owned reviewed plans, origin checks, stale/reused-node rejection |
| Responsive UI | PASS for tested layouts | 1440px, 768px, and 390px; reduced motion, labeled controls, keyboard/focus checks, no horizontal overflow |
| Clean packaged installation | PASS | Clean macOS Node 22.20.0 and Linux Node 24.20.0 installs pass CLI/UI checks, zero-model replay, and cancellation during execution and planning |
| Public-site smoke | PASS once | Freeform navigation from `https://playwright.dev/` reaches the required `/docs/intro` path; actual planner/Jev calls, 6.479s reported runner duration |
| Demand validation on users' apps | Not run | Proposed five-developer pilot and repeat-use milestone require actual voluntary participants |

## Benchmark conditions

Ten journeys cover valid/invalid login, create-and-persist, rename, archive, filtering, persistent select and checkbox settings, required-field validation, and asynchronous search. The app is reset before each trial. Each mutant exposes an observable violation while retaining usable controls. Retained first attempts are counted; BLOCKED is never credited as bug detection.

The Jev alias resolves to `typesafe/jev-1.13-20260917`; the optional planner is `openai/gpt-4.1-mini`, through the same OpenRouter key. Decisions use `/api/alpha/decisions`; interpretation uses `/api/v1/chat/completions`. No separate OpenAI credential or silent model fallback is used.

| Healthy execution | Runs | Median | p95 | Model calls |
| --- | --- | --- | --- | --- |
| Jev discovery, planner off | 100 | 1.832s | 2.644s | 220 Jev; zero planner |
| Jev discovery, planner on | 100 | 4.516s | 6.055s | 100 planner; 220 Jev |
| Saved-flow replay | 100 | 0.977s | 1.118s | Zero |
| Handwritten Playwright baseline | 30 | 1.049s | 1.556s | Zero |

Trial timing includes applicable planning, browser/context setup, actions, waits, assertions, artifacts, and cleanup. The handwritten baseline uses the same demo journeys and comparable evidence/cleanup. Discovery is slower than handwritten Playwright on this benchmark; the product's intended benefit is reducing test authoring and flow maintenance. The replay sample is too small and controlled to claim a general speed improvement.

Across both modes, the final repeated protocol completed **200/200 healthy PASS, 200/200 broken FAIL, and 100/100 replay PASS**, with zero false passes or blocks. Every case scored 10/10 in each applicable group. Broken-run median/p95 were 2.966s/4.241s without planning and 5.648s/7.101s with planning. Reported model cost was $0.029485428 for planner-off discovery/replay and $0.161106874 for the planner-on evaluation, including its 30 interpretation checks. These costs exclude earlier development experiments and separate CLI/UI smoke checks.

The full ten-case CLI smoke suite also passed with actual planner/Jev calls. A separate read-only public-site case passed once using one planner and three Jev requests ($0.0029378); this small smoke check does not replace broader application testing. Packed-install checks exercise exit codes 0 (PASS), 1 (FAIL), 2 (BLOCKED), and 130 (canceled during execution or planning), local UI startup/review, and replay without any API key. Ordinary CI and the 23 regression tests make no paid calls.

## Reproduction and retained evidence

```sh
npm ci
npm run build
node dist/cli.js setup
npm run check
npm test

# Opt-in paid evaluations; provide your own funded OpenRouter key.
npm run test:live -- --rounds 10 --mode off --replay --budget 0.15
npm run test:live -- --rounds 10 --mode on --interpretation --budget 0.25
node scripts/baseline.mjs
```

Local private records: `.jev-e2e/tests-final.log`, `.jev-e2e/evaluations/beta-off/evaluation.json`, `.jev-e2e/evaluations/beta-on-authoritative-auth/evaluation.json`, its `contract-review.json`, the Playwright baseline record, public-site smoke evidence, and per-trial reports. Earlier experiments remain retained: they exposed select-label binding, missing save/reload actions, and invented auth setup. Those issues were corrected; the final repeated runs are reported separately rather than replacing the failed attempts.

The paid evaluation uses the core recorded by `.jev-e2e/evaluations/final-core-sha256.txt`. Subsequent narrow changes strengthen numeric parsing, clipped-secret and metadata redaction, explicit input-to-field binding, permissions on overwritten reports, CLI cancellation exit handling, and interpretation-evaluator ordering. These receive focused regression/package verification; the controlled benchmark does not exercise every guard. Source/package fingerprints and installation results are retained separately. The metadata and input-target regressions reproduced real gaps before their fixes and pass afterward, including swapped email/password targets in a negative test.

Pre-publication source/config/test fingerprint: `e7782da3d032d635424d294b615f622d0aabae971fb766c34c976bf2bccbaba7`. The relative file list and hashing method are retained locally in `.jev-e2e/delivery-source-sha256.json`; docs and private artifacts are excluded from that fingerprint. Publication adds repository metadata and generalizes local setup notes; runtime behavior is unchanged. Private package privacy/install records are `.jev-e2e/package-privacy.json`, `.jev-e2e/package-macos-result.json`, and `.jev-e2e/package-linux-result.log`; these are maintainer records, not files included in a fresh checkout.

## Remaining limits

This establishes behavior on one seeded application and supported prompts. It does not establish reliability on arbitrary websites, real-user onboarding success, or demand. Native apps, CAPTCHA, canvas, complex frames, payments, and subjective visual judgments are outside this alpha. Application database reset belongs to the test owner. Known fixture/auth secrets are redacted and inputs masked, but unrelated app content may remain in evidence. Raw Playwright trace export is not implemented.

The paid evaluations respected their configured budgets. This release publishes source; npm distribution and cloud execution are later steps. Agent-created PRs require the independent final-SHA review described in [CONTRIBUTING.md](CONTRIBUTING.md).
