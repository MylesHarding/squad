import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAblyApiKey, startAblyTrigger } from '../packages/squad-cli/src/cli/commands/watch/ably-trigger.js';
import { loadWatchConfig } from '../packages/squad-cli/src/cli/commands/watch/config.js';

const TEST_ROOT = path.join(os.tmpdir(), `squad-ably-trigger-test-${Date.now()}`);
const SQUAD_DIR = path.join(TEST_ROOT, '.squad');

function writeConfigJson(content: unknown): void {
  mkdirSync(SQUAD_DIR, { recursive: true });
  writeFileSync(path.join(SQUAD_DIR, 'config.json'), JSON.stringify(content));
}

const ORIGINAL_ABLY_API_KEY = process.env['ABLY_API_KEY'];

beforeEach(() => {
  mkdirSync(SQUAD_DIR, { recursive: true });
  delete process.env['ABLY_API_KEY'];
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  if (ORIGINAL_ABLY_API_KEY === undefined) {
    delete process.env['ABLY_API_KEY'];
  } else {
    process.env['ABLY_API_KEY'] = ORIGINAL_ABLY_API_KEY;
  }
});

describe('resolveAblyApiKey', () => {
  it('returns null when ABLY_API_KEY is not set', () => {
    expect(resolveAblyApiKey()).toBeNull();
  });

  it('returns the env var value when set', () => {
    process.env['ABLY_API_KEY'] = 'appid.keyid:secret';
    expect(resolveAblyApiKey()).toBe('appid.keyid:secret');
  });

  it('never reads the key from .squad/config.json — env var only', () => {
    writeConfigJson({ watch: { ablyApiKey: 'should-never-be-read' } });
    expect(resolveAblyApiKey()).toBeNull();
  });
});

describe('startAblyTrigger', () => {
  it('returns null immediately when no ABLY_API_KEY is configured — caller falls back to polling', () => {
    const trigger = startAblyTrigger({
      channel: 'squad-watch',
      onEvent: () => {},
      log: () => {},
      logError: () => {},
    });
    expect(trigger).toBeNull();
  });

  it('never throws on a malformed key — resolves ready=false instead of crashing the caller', async () => {
    process.env['ABLY_API_KEY'] = 'not-a-valid-key-at-all';
    const errors: string[] = [];
    const trigger = startAblyTrigger({
      channel: 'squad-watch',
      onEvent: () => {},
      log: () => {},
      logError: (msg) => errors.push(msg),
    });
    expect(trigger).not.toBeNull();
    const ok = await trigger!.ready;
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    await trigger!.stop();
  });
});

describe('loadWatchConfig ablyChannel resolution', () => {
  it('defaults to "squad-watch" when nothing overrides it', () => {
    const config = loadWatchConfig(TEST_ROOT, {});
    expect(config.ablyChannel).toBe('squad-watch');
  });

  it('reads a repo-configured channel from .squad/config.json', () => {
    writeConfigJson({ watch: { ablyChannel: 'my-repo-progress' } });
    const config = loadWatchConfig(TEST_ROOT, {});
    expect(config.ablyChannel).toBe('my-repo-progress');
  });

  it('CLI override wins over .squad/config.json', () => {
    writeConfigJson({ watch: { ablyChannel: 'from-config-file' } });
    const config = loadWatchConfig(TEST_ROOT, { ablyChannel: 'from-cli-flag' });
    expect(config.ablyChannel).toBe('from-cli-flag');
  });
});
