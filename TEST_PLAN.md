# Test plan and exit criteria

Updated September 18, 2026. These remain the gates for the local open-source product. The alpha runner, CLI, UI, demo, and provider transports are implemented. Focused checks and repeated paid benchmarks are recorded separately in [TEST_RESULTS.md](TEST_RESULTS.md). Original provider smoke checks remain in [LIVE_PROVIDER_CHECK.md](LIVE_PROVIDER_CHECK.md). Gates must be assessed from recorded results, not inferred from implementation status.

## Scope and verdict contract

Test ordinary Chromium websites plus accessible local apps on an iOS Simulator or Android Emulator. Browser coverage includes forms, buttons, links, checkboxes, native selects, authenticated fixtures, and asynchronous rendering. Native coverage includes exact accessible taps, fills, switches, scrolling, back, keyboard dismissal, relaunch/persistence, local recording, and checked milestones. Physical phones, hosted devices, native desktop apps, CAPTCHA, payment-provider flows, biometrics, arbitrary canvas/visual judgments, complex WebViews, and complex cross-origin frames remain outside this release. Unsupported requirements must receive a useful BLOCKED reason.

PASS requires every required milestone and assertion to be checked and satisfied on fresh evidence. FAIL requires observed behavior that contradicts a required expectation. BLOCKED records an inability to execute or verify, including missing data, ambiguity, provider errors, limits, and cancellation. Never treat a model's DONE or confidence as a test verdict. A canceled suite remains non-passing even if its already completed cases passed.

The general model is optional. Free-form cases use a configured interpreter through OpenRouter; OpenAI is an optional vendor and a separate OpenAI API key is not required. Planner-off cases use documented goal/input/expectation templates. Saved specifications bypass interpretation. Jev calls still require the selected provider credential; planner-off does not mean offline or model-free execution.

## Delivery gates

| Milestone | Exit criterion | Evidence |
| --- | --- | --- |
| Integration proof | Verify the actual Jev Choice protocol and an optional schema-constrained planner request. Establish valid/no-match answers, response mapping, model/usage, provider errors, abort, and deadline behavior | Exact sanitized request/response fixtures and focused transport checks; use direct TypeSafe only if OpenRouter cannot carry the protocol |
| Working vertical slice | One explicit case and its free-form equivalent produce the same required values and expectations, then pass on the healthy app and fail on an observable broken outcome | Real Jev calls, real browser actions, checked assertions, and visible evidence; zero generative requests in planner-off mode |
| Usable alpha | UI and CLI run 3–10 cases, support fixtures and Stop, save/rerun plans, and produce JSON/HTML evidence. Contract/browser checks pass; all ten benchmark cases pass once on healthy state and correctly fail once on a known mutant through each entry mode | Packed installation, recorded first attempts, no false passes, and documented scope/limits; ready for an explicitly labeled alpha pilot |
| Validated beta | Meet every engineering gate in the table below; publish the benchmark conditions and results | Repeated live trials, clean installs, and completed focused checks |
| Hosted-product decision | Assess the demand milestone below and resolve disputed verdicts before investing in cloud infrastructure | Voluntary pilot feedback and evidence of repeat use; this is a business decision, not a software-correctness gate |

## Beta exit criteria

| Gate | Exit criterion | How verified |
| --- | --- | --- |
| Complete product flow | In the local UI, enter a URL and 3–10 cases, inspect validated expectations, run, stop, inspect evidence, save, and rerun without handwritten selectors or test code. The CLI uses the same runner and verdicts | Full browser/UI flow and installed CLI smoke test |
| Optional planner | All 30 supported explicit-format fixtures parse faithfully; unsupported/missing requirements block before mutations. Explicit cases and saved specifications work without OpenAI credentials or a planner model and make zero generative planning requests | Offline format/contract cases, request counters, and live planner-off runs |
| Free-form interpretation | At least 29/30 manually reviewed supported prompts are fully faithful. All plans accepted for execution preserve exact literals, fixtures, negative intent, and required expectations. Missing or contradictory requirements are surfaced | Separate live interpretation evaluation with a manually authored expected contract and invalid/ambiguous examples |
| Healthy runs | Per entry mode: ten benchmark cases, ten independent discovery runs each; at least 95/100 PASS and at least 9/10 per case. Retain every first attempt | Reset app state before each trial; evaluate planner-on and planner-off separately, 200 trials total |
| Broken runs | Per entry mode: ten observable mutants, ten runs each; zero PASS and at least 95/100 correct FAIL. BLOCKED is not successful bug detection | Ground truth from seeded fault switches, 200 trials total; report every failure/block |
| Replay | Ten runs per verified case, fresh app state each time: at least 95/100 PASS. Every original assertion runs; repairs preserve intent/data/expectations; zero generative planning calls | 100 saved-flow trials and assertion/request counters; retain first failure if a retry passes |
| Runner correctness | All focused contracts, real-browser integration checks, type checks, and build checks pass, including invalid decisions, stale targets, delayed pages, and unknown mutation outcomes | Scripted model responses plus real Chromium; ordinary CI makes no paid calls |
| Speed | For healthy cases with at most ten UI actions, discovery median at most 30s and p95 at most 90s in each mode, including applicable planning, setup, waits, assertions, and artifacts | Record full trial timing; publish replay separately and compare with conventional Playwright on the same flows |
| Evidence | Every case records intent, required expectations, checked observations, verdict/reason, actions, timing, and model/schema versions. Failed checks show expected versus observed. UI, JSON, and HTML agree | Report contract checks and manual inspection of passing, failed, blocked, and canceled runs |
| Secrets and lifecycle | Keys/fixture secrets are absent from frontend storage, model state, and shareable reports. Stop prevents further dispatch and releases owned resources within 5s in controlled tests; an unknown mutation is never automatically repeated | Fake-secret scans and cancellation during planning, Jev calls, and browser waits; inspect resource teardown |
| UI and installation | Keyboard/focus/contrast pass; usable at 1440px, 768px, and 390px. Clean Node 22+ macOS/Linux installations run UI and CLI via the documented setup | Responsive UI verification and packed-package installation smoke tests |
| Configuration and limits | Planner-off needs no generative configuration. Invalid/missing selected-provider configuration is actionable; request/action/deadline/spending limits remain non-passing rather than silently changing models or expectations | Configuration, error, and limit tests; retain provider usage and obey the project key cap during evaluation |

