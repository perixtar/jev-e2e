# jev-e2e

Test web applications from natural-language cases, with evidence for every verdict.

**Status:** alpha. Includes a CLI, local workbench, demo app, fixtures, saved-flow replay, cancellation, and JSON/HTML/screenshot evidence. Install from source; an npm release is not yet available. See [test results](TEST_RESULTS.md) for measured validation and remaining gates.

The first release runs locally against Chromium websites. An optional generative model interprets freeform cases into semantic steps, input bindings, and expectations. Explicit cases use documented templates without that model; saved plans need no new interpretation. Jev selects observed controls and navigation. Playwright executes the steps and independently checks expectations. The workbench and CLI share the same runner.

Every case returns **PASS**, **FAIL**, or **BLOCKED**. A completed navigation or a confident model response cannot substitute for checked expectations.

The workbench uses a warm light background, orange accents, and spacious typography inspired by Firecrawl, with original jev-e2e branding.

## Quick start from this repository

Requires Node 22+. Install dependencies and Chromium explicitly:

```sh
git clone https://github.com/perixtar/jev-e2e.git
cd jev-e2e
npm ci
npm run build
node dist/cli.js setup
```

Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. A separate OpenAI key is unnecessary. The defaults are `typesafe/jev-1.13` for Decisions and optional `openai/gpt-4.1-mini` for interpretation.

Start the demo and workbench in separate terminals:

```sh
npm run demo
npm run ui
```

Visit the printed workbench URL, normally `http://127.0.0.1:4007`. The demo runs at `http://127.0.0.1:4177`; its command writes demo-only fixtures under `.jev-e2e/demo`. Review the plan, then run it. Choose a fresh project name for repeated create tests: a new browser context does not reset the app's data.

## CLI

```sh
# Read-only public-site example; no auth fixtures needed.
node dist/cli.js run --url https://playwright.dev/ \
  --cases examples/public-site.cases --planner on

node dist/cli.js run --url http://127.0.0.1:4177 \
  --cases examples/simple.cases --planner off \
  --fixtures .jev-e2e/demo/fixtures.json

node dist/cli.js plan --cases examples/simple.cases --planner off \
  --out .jev-e2e/my-plan.json

node dist/cli.js run --url http://127.0.0.1:4177 \
  --plan .jev-e2e/my-plan.json --fixtures .jev-e2e/demo/fixtures.json

# Use the successful run's printed directory for saved-flow replay.
node dist/cli.js run --url http://127.0.0.1:4177 \
  --replay .jev-e2e/runs/RUN_ID/plan.json \
  --fixtures .jev-e2e/demo/fixtures.json
```

Successful replay reuses observed control descriptions and rechecks every assertion. Changed or ambiguous controls require repair by Jev; a complete unchanged flow can replay without a provider key. Failed/blocked flows are not cached as successful flows.

`--planner on` accepts prose, for example:

```text
Case: Create and persist
Auth: @signed-in
Add a new project named "Acme", save it, refresh, and verify it persisted.
Expect: project named "Acme" exists exactly once after reload
```

`--planner off` uses the same expectation with `Goal: Create project named "Acme"`. Supported inferred goals include sign-in with supplied fixtures, create/rename/archive projects, filter/search projects, set a native select, and check/uncheck a checkbox. For other flows, provide `Goal`, `Step`, and `Expect` lines:

```text
Case: Contact submission
Goal: Send the supplied test message
Step: Click "Contact"
Step: Fill "Message" with "Hello from the test account"
Step: Click "Send"
Expect: text "Message sent" is visible
```

Step commands: `Click`, `Fill ... with`, `Select ... with`, `Check`, `Uncheck`, `Reload`, and `Wait for text`, with double-quoted targets and values or `@fixture` input values. They describe control purposes, never selectors or JavaScript. Each suite has 1–10 cases.

Supported expectations:

