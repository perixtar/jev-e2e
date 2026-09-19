// SDK requests have no AbortSignal. Exiting this owned process closes the RPC
// connection; the daemon cancels that request. Session cleanup uses a new worker.
import { createAgentDeviceClient } from 'agent-device';

let client: ReturnType<typeof createAgentDeviceClient>;
process.on('message', async (message: any) => {
  const { id, config, command, args } = message;
  try {
    client ??= createAgentDeviceClient(config);
    let value: unknown;
    switch (command) {
      case 'devices': value = await client.devices.list(args); break;
      case 'doctor': value = await client.command.doctor(args); break;
      case 'install': value = await client.apps.install(args); break;
      case 'open': value = await client.apps.open(args); break;
      case 'snapshot': value = await client.capture.snapshot(args); break;
      case 'screenshot': value = await client.capture.screenshot(args); break;
      case 'press': value = await client.interactions.press(args); break;
      case 'fill': value = await client.interactions.fill(args); break;
      case 'type': value = await client.interactions.type(args); break;
      case 'scroll': value = await client.interactions.scroll(args); break;
      case 'back': value = await client.command.back(args); break;
      case 'keyboard': value = await client.command.keyboard(args); break;
      case 'record': value = await client.recording.record(args); break;
      case 'close': value = await client.sessions.close(args); break;
      default: throw new Error('Unknown device command.');
    }
    process.send?.({ id, value });
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message : 'Native command failed.' });
  }
});
