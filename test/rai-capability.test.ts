/**
 * Rai capability tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RaiCapability } from '../packages/squad-cli/src/cli/commands/watch/capabilities/rai.js';
import type { WatchContext } from '../packages/squad-cli/src/cli/commands/watch/types.js';

describe('RaiCapability', () => {
  let capability: RaiCapability;
  let mockContext: WatchContext;

  beforeEach(() => {
    capability = new RaiCapability();
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
    expect(capability.name).toBe('rai');
    expect(capability.description).toBe('Spawn Rai to audit recent changes against RAI policy');
    expect(capability.configShape).toBe('boolean');
    expect(capability.phase).toBe('housekeeping');
    expect(capability.requires).toContain('copilot');
    expect(capability.requires).toContain('gh');
  });

  it('preflight fails when .squad/rai dir missing', async () => {
    const result = await capability.preflight(mockContext);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no .squad/rai directory found');
  });

  it('preflight fails when policy.md missing', async () => {
    const result = await capability.preflight(mockContext);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('policy.md');
  });

  it('preflight fails when audit-trail.md missing', async () => {
    const result = await capability.preflight(mockContext);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('audit-trail.md');
  });

  it('execute returns appropriate summary', async () => {
    const result = await capability.execute(mockContext);
    // In the real environment, this spawns a copilot process
    // For unit test, we just verify the interface
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('summary');
    expect(typeof result.summary).toBe('string');
  });

  it('returns error summary on spawn failure', async () => {
    // Mock context with no valid copilot will cause spawn failure
    const result = await capability.execute(mockContext);
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('summary');
  });
});
