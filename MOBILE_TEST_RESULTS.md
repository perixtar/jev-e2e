# Native mobile validation

Results in this document were measured on September 18, 2026. The final controlled execution matrix and demo artifact are being completed before release.

The tested release target is local iOS Simulator and Android Emulator automation through `agent-device@0.21.6`. The owned fixture is the React Native Jev Shop app under `examples/mobile-app`.

## Completed gates

- 40/40 independently compiled prose cases matched manually authored action contracts (20 per platform). Cost: $0.0239744 through `openai/gpt-4.1-mini` on OpenRouter.
- Both real SDK integrations opened the owned app; observed controls; replaced Unicode text; changed and read switch state; rejected stale references and competing owners; recorded private clips; discarded clips after an input screen; canceled provider, snapshot, fill, press, and settling work; released the owned session within five seconds.
- Android's checked-state supplement retained the SDK device lease and left the tested app usable.
- Existing Chromium tests and the native contract suite pass without paid calls.

The full healthy/fault/replay counts, timing distribution, API cost, exact versions, and reproduction commands will replace this note after the pre-registered matrix finishes.
