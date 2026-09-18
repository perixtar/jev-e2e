# Contributing

Use Node 22+, `npm ci`, `npm run build`, and `node dist/cli.js setup`. Run `npm run check` and `npm test` before submitting changes. Tests use scripted provider responses and real Chromium; they make no paid calls and need no API keys.

Keep actions and expectations separate. Never turn a provider error, cancellation, ambiguous observation, unsupported requirement, or unknown mutation outcome into PASS. Do not retry an uncertain mutation or change supplied values to make a failed test pass. Fixture values stay local; prompt content and reports use fixture names.

The optional paid benchmark is `npm run test:live -- --rounds 1 --budget 0.2`. It requires your own OpenRouter key. Results are private under `.jev-e2e/evaluations`; retain every first attempt and compare healthy versus known broken app variants. Full beta checks use ten rounds per mode, 30 interpretation fixtures, and 100 replay trials. Do not advertise benchmark results as guarantees for other sites.

Report a reproducible issue with the package/model versions, a sanitized case, expected versus observed behavior, and a minimal demo. Review artifacts before sharing them: known fixture values are redacted, but unrelated application content may remain. Never commit `.env`, auth state, keys, real credentials, or private run artifacts.

Agent-created pull requests require an independent regression review of the final intended SHA against the latest target branch, following [AGENTS.md](AGENTS.md). Record the reviewed SHA, scope, findings, resolutions, verification, and remaining risks in the PR description. Repeat the review after material fixes and keep material unresolved concerns in a draft PR.
