/**
 * GitHub platform adapter — wraps gh CLI for issue/PR/branch operations.
 *
 * @module platform/github
 */

import { execFileSync } from 'node:child_process';
import type { PlatformAdapter, PlatformType, WorkItem, PullRequest } from './types.js';

const EXEC_OPTS: { encoding: 'utf-8'; stdio: ['pipe', 'pipe', 'pipe'] } = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] };

/** Safely parse JSON output, including raw text in error messages */
function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON from CLI output: ${(err as Error).message}\nRaw output: ${raw}`);
  }
}

/**
 * Shape of ntsy-forge's `GET /api/backlog` (`tools/dashboard/src/ingestion/backlog-poller.ts`'s
 * `BacklogSnapshot`) — the only fields this adapter reads. Deliberately narrow: that
 * endpoint's issue entries carry no `body` and its PR entries carry no `baseRefName`/
 * `reviewDecision`/`author`, so only `listWorkItems()` (issues) is wired to it below —
 * `listPullRequests()` doesn't have enough fields available to map faithfully and stays on
 * the `gh`-based path unconditionally. `getWorkItem()` (single-issue detail, not list-scale
 * traffic) also stays direct, since it's the one caller that actually needs `body`.
 */
interface CachedBacklogIssue {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
}
interface CachedBacklogSnapshot {
  issues: CachedBacklogIssue[];
}

const BACKLOG_CACHE_FETCH_TIMEOUT_MS = 5_000;

export class GitHubAdapter implements PlatformAdapter {
  readonly type: PlatformType = 'github';

  constructor(
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private get repoFlag(): string {
    return `${this.owner}/${this.repo}`;
  }

  private gh(args: string[]): string {
    return execFileSync('gh', args, EXEC_OPTS).trim();
  }

  /**
   * Cache-first read path for `listWorkItems()`, additive and env-var-gated — this repo's
   * `gh`-shelling behavior is unchanged when unset. `SQUAD_BACKLOG_CACHE_URL` points at a
   * centralized issue/PR cache (e.g. ntsy-forge's `/api/backlog`), avoiding an independent
   * `gh issue list` call every watch round on top of whatever's already polling that same
   * repo. `SQUAD_BACKLOG_CACHE_REPO` must exactly match `this.repoFlag` — the cache response
   * itself carries no repo identifier, so without this check a cache URL left set while
   * watching a *different* repo would silently return the wrong repo's issues. Any failure
   * (env var unset, mismatch, network error, bad JSON, timeout) returns `null` and the caller
   * falls back to the existing `gh`-based path — never a hard failure.
   */
  private async fetchCachedWorkItems(): Promise<WorkItem[] | null> {
    const cacheUrl = process.env['SQUAD_BACKLOG_CACHE_URL'];
    const cacheRepo = process.env['SQUAD_BACKLOG_CACHE_REPO'];
    if (!cacheUrl || cacheRepo !== this.repoFlag) return null;

    try {
      const res = await fetch(cacheUrl, { signal: AbortSignal.timeout(BACKLOG_CACHE_FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const snapshot = await res.json() as CachedBacklogSnapshot;
      if (!Array.isArray(snapshot.issues)) return null;

      return snapshot.issues.map((issue) => ({
        id: issue.number,
        title: issue.title,
        // /api/backlog only ever holds open issues (backlog-poller.ts filters to OPEN
        // before publishing), so this is not an assumption — the source data guarantees it.
        state: 'open',
        tags: issue.labels,
        assignedTo: issue.assignees[0],
        url: `https://github.com/${this.repoFlag}/issues/${issue.number}`,
      }));
    } catch {
      return null;
    }
  }

  async listWorkItems(options: { tags?: string[]; state?: string; limit?: number }): Promise<WorkItem[]> {
    const cached = await this.fetchCachedWorkItems();
    if (cached) {
      let result = cached;
      if (options.state) result = result.filter((w) => w.state === options.state!.toLowerCase());
      if (options.tags?.length) result = result.filter((w) => options.tags!.every((t) => w.tags.includes(t)));
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    }

    const args = ['issue', 'list', '--repo', this.repoFlag, '--json', 'number,title,state,labels,assignees,url'];
    if (options.state) args.push('--state', options.state);
    if (options.limit) args.push('--limit', String(options.limit));
    if (options.tags?.length) {
      for (const tag of options.tags) {
        args.push('--label', tag);
      }
    }

    const output = this.gh(args);
    const issues = parseJson<Array<{
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      assignees: Array<{ login: string }>;
      url: string;
    }>>(output);

    return issues.map((issue) => ({
      id: issue.number,
      title: issue.title,
      state: issue.state.toLowerCase(),
      tags: issue.labels.map((l) => l.name),
      assignedTo: issue.assignees[0]?.login,
      url: issue.url,
    }));
  }

  async getWorkItem(id: number): Promise<WorkItem> {
    const output = this.gh([
      'issue', 'view', String(id), '--repo', this.repoFlag,
      '--json', 'number,title,state,labels,assignees,url,body',
    ]);
    const issue = parseJson<{
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      assignees: Array<{ login: string }>;
      url: string;
      body?: string;
    }>(output);

    return {
      id: issue.number,
      title: issue.title,
      state: issue.state.toLowerCase(),
      tags: issue.labels.map((l) => l.name),
      assignedTo: issue.assignees[0]?.login,
      body: issue.body,
      url: issue.url,
    };
  }

  async createWorkItem(options: { title: string; description?: string; tags?: string[]; assignedTo?: string; type?: string }): Promise<WorkItem> {
    const args = [
      'issue', 'create',
      '--repo', this.repoFlag,
      '--title', options.title,
    ];
    if (options.description) {
      args.push('--body', options.description);
    }
    if (options.tags?.length) {
      for (const tag of options.tags) {
        args.push('--label', tag);
      }
    }
    if (options.assignedTo) {
      args.push('--assignee', options.assignedTo);
    }

    // gh issue create doesn't support --json; it prints the issue URL to stdout
    const url = this.gh(args);
    const match = url.match(/\/issues\/(\d+)\s*$/);
    if (!match) {
      throw new Error(`Could not parse issue number from gh output: ${url}`);
    }
    const issueNumber = parseInt(match[1]!, 10);

    return {
      id: issueNumber,
      title: options.title,
      state: 'open',
      tags: options.tags ?? [],
      assignedTo: options.assignedTo,
      url: url.trim(),
    };
  }

  async addTag(workItemId: number, tag: string): Promise<void> {
    this.gh(['issue', 'edit', String(workItemId), '--repo', this.repoFlag, '--add-label', tag]);
  }

  async ensureTag(tag: string, options?: { color?: string; description?: string }): Promise<void> {
    const args = ['label', 'create', tag, '--repo', this.repoFlag, '--force'];
    if (options?.color) args.push('--color', options.color);
    if (options?.description) args.push('--description', options.description);
    try {
      this.gh(args);
    } catch {
      // Label already exists or creation failed — continue either way
    }
  }

  async removeTag(workItemId: number, tag: string): Promise<void> {
    this.gh(['issue', 'edit', String(workItemId), '--repo', this.repoFlag, '--remove-label', tag]);
  }

  async addComment(workItemId: number, comment: string): Promise<void> {
    this.gh(['issue', 'comment', String(workItemId), '--repo', this.repoFlag, '--body', comment]);
  }

  async setAssignee(workItemId: number, assignee: string | undefined): Promise<void> {
    const args = ['issue', 'edit', String(workItemId), '--repo', this.repoFlag];
    if (assignee) {
      args.push('--add-assignee', assignee);
    } else {
      // Unassign: remove the current assignee (if any).
      const wi = await this.getWorkItem(workItemId);
      if (!wi.assignedTo) return;
      args.push('--remove-assignee', wi.assignedTo);
    }
    this.gh(args);
  }

  async listPullRequests(options: { status?: string; limit?: number }): Promise<PullRequest[]> {
    const args = ['pr', 'list', '--repo', this.repoFlag, '--json', 'number,title,headRefName,baseRefName,state,isDraft,reviewDecision,author,url'];
    if (options.status) args.push('--state', mapStatusToGhState(options.status));
    if (options.limit) args.push('--limit', String(options.limit));

    const output = this.gh(args);
    const prs = parseJson<Array<{
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      state: string;
      isDraft: boolean;
      reviewDecision: string;
      author: { login: string };
      url: string;
    }>>(output);

    return prs.map((pr) => ({
      id: pr.number,
      title: pr.title,
      sourceBranch: pr.headRefName,
      targetBranch: pr.baseRefName,
      status: mapGitHubPrStatus(pr.state, pr.isDraft),
      reviewStatus: mapGitHubReviewStatus(pr.reviewDecision),
      author: pr.author.login,
      url: pr.url,
    }));
  }

  async createPullRequest(options: {
    title: string;
    sourceBranch: string;
    targetBranch: string;
    description?: string;
  }): Promise<PullRequest> {
    const args = [
      'pr', 'create',
      '--repo', this.repoFlag,
      '--head', options.sourceBranch,
      '--base', options.targetBranch,
      '--title', options.title,
      '--json', 'number,title,headRefName,baseRefName,state,isDraft,reviewDecision,author,url',
    ];
    if (options.description) {
      args.push('--body', options.description);
    }

    const output = this.gh(args);
    const pr = parseJson<{
      number: number;
      title: string;
      headRefName: string;
      baseRefName: string;
      state: string;
      isDraft: boolean;
      reviewDecision: string;
      author: { login: string };
      url: string;
    }>(output);

    return {
      id: pr.number,
      title: pr.title,
      sourceBranch: pr.headRefName,
      targetBranch: pr.baseRefName,
      status: mapGitHubPrStatus(pr.state, pr.isDraft),
      reviewStatus: mapGitHubReviewStatus(pr.reviewDecision),
      author: pr.author.login,
      url: pr.url,
    };
  }

  async mergePullRequest(id: number): Promise<void> {
    this.gh(['pr', 'merge', String(id), '--repo', this.repoFlag, '--merge']);
  }

  async ensureAuth(preferredUser?: string): Promise<void> {
    try {
      // 1. Check current gh auth
      const authStatus = execFileSync('gh', ['auth', 'status', '--active'], EXEC_OPTS).trim();
      const activeMatch = authStatus.match(/account\s+(\S+)/);
      const activeUser = activeMatch?.[1] || '';

      // 2. Determine target user
      let targetUser = preferredUser || '';

      if (!targetUser) {
        // Auto-detect from remote URL — works for EMU repos where org = account
        const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], EXEC_OPTS).trim();
        const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\//);
        if (httpsMatch?.[1]) targetUser = httpsMatch[1];
      }

      if (!targetUser || activeUser === targetUser) return; // Already correct or can't determine

      // 3. Switch
      try {
        execFileSync('gh', ['auth', 'switch', '--user', targetUser], EXEC_OPTS);
        console.log(`✅ Auth context switched to ${targetUser}`);
      } catch {
        // targetUser might not be a valid account — non-fatal
      }
    } catch {
      // Non-fatal — continue with whatever auth is active
    }
  }

  async createBranch(name: string, fromBranch?: string): Promise<void> {
    const base = fromBranch ?? 'main';
    execFileSync('git', ['checkout', base], EXEC_OPTS);
    execFileSync('git', ['pull'], EXEC_OPTS);
    execFileSync('git', ['checkout', '-b', name], EXEC_OPTS);
  }
}

/** Map normalized status (active/completed/abandoned/draft) to gh CLI --state values */
function mapStatusToGhState(status: string): string {
  switch (status.toLowerCase()) {
    case 'active': return 'open';
    case 'completed': return 'merged';
    case 'abandoned': return 'closed';
    case 'draft': return 'open';
    default: return status;
  }
}

function mapGitHubPrStatus(state: string, isDraft: boolean): PullRequest['status'] {
  if (isDraft) return 'draft';
  switch (state.toUpperCase()) {
    case 'OPEN': return 'active';
    case 'CLOSED': return 'abandoned';
    case 'MERGED': return 'completed';
    default: return 'active';
  }
}

function mapGitHubReviewStatus(decision: string): PullRequest['reviewStatus'] {
  switch (decision?.toUpperCase()) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes-requested';
    case 'REVIEW_REQUIRED': return 'pending';
    default: return undefined;
  }
}
