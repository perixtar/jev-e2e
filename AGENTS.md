# Engineering conventions

Inspect the existing code, contracts, callers, and nearby implementations before proposing changes. Prefer the smallest change that fully solves the problem. Reuse the current design and dependencies; explain why an existing approach is insufficient before adding abstractions or infrastructure.

Keep model decisions separate from test verdicts. Preserve authored literals, fixture bindings, required actions, and assertions. Missing evidence, ambiguity, cancellation, limits, or uncertain mutations cannot produce PASS. Never automatically repeat an uncertain mutation.

Run relevant focused checks, type checks, builds, and real-browser verification. Ordinary tests must make no paid provider calls. Do not commit keys, local auth state, credentials, or private artifacts.

# Agent-created pull requests

Every agent-created PR requires a full independent regression review by a separate reviewer or subagent that did not implement the change. Review the final intended PR SHA against the latest target branch, including the complete diff, related callers and consumers, contracts, state transitions, concurrency and cancellation, authentication, privacy, failure paths, and affected user flows.

Run relevant focused tests, static checks, builds, and real end-to-end verification when applicable. Resolve findings and repeat independent review after material fixes. Record the reviewed SHA, scope, findings, resolutions, verification, and remaining risks in the PR description. Keep the PR as a draft if a material concern remains.
