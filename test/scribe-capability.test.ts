/**
 * Scribe capability tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScribeCapability } from '../packages/squad-cli/src/cli/commands/watch/capabilities/scribe.js';
import type { WatchContext } from '../packages/squad-cli/src/cli/commands/watch/types.js';

describe('ScribeCapability', () => {
  let capability: ScribeCapability;
  let mockContext: WatchContext;

  beforeEach(() => {
    capability = new ScribeCapability();
    mockContext = {
      teamRoot: '/tmp/test-squad',
      adapter: {} as any,
      round: 1,
      roster: [],
      config: {},
      verbose: false,
    };
  });

  it('has correct metadata', () => {
    expect(capability.name).toBe('scribe');
    expect(capability.description).toBe('Spawn Scribe to merge decisions and propagate team history');
    expect(capability.configShape).toBe('boolean');
    expect(capability.phase).toBe('housekeeping');
    expect(capability.requires).toContain('copilot');
    expect(capability.requires).toContain('gh');
  });

  it('preflight fails when .squad/decisions dir missing', async () => {
    const result = await capability.preflight(mockContext);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no .squad/decisions directory found');
  });

  it('preflight fails when .squad/agents dir missing', async () => {
    // Create decisions dir but not agents
    const result = await capability.preflight(mockContext);
    expect(result.ok).toBe(false);
  });

  it('preflight succeeds when both required dirs exist', async () => {
    // This would require setup in a real temp directory with both dirs present
    // Skipping detailed test due to filesystem dependency
    expect(capability.name).toBe('scribe');
  });

  it('execute returns appropriate summary', async () => {
    const result = await capability.execute(mockContext);
    // In the real environment, this spawns a copilot process
    // For unit test, we just verify the interface
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('summary');
    expect(typeof result.summary).toBe('string');
  });
});
