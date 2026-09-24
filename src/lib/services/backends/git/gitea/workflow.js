/* eslint-disable no-await-in-loop */

import { decodeBase64 } from '@sveltia/utils/file';
import { sleep } from '@sveltia/utils/misc';

import { commitChanges } from '$lib/services/backends/git/gitea/commits';
import { repository } from '$lib/services/backends/git/gitea/repository';
import { fetchAPI } from '$lib/services/backends/git/shared/api';
import { runConcurrently } from '$lib/services/backends/git/shared/concurrency';
import { isSquashMergeEnabled } from '$lib/services/backends/git/shared/workflow';
import { WORKFLOW_STATUSES } from '$lib/services/workflow/constants';
import {
  getAllStatusLabels,
  getStatusFromLabels,
  getStatusLabel,
} from '$lib/services/workflow/labels';

/**
 * @import {
 * CommitResults,
 * WorkflowPullRequest,
 * WorkflowSaveOptions,
 * WorkflowStatus,
 * } from '$lib/types/private';
 */

/**
 * Maximum numbers of items to retrieve from the REST API: open pull requests, changed files per
 * pull request, and repository labels. Editorial Workflow is not meant to hold a huge backlog, so
 * a couple of pages are enough in practice.
 */
const MAX_ITEMS = { pullRequests: 100, files: 100, labels: 100 };
/**
 * Number of items to request per page. An instance caps it by the `[api] MAX_RESPONSE_ITEMS`
 * setting (50 by default) by silently returning fewer items, so asking for 50 works everywhere, and
 * pagination covers instances configured with a smaller limit.
 * @see https://docs.gitea.com/administration/config-cheat-sheet
 */
const PAGE_SIZE = 50;

/**
 * Regular expression matching the draft indicators Gitea/Forgejo accept at the beginning of a pull
 * request title. The default instance configuration recognizes `WIP:` and `[WIP]`, but the prefixes
 * are configurable, and a `Draft:` title is tolerated when reading, as it may have been created
 * elsewhere.
 * @see https://docs.gitea.com/usage/linked-references
 */
const DRAFT_TITLE_REGEX =
  /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s|\[wip\]|\(wip\)|wip:|wip\s)\s*/i;

/**
 * Prefix added to a pull request title to mark it as a draft. Gitea/Forgejo have no dedicated API
 * field to toggle the draft state; the read-only `draft` property is derived from the title
 * instead, and the default instance configuration recognizes this prefix.
 */
const DRAFT_TITLE_PREFIX = 'WIP: ';

/**
 * Fill colors for the status labels the CMS creates, as 6-digit hex codes without the leading hash.
 * A repository usually has no labels for a CMS prefix, and Gitea/Forgejo do not create labels when
 * they are assigned, so the four status labels are created up front with these colors.
 */
const STATUS_LABEL_COLORS = {
  draft: 'cccccc',
  pending_review: 'fbca04',
  pending_publish: '0e8a16',
  pending_deletion: 'd93f0b',
};

/**
 * Number of merge attempts after the first one fails with the transient conflict error. An instance
 * checks a freshly committed pull request for conflicts asynchronously, and merging too early fails
 * with 405, unlike GitHub and GitLab, which block the merge instead. The check can take a few
 * seconds, so the retries back off.
 */
const MAX_MERGE_RETRIES = 3;
const MERGE_RETRY_DELAYS = [1000, 2000, 3000];

/**
 * Fetch all the items on a paginated endpoint, up to the given cap. An instance silently returns
 * fewer items than requested rather than an error, so a short page is the end of the list.
 * @param {string} path API endpoint path without pagination parameters.
 * @param {number} cap Maximum number of items to return.
 * @returns {Promise<Record<string, any>[]>} Items.
 */
const fetchAllPages = async (path, cap) => {
  /** @type {Record<string, any>[]} */
  const items = [];

  for (let page = 1; items.length < cap; page += 1) {
    const result = /** @type {Record<string, any>[]} */ (
      await fetchAPI(`${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=${PAGE_SIZE}`)
    );

    items.push(...result);

    if (result.length < PAGE_SIZE) {
      break;
    }
  }

  return items.slice(0, cap);
};

/**
 * Remove any draft indicator from the given pull request title.
 * @param {string} title Raw title.
 * @returns {string} Title without a draft prefix.
 */
