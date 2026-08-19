/**
 * Tests for real wall-clock timestamp injection in Rai and Scribe capabilities.
 *
 * Verifies that {CURRENT_DATETIME} placeholders are replaced with real ISO 8601
 * timestamps at the time the capability execute() method runs, not left for the LLM
 * to estimate (issue #696).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WatchContext } from '../../packages/squad-cli/src/cli/commands/watch/types.js';

// ── Hoisted mock setup ──────────────────────────────────────────

const { mockStorage, mockExecFile, mockExecFileSync, mockFsExistsSync } = vi.hoisted(() => ({
  mockStorage: {
    existsSync: vi.fn(() => true),
    listSync: vi.fn(() => []),
  },
  mockExecFile: vi.fn((...args: unknown[]) => {
    const cb = args.find(a => typeof a === 'function') as
      | ((...cbArgs: unknown[]) => void)
      | undefined;
    if (cb) cb(null, '', '');
    return {};
  }),
  mockExecFileSync: vi.fn(() => ''),
  mockFsExistsSync: vi.fn(() => false),
}));

vi.mock('@bradygaster/squad-sdk', () => ({
  FSStorageProvider: vi.fn(function () { return mockStorage; }),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

vi.mock('node:fs', () => ({
  existsSync: mockFsExistsSync,
}));

// ── Imports ─────────────────────────────────────────────────────

import { RaiCapability } from '../../packages/squad-cli/src/cli/commands/watch/capabilities/rai.js';
import { ScribeCapability } from '../../packages/squad-cli/src/cli/commands/watch/capabilities/scribe.js';
import * as agentSpawn from '../../packages/squad-cli/src/cli/commands/watch/agent-spawn.js';

// ── Helpers ─────────────────────────────────────────────────────

function makeContext(overrides: Partial<WatchContext> = {}): WatchContext {
  return {
    teamRoot: '/fake/team',
    adapter: {} as WatchContext['adapter'],
    round: 1,
    roster: [],
    config: {},
    ...overrides,
  };
}

/**
 * ISO 8601 timestamp pattern: YYYY-MM-DDTHH:mm:ss.sssZ
 * Example: 2026-08-19T15:30:45.123Z
 */
const ISO_8601_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

// ── Tests ───────────────────────────────────────────────────────

describe('Rai and Scribe timestamp injection (issue #696)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.existsSync.mockReturnValue(true);
  });

  it('Rai: buildCopilotCommand receives prompt with real ISO timestamp, not {CURRENT_DATETIME}', () => {
    const capability = new RaiCapability();
    const context = makeContext();

    let capturedPrompt = '';
    const buildCopilotCommandSpy = vi.spyOn(agentSpawn, 'buildCopilotCommand').mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return { cmd: 'copilot', args: ['-p', prompt] };
    });

    // Mock spawnAgent to prevent actual execution
    vi.spyOn(agentSpawn, 'spawnAgent').mockResolvedValue({ success: true });

    // Execute the capability
    capability.execute(context);

    // Verify the prompt was built with a real timestamp
    expect(capturedPrompt).not.toContain('{CURRENT_DATETIME}');
    expect(capturedPrompt).toMatch(ISO_8601_PATTERN);

    buildCopilotCommandSpy.mockRestore();
  });

  it('Scribe: buildCopilotCommand receives prompt with real ISO timestamp, not {CURRENT_DATETIME}', () => {
    const capability = new ScribeCapability();
    const context = makeContext();

    let capturedPrompt = '';
    const buildCopilotCommandSpy = vi.spyOn(agentSpawn, 'buildCopilotCommand').mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return { cmd: 'copilot', args: ['-p', prompt] };
    });

    // Mock spawnAgent to prevent actual execution
    vi.spyOn(agentSpawn, 'spawnAgent').mockResolvedValue({ success: true });

    // Execute the capability
    capability.execute(context);

    // Verify the prompt was built with a real timestamp
    expect(capturedPrompt).not.toContain('{CURRENT_DATETIME}');
    expect(capturedPrompt).toMatch(ISO_8601_PATTERN);

    buildCopilotCommandSpy.mockRestore();
  });

  it('Rai: timestamp in prompt is close to execution time (within a few seconds)', async () => {
    const capability = new RaiCapability();
    const context = makeContext();

    const beforeTime = new Date();
    let capturedPrompt = '';

    const buildCopilotCommandSpy = vi.spyOn(agentSpawn, 'buildCopilotCommand').mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return { cmd: 'copilot', args: ['-p', prompt] };
    });

    vi.spyOn(agentSpawn, 'spawnAgent').mockResolvedValue({ success: true });

    await capability.execute(context);
    const afterTime = new Date();

    // Extract the timestamp from the prompt
    const match = capturedPrompt.match(ISO_8601_PATTERN);
    expect(match).toBeTruthy();

    const promptTimestamp = new Date(match![0]);

    // Timestamp should be between beforeTime and afterTime (within a few seconds tolerance)
    expect(promptTimestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime() - 1000);
    expect(promptTimestamp.getTime()).toBeLessThanOrEqual(afterTime.getTime() + 1000);

    buildCopilotCommandSpy.mockRestore();
  });

  it('Scribe: timestamp in prompt is close to execution time (within a few seconds)', async () => {
    const capability = new ScribeCapability();
    const context = makeContext();

    const beforeTime = new Date();
    let capturedPrompt = '';

    const buildCopilotCommandSpy = vi.spyOn(agentSpawn, 'buildCopilotCommand').mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return { cmd: 'copilot', args: ['-p', prompt] };
    });

    vi.spyOn(agentSpawn, 'spawnAgent').mockResolvedValue({ success: true });

    await capability.execute(context);
    const afterTime = new Date();

    // Extract the timestamp from the prompt
    const match = capturedPrompt.match(ISO_8601_PATTERN);
    expect(match).toBeTruthy();

    const promptTimestamp = new Date(match![0]);

    // Timestamp should be between beforeTime and afterTime (within a few seconds tolerance)
    expect(promptTimestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime() - 1000);
    expect(promptTimestamp.getTime()).toBeLessThanOrEqual(afterTime.getTime() + 1000);

    buildCopilotCommandSpy.mockRestore();
  });

  it('Scribe: all occurrences of {CURRENT_DATETIME} are replaced with real timestamps', () => {
    const capability = new ScribeCapability();
    const context = makeContext();

    let capturedPrompt = '';
    const buildCopilotCommandSpy = vi.spyOn(agentSpawn, 'buildCopilotCommand').mockImplementation((prompt) => {
      capturedPrompt = prompt;
      return { cmd: 'copilot', args: ['-p', prompt] };
    });

    vi.spyOn(agentSpawn, 'spawnAgent').mockResolvedValue({ success: true });

    capability.execute(context);

    // Count occurrences of the placeholder (should be 0)
    const placeholderCount = (capturedPrompt.match(/{CURRENT_DATETIME}/g) || []).length;
    expect(placeholderCount).toBe(0);

    // Verify the prompt contains ISO timestamps (at least 2 occurrences)
    const timestampMatches = capturedPrompt.split(ISO_8601_PATTERN).length - 1;
    expect(timestampMatches).toBeGreaterThanOrEqual(2);

    buildCopilotCommandSpy.mockRestore();
  });
});
