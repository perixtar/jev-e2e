# Live provider smoke checks

Checked September 18, 2026. Two minimal inference requests used one OpenRouter key. The CLI, UI, and runner were subsequently implemented. This document preserves the initial transport checks; product regression and benchmark results are in [TEST_RESULTS.md](TEST_RESULTS.md).

| Check | Result | Reported usage/cost | Request duration |
| --- | --- | --- | --- |
| Jev: choose an observed control and return no match for an absent control in one request | HTTP 200; target `e1`, missing target `none`; both answers had type `choice` and matched expectations | 461 input tokens, 79 output tokens; $0.000019362 | 460 ms |
| Optional GPT planner: preserve the supplied name, create/reload actions, exact count, and reload expectation under JSON Schema output | HTTP 200; all four checks passed | 122 prompt tokens, 29 completion tokens; $0.0000952 | 1,905 ms |

Total reported inference cost: **$0.000114562**. Timings cover synthetic API requests, not end-to-end browser tests. These numbers use per-request usage; aggregate provider accounting can update later.

## Jev transport

Use `POST https://openrouter.ai/api/alpha/decisions` with the OpenRouter credential. The request contains `model`, `state`, and named `questions`. Each Choice contains `type: choice`, `instructions`, and a `criteria` map. Consume `answers[questionName].choice` only after validating its type and membership in the supplied candidates.

The observed controls were `e1 = Account settings` and `e2 = Help`. One question asked which control opens account settings; the other asked which opens billing. Both offered `e1`, `e2`, and `none`. The expected and returned answers were `e1` and `none`. The resolved model was `typesafe/jev-1.13-20260917`.

The API is documented as alpha. This check establishes minimal batched Choice transport, not Noul/Score behavior, quality on unfamiliar websites, or compatibility with a changed TypeSafe SDK base URL.

Primary sources: [Decisions HTTP API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md), [official TypeScript SDK example](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md).

## Optional planner

The initial candidate was `openai/gpt-4.1-mini`, verified in the public model catalog before use. A request to `POST https://openrouter.ai/api/v1/chat/completions` used strict `json_schema` output, required parameter support, disabled provider fallback, and bounded output at 350 tokens.

The case was: create a project named Acme, reload, and expect exactly one project named Acme after reload. The parsed output preserved `projectName = Acme`, actions `create_project` then `reload_page`, `expectedProjectCount = 1`, and `requireReload = true`.

No separate OpenAI key was used. This initial probe preceded the 30-prompt interpretation evaluation. The evaluated alpha now defaults to this optional planner; final product results are in [TEST_RESULTS.md](TEST_RESULTS.md).

## Remaining verification

Provider errors, malformed/missing answers, cancellation/deadlines, budgets, guarded execution, assertions, secret redaction, teardown, both input modes, replay, and packaging now have focused checks. Repeated live benchmarks are recorded in [TEST_RESULTS.md](TEST_RESULTS.md), against the gates in [TEST_PLAN.md](TEST_PLAN.md). These initial API probes cannot substitute for product validation.
