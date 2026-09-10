import { decodeBase64 } from '@sveltia/utils/file';
import { sleep } from '@sveltia/utils/misc';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { commitChanges } from '$lib/services/backends/git/gitea/commits';
import giteaWorkflow, {
  createPullRequest,
  deleteBranch,
  discard,
  ensureLabels,
  fetchPullRequestFileContents,
  fetchPullRequestFileList,
  fetchPullRequests,
  parsePullRequest,
  publish,
  savePullRequest,
  stripDraftPrefix,
  updateStatus,
} from '$lib/services/backends/git/gitea/workflow';
import { fetchAPI } from '$lib/services/backends/git/shared/api';

vi.mock('@sveltia/utils/file', () => ({
  decodeBase64: vi.fn(),
}));

vi.mock('@sveltia/utils/misc', () => ({
  sleep: vi.fn(),
}));

vi.mock('$lib/services/backends/git/gitea/commits');
vi.mock('$lib/services/backends/git/gitea/repository', () => ({
  repository: { owner: 'owner', repo: 'repo', branch: 'main' },
}));
vi.mock('$lib/services/backends/git/shared/api');
vi.mock('$lib/services/config', () => ({ cmsConfig: { subscribe: vi.fn() } }));
vi.mock('svelte/store', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  get: vi.fn(),
}));

/**
 * Get the request body passed to the given `fetchAPI` call.
 * @param {number} [index] Call index, negative counting from the end. Default: last call.
 * @returns {any} Request body.
 */
const getRequestBody = (index = -1) => vi.mocked(fetchAPI).mock.calls.at(index)?.[1]?.body;

/**
 * Create a raw pull request as returned by the REST API.
 * @param {object} [overrides] Properties to override.
 * @returns {any} Pull request.
 */
const createItem = (overrides = {}) => ({
  id: 900,
  number: 1,
  title: 'WIP: Create Post “hello”',
  html_url: 'https://gitea.com/owner/repo/pulls/1',
  head: { ref: 'cms/posts/hello', sha: 'abc123' },
  user: { id: 7, login: 'me', full_name: 'Me' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  labels: [{ name: 'sveltia-cms/draft', id: 1 }],
  ...overrides,
});

/**
 * Mock the REST API for a listing request, returning the given pull requests per status label ID.
 * @param {Record<string, any[]>} byLabelId Pull request items keyed by status label ID.
 * @param {{ id: number, name: string }[]} existingLabels Labels already in the repository.
 */
const mockList = (byLabelId, existingLabels) => {
  let createdId = 100;

  vi.mocked(fetchAPI).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') {
      createdId += 1;

      return { id: createdId };
    }

    if (path.includes('/pulls?state=open')) {
      const [, labelId] = path.match(/[?&]labels=(\d+)/) ?? [];

      return byLabelId[labelId ?? ''] ?? [];
    }

    if (path.includes('/files?')) {
      return [{ filename: 'content/posts/hello.md', status: 'changed' }];
    }

    if (path.includes('/contents/')) {
      return { content: 'aGVsbG8=', encoding: 'base64', sha: 'sha1', size: 7 };
    }

    if (path.includes('/labels?')) {
      return existingLabels;
    }

    return {};
  });

  vi.mocked(decodeBase64).mockResolvedValue('# Hello');
};