export const stripDraftPrefix = (title) => {
  let result = title;

  // Repeat, because titles may carry combinations such as `WIP: Draft: Title`
  while (DRAFT_TITLE_REGEX.test(result)) {
    result = result.replace(DRAFT_TITLE_REGEX, '');
  }

  return result;
};

/**
 * Parse a pull request returned by the REST API.
 * @param {Record<string, any>} item Pull request.
 * @returns {WorkflowPullRequest | undefined} Parsed pull request, or `undefined` if the pull
 * request is not managed by the CMS.
 */
export const parsePullRequest = (item) => {
  const labels = /** @type {{ name: string }[]} */ (item.labels ?? []);
  const status = getStatusFromLabels(labels.map((label) => label.name));

  if (!status) {
    return undefined;
  }

  const { full_name: fullName, login, id } = item.user ?? {};

  return {
    number: item.number,
    nodeId: String(item.id),
    title: stripDraftPrefix(item.title),
    url: item.html_url,
    branch: item.head.ref,
    headSHA: item.head.sha,
    status,
    createdDate: new Date(item.created_at),
    updatedDate: new Date(item.updated_at),
    author: login ? { name: fullName ?? login, email: '', id, login } : undefined,
    files: [],
  };
};

/**
 * Make sure the status labels exist in the repository, and return the ID of every label found.
 * Unlike GitHub and GitLab, Gitea/Forgejo do not create labels when they are assigned to a pull
 * request, so the four status labels of the configured prefix are created here. Legacy
 * Netlify/Decap CMS labels are only picked up when they already exist.
 * @returns {Promise<Map<string, number>>} Label IDs keyed with label names.
 * @see https://docs.gitea.com/api/next/#tag/issue/operation/issueListLabels
 * @see https://docs.gitea.com/api/next/#tag/issue/operation/issueCreateLabel
 */
export const ensureLabels = async () => {
  const { owner, repo } = repository;
  const labels = await fetchAllPages(`/repos/${owner}/${repo}/labels`, MAX_ITEMS.labels);
  const labelMap = new Map(labels.map(({ name, id }) => [name, id]));

  await runConcurrently(WORKFLOW_STATUSES, async (status) => {
    const name = getStatusLabel(status);

    if (labelMap.has(name)) {
      return;
    }

    const { id } = /** @type {{ id: number }} */ (
      await fetchAPI(`/repos/${owner}/${repo}/labels`, {
        method: 'POST',
        body: { name, color: STATUS_LABEL_COLORS[status] },
      })
    );

    labelMap.set(name, id);
  });

  return labelMap;
};

/**
 * Fetch the list of files changed in the given pull request.
 * @param {WorkflowPullRequest} pullRequest Pull request to complete.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoGetPullRequestFiles
 */
export const fetchPullRequestFileList = async (pullRequest) => {
  const { owner, repo } = repository;

  const files = await fetchAllPages(
    `/repos/${owner}/${repo}/pulls/${pullRequest.number}/files`,
    MAX_ITEMS.files,
  );

  pullRequest.files = files.map(({ filename, status, previous_filename: previousFilename }) => ({
    path: filename,
    sha: '',
    size: 0,
    deleted: status === 'deleted',
    previousPath: status === 'renamed' ? previousFilename : undefined,
  }));
};

/**
 * Fetch the content of the files changed in the given pull request, and populate the
 * {@link WorkflowFile} objects in place. The contents endpoint returns binary files just like text
 * ones, so a decoded blob is only kept as text when it carries no NUL or replacement character,
 * which plaintext never does.
 * @param {WorkflowPullRequest} pullRequest Pull request to complete.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoGetContents
 */
export const fetchPullRequestFileContents = async (pullRequest) => {
  const { owner, repo } = repository;
  const files = pullRequest.files.filter(({ deleted }) => !deleted);

  if (!files.length) {
    return;
  }

  await runConcurrently(files, async (file) => {
    let result;

    try {
      result = /** @type {Record<string, any>} */ (
        await fetchAPI(
          `/repos/${owner}/${repo}/contents/${encodeURI(file.path)}` +
            `?ref=${encodeURIComponent(pullRequest.branch)}`,
        )
      );
    } catch {
      // The file may have been removed from the branch in the meantime
      file.deleted = true;
      return;
    }

    const { content, encoding, sha, size } = result;
    const text = content && encoding === 'base64' ? await decodeBase64(content) : undefined;
    // A NUL or a replacement character in the decoded bytes means the file is binary, and keeping
    // such a string as text would let the entry list parse it as an entry
    const isBinary = !!text && (text.includes('\u0000') || text.includes('\uFFFD'));

    Object.assign(file, {
      sha,
      size: Number(size) || 0,
      text: isBinary || !text ? undefined : text,
    });
  });
};

