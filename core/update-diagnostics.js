/**
 * Independent cross-check for core self-update (see self-update.js). ST's own
 * /api/extensions/version endpoint is a black box from here — a real tester once
 * reported running visibly stale code despite auto-update reporting success, and
 * there was no way to prove what happened, only guess from a screenshot. This asks
 * GitHub directly for the actual latest commit on the tracked branch and compares
 * it to the exact commit hash ST's own endpoint said this install is on
 * (`currentCommitHash`, returned by /version — see checkCoreUpdate() in
 * self-update.js). A mismatch while ST claims `upToDate: true` is that bug's exact
 * signature, provable instead of guessed at.
 *
 * Deliberately commit-hash-based, not date-based: this project ships 5-30 commits
 * a day, so "today" is far too coarse a unit to mean anything here — only the
 * exact commit matters.
 */

const API_BASE = 'https://api.github.com';

/** The single GitHub media type that returns just the raw 40-char commit SHA as the response body, no JSON parsing needed for the common case. */
async function fetchLatestCommitSha(owner, repo, branch, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, {
        headers: { Accept: 'application/vnd.github.sha' },
    });
    if (!response.ok) throw new Error(`Could not read the latest commit for "${owner}/${repo}@${branch}" (HTTP ${response.status}).`);
    const text = (await response.text()).trim();
    if (/^[0-9a-f]{40}$/i.test(text)) return text;
    // Some proxy/CDN in front of the API can strip a custom Accept header — fall
    // back to parsing the default JSON commit object instead of failing outright.
    const data = JSON.parse(text);
    if (!data?.sha) throw new Error(`Unexpected response reading the latest commit for "${owner}/${repo}@${branch}".`);
    return data.sha;
}

/**
 * Never throws — this is purely observational and must never affect the real
 * update flow. `{ applicable: false }` when there's nothing to compare (a non-git
 * install reports an empty currentCommitHash/currentBranchName, or the /version
 * check itself failed/was skipped, or the GitHub lookup itself failed). Otherwise
 * `{ applicable: true, matches, localSha, remoteSha, branch }`.
 */
export async function diagnoseCoreUpdate({ currentCommitHash, currentBranchName, owner, repo }, { fetchImpl = fetch } = {}) {
    if (!currentCommitHash || !currentBranchName) return { applicable: false };
    try {
        const remoteSha = await fetchLatestCommitSha(owner, repo, currentBranchName, { fetchImpl });
        const matches = remoteSha.toLowerCase() === currentCommitHash.toLowerCase();
        return { applicable: true, matches, localSha: currentCommitHash, remoteSha, branch: currentBranchName };
    } catch (error) {
        return { applicable: false, error: error?.message || String(error) };
    }
}
