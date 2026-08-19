/**
 * `--once` config resolution tests (issue #611) — `loadWatchConfig`'s priority order
 * (default < .squad/config.json < CLI override), mirroring the existing
 * `loadWatchConfig ablyChannel resolution` tests in watch-ably-trigger.test.ts.
 *
 * Does NOT test the full `runWatch()` early-return behavior (requires gh CLI + network,
 * same constraint documented in test/cli/watch.test.ts) — verified live instead: a real
 * `squad watch --once` run against an isolated .squad/ copy completed one round and exited
 * cleanly (process exit 0, no polling/Ably setup entered) rather than blocking forever.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadWatchConfig } from '../packages/squad-cli/src/cli/commands/watch/config.js';

const TEST_ROOT = path.join(os.tmpdir(), `squad-once-test-${Date.now()}`);
const SQUAD_DIR = path.join(TEST_ROOT, '.squad');

function writeConfigJson(content: unknown): void {
  mkdirSync(SQUAD_DIR, { recursive: true });
  writeFileSync(path.join(SQUAD_DIR, 'config.json'), JSON.stringify(content));
}

describe('loadWatchConfig once resolution', () => {
  it('defaults to false', () => {
    const config = loadWatchConfig(TEST_ROOT, {});
    expect(config.once).toBe(false);
  });

  it('reads once:true from .squad/config.json', () => {
    writeConfigJson({ watch: { once: true } });
    const config = loadWatchConfig(TEST_ROOT, {});
    expect(config.once).toBe(true);
  });

  it('CLI override wins over .squad/config.json', () => {
    writeConfigJson({ watch: { once: false } });
    const config = loadWatchConfig(TEST_ROOT, { once: true });
    expect(config.once).toBe(true);
  });

  it('is not swallowed into the free-form capabilities bag', () => {
    writeConfigJson({ watch: { once: true, scribe: true } });
    const config = loadWatchConfig(TEST_ROOT, {});
    expect(config.capabilities['once']).toBeUndefined();
    expect(config.capabilities['scribe']).toBe(true);
  });
});