/**
 * Fetch all the open pull requests managed by the CMS, along with the changed files.
 * @returns {Promise<WorkflowPullRequest[]>} Pull requests.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoListPullRequests
 */
export const fetchPullRequests = async () => {
  const { owner, repo } = repository;
  const labelMap = await ensureLabels();
  /** @type {Map<number, WorkflowPullRequest>} */
  const found = new Map();

  // The status labels are matched by the API rather than by {@link parsePullRequest}, so the item
  // cap applies to the CMS’s own pull requests instead of the repository’s most recently updated
  // ones, which could otherwise push the unpublished entries out of the result. The `labels` filter
  // matches a pull request carrying all the given labels, and only takes label IDs, so each known
  // label needs its own request and the results are merged here
  const labelIds = getAllStatusLabels()
    .map((name) => labelMap.get(name))
    .filter((id) => id !== undefined);

  await runConcurrently(labelIds, async (labelId) => {
    const items = await fetchAllPages(
      `/repos/${owner}/${repo}/pulls?state=open&sort=recentupdate&labels=${labelId}`,
      MAX_ITEMS.pullRequests,
    );

    items.forEach((item) => {
      const pullRequest = parsePullRequest(item);

      // A pull request can carry status labels with more than one prefix, so it can show up in
      // several of these requests
      if (pullRequest) {
        found.set(item.number, pullRequest);
      }
    });
  });

  const pullRequests = [...found.values()].sort(
    (a, b) => b.updatedDate.getTime() - a.updatedDate.getTime(),
  );

  await runConcurrently(pullRequests, async (pullRequest) => {
    await fetchPullRequestFileList(pullRequest);
    await fetchPullRequestFileContents(pullRequest);
  });

  return pullRequests;
};

/**
 * Delete the given branch. Failures are ignored, as the branch may already have been deleted when
 * the pull request was merged.
 * @param {string} branch Branch name.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoDeleteBranch
 */
export const deleteBranch = async (branch) => {
  try {
    await fetchAPI(
      `/repos/${repository.owner}/${repository.repo}/branches/${encodeURIComponent(branch)}`,
      { method: 'DELETE', responseType: 'raw' },
    );
  } catch (/** @type {any} */ ex) {
    // A missing branch is not a failure, but the state the merge was supposed to leave the
    // repository in; anything else makes the next pull request for the same entry start from an
    // existing branch, so make it visible rather than swallowing it
    if (ex.cause?.status === 404) {
      return;
    }

    // eslint-disable-next-line no-console
    console.warn(`Failed to delete the ${branch} branch.`, ex);
  }
};

/**
 * Create a new pull request for the given workflow branch. The pull request is created as a draft
 * by way of the `WIP:` title prefix, because a newly saved entry always starts with the `draft`
 * status.
 * @param {object} args Arguments.
 * @param {string} args.branch Workflow branch name.
 * @param {string} args.title Pull request title.
 * @param {WorkflowStatus} args.status Status to open the pull request with.
 * @returns {Promise<WorkflowPullRequest>} Created pull request.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoCreatePullRequest
 */
export const createPullRequest = async ({ branch, title, status }) => {
  const { owner, repo, branch: baseBranch } = repository;
  const isDraft = status === 'draft';
  const labelMap = await ensureLabels();
  const labelId = labelMap.get(getStatusLabel(status));

  const result = /** @type {Record<string, any>} */ (
    await fetchAPI(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: {
        title: isDraft ? `${DRAFT_TITLE_PREFIX}${title}` : title,
        head: branch,
        base: baseBranch,
        labels: [labelId],
        body: 'Automatically generated by Sveltia CMS',
      },
    })
  );

  return {
    number: result.number,
    nodeId: String(result.id),
    title,
    url: result.html_url,
    branch,
    headSHA: result.head.sha,
    status,
    createdDate: new Date(result.created_at),
    updatedDate: new Date(result.updated_at),
    files: [],
  };
};

/**
 * Commit the given changes on the workflow branch, creating the branch and the pull request if
 * they don’t exist yet.
 * @param {WorkflowSaveOptions} args Arguments.
 * @returns {Promise<{ commit: CommitResults, pullRequest: WorkflowPullRequest }>} Commit results
 * and the new or updated pull request.
 */
