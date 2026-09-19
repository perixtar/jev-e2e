<div align="center">

# jev-e2e

**Test websites and native apps in plain English. Get evidence for every result.**

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](TEST_RESULTS.md)
[![Node: 22.12+](https://img.shields.io/badge/node-22.12%2B-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [Native mobile](docs/MOBILE.md) · [Write a test](#write-a-test) · [Benchmarks](#live-ebay-benchmark) · [CLI reference](docs/USAGE.md) · [Contribute](CONTRIBUTING.md)

</div>

Describe a flow and what should be true. jev-e2e turns it into a test plan, uses Jev to select accessible controls, and runs it with Playwright or a local simulator/emulator. Each result is **PASS**, **FAIL**, or **BLOCKED**, with an HTML report, JSON, and privacy-aware evidence.

**Local alpha:** CLI and workbench for Chromium websites, iOS Simulator, and Android Emulator. Install from source; an npm release is not yet available.

## Watch the eBay comparison

Search and filter products → add two items → change quantity → remove an item → refresh and verify the cart. Three models, the same written steps, and 31 independent checks. The video shows actual browser recordings at **10.77× playback**.

https://github.com/user-attachments/assets/3f6eea28-9f85-4d9c-9a76-ba90311ff673

[Download the 10-second video](docs/assets/ebay-benchmark.mp4) · [All nine attempts and methodology](docs/benchmarks/ebay-2026-09-18.md)

This is a UI execution experiment with a shared human-authored plan and an extended benchmark observer. It does not measure natural-language planning or the unmodified CLI's reliability on eBay.

## Why jev-e2e?

- **Write cases in plain English.** Use an optional planner for prose, or explicit `Goal`, `Step`, and `Expect` templates without it.
- **Check the outcome.** Playwright verifies expectations independently. Missing evidence or unsupported requirements produce BLOCKED.
- **See what happened.** Reports include expected and observed values, actions, timing, provider usage, and screenshots.
- **Replay successful flows.** Reuse saved controls and recheck assertions. An unchanged flow can replay with zero model calls; stale targets require Jev to repair them.
- **Run locally with limits.** Use your own OpenRouter key, authentication fixtures, request limits, deadlines, and cost budget. Stop execution from the workbench or with Ctrl+C.

## Quick start

Requires **Node.js 22.12+** and one **OpenRouter API key**.

### 1. Install from source

```sh
git clone https://github.com/perixtar/jev-e2e.git
cd jev-e2e
npm ci
npm run build
node dist/cli.js setup
cp .env.example .env
```

### 2. Add your key

Set this in your local `.env` file:

```dotenv
OPENROUTER_API_KEY=your_key_here
```

The defaults are `typesafe/jev-1.13` for control selection and optional `openai/gpt-4.1-mini` for interpreting prose. Both use the same OpenRouter key; a separate OpenAI key is unnecessary. Set `--planner off` to use explicit case templates. There is no silent model fallback.

### 3. Run a website test

```sh
node dist/cli.js run --url https://playwright.dev/ \
  --cases examples/public-site.cases --planner on --headed
```

This read-only example opens the getting-started guide and checks its URL. Discovery and prose interpretation make paid model calls. Runs default to a **$0.05 model budget** and a **60-second deadline per case**; see the [limits and exit codes](docs/USAGE.md).

### 4. Try the workbench

Start these in separate terminals:

```sh
npm run demo
```

```sh
npm run ui
```

Open the printed workbench URL, normally **http://127.0.0.1:4007**. Point it at the demo on **http://127.0.0.1:4177**, review a plan, run it, and inspect the evidence. The demo command creates demo-only fixtures under `.jev-e2e/demo`. Use a fresh project name for repeated create tests; a fresh browser context does not reset application data.

### 5. Test a native app

    node dist/cli.js doctor --platform ios
    node dist/cli.js devices --platform ios
    node dist/cli.js run --platform ios --device EXACT_ID \
      --app com.example.app --cases mobile.cases --fixtures fixtures.json

Native tests use the same case, review, replay, and report flow. The first release supports local iOS Simulator and Android Emulator targets with accessible native or React Native controls. See the [native setup and case reference](docs/MOBILE.md).

## Write a test

Save a case in a `.cases` file. With `--planner on`, describe the flow and give a concrete expectation:

```text
Case: Create and persist a project
Auth: @signed-in
Add a new project named "Acme", save it, refresh, and verify it persisted.
Expect: project named "Acme" exists exactly once after reload
```

`Auth: @signed-in` references your own [local authentication fixture](docs/USAGE.md#credentials-and-app-state). For the included demo, run this explicit template without the prose planner:

```sh
node dist/cli.js run --url http://127.0.0.1:4177 \
  --cases examples/simple.cases --planner off \
  --fixtures .jev-e2e/demo/fixtures.json --headed
```

The [case reference](docs/USAGE.md) covers supported steps, expectations, fixtures, saved plans, and replay. Expectations are checked after the required steps; use separate cases for intermediate outcomes.

## Live eBay benchmark

Measured **September 18, 2026**, through OpenRouter. We retained three attempts per model, rotated model order, and used fresh guest browser contexts. No retries, substituted models, or discarded failures.

| Model | Completed-case median | API cost / completed case, median | PASS / attempts | Correct UI choices |
| --- | ---: | ---: | ---: | ---: |
| Jev 1.13 | 47.46 s | $0.006678 | 1/3 | 30/31 |
| GPT-5.6 Luna | 61.99 s | $0.027704 | 2/3 | 32/32 |
| Claude Sonnet 5 | 78.62 s | $0.406216 | 1/3 | 19/19 |

**Jev was faster and cheaper among completed cases, and it missed one quantity-field choice on another attempt.** Three attempts were blocked by eBay availability, and one by a detached-frame bug in the benchmark observer. The verifier stopped the incorrect choice before executing it. Completed-case sample sizes are **1 / 2 / 1**; these small, unequal samples do not establish a general accuracy ranking. Site and runner blocks are separate from model mistakes.

The video uses the first registered round for all three models, selected before the batch. Timers and costs follow actual measurement events. Its final scorecard shows all three attempts per model. [Read the protocol and every outcome](docs/benchmarks/ebay-2026-09-18.md) or inspect the [public result data](docs/benchmarks/ebay-2026-09-18.json).

For product validation, see the separate [controlled-demo test results](TEST_RESULTS.md), including healthy, known-broken, and saved-flow replay runs. Those checks do not prove reliability on arbitrary websites.

## How it works

| Component | Responsibility |
| --- | --- |
| Optional prose planner | Converts your case into semantic steps, input bindings, and explicit expectations. Saved plans need no new interpretation. |
| Jev | Selects from observed controls and navigation choices using OpenRouter's native Decisions API. |
| Playwright / agent-device | Executes browser or local native actions. |
| Evidence checker | Verifies authored browser or accessibility expectations independently of Jev's choice. |
| CLI + local workbench | Share the runner, budgets, cancellation, saved plans, and evidence reports. |

Jev uses `POST /api/alpha/decisions`; the optional planner uses `POST /api/v1/chat/completions`. Both use standard `fetch`. Direct TypeSafe transport is not implemented. [Provider setup](OPENROUTER_SETUP.md) · [Technical plan](TECHNICAL_PLAN.md)

## Scope and privacy

The alpha supports common Chromium flows plus accessible local iOS and Android apps. Physical phones, hosted devices, native desktop apps, CAPTCHA, arbitrary canvas controls, complex WebViews/frames, payment-provider flows, biometrics, and subjective visual judgments remain outside this release. Hosted infrastructure is a later stage.

API keys stay in the server process. Known fixture/auth values are redacted from observations and reports; input screens are omitted from screenshots. Visible application text is sent to OpenRouter, and unrelated app or page content can remain in reports. Native recording is explicit, local, and starts after credential-entry steps. If a later screen exposes an input or known secret, the whole report clip is discarded. Inspect evidence before sharing it. Reports and recordings stay under your local `.jev-e2e/runs`; nothing uploads automatically. No telemetry is required.

## Help shape the project

Try a flow on your website and [open an issue](https://github.com/perixtar/jev-e2e/issues/new) with a sanitized case, expected outcome, and what happened. Unsupported flows and reproducible failures are useful contributions. If the project helps you, give it a star.

```sh
npm run check
npm test
```

Ordinary tests use scripted provider responses and real Chromium, with no paid calls. The [contributing guide](CONTRIBUTING.md) covers development, opt-in paid checks, and review requirements.

[Test plan](TEST_PLAN.md) · [UI design](UI_DESIGN.md) · [Research](RESEARCH.md) · [Live provider checks](LIVE_PROVIDER_CHECK.md) · [MIT license](LICENSE)