## Native mobile alpha exit criteria

These gates apply independently to iOS Simulator and Android Emulator unless a row says otherwise. Every paid run is first-attempt evidence; BLOCKED does not count as a detected fault.

| Gate | Exit criterion | How verified |
| --- | --- | --- |
| SDK contract and ownership | The real pinned SDK can open, observe, fill, tap, check, record, and close the owned fixture. Stale references reject before dispatch; ambiguous/physical-device selection blocks; a competing lease cannot disturb the owner | Live SDK gate on the exact project-owned simulator/emulator, including Unicode replacement and idempotent switch state |
| Natural-language fidelity | At least 19/20 independently authored prose cases compile faithfully on each platform, preserving action order, exact literals, fixtures, and expectations | Fresh one-case-per-request paid cohort; retain all outputs and provider usage |
| Healthy discovery | Five representative flows × 10 first attempts produce at least 48/50 PASS per platform and at least 9/10 for every flow | Reset the owned fixture baseline before each run; use the same cases, limits, and evaluation rules |
| Fault detection | Five observable faults × 10 first attempts produce zero PASS and at least 48/50 correct FAIL per platform | Seed one known contradiction at a time; a BLOCKED result is reported separately and does not count as detection |
| Saved replay | 50 first-attempt replays per platform produce at least 48/50 PASS and make zero planner requests | Freeze only a complete healthy discovery flow, restore the same baseline, and re-run every authored assertion |
| Evidence agreement | CLI exit status, JSON, HTML, and workbench show the same PASS/FAIL/BLOCKED verdict and expected-versus-observed checks | Inspect representative pass, fault, block, cancellation, recording, and replay results |
| Stop and release | Stop prevents any later action dispatch. Cancellation during provider selection, snapshot, fill, press/settle, and metadata releases the owned session within five seconds; unrelated sessions remain untouched | Live cancellation/reopen gates plus exact-device inventory before and after |
| Privacy and artifacts | Keys and fixture values are absent from frontend/model/shareable output. Recording is opt-in/local, starts after credentials, and is discarded when any later or final screen contains an input/known secret or cannot be verified | Fake-secret scans, malformed-recorder tests, final-screen checks, file permissions, and manual clip inspection |
| Limits, cost, and speed | Request/action/deadline/cost limits stay non-passing. For healthy flows with at most ten authored actions, warm discovery median is at most 60 seconds per platform | Publish full-run timing phases, request counts, billed provider cost, cold setup separately, and every first attempt |
| Distribution and demonstration | Type/build/browser regressions pass; packed installs work with and without the optional SDK as documented; native smoke runs use the installed package. README includes a checked uncut native run and a roughly ten-second edit with a large readable phone view | Clean temporary installs, real browser/workbench flow, native CLI smoke, decoded video/frame QA, and independent final-SHA review |

Zero false passes on this controlled benchmark is a release gate, not a guarantee for all websites. If a gate fails, keep the product labeled as a development preview and publish the limitation rather than implying the release is validated. Do not drop difficult benchmark cases to improve the score.

## Owned benchmark app

Use one small local app with login, project management, settings, and deterministic fault switches. Expected behavior is manually specified from the case contract. Evaluators may inspect fixture APIs/storage to establish ground truth; the agent must use the public UI for actions and normal assertions unless a case explicitly requests an API check.

