/**
 * Push-driven triggering for watch mode's round scheduler.
 *
 * Ralph's watch loop defaults to a blind `setInterval` — checking for new work whether or
 * not anything actually changed. When an Ably API key is configured, this subscribes to a
 * realtime channel instead (fed by an installed `squad-ably-relay.yml` workflow reacting to
 * the adopting repo's own issue/PR events — see templates/workflows/squad-ably-relay.yml)
 * and triggers a round the moment something happens, at zero cost when nothing has. This
 * mirrors the same push-over-poll pattern used elsewhere for this reason: a blind timer
 * can't tell "nothing changed" from "time to check anyway," and every empty-queue tick
 * still costs whatever the round itself costs (API calls, rate-limit budget).
 *
 * Never a permanent second layer alongside the interval — when this connects successfully,
 * the caller (see index.ts) does not also start the interval. Polling is the fallback for
 * when push isn't configured or fails, not a safety blanket underneath a working one.
 */

import Ably from 'ably';

export interface AblyTriggerOptions {
  /** Ably channel name to subscribe to. */
  channel: string;
  /** Called once per message — the caller decides whether/how to run a round. */
  onEvent: () => void;
  /** Plain console.log-shaped logger, so callers can route through their own output. */
  log: (message: string) => void;
  logError: (message: string) => void;
}

export interface AblyTrigger {
  /** Resolves once the connection either succeeds or fails — never rejects. */
  ready: Promise<boolean>;
  stop(): Promise<void>;
}

/** Reads the subscribe key from the environment only — never from a committed config file. */
export function resolveAblyApiKey(): string | null {
  return process.env['ABLY_API_KEY'] || null;
}

/**
 * Starts an Ably subscription if a key is configured. Returns null immediately (no
 * connection attempted) when it isn't — the caller's own fallback-to-polling logic decides
 * what happens next, this module has no opinion on that.
 */
export function startAblyTrigger(options: AblyTriggerOptions): AblyTrigger | null {
  const apiKey = resolveAblyApiKey();
  if (!apiKey) return null;

  let client: Ably.Realtime;
  try {
    client = new Ably.Realtime({ key: apiKey, echoMessages: false });
  } catch (err) {
    // A malformed/revoked key throws synchronously here — never let that take down the
    // whole watch process. Report unready; the caller falls back to polling.
    options.logError(`Ably: failed to construct client — ${(err as Error).message}`);
    return { ready: Promise.resolve(false), stop: async () => {} };
  }

  let resolveReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  let settled = false;
  const settle = (ok: boolean) => {
    if (settled) return;
    settled = true;
    resolveReady(ok);
  };

  client.connection.on('connected', () => {
    options.log(`Ably: connected, subscribed to "${options.channel}"`);
    settle(true);
  });
  client.connection.on('failed', (stateChange) => {
    options.logError(`Ably: connection failed — ${stateChange.reason?.message ?? 'unknown error'}`);
    settle(false);
  });

  const channel = client.channels.get(options.channel);
  channel.subscribe(() => {
    options.onEvent();
  });

  return {
    ready,
    stop: async () => {
      client.close();
    },
  };
}
