/**
 * Rai capability — spawn Rai agent to run policy audits and record verdicts.
 *
 * Rai is a responsible-AI policy auditor that runs after watch completes a round,
 * reviewing recent changes against the team's RAI policy and recording traffic-light
 * verdicts (green/yellow/red) in .squad/rai/audit-trail.md. This capability follows
 * the existing pattern used by retro and decision-hygiene capabilities.
 */

import path from 'node:path';
import { FSStorageProvider } from '@bradygaster/squad-sdk';
import type { WatchCapability, WatchContext, PreflightResult, CapabilityResult } from '../types.js';
import { buildCopilotCommand, spawnAgent } from '../agent-spawn.js';

const storage = new FSStorageProvider();

export class RaiCapability implements WatchCapability {
  readonly name = 'rai';
  readonly description = 'Spawn Rai to audit recent changes against RAI policy';
  readonly configShape = 'boolean' as const;
  readonly requires = ['copilot', 'gh'];
  readonly phase = 'housekeeping' as const;

  async preflight(context: WatchContext): Promise<PreflightResult> {
    const raiDir = path.join(context.teamRoot, '.squad', 'rai');
    const policyFile = path.join(raiDir, 'policy.md');
    const auditTrailFile = path.join(raiDir, 'audit-trail.md');

    // Check that required RAI files exist
    if (!storage.existsSync(raiDir)) {
      return { ok: false, reason: 'no .squad/rai directory found' };
    }
    if (!storage.existsSync(policyFile)) {
      return { ok: false, reason: '.squad/rai/policy.md not found' };
    }
    if (!storage.existsSync(auditTrailFile)) {
      return { ok: false, reason: '.squad/rai/audit-trail.md not found' };
    }

    return { ok: true };
  }

  async execute(context: WatchContext): Promise<CapabilityResult> {
    try {
      const teamRoot = context.teamRoot;

      // Build Rai's spawn prompt
      const prompt =
        `You are Rai, the responsible AI auditor. Review recent changes and record a traffic-light verdict.\n\n` +
        `Steps:\n\n` +
        `1. Read .squad/rai/policy.md to understand the audit criteria (critical violations 🔴, advisory concerns 🟡).\n\n` +
        `2. Check recent git commits (last 5-10) in this repo:\n` +
        `   - Run: git log --oneline -10\n` +
        `   - For each commit, run: git show <commit-hash> to inspect the diff\n\n` +
        `3. Audit the diffs against policy.md, specifically:\n` +
        `   - CRITICAL VIOLATIONS (🔴): credentials, injection vulnerabilities, harmful content, deceptive patterns\n` +
        `   - ADVISORY CONCERNS (🟡): PII, bias, inclusive language, security posture, accessibility\n\n` +
        `4. If any findings exist, append a verdict entry to .squad/rai/audit-trail.md with:\n` +
        `   - Traffic-light emoji (🟢 green, 🟡 yellow, 🔴 red)\n` +
        `   - Timestamp: {CURRENT_DATETIME}\n` +
        `   - Summary (1 line): what was checked\n` +
        `   - Findings (if any): each as a bullet\n` +
        `   - Remediation path (if critical violations found)\n\n` +
        `   Format: append as markdown under the "<!-- Rai appends findings below -->" comment.\n\n` +
        `5. Use squad_state_append("rai/audit-trail.md", "\\n{verdict entry}") to record the verdict.\n\n` +
        `6. Never block or alarm the operator — just record evidence.\n\n` +
        `TEAM_ROOT: ${teamRoot}`;

      const { cmd, args } = buildCopilotCommand(prompt, context);

      const result = await spawnAgent(
        cmd,
        args,
        teamRoot,
        300_000, // 5 minute timeout for policy audit + recording
        context.pidTracker ? { tracker: context.pidTracker, label: 'rai' } : undefined,
      );

      if (!result.success) {
        return {
          success: false,
          summary: `rai spawn failed: ${result.error || 'unknown error'}`,
        };
      }

      return { success: true, summary: 'rai: audit completed and verdict recorded' };
    } catch (e) {
      return { success: false, summary: `rai: ${(e as Error).message}` };
    }
  }
}
