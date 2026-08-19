/**
 * GitHubAdapter cache-first `listWorkItems()` tests (issue #611) — the env-var-gated path
 * that reads a pre-fetched issue snapshot (e.g. ntsy-forge's `/api/backlog`) instead of
 * shelling to `gh`, plus its fallback behavior when the cache isn't usable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const { GitHubAdapter } = await import('../packages/squad-sdk/src/platform/github.js');

const CACHE_URL = 'http://localhost:4173/api/backlog';
const REPO = 'owner/repo';

describe('GitHubAdapter.listWorkItems — cache-first path', () => {
  beforeEach(() => {
    delete process.env['SQUAD_BACKLOG_CACHE_URL'];
    delete process.env['SQUAD_BACKLOG_CACHE_REPO'];
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue('[]'); // gh-based fallback path returns an empty issue list
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SQUAD_BACKLOG_CACHE_URL'];
    delete process.env['SQUAD_BACKLOG_CACHE_REPO'];
  });

  it('uses the cache when the URL is set and the repo matches, without calling gh', async () => {
    process.env['SQUAD_BACKLOG_CACHE_URL'] = CACHE_URL;
    process.env['SQUAD_BACKLOG_CACHE_REPO'] = REPO;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        issues: [
          { number: 42, title: 'Fix the thing', labels: ['bug'], assignees: ['alice'] },
        ],
      }),
    });

    const adapter = new GitHubAdapter('owner', 'repo');
    const items = await adapter.listWorkItems({});

    expect(items).toEqual([
      { id: 42, title: 'Fix the thing', state: 'open', tags: ['bug'], assignedTo: 'alice', url: 'https://github.com/owner/repo/issues/42' },
    ]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('applies state/tags/limit filtering to cached results the same as the gh-based path', async () => {
    process.env['SQUAD_BACKLOG_CACHE_URL'] = CACHE_URL;
    process.env['SQUAD_BACKLOG_CACHE_REPO'] = REPO;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        issues: [
          { number: 1, title: 'A', labels: ['bug'], assignees: [] },
          { number: 2, title: 'B', labels: ['feature'], assignees: [] },
          { number: 3, title: 'C', labels: ['bug'], assignees: [] },
        ],
      }),
    });

    const adapter = new GitHubAdapter('owner', 'repo');
    const filtered = await adapter.listWorkItems({ tags: ['bug'], limit: 1 });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe(1);
  });

  it('does NOT use the cache when SQUAD_BACKLOG_CACHE_REPO does not match this adapter repo (cross-repo contamination guard)', async () => {
    process.env['SQUAD_BACKLOG_CACHE_URL'] = CACHE_URL;
    process.env['SQUAD_BACKLOG_CACHE_REPO'] = 'someone-else/other-repo';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const adapter = new GitHubAdapter('owner', 'repo');
    await adapter.listWorkItems({});

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'list', '--repo', 'owner/repo']),
      expect.anything(),
    );
  });

  it('falls back to gh when the cache URL is unset', async () => {
    const adapter = new GitHubAdapter('owner', 'repo');
    await adapter.listWorkItems({});
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('falls back to gh when the cache fetch fails (non-OK response)', async () => {
    process.env['SQUAD_BACKLOG_CACHE_URL'] = CACHE_URL;
    process.env['SQUAD_BACKLOG_CACHE_REPO'] = REPO;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    const adapter = new GitHubAdapter('owner', 'repo');
    await adapter.listWorkItems({});
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('falls back to gh when the cache fetch throws (network error)', async () => {
    process.env['SQUAD_BACKLOG_CACHE_URL'] = CACHE_URL;
    process.env['SQUAD_BACKLOG_CACHE_REPO'] = REPO;
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));

    const adapter = new GitHubAdapter('owner', 'repo');
    await adapter.listWorkItems({});
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('falls back to gh when the cache response has no issues array', async () => {
    process.env['SQUAD_BACKLOG_CACHE_URL'] = CACHE_URL;
    process.env['SQUAD_BACKLOG_CACHE_REPO'] = REPO;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({}) });

    const adapter = new GitHubAdapter('owner', 'repo');
    await adapter.listWorkItems({});
    expect(execFileSyncMock).toHaveBeenCalled();
  });
});
