# UI direction

Prepared September 18, 2026. This design brief guided the implemented local workbench; see [README.md](README.md) to run it and [TEST_RESULTS.md](TEST_RESULTS.md) for UI validation.

Reference inspected in a browser: [Firecrawl's homepage](https://www.firecrawl.dev/). Its visual direction combines a near-white canvas, orange accents, dark large headings, fine geometric grid lines, rounded controls, and occasional monospace labels. The palette below is a proposed jev-e2e interpretation, not a claim about Firecrawl's exact CSS tokens.

## Theme

| Token | Proposed value | Use |
| --- | --- | --- |
| Canvas | `#FAFAF9` | Page background |
| Surface | `#FFFFFF` | Inputs and workspace panels |
| Text | `#202020` | Headings and primary text |
| Secondary text | `#626262` | Supporting text |
| Border/grid | `#E8E8E5` | Panel outlines and subtle geometry |
| Accent | `#F5650B` | Selected states, decorative emphasis |
| Primary button | `#C94700` with white text | Run action; darker orange for contrast |
| Pass | `#166534` | Checked, satisfied expectations |
| Fail | `#B91C1C` | Observed violations |
| Blocked | `#92400E` | Incomplete or unsupported cases |

Use the system sans-serif stack for body text and headings and a system monospace stack for URLs, timing, and step numbers. Keep ordinary body text at least 16px. Use generous spacing, fine borders, and modest corner radii. Keep the grid decorative and faint around the workspace rather than behind dense text. Use original jev-e2e identity, icons, illustrations, and copy.

## Main workspace

The first screen should say **“Describe your tests. See what passed.”** and make the next action clear.

1. **Cases:** target URL, a multiline editor, examples for free-form and explicit cases, and Run tests. Before execution, show validated steps and expectations so users can catch a mismatch. An advanced option disables interpretation and explains the supported explicit format. Missing fixtures or ambiguous expectations point to the relevant case.
2. **Execution:** case status, current step, elapsed time, a recent masked screenshot, and Stop. Show useful actions in plain language rather than model payloads. The headed-browser option lets users watch the actual website.
3. **Evidence:** case verdicts, each required expectation, expected versus observed result, and the relevant screenshot/action history. A failing assertion should be visible without opening a raw log. Advanced private diagnostics are a separate opt-in.

Use a two-column desktop workspace with case input on the left and execution on the right; results expand below. At narrow widths, stack cases, execution, and evidence. No pricing page, account signup, or cloud dashboard is needed for the local release.

## States and interaction

Implement empty, planning, ready, running, stopping, completed, and configuration/provider error states. A case also retains PASS, FAIL, or BLOCKED. Cancellation is recorded as BLOCKED with a cancellation reason. A stopped run preserves completed cases and partial evidence.

Run is disabled while a suite is active. Stop becomes available during planning and browser execution. Reconnecting the UI shows the current run without submitting it again. Changing input marks an existing compiled plan as stale. Save a suite locally so the user can repeat it without retyping.

Credential settings show whether the local process has the selected Jev credential and, when enabled, a configured interpreter model. They must not expose key values. A missing interpreter configuration offers instructions for setup or explicit cases; it does not prevent supported planner-off cases. Keep provider details out of the main testing flow except when configuration or an outage requires action.

## UI acceptance

Review at 1440px, 768px, and 390px widths with empty, running, failed, and blocked cases. No page-level horizontal overflow. URL, editor, Run, Stop, and result details must work with a keyboard and have visible focus and labels. Text/button contrast must meet WCAG AA; status must use text and icons as well as color. Respect reduced motion and announce progress without repeatedly moving focus. Display page/model strings as text, not trusted HTML.