describe('Gitea Editorial Workflow service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(get).mockReturnValue({ backend: { name: 'gitea' } });
    vi.mocked(fetchAPI).mockResolvedValue({});
    vi.mocked(decodeBase64).mockResolvedValue('');
  });

  test('exports the expected service structure', () => {
    expect(giteaWorkflow).toEqual({
      fetchPullRequests: expect.any(Function),
      savePullRequest: expect.any(Function),
      updateStatus: expect.any(Function),
      publish: expect.any(Function),
      discard: expect.any(Function),
    });
  });

  describe('stripDraftPrefix', () => {
    test.each([
      ['WIP: Title', 'Title'],
      ['wip: Title', 'Title'],
      ['[WIP] Title', 'Title'],
      ['(WIP) Title', 'Title'],
      ['Draft: Title', 'Title'],
      ['[Draft] Title', 'Title'],
      ['WIP: Draft: Title', 'Title'],
      ['Title', 'Title'],
      ['Wiping the disk', 'Wiping the disk'],
    ])('strips %s', (input, expected) => {
      expect(stripDraftPrefix(input)).toBe(expected);
    });
  });

  describe('parsePullRequest', () => {
    test('parses a CMS-managed pull request', () => {
      expect(parsePullRequest(createItem())).toEqual({
        number: 1,
        nodeId: '900',
        title: 'Create Post “hello”',
        url: 'https://gitea.com/owner/repo/pulls/1',
        branch: 'cms/posts/hello',
        headSHA: 'abc123',
        status: 'draft',
        createdDate: new Date('2026-01-01T00:00:00Z'),
        updatedDate: new Date('2026-01-02T00:00:00Z'),
        author: { name: 'Me', email: '', id: 7, login: 'me' },
        files: [],
      });
    });

    test('returns undefined without a CMS label', () => {
      expect(parsePullRequest(createItem({ labels: [{ name: 'bug' }] }))).toBeUndefined();
      expect(parsePullRequest(createItem({ labels: undefined }))).toBeUndefined();
    });

    test('picks up a pull request created with Netlify/Decap CMS', () => {
      expect(
        parsePullRequest(createItem({ labels: [{ name: 'decap-cms/pending_review' }] }))?.status,
      ).toBe('pending_review');
    });

    test('handles a missing author and one without a display name', () => {
      expect(parsePullRequest(createItem({ user: null }))?.author).toBeUndefined();

      expect(parsePullRequest(createItem({ user: { login: 'bot' } }))?.author).toEqual({
        name: 'bot',
        email: '',
        id: undefined,
        login: 'bot',
      });
    });
  });

  describe('ensureLabels', () => {
    test('creates the missing status labels and returns the IDs of all the labels', async () => {
      vi.mocked(fetchAPI).mockImplementation(async (path, options) =>
        options?.method === 'POST'
          ? { id: 100 }
          : [
              { id: 1, name: 'sveltia-cms/draft' },
              { id: 9, name: 'bug' },
            ],
      );

      const result = await ensureLabels();

      expect(fetchAPI).toHaveBeenCalledWith('/repos/owner/repo/labels?page=1&limit=50');

      expect(fetchAPI).toHaveBeenCalledWith('/repos/owner/repo/labels', {
        method: 'POST',
        body: { name: 'sveltia-cms/pending_review', color: expect.any(String) },
      });

      // Only the four labels of the configured prefix are created
      expect(fetchAPI).toHaveBeenCalledTimes(4);
      expect(result.get('sveltia-cms/draft')).toBe(1);
      expect(result.get('sveltia-cms/pending_review')).toBe(100);
      expect(result.get('sveltia-cms/pending_publish')).toBe(100);
      expect(result.get('sveltia-cms/pending_deletion')).toBe(100);
      // A label the CMS does not manage is kept in the map as well
      expect(result.get('bug')).toBe(9);
    });

    test('creates nothing when every status label already exists', async () => {
      vi.mocked(fetchAPI).mockResolvedValue([
        { id: 1, name: 'sveltia-cms/draft' },
        { id: 2, name: 'sveltia-cms/pending_review' },
        { id: 3, name: 'sveltia-cms/pending_publish' },
        { id: 4, name: 'sveltia-cms/pending_deletion' },
      ]);

      const result = await ensureLabels();

      expect(fetchAPI).toHaveBeenCalledTimes(1);
      expect(result.get('sveltia-cms/pending_deletion')).toBe(4);
    });
  });

  describe('fetchPullRequestFileList', () => {
    test('maps the changed files to workflow files', async () => {
      vi.mocked(fetchAPI).mockResolvedValue([
        { filename: 'content/posts/hello.md', status: 'changed' },
        { filename: 'content/posts/old.md', status: 'deleted' },
      ]);

      const pullRequest = /** @type {any} */ ({ number: 1, files: [] });

      await fetchPullRequestFileList(pullRequest);

      expect(fetchAPI).toHaveBeenCalledWith('/repos/owner/repo/pulls/1/files?page=1&limit=50');

      expect(pullRequest.files).toEqual([
        {
          path: 'content/posts/hello.md',
          sha: '',
          size: 0,
          deleted: false,
          previousPath: undefined,
        },
        {
          path: 'content/posts/old.md',
          sha: '',
          size: 0,
          deleted: true,
          previousPath: undefined,
        },
      ]);
    });

    test('keeps the path a rename came from', async () => {
      vi.mocked(fetchAPI).mockResolvedValue([
        {
          filename: 'content/posts/renamed.md',
          status: 'renamed',
          previous_filename: 'content/posts/hello.md',
        },
      ]);

      const pullRequest = /** @type {any} */ ({ number: 1, files: [] });

      await fetchPullRequestFileList(pullRequest);

      expect(pullRequest.files[0]).toEqual({
        path: 'content/posts/renamed.md',
        sha: '',
        size: 0,
        deleted: false,
        previousPath: 'content/posts/hello.md',
      });
    });
  });

  describe('fetchPullRequestFileContents', () => {
    test('does nothing when every file is deleted', async () => {
      await fetchPullRequestFileContents(
        /** @type {any} */ ({ branch: 'cms/posts/hello', files: [{ deleted: true }] }),
      );

      expect(fetchAPI).not.toHaveBeenCalled();
    });

    test('populates the file contents, keeping a binary file without text', async () => {
      const pullRequest = /** @type {any} */ ({
        branch: 'cms/posts/hello',
        files: [
          { path: 'content/posts/hello.md', sha: '', size: 0, deleted: false },
          { path: 'static/img.png', sha: '', size: 0, deleted: false },
        ],
      });

      vi.mocked(fetchAPI).mockImplementation(async (path) =>
        path.includes('hello.md')
          ? { content: 'aGVsbG8=', encoding: 'base64', sha: 'sha1', size: 7 }
          : // A binary blob carries no size when it does not fit the response, and its decoded
            // bytes contain NUL and/or replacement characters
            { content: 'aW1hZ2U=', encoding: 'base64', sha: 'sha2' },
      );

      vi.mocked(decodeBase64).mockImplementation(async (content) =>
        content === 'aGVsbG8=' ? '# Hello' : 'binary\u0000\uFFFDgarbage',
      );

      await fetchPullRequestFileContents(pullRequest);

      expect(fetchAPI).toHaveBeenCalledWith(
        '/repos/owner/repo/contents/content/posts/hello.md?ref=cms%2Fposts%2Fhello',
      );

      expect(pullRequest.files[0]).toEqual({
        path: 'content/posts/hello.md',
        sha: 'sha1',
        size: 7,
        text: '# Hello',
        deleted: false,
      });

      expect(pullRequest.files[1]).toEqual({
        path: 'static/img.png',
        sha: 'sha2',
        size: 0,
        text: undefined,
        deleted: false,
      });
    });

    test('leaves the text empty when the response carries no content', async () => {
      const pullRequest = /** @type {any} */ ({
        branch: 'cms/posts/hello',
        files: [{ path: 'content/posts/hello.md', sha: '', size: 0, deleted: false }],
      });

      vi.mocked(fetchAPI).mockResolvedValue({
        sha: 'sha1',
        size: 5,
        content: null,
        encoding: null,
      });

      await fetchPullRequestFileContents(pullRequest);

      expect(pullRequest.files[0]).toEqual({
        path: 'content/posts/hello.md',
        sha: 'sha1',
        size: 5,
        text: undefined,
        deleted: false,
      });
    });

    test('marks a file as deleted when the request fails', async () => {
      const pullRequest = /** @type {any} */ ({
        branch: 'cms/posts/hello',
        files: [{ path: 'content/posts/hello.md', sha: '', size: 0, deleted: false }],
      });

      vi.mocked(fetchAPI).mockRejectedValue(
        Object.assign(new Error('Not found'), { cause: { status: 404 } }),
      );

      await fetchPullRequestFileContents(pullRequest);

      expect(pullRequest.files[0].deleted).toBe(true);
    });
  });

  describe('fetchPullRequests', () => {
    test('asks the API for each status label of the configured prefix, with their IDs', async () => {
      mockList({ 1: [createItem()] }, [{ id: 1, name: 'sveltia-cms/draft' }]);

      const result = await fetchPullRequests();

      expect(fetchAPI).toHaveBeenCalledWith(
        '/repos/owner/repo/pulls?state=open&sort=recentupdate&labels=1&page=1&limit=50',
      );

      // The legacy prefixes are never asked for, as their labels do not exist in the repository
      const listingPaths = vi
        .mocked(fetchAPI)
        .mock.calls.map(([path]) => path)
        .filter((path) => path.includes('/pulls?state=open'));

      expect(listingPaths).toHaveLength(4);
      expect(result).toHaveLength(1);
      expect(result[0].files[0].text).toBe('# Hello');
    });

    test('skips an item the API returned without a CMS label', async () => {
      mockList({ 1: [createItem({ number: 2, labels: [{ name: 'bug', id: 9 }] })] }, [
        { id: 1, name: 'sveltia-cms/draft' },
      ]);

      await expect(fetchPullRequests()).resolves.toEqual([]);
    });

    test('merges the results, listing a pull request found twice only once', async () => {
      // A pull request can carry status labels with more than one prefix
      mockList(
        {
          1: [createItem()],
          2: [createItem()],
          3: [createItem({ number: 2, updated_at: '2026-01-03T00:00:00Z' })],
        },
        [
          { id: 1, name: 'sveltia-cms/draft' },
          { id: 2, name: 'decap-cms/draft' },
          { id: 3, name: 'sveltia-cms/pending_publish' },
        ],
      );

      const result = await fetchPullRequests();

      // Sorted by the last update, newest first
      expect(result.map(({ number }) => number)).toEqual([2, 1]);
    });

    test('paginates a listing the instance cuts short', async () => {
      mockList({}, [{ id: 1, name: 'sveltia-cms/draft' }]);

      vi.mocked(fetchAPI).mockImplementation(async (path, options) => {
        if (options?.method === 'POST') {
          return { id: 100 };
        }

        if (path.includes('/pulls?state=open')) {
          return path.includes('page=1')
            ? // A full page keeps the next one coming
              Array.from({ length: 50 }, (_, index) => ({ number: index }))
            : [createItem({ number: 100 })];
        }

        if (path.includes('/files?')) {
          return [{ filename: 'content/posts/hello.md', status: 'changed' }];
        }

        if (path.includes('/contents/')) {
          return { content: 'aGVsbG8=', encoding: 'base64', sha: 'sha1', size: 7 };
        }

        if (path.includes('/labels?')) {
          return [{ id: 1, name: 'sveltia-cms/draft' }];
        }

        return {};
      });

      const result = await fetchPullRequests();

      const listingPaths = vi
        .mocked(fetchAPI)
        .mock.calls.map(([path]) => path)
        .filter((path) => path.includes('/pulls?state=open'));

      expect(listingPaths.some((path) => path.includes('page=2'))).toBe(true);
      expect(result.map(({ number }) => number)).toEqual([100]);
    });

    test('stops at the cap when the listing is huge', async () => {
      vi.mocked(fetchAPI).mockImplementation(async (path, options) => {
        if (options?.method === 'POST') {
          return { id: 100 };
        }

        if (path.includes('/pulls?state=open')) {
          return Array.from({ length: 100 }, (_, index) => ({ number: index }));
        }

        if (path.includes('/labels?')) {
          return [{ id: 1, name: 'sveltia-cms/draft' }];
        }

        return {};
      });

      await expect(fetchPullRequests()).resolves.toEqual([]);

      const listingPaths = vi
        .mocked(fetchAPI)
        .mock.calls.map(([path]) => path)
        .filter((path) => path.includes('/pulls?state=open'));

      expect(listingPaths.every((path) => path.includes('page=1'))).toBe(true);
    });
  });

  describe('deleteBranch', () => {
    test('deletes the branch with an encoded name', async () => {
      await deleteBranch('cms/posts/hello');

      expect(fetchAPI).toHaveBeenCalledWith('/repos/owner/repo/branches/cms%2Fposts%2Fhello', {
        method: 'DELETE',
        responseType: 'raw',
      });
    });

    test('ignores a missing branch silently, because the merge already deleted it', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(fetchAPI).mockRejectedValue(
        Object.assign(new Error('Not found'), { cause: { status: 404 } }),
      );

      await expect(deleteBranch('cms/posts/hello')).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    test('warns about any other failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(fetchAPI).mockRejectedValue(new Error('Network error'));

      await expect(deleteBranch('cms/posts/hello')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('createPullRequest', () => {
    test('creates a draft pull request with the draft label', async () => {
      vi.mocked(fetchAPI).mockImplementation(async (path, options) => {
        if (options?.method === 'POST') {
          return path.includes('/pulls')
            ? {
                id: 900,
                number: 5,
                html_url: 'https://gitea.com/owner/repo/pulls/5',
                head: { sha: 'def456' },
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
              }
            : { id: 1 };
        }

        return [
          { id: 1, name: 'sveltia-cms/draft' },
          { id: 2, name: 'sveltia-cms/pending_review' },
          { id: 3, name: 'sveltia-cms/pending_publish' },
          { id: 4, name: 'sveltia-cms/pending_deletion' },
        ];
      });

      const result = await createPullRequest({
        branch: 'cms/posts/hello',
        title: 'Create Post “hello”',
        status: 'draft',
      });

      expect(fetchAPI).toHaveBeenCalledWith('/repos/owner/repo/pulls', {
        method: 'POST',
        body: expect.objectContaining({
          title: 'WIP: Create Post “hello”',
          head: 'cms/posts/hello',
          base: 'main',
          labels: [1],
          body: 'Automatically generated by Sveltia CMS',
        }),
      });

      // The stored title excludes the draft prefix
      expect(result).toEqual(
        expect.objectContaining({
          number: 5,
          nodeId: '900',
          title: 'Create Post “hello”',
          headSHA: 'def456',
          status: 'draft',
          files: [],
        }),
      );
    });

    test('creates a pending deletion without the draft prefix', async () => {
      vi.mocked(fetchAPI).mockImplementation(async (path, options) => {
        if (options?.method === 'POST') {
          return path.includes('/pulls')
            ? {
                id: 901,
                number: 6,
                html_url: 'https://gitea.com/owner/repo/pulls/6',
                head: { sha: 'def456' },
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
              }
            : { id: 4 };
        }

        return [
          { id: 1, name: 'sveltia-cms/draft' },
          { id: 2, name: 'sveltia-cms/pending_review' },
          { id: 3, name: 'sveltia-cms/pending_publish' },
          { id: 4, name: 'sveltia-cms/pending_deletion' },
        ];
      });

      await createPullRequest({
        branch: 'cms/posts/hello',
        title: 'Delete Post',
        status: 'pending_deletion',
      });

      expect(getRequestBody().title).toBe('Delete Post');
      expect(getRequestBody().labels).toEqual([4]);
    });
  });

  describe('savePullRequest', () => {
    const args = /** @type {any} */ ({
      changes: [],
      options: { commitType: 'create' },
      branch: 'cms/posts/hello',
      title: 'Create Post “hello”',
    });

    test('lets the commit create the branch on the first save', async () => {
      vi.mocked(commitChanges).mockResolvedValue({ sha: 'def', files: {} });

      vi.mocked(fetchAPI).mockImplementation(async (path, options) => {
        if (options?.method === 'POST') {
          return path.includes('/pulls')
            ? {
                id: 900,
                number: 5,
                html_url: 'https://gitea.com/owner/repo/pulls/5',
                head: { sha: 'def456' },
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
              }
            : { id: 1 };
        }

        return [
          { id: 1, name: 'sveltia-cms/draft' },
          { id: 2, name: 'sveltia-cms/pending_review' },
          { id: 3, name: 'sveltia-cms/pending_publish' },
          { id: 4, name: 'sveltia-cms/pending_deletion' },
        ];
      });

      const result = await savePullRequest(args);

      expect(commitChanges).toHaveBeenCalledWith([], {
        commitType: 'create',
        branch: 'cms/posts/hello',
        startBranch: 'main',
      });

      // Only the pull request is created here; the branch comes with the commit
      expect(fetchAPI).toHaveBeenCalledWith(
        '/repos/owner/repo/pulls',
        expect.objectContaining({ method: 'POST' }),
      );

      expect(result.pullRequest.number).toBe(5);
    });

    test('reuses an existing pull request without creating a branch', async () => {
      const pullRequest = /** @type {any} */ ({ number: 5, branch: 'cms/posts/hello' });

      vi.mocked(commitChanges).mockResolvedValue({ sha: 'def', files: {} });

      const result = await savePullRequest({ ...args, pullRequest });

      expect(fetchAPI).not.toHaveBeenCalled();
      expect(commitChanges).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ startBranch: undefined }),
      );

      expect(result.pullRequest).toBe(pullRequest);
    });
  });

  describe('updateStatus', () => {
    const pullRequest = /** @type {any} */ ({
      number: 1,
      title: 'Create Post “hello”',
      status: 'draft',
    });

    /**
     * Mock the REST API for a status update, with every status label already in the repository.
     * @param {{ id: number, name: string }[]} currentLabels Labels currently on the pull request.
     */
    const mockUpdate = (currentLabels) => {
      vi.mocked(fetchAPI).mockImplementation(async (path) => {
        if (path.includes('/labels?')) {
          return [
            { id: 1, name: 'sveltia-cms/draft' },
            { id: 2, name: 'sveltia-cms/pending_review' },
            { id: 3, name: 'sveltia-cms/pending_publish' },
            { id: 4, name: 'sveltia-cms/pending_deletion' },
          ];
        }

        if (path.includes('/issues/1/labels')) {
          return currentLabels;
        }

        return {};
      });
    };

    test('removes the draft prefix and swaps the label while keeping external ones', async () => {
      mockUpdate([
        { id: 1, name: 'sveltia-cms/draft' },
        { id: 9, name: 'bug' },
      ]);

      const result = await updateStatus(pullRequest, 'pending_publish');

      expect(fetchAPI).toHaveBeenCalledWith('/repos/owner/repo/pulls/1', {
        method: 'PATCH',
        body: { title: 'Create Post “hello”', labels: [9, 3] },
      });

      expect(result.status).toBe('pending_publish');
      expect(result.updatedDate).toBeInstanceOf(Date);
    });

    test('adds the draft prefix when going back to the draft status', async () => {
      mockUpdate([{ id: 3, name: 'sveltia-cms/pending_publish' }]);

      await updateStatus({ ...pullRequest, status: 'pending_publish' }, 'draft');

      expect(getRequestBody().title).toBe('WIP: Create Post “hello”');
    });

    test('removes the Netlify/Decap CMS labels as well', async () => {
      mockUpdate([
        { id: 5, name: 'decap-cms/draft' },
        { id: 9, name: 'bug' },
      ]);

      await updateStatus(pullRequest, 'pending_review');

      expect(getRequestBody().labels).toEqual([9, 2]);
    });
  });

  describe('publish', () => {
    test('merges the pull request and deletes the branch', async () => {
      await publish(
        /** @type {any} */ ({
          number: 1,
          branch: 'cms/posts/hello',
          title: 'Create Post',
          headSHA: 'abc123',
        }),
      );

      expect(fetchAPI).toHaveBeenNthCalledWith(1, '/repos/owner/repo/pulls/1/merge', {
        method: 'POST',
        body: {
          Do: 'merge',
          delete_branch_after_merge: true,
          head_commit_id: 'abc123',
          merge_title_field: 'Create Post',
        },
      });

      expect(fetchAPI).toHaveBeenNthCalledWith(
        2,
        '/repos/owner/repo/branches/cms%2Fposts%2Fhello',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    test('omits the commit ID when the pull request has no head SHA on record', async () => {
      await publish(/** @type {any} */ ({ number: 1, branch: 'cms/posts/hello', title: 't' }));

      expect(getRequestBody(0).head_commit_id).toBeUndefined();
    });

    test('uses a squash merge when configured', async () => {
      vi.mocked(get).mockReturnValue({ backend: { name: 'gitea', squash_merges: true } });

      await publish(
        /** @type {any} */ ({ number: 1, branch: 'cms/posts/hello', title: 't', headSHA: 'sha1' }),
      );

      expect(getRequestBody(0)).toEqual({
        Do: 'squash',
        delete_branch_after_merge: true,
        head_commit_id: 'sha1',
        merge_title_field: 't',
      });
    });

    test('falls back to a regular merge without the config', async () => {
      vi.mocked(get).mockReturnValue(undefined);

      await publish(/** @type {any} */ ({ number: 1, branch: 'cms/posts/hello', title: 't' }));

      expect(getRequestBody(0).Do).toBe('merge');
    });

    test('retries a transient merge conflict and succeeds', async () => {
      vi.mocked(fetchAPI)
        .mockRejectedValueOnce(
          new Error('Server responded with an error', {
            cause: { status: 405, message: 'Please try again later' },
          }),
        )
        .mockResolvedValueOnce({});

      await publish(
        /** @type {any} */ ({ number: 1, branch: 'cms/posts/hello', title: 't', headSHA: 'sha1' }),
      );

      // Two merge attempts, then the branch deletion
      expect(fetchAPI).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    test('gives up when the merge keeps failing', async () => {
      vi.mocked(fetchAPI).mockRejectedValue(
        new Error('Server responded with an error', {
          cause: { status: 405, message: 'Please try again later' },
        }),
      );

      await expect(
        publish(/** @type {any} */ ({ number: 1, branch: 'cms/posts/hello', title: 't' })),
      ).rejects.toThrow();

      expect(fetchAPI).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    test('retries a 405 with an empty error message, as Forgejo sends', async () => {
      vi.mocked(fetchAPI)
        .mockRejectedValueOnce(
          new Error('Server responded with an error', { cause: { status: 405, message: '' } }),
        )
        .mockResolvedValueOnce({});

      await publish(
        /** @type {any} */ ({ number: 1, branch: 'cms/posts/hello', title: 't', headSHA: 'sha1' }),
      );

      // Two merge attempts, then the branch deletion
      expect(fetchAPI).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(1);
    });
  });

  describe('discard', () => {
    test('closes the pull request and deletes the branch', async () => {
      await discard(/** @type {any} */ ({ number: 1, branch: 'cms/posts/hello' }));

      expect(fetchAPI).toHaveBeenNthCalledWith(1, '/repos/owner/repo/pulls/1', {
        method: 'PATCH',
        body: { state: 'closed' },
      });

      expect(fetchAPI).toHaveBeenNthCalledWith(
        2,
        '/repos/owner/repo/branches/cms%2Fposts%2Fhello',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
