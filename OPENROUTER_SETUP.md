# OpenRouter setup

The alpha uses one OpenRouter key for Jev decisions and optional freeform interpretation. A separate OpenAI key is unnecessary. Provider compatibility was checked on September 18, 2026; see [live provider checks](LIVE_PROVIDER_CHECK.md) and [product results](TEST_RESULTS.md).

## Configure your account

Create your own key at [OpenRouter API keys](https://openrouter.ai/settings/keys) and configure a spending cap appropriate for your usage. Paid inference requires available account credit. Copy the example configuration locally:

```sh
cp .env.example .env
chmod 600 .env
```

Set these values in the git-ignored `.env` or your process environment:

```dotenv
OPENROUTER_API_KEY=
OPENROUTER_JEV_MODEL=typesafe/jev-1.13
JEV_E2E_PLANNER=on
OPENROUTER_PLANNER_MODEL=openai/gpt-4.1-mini
```

The CLI loads `.env` from its working directory. Keys remain in the local server process. Supply test credentials through fixture references; models receive fixture names and redacted observations. Visible app text is sent to OpenRouter, so review the [data flow](README.md#credentials-and-app-state) before testing private applications.

## Supported protocols

- Jev: `POST https://openrouter.ai/api/alpha/decisions`, using named Choice questions with candidate maps. The evaluated alias resolved to `typesafe/jev-1.13-20260917`.
- Optional interpreter: `POST https://openrouter.ai/api/v1/chat/completions`, using strict JSON Schema output. The evaluated default is `openai/gpt-4.1-mini`; other compatible models can be selected with `OPENROUTER_PLANNER_MODEL`.
- Planner off: documented explicit cases and saved specifications make zero generative planning requests. Jev selection still needs a provider key; a complete unchanged saved flow can replay without one.

Both protocols use built-in `fetch`. Direct TypeSafe SDK transport is unimplemented. The Decisions API is alpha; transport checks and the opt-in live benchmark detect compatibility changes. There is no silent model fallback.

Sources: [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [Jev model page](https://openrouter.ai/typesafe/jev-1.13).
