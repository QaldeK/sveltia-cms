import { _ } from '@sveltia/i18n';
import { encodeBase64 } from '@sveltia/utils/file';

import { repository } from '$lib/services/backends/git/gitea/repository';
import { fetchAPI } from '$lib/services/backends/git/shared/api';
import { createCommitMessage, dedupeFileCommits } from '$lib/services/backends/git/shared/commits';
import { user } from '$lib/services/user/account.svelte';

/**
 * @import { CommitOptions, CommitResults, FileChange, FileCommit, User } from '$lib/types/private';
 */

/**
 * @typedef {object} CommitResponse
 * @property {object} commit Commit information, including the commit SHA and creation date.
 * @property {string} commit.sha Commit SHA.
 * @property {string} commit.created Commit creation date in ISO format.
 * @property {({ path: string, sha: string } | null)[]} files List of saved files, each with its
 * path and SHA. It can be `null` if the file was deleted.
 */

/**
 * Fetch the last commit on the repository.
 * @returns {Promise<{ hash: string, message: string }>} Commit’s SHA-1 hash and message.
 * @throws {Error} When the branch could not be found.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoGetSingleCommit
 */
export const fetchLastCommit = async () => {
  const { owner, repo, branch } = repository;

  try {
    const {
      commit: { id: hash, message },
    } = /** @type {{ commit: { id: string, message: string }}} */ (
      await fetchAPI(`/repos/${owner}/${repo}/branches/${branch}`)
    );

    return { hash, message };
  } catch {
    throw new Error('Failed to retrieve the last commit hash.', {
      cause: new Error(_('branch_not_found', { values: { repo, branch } })),
    });
  }
};

/**
 * Save entries or assets remotely.
 * @param {FileChange[]} changes File changes to be saved.
 * @param {CommitOptions} options Commit options.
 * @returns {Promise<CommitResults>} Commit results, including the commit SHA and updated file SHAs.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoChangeFiles
 */
export const commitChanges = async (changes, options) => {
  const { owner, repo, branch: defaultBranch } = repository;
  const { branch, startBranch } = options;
  const commitMessage = createCommitMessage(changes, options);
  const { name, email } = /** @type {User} */ (user.account);
  const date = new Date().toJSON();
  // Update and delete operations require the current blob SHA of the file, which the caller may not
  // know for a file that only lives on a workflow branch — the file cache is filled from the
  // configured branch only. Look it up on the target branch, and turn an update of a missing file
  // into a create
  const ref = branch ?? defaultBranch;

  const files = await Promise.all(
    changes.map(async ({ action, path, previousPath, previousSha, data = '' }) => {
      const operation = action === 'move' ? 'update' : action;
      let finalOperation = operation;
      let sha = previousSha;

      if (!sha && operation !== 'create' && ref) {
        const lookupPath = previousPath ?? path;

        try {
          ({ sha } = /** @type {{ sha: string }} */ (
            await fetchAPI(
              `/repos/${owner}/${repo}/contents/${encodeURI(lookupPath)}` +
                `?ref=${encodeURIComponent(ref)}`,
            )
          ));
        } catch {
          // The file does not exist on the branch, so an update becomes a create
          if (operation === 'update') {
            finalOperation = 'create';
          }
        }
      }

      return {
        operation: finalOperation,
        path,
        content: await encodeBase64(data),
        from_path: previousPath,
        sha,
      };
    }),
  );

  /**
   * Commit the changes, optionally creating a new branch from the given one on the way, which is
   * how a workflow branch comes to life on the first save.
   * @param {string | undefined} fromBranch Branch to commit to, and the branch a new one is created
   * from. An omitted branch makes the instance use its default one.
   * @param {string} [newBranch] Branch to create from `fromBranch` before committing.
   * @returns {Promise<CommitResponse>} Commit response.
   */
  const commit = async (fromBranch, newBranch) =>
    /** @type {CommitResponse} */ (
      await fetchAPI(`/repos/${owner}/${repo}/contents`, {
        method: 'POST',
        body: {
          branch: fromBranch,
          ...(newBranch ? { new_branch: newBranch } : {}),
          author: { name, email },
          committer: { name, email },
          dates: { author: date, committer: date },
          message: commitMessage,
          files,
        },
      })
    );

  /** @type {CommitResponse} */
  let response;

  try {
    response = await commit(
      startBranch ?? branch ?? defaultBranch,
      startBranch ? branch : undefined,
    );
  } catch (/** @type {any} */ ex) {
    // Gitea/Forgejo refuse to create a branch that already exists, which happens when an earlier
    // save was interrupted after creating it. Forgejo answers 422 and Gitea 409 in that case.
    // Commit onto the existing branch instead
    if (!startBranch || ![409, 422].includes(ex.cause?.status)) {
      throw ex;
    }

    response = await commit(branch ?? defaultBranch);
  }

  const {
    commit: { sha, created },
    files: savedFiles,
  } = response;

  return {
    sha,
    date: new Date(created),
    files: Object.fromEntries(
      savedFiles.map((file, index) => [
        file?.path ?? changes[index].path,
        { sha: file?.sha ?? '' },
      ]),
    ),
  };
};

/**
 * Fetch commit history for the given file paths.
 * @param {string[]} paths File paths to fetch commit history for.
 * @returns {Promise<FileCommit[]>} Deduplicated and sorted list of commits.
 * @see https://docs.gitea.com/api/next/#tag/repository/operation/repoGetAllCommits
 */
export const fetchFileCommits = async (paths) => {
  const { owner, repo, branch } = repository;

  const results = await Promise.all(
    paths.map(
      (path) =>
        /** @type {Promise<any[]>} */ (
          fetchAPI(
            `/repos/${owner}/${repo}/commits` +
              `?sha=${encodeURIComponent(branch ?? '')}` +
              `&path=${encodeURIComponent(path)}&limit=100`,
          )
        ),
    ),
  );

  return dedupeFileCommits(
    results.flat().map((commit) => ({
      sha: commit.sha,
      authorName: commit.commit?.author?.name ?? '',
      authorEmail: commit.commit?.author?.email,
      authorAvatarURL: commit.author?.avatar_url,
      authorLogin: commit.author?.login,
      date: new Date(commit.commit?.author?.date ?? commit.created),
    })),
  );
};
