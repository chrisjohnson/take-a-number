// take-a-number opencode plugin (opencode 1.18.34, plain JS, zero runtime
// deps). Gates every model call through the take-a-number queue: the
// `chat.headers` hook acquires a dynamic lease and returns the claim headers;
// the admission proxy checks the lease out via the claim token and releases
// it when the forwarded response completes or aborts.
//
// Fail-open everywhere: daemon down, unmapped model, stale map, or a plugin
// fault → no headers → the call proceeds (the proxy still gates). The plugin
// never releases a grant: 1.18.34 has no response hook, so release is
// proxy-owned and the only leak path is bounded by the daemon's grant TTL.

import { TanClient } from '../../client/index.mjs';
import { createGate } from './gate.mjs';

export const id = 'opencode-take-a-number';

export const server = async (input, options = {}) => {
  if (options.enabled === false) return {};
  const instance = typeof options.instance === 'string' && options.instance !== '' ? options.instance : 'opencode';
  const tan = new TanClient({
    sock: typeof options.sock === 'string' && options.sock !== '' ? options.sock : '/run/take-a-number/tan.sock',
    tcp: typeof options.tcp === 'string' && options.tcp !== '' ? options.tcp : '127.0.0.1:4100',
    harness: 'opencode',
    instance,
    capability: 'dynamic',
  });
  await tan.connect();
  const timeoutMs = Number(options.acquireTimeoutMs);
  const { gate } = createGate({
    tan,
    instance,
    queues: Array.isArray(options.queues) ? options.queues : [],
    acquireTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600_000,
  });
  return {
    'chat.headers': async (hookInput, output) => {
      try {
        const headers = await gate({
          model: hookInput?.model?.id,
          sessionID: hookInput?.sessionID,
          agent: hookInput?.agent,
        });
        output.headers = { ...(output.headers ?? {}), ...headers };
      } catch {
        // A plugin fault must never brick a model call: leave headers as-is.
      }
    },
    dispose: () => {
      tan.close();
    },
  };
};

export default { id, server };
