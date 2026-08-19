/**
 * Scribe capability — spawn Scribe agent to merge decisions and propagate history.
 *
 * Scribe is a background agent that runs after watch completes a round,
 * merging decision inbox entries into decisions.md and propagating updates
 * to individual agent histories. This capability follows the existing pattern
 * used by retro and decision-hygiene capabilities.
 */

import path from 'node:path';
import { FSStorageProvider } from '@bradygaster/squad-sdk';
import type { WatchCapability, WatchContext, PreflightResult, CapabilityResult } from '../types.js';
import { buildCopilotCommand, spawnAgent } from '../agent-spawn.js';

const storage = new FSStorageProvider();

export class ScribeCapability implements WatchCapability {
  readonly name = 'scribe';
  readonly description = 'Spawn Scribe to merge decisions and propagate team history';
  readonly configShape = 'boolean' as const;
  readonly requires = ['copilot', 'gh'];
  readonly phase = 'housekeeping' as const;

  async preflight(context: WatchContext): Promise<PreflightResult> {
    const decisionsDir = path.join(context.teamRoot, '.squad', 'decisions');
    const agentsDir = path.join(context.teamRoot, '.squad', 'agents');

    // Check that required directories exist
    if (!storage.existsSync(decisionsDir)) {
      return { ok: false, reason: 'no .squad/decisions directory found' };
    }
    if (!storage.existsSync(agentsDir)) {
      return { ok: false, reason: 'no .squad/agents directory found' };
    }

    return { ok: true };
  }

  async execute(context: WatchContext): Promise<CapabilityResult> {
    try {
      const teamRoot = context.teamRoot;
      const inboxDir = path.join(teamRoot, '.squad', 'decisions', 'inbox');
      const decisionsFile = path.join(teamRoot, '.squad', 'decisions.md');
      const now = new Date().toISOString();

      // Check if there are any pending decisions to merge
      let hasPendingDecisions = false;
      try {
        if (storage.existsSync(inboxDir)) {
          const files = storage.listSync?.(inboxDir) ?? [];
          hasPendingDecisions = (Array.isArray(files) ? files : [])
            .some((f: string) => f.endsWith('.md'));
        }
      } catch {
        // No inbox directory, that's ok
      }

      // Build Scribe's spawn prompt
      const prompt =
        `You are Scribe, the team's memory manager and decision merger. ` +
        `Run these steps in order:\n\n` +
        `1. If any .md files exist in .squad/decisions/inbox/, merge each into .squad/decisions.md:\n` +
        `   - List inbox files with squad_state_list("decisions/inbox")\n` +
        `   - Read each with squad_state_read("decisions/inbox/{filename}")\n` +
        `   - Append to decisions.md with squad_state_append("decisions.md", "\\n\\n{content}")\n` +
        `   - Delete each inbox file with squad_state_delete("decisions/inbox/{filename}")\n\n` +
        `2. Deduplicate decisions.md by finding exact-match headings and keeping only the first.\n\n` +
        `3. For any newly merged decision affecting other agents, append updates to agent histories:\n` +
        `   - For each agent in .squad/agents/, if a decision affects them,\n` +
        `   - Append: "📌 Team update (${now}): {summary} — decided by {Name}"\n` +
        `   - Use squad_state_append("agents/{agent}/history.md", "\\n\\n{update}")\n\n` +
        `4. If decisions.md exceeds size limits, apply archival:\n` +
        `   - If >20KB: archive entries older than 30 days to .squad/archive/\n` +
        `   - If still >50KB: archive entries older than 7 days\n` +
        `   - Create archive entries with timestamps: ${now}-archived-decisions.md\n\n` +
        `5. Call squad_state_health() to verify persistence, then exit silently (never speak to user).\n\n` +
        `TEAM_ROOT: ${teamRoot}`;

      // Only spawn if there's actual work (inbox files exist) or on a timer
      // For now, we always spawn to ensure consistent behavior
      const { cmd, args } = buildCopilotCommand(prompt, context);

      const result = await spawnAgent(
        cmd,
        args,
        teamRoot,
        300_000, // 5 minute timeout for decision merging + archival
        context.pidTracker ? { tracker: context.pidTracker, label: 'scribe' } : undefined,
      );

      if (!result.success) {
        return {
          success: false,
          summary: `scribe spawn failed: ${result.error || 'unknown error'}`,
        };
      }

      // Count merged decisions by checking if inbox is now empty
      const inboxNowEmpty = !storage.existsSync(inboxDir) ||
        (storage.listSync?.(inboxDir) ?? []).filter((f: string) => f.endsWith('.md')).length === 0;

      const status = hasPendingDecisions && inboxNowEmpty
        ? 'merged pending decisions'
        : 'completed (no pending decisions)';

      return { success: true, summary: `scribe: ${status}` };
    } catch (e) {
      return { success: false, summary: `scribe: ${(e as Error).message}` };
    }
  }
}
