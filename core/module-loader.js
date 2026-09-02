const RAW_BASE = 'https://raw.githubusercontent.com';
const API_BASE = 'https://api.github.com';

const GITHUB_BLOB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i;
const GITHUB_TREE_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?$/i;
const GITHUB_REPO_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * Classifies a pasted URL without any network access — the pure, testable half
 * of module resolution. Three shapes:
 *  - 'file': already points at one .js file on GitHub (a /blob/ link) — owner/repo/branch/path are all known.
 *  - 'repo': a bare repository link (optionally with /tree/<branch>, .git, or a trailing slash) — the
 *    entry file still needs to be found (see resolveModuleUrl).
 *  - 'raw': anything else — a raw.githubusercontent.com link, or a non-GitHub URL — passed through
 *    unchanged, exactly like before this file existed.
 */
export function parseSourceUrl(rawUrl) {
    const url = String(rawUrl ?? '').trim();
    let match = url.match(GITHUB_BLOB_RE);
    if (match) {
        const [, owner, repo, branch, path] = match;
        return { kind: 'file', owner, repo, branch, path };
    }
    match = url.match(GITHUB_TREE_RE);
    if (match) {
        const [, owner, repo, branch] = match;
        return { kind: 'repo', owner, repo, branch };
    }
    match = url.match(GITHUB_REPO_RE);
    if (match) {
        const [, owner, repo] = match;
        return { kind: 'repo', owner, repo, branch: null };
    }
    return { kind: 'raw', url };
}

/**
 * Turns whatever the user pasted into one fetchable raw-file URL. For a bare
 * repo link this means: find the default branch (if the URL didn't name one),
 * then find the entry file — `manifest.json`'s `"js"` field first (the same
 * convention this very repository's own manifest.json uses), then `module.js`,
 * then `index.js` at the repo root. Throws a clear error if none of those exist,
 * telling the user to link the .js file directly instead.
 */
export async function resolveModuleUrl(rawUrl, { fetchImpl = fetch } = {}) {
    const parsed = parseSourceUrl(rawUrl);
    if (parsed.kind === 'file') return `${RAW_BASE}/${parsed.owner}/${parsed.repo}/${parsed.branch}/${parsed.path}`;
    if (parsed.kind === 'raw') return parsed.url;

    const branch = parsed.branch ?? await fetchDefaultBranch(parsed.owner, parsed.repo, fetchImpl);
    const entryPath = await findEntryFile(parsed.owner, parsed.repo, branch, fetchImpl);
    return `${RAW_BASE}/${parsed.owner}/${parsed.repo}/${branch}/${entryPath}`;
}

async function fetchDefaultBranch(owner, repo, fetchImpl) {
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}`);
    if (!response.ok) throw new Error(`Could not read repository "${owner}/${repo}" (HTTP ${response.status}).`);
    const data = await response.json();
    return data?.default_branch || 'main';
}

async function findEntryFile(owner, repo, branch, fetchImpl) {
    const response = await fetchImpl(`${API_BASE}/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`);
    if (!response.ok) throw new Error(`Could not list files in "${owner}/${repo}" (HTTP ${response.status}).`);
    const entries = await response.json();
    const names = new Set((Array.isArray(entries) ? entries : []).map(entry => entry.name));

    if (names.has('manifest.json')) {
        const manifestResponse = await fetchImpl(`${RAW_BASE}/${owner}/${repo}/${branch}/manifest.json`);
        if (manifestResponse.ok) {
            const manifest = await manifestResponse.json().catch(() => null);
            if (manifest?.js) return manifest.js;
        }
    }
    if (names.has('module.js')) return 'module.js';
    if (names.has('index.js')) return 'index.js';
    throw new Error(`Could not find a module entry file in "${owner}/${repo}" — link directly to the .js file instead, or add a manifest.json with a "js" field.`);
}