export const savePullRequest = async ({ changes, options, branch, title, status, pullRequest }) => {
  // The commit itself creates the workflow branch on the first save, so it doesn’t need a request
  // of its own
  const startBranch = pullRequest ? undefined : repository.branch;
  const commit = await commitChanges(changes, { ...options, branch, startBranch });

  return {
    commit,
    pullRequest: pullRequest ?? (await createPullRequest({ branch, title, status })),
  };
};

/**
 * Update the pull request’s status label and draft state. A pull request in the `draft` status is
 * kept as a WIP pull request, so it cannot be merged accidentally. Gitea/Forgejo store the draft
 * state in the title, and the edit endpoint replaces all the labels, so the labels added outside
 * the CMS have to be sent again in the same request.
 * @param {WorkflowPullRequest} pullRequest Pull request.
 * @param {WorkflowStatus} status New status.
 * @returns {Promise<WorkflowPullRequest>} Updated pull request.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoEditPullRequest
 */
export const updateStatus = async (pullRequest, status) => {
  const { owner, repo } = repository;
  const isDraft = status === 'draft';
  const newLabel = getStatusLabel(status);
  const title = isDraft ? `${DRAFT_TITLE_PREFIX}${pullRequest.title}` : pullRequest.title;
  const labelMap = await ensureLabels();

  const currentLabels = /** @type {{ id: number, name: string }[]} */ (
    await fetchAPI(`/repos/${owner}/${repo}/issues/${pullRequest.number}/labels`)
  );

  // Drop every status label the CMS recognizes, whatever the prefix, so a pull request created
  // with another CMS is migrated, and add the ID of the new status
  const labelIds = currentLabels
    .filter(({ name }) => !getAllStatusLabels().includes(name))
    .map(({ id }) => id);

  labelIds.push(/** @type {number} */ (labelMap.get(newLabel)));

  await fetchAPI(`/repos/${owner}/${repo}/pulls/${pullRequest.number}`, {
    method: 'PATCH',
    body: { title, labels: labelIds },
  });

  return { ...pullRequest, status, updatedDate: new Date() };
};

/**
 * Merge the pull request and delete the workflow branch.
 * @param {WorkflowPullRequest} pullRequest Pull request.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoMergePullRequest
 */
export const publish = async (pullRequest) => {
  const squash = isSquashMergeEnabled();
  const { owner, repo } = repository;

  for (let attempt = 0; ; attempt += 1) {
    try {
      // The instance answers with an empty 200 body, which the JSON parsing would reject
      await fetchAPI(`/repos/${owner}/${repo}/pulls/${pullRequest.number}/merge`, {
        method: 'POST',
        responseType: 'raw',
        body: {
          // Forgejo’s swagger names the merge style `Do`, Gitea’s `do`; their JSON decoders are
          // case-insensitive, so the former works everywhere
          Do: squash ? 'squash' : 'merge',
          delete_branch_after_merge: true,
          // A merge can be rejected when the pull request head has moved since it was listed
          ...(pullRequest.headSHA ? { head_commit_id: pullRequest.headSHA } : {}),
          merge_title_field: pullRequest.title,
        },
      });

      break;
    } catch (/** @type {any} */ ex) {
      // An instance checks a freshly committed pull request for conflicts asynchronously, and
      // merging too early fails with 405. Forgejo carries no consistent error message in that
      // case, so any 405 is retried; permanent ones, like a WIP pull request, just fail again
      // after the retries
      if (attempt >= MAX_MERGE_RETRIES || ex.cause?.status !== 405) {
        throw ex;
      }

      await sleep(MERGE_RETRY_DELAYS[attempt] ?? 3000);
    }
  }

  // The merge usually deletes the branch itself, in which case this is a no-op
  await deleteBranch(pullRequest.branch);
};

/**
 * Close the pull request without merging it, and delete the workflow branch.
 * @param {WorkflowPullRequest} pullRequest Pull request.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoEditPullRequest
 */
export const discard = async (pullRequest) => {
  const { owner, repo } = repository;

  await fetchAPI(`/repos/${owner}/${repo}/pulls/${pullRequest.number}`, {
    method: 'PATCH',
    body: { state: 'closed' },
  });

  await deleteBranch(pullRequest.branch);
};

/**
 * Gitea/Forgejo’s Editorial Workflow implementation.
 * @type {import('$lib/types/private').WorkflowBackendService}
 */
export default {
  fetchPullRequests,
  savePullRequest,
  updateStatus,
  publish,
  discard,
};