| Requirement | Example |
| --- | --- |
| Exact visible/absent text | `text "Saved" is visible` / `text "Error" is absent` |
| Exact entity count | `project named "Acme" exists exactly once` / `record "Acme" count is 2` |
| Record-scoped text | `text "Archived" in record "Demo" is visible` |
| Field value / selected label | `field "Theme" is "Dark"` |
| Checkbox state | `checkbox "Enable notifications" is checked` |
| Numeric field | `number in field "Quantity" equals 5` |
| URL pathname | `url is "/projects"` |

Append `after reload` when persistence must be verified. Record checks require semantic list, table, or article markup. Unsupported checks block with a reason. Expectations are checked after all required steps; use separate cases to test intermediate outcomes.

Runs default to a 60-second case deadline, 30 actions, 100 provider requests, and $0.05 model budget. Change these with `--timeout`, `--max-actions`, `--max-requests`, and `--max-cost`. Workbench review and execution have separate budgets; displayed run costs exclude earlier plan-review costs. Estimates reserve capacity before each request; unknown billing outcomes use the reservation instead of claiming zero cost. `--allow-origin` explicitly permits an additional app origin. `--headed` shows execution; `--json` prints a machine-readable result. Ctrl+C stops owned execution.

Exit codes: **0 PASS, 1 FAIL, 2 BLOCKED/configuration error, 130 canceled**. Reports contain expected and observed values, actions, reasons, timings, provider usage and resolved model IDs, masked screenshots, and the saved specification. They are stored privately under `.jev-e2e/runs`.

## Credentials and app state

Use a local fixtures JSON file rather than putting credentials in cases:

```json
{
  "inputs": {
    "valid.email": { "env": "E2E_TEST_EMAIL" },
    "valid.password": { "env": "E2E_TEST_PASSWORD" }
  },
  "auth": {
    "signed-in": { "storageState": "../.auth/user.json" }
  }
}
```

Refer to these as `Input: Email = @valid.email`, `Input: Password = @valid.password`, or `Auth: @signed-in`. Auth paths resolve relative to the fixtures file. Each case gets a fresh Playwright context; app database reset remains the test owner's responsibility.

Keys stay in the server process. Known fixture/auth values are redacted from model observations and reports; input fields are masked in screenshots. Visible application text is sent to OpenRouter for decisions, and unrelated application content can remain in reports. Inspect evidence before sharing it. Raw trace recording is not implemented.

## Development and scope

```sh
npm run check
npm test

# Opt-in paid checks; ordinary tests make no paid calls.
npm run test:live -- --rounds 1 --budget 0.2
```

The alpha targets common Chromium forms, buttons, links, native selects, checkboxes, authenticated fixtures, and async results. Native desktop/mobile apps, CAPTCHA, canvas, complex frames, payment-provider workflows, and subjective visual judgments are outside this release. The controlled demo benchmark does not establish reliability across arbitrary sites. Hosted infrastructure is a later stage.

See [contributing](CONTRIBUTING.md) for checks, benchmark protocol, and PR review requirements.

- [Technical plan](TECHNICAL_PLAN.md): architecture, model responsibilities, scope, and implementation sequence.
- [Test plan](TEST_PLAN.md): release gates, benchmark cases, and verification protocol.
- [UI design](UI_DESIGN.md): layout, palette, screen states, and accessibility.
- [Research](RESEARCH.md): Jev's capabilities and the inspected open-source implementations.
- [Live provider checks](LIVE_PROVIDER_CHECK.md): the actual Decisions and planner protocols through OpenRouter.

`.env.example` documents current configuration. Change the optional planner vendor/model with `OPENROUTER_PLANNER_MODEL`; it must support strict JSON schema. There is no silent model fallback.

Jev uses `POST /api/alpha/decisions`; the optional planner uses `POST /api/v1/chat/completions`. Both use standard `fetch` and one OpenRouter key. Direct TypeSafe transport is a research fallback and is not implemented. See [OpenRouter setup](OPENROUTER_SETUP.md).

MIT licensed. No telemetry or hosted infrastructure is required.