| Case | Required healthy evidence | Deliberate broken variant |
| --- | --- | --- |
| Valid login | Authenticated page/session appears | Submit shows an error and session remains unauthenticated |
| Invalid password | Credentials error and unauthenticated session | Incorrectly creates an authenticated session |
| Create project and reload | Exactly one named project persists | Reports success but loses the saved project after reload |
| Rename project | New name survives reload; old identity's name changes | Displays/persists the old name |
| Archive project | The chosen project's status becomes Archived | Its visible status remains Active |
| Filter archived projects | Every displayed project is archived | Includes a known active project |
| Select a setting and reload | Exact selected value persists | Reverts to the previous value |
| Toggle a setting and reload | Exact checkbox state persists | Reverts the checkbox after reload |
| Required-field validation | Relevant error appears; record is not created | Creates a record despite the invalid field |
| Async project search | Expected project appears after loading; irrelevant entries are absent | Returns an observable incorrect result set |

Use seeded credentials and unique project names per run. Reset database state before every trial and check cleanup independently. A new browser context alone does not reset the app. Broken variants retain usable controls and present observable violations so a correct FAIL is distinguishable from a navigation block. Each case has a manually reviewed free-form version and an equivalent explicit-format version. Filter/search cases require known expected identities/counts so an empty list cannot pass a vacuous "all results match" assertion.

## Verification layers

**Offline contracts:** use scripted transport responses to check planning refusals/incomplete output, both input paths, cached-plan invalidation, supported schemas, fixture preservation, zero mutations on invalid plans, incompatible action/target answers, stale observations, missing candidates, all-assertions-required aggregation, CI exit status, and escaped report content. An expected failure cannot be repaired into success by changing its input. Planner-off runs must not invoke the planner at all, and malformed explicit cases must not silently become free-form requests.

**Real-browser integration:** operate the local app with scripted decisions. Check fill/select/check/click/reload, fresh contexts, replaced or covered controls, delayed content, save failures, and a lost response after a mutation. Never submit a mutation again merely because its outcome is unknown. Check that page instructions cannot change the case contract, and that unauthorized navigation/secret entry outside configured app origins is blocked by the executor. Stop during planning, a Jev request, and a browser wait; assert no later dispatch and resource cleanup. Check double-start and UI reconnection without duplicate execution.

**UI verification:** exercise the full author-to-report flow, missing configuration, provider errors, stopping, failed and blocked evidence, saved-suite rerun, responsive widths, keyboard use, focus, and reduced motion. Scan bundles, captured logs, model inputs, and shareable outputs for fake API keys and fake fixture secrets. Raw opt-in traces are private and may contain application data; do not present them as redacted exports.

**Live evaluation:** use actual Jev calls and optional planner calls in a separate opt-in maintainer command with an explicit budget. Review the 30-prompt interpretation set first, then run the healthy, broken, and replay protocol. Pin/record model versions and provider endpoints; do not silently substitute another model. For planner-on discovery trials, compile the case freshly and include that time; planner-off trials parse locally. Do not reuse cached plans when measuring full free-form discovery latency. Replay reuses the specification and is measured separately. Unexpected blocks need investigation; they must not be hidden or counted as detected bugs. Routine CI uses scripted responses and makes no paid model calls. Reaching the spending cap stops evaluation; unfinished gates stay unverified until authorized capacity is available.

**Package verification:** run type checks, focused tests, real-browser checks, and the build. Pack the package, install it into a clean temporary project, install Chromium through documented setup, and run the UI and CLI demo. Missing/invalid keys and unavailable browsers must produce actionable errors. Verify PASS exits successfully and FAIL, BLOCKED, provider error, and cancellation do not.

## Benchmark record and demand validation

For each trial retain app seed/fault, case/plan version, package SHA, model IDs, status, assertions, first-attempt result, provider usage, request counts, phase durations, total duration, and private artifact references. Report interpretation accuracy, healthy PASS rate, broken FAIL rate, false passes, BLOCKED rate, per-case counts, and discovery/replay median/p95. Compare repeat execution with a conventional Playwright baseline on the same cases. Do not claim a speed improvement before measuring it.

After the usable-alpha gate passes, recruit five developers to test three cases on their own apps while the repeated beta evaluation proceeds. Proposed demand milestone: at least four reach a meaningful result within 10 minutes after dependencies/downloads are ready, at least three voluntarily rerun within a week, and every disputed verdict is reviewed against evidence. Also ask which cases they wanted, what setup blocked them, and whether hosted execution would remove a recurring obstacle. Gather this through voluntary feedback; no telemetry service is required. This informs investment in the hosted product and is separate from software correctness. Full beta gates are still required before advertising validated beta results.

Before any PR is presented as ready, obtain the independent regression review required by the workspace instructions. Review the final intended SHA against the latest target branch, resolve findings, repeat after material fixes, and record the scope, verification, and remaining risks. No PR has been created during this implementation.
