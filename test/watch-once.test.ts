/**
 * `--once` config resolution tests (issue #611) — `loadWatchConfig`'s priority order
 * (default < .squad/config.json < CLI override), mirroring the existing
 * `loadWatchConfig ablyChannel resolution` tests in watch-ably-trigger.test.ts.
 *
 * Does NOT test the full `runWatch()` early-return behavior (requires gh CLI + network,
 * same constraint documented in test/cli/watch.test.ts) — verified live instead: a real
 * `squad watch --once` run against an isolated .squad/ copy completed one round and exited
 * cleanly (process exit 0, no polling/Ably setup entered) rather than blocking forever.
 *
 * Also covers `saveWatchSummary()`'s serialization contract (a private, non-exported
 * function in index.ts, same "re-declare the shape and test it" convention as
 * watch-circuit-breaker.test.ts uses for saveCBState/loadCBState) — the JSON file a
 * `--once` caller reads back to learn what each housekeeping capability (scribe, rai)
 * actually did this round, since runPhase() itself only logs a summary on failure.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadWatchConfig } from '../packages/squad-cli/src/cli/commands/watch/config.js';

interface CapabilityResult {
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
}

function saveWatchSummary(squadDir: string, results: Map<string, CapabilityResult>): void {
  const summary: Record<string, { success: boolean; summary: string }> = {};
  for (const [name, result] of results) {
    summary[name] = { success: result.success, summary: result.summary };
  }
  writeFileSync(path.join(squadDir, '.last-watch-summary.json'), JSON.stringify(summary, null, 2));
}

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

describe('saveWatchSummary serialization contract', () => {
  it('serializes each capability result to a plain success/summary object', () => {
    const results = new Map<string, CapabilityResult>([
      ['scribe', { success: true, summary: 'scribe: merged pending decisions' }],
      ['rai', { success: true, summary: 'rai: audit completed and verdict recorded' }],
    ]);

    mkdirSync(SQUAD_DIR, { recursive: true });
    saveWatchSummary(SQUAD_DIR, results);

    const written = JSON.parse(readFileSync(path.join(SQUAD_DIR, '.last-watch-summary.json'), 'utf8'));
    expect(written).toEqual({
      scribe: { success: true, summary: 'scribe: merged pending decisions' },
      rai: { success: true, summary: 'rai: audit completed and verdict recorded' },
    });
  });

  it('drops the optional data field — only success/summary travel to the file', () => {
    const results = new Map<string, CapabilityResult>([
      ['execute', { success: true, summary: 'executed 3 issues', data: { executed: 3 } }],
    ]);

    mkdirSync(SQUAD_DIR, { recursive: true });
    saveWatchSummary(SQUAD_DIR, results);

    const written = JSON.parse(readFileSync(path.join(SQUAD_DIR, '.last-watch-summary.json'), 'utf8'));
    expect(written.execute).toEqual({ success: true, summary: 'executed 3 issues' });
    expect(written.execute.data).toBeUndefined();
  });

  it('records a failed capability with success: false', () => {
    const results = new Map<string, CapabilityResult>([
      ['scribe', { success: false, summary: 'scribe: decisions.md write failed' }],
    ]);

    mkdirSync(SQUAD_DIR, { recursive: true });
    saveWatchSummary(SQUAD_DIR, results);

    const written = JSON.parse(readFileSync(path.join(SQUAD_DIR, '.last-watch-summary.json'), 'utf8'));
    expect(written.scribe.success).toBe(false);
  });

  it('overwrites the previous round — file reflects only the latest results', () => {
    mkdirSync(SQUAD_DIR, { recursive: true });
    saveWatchSummary(SQUAD_DIR, new Map([['scribe', { success: true, summary: 'round 1' }]]));
    saveWatchSummary(SQUAD_DIR, new Map([['scribe', { success: true, summary: 'round 2' }]]));

    const written = JSON.parse(readFileSync(path.join(SQUAD_DIR, '.last-watch-summary.json'), 'utf8'));
    expect(written.scribe.summary).toBe('round 2');
  });
});
