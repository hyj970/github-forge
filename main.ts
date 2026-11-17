// Entry point: the wire protocol between this forge and the trial env.
// The env drives the trial; this process only has three jobs: bind a port
// of its own choosing, tell the env that port, and wait until the env says
// the trial is over. Everything the suite scores lives in the app that
// app.ts builds; this file is just the harness handshake, so it stays small
// and does nothing else.

import { createApp } from './app.ts';

// The env's origin, e.g. http://store:8080 inside a trial container.
// No env URL means there is nothing to register with: exit at once.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One HTTP round trip may take this long before it is abandoned and retried.
const CALL_TIMEOUT_MS = 30_000;
// Backoff between retries: start here, double each time, never pass this.
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

/**
 * Tell the env which port this process bound. 200 registers; 409 means a
 * first register already won and is fine to proceed on; 400/405 are contract
 * errors and end the run; anything else is retried, the env may still be
 * starting.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffMs(failures));
  }
}

/** Ask the env whether the trial is over, until it says it is. A missed or failed poll just means not yet. */
async function awaitTrialEnd(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (reply.ok) {
        const state = (await reply.json()) as { done?: unknown };
        if (state.done === true) return;
      }
    } catch {
      // Not answering, or the call timed out: keep polling.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind, announce, wait for the env, then shut down cleanly. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitTrialEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
