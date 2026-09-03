/**
 * Core self-update: uses SillyTavern's own git-based extension update endpoints
 * (the same ones behind the "Update" button in ST's Extensions manager) to check
 * whether this extension itself is behind its origin, and to pull if so.
 *
 * Both endpoints only exist for a git-cloned extension install. A manually-copied
 * (non-git) install gets a 404 or a network error from either call — every function
 * here treats that identically to "nothing to do", never throwing, so index.js can
 * always call these unconditionally and stay silent for anyone not on a git install.
 */

const VERSION_ENDPOINT = '/api/extensions/version';
const UPDATE_ENDPOINT = '/api/extensions/update';
const DISCOVER_ENDPOINT = '/api/extensions/discover';

/**
 * `import.meta.url` for a real extension looks like
 * ".../scripts/extensions/third-party/<name>/index.js" for one installed for ALL
 * users ("global", ST's own term), or ".../scripts/extensions/<name>/index.js"
 * (no "third-party" segment) for one installed for just the current user — the
 * folder name right before the script file is exactly the `extensionName` ST's own
 * update endpoints expect, either way. Falls back to null (never throws) if the URL
 * doesn't match that shape at all, e.g. when run outside a real ST page (tests, the
 * jsdom smoke harness).
 */
export function deriveExtensionName(url) {
    const match = String(url ?? '').match(/\/extensions\/(?:third-party\/)?([^/]+)\/[^/]*$/);
    return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Whether this extension is a "global" install (shared, available to every user) as
 * opposed to a per-user one — ST's `/api/extensions/version` and `/update` endpoints
 * need to be told which directory to look in via a `global` request field, and
 * getting this wrong makes the server look in the wrong place and 404.
 *
 * This used to be guessed from `import.meta.url` (true iff the URL contained a
 * "third-party" segment) — confirmed WRONG against ST's own real server routing: a
 * per-user ("local", ST's own term) install is served from the exact same
 * ".../extensions/third-party/<name>/..." URL prefix as a real global one, so that
 * heuristic returned true for BOTH, and a real per-user tester got `global: true`
 * sent, which sent the server looking in the shared directory instead of their own
 * and 404'd — this is what actually caused a long-standing, previously-unprovable
 * update bug (see the self-update-diagnostics memory).
 *
 * Fixed to ask the server directly instead, the same way ST's own Extensions manager
 * does it (public/scripts/extensions.js's getExtensionType()): fetch
 * `/api/extensions/discover`, find the entry for this extension by name, and read
 * its real `type`. Entries come back as `{ type: 'system' | 'local' | 'global', name }`
 * — `name` is the bare folder name for 'system' extensions, but
 * `third-party/<folder>` for both 'local' and 'global' ones, so both forms are
 * checked. Never throws — a failed or malformed discover() call returns false (not
 * global), which degrades the same safe way a network error already does elsewhere
 * in this file: a real global install would then 404 exactly as it did before this
 * fix existed, rather than risking the wrong-directory 404 this fix removes for the
 * far more common per-user case.
 */
export async function isGlobalInstall(extensionName, context) {
    if (!extensionName) return false;
    try {
        const response = await fetch(DISCOVER_ENDPOINT, { headers: context?.getRequestHeaders?.() ?? {} });
        if (!response.ok) return false;
        const extensions = await response.json();
        const entry = Array.isArray(extensions)
            ? extensions.find(item => item?.name === extensionName || item?.name === `third-party/${extensionName}`)
            : null;
        return entry?.type === 'global';
    } catch {
        return false;
    }
}

async function postJson(context, endpoint, body) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(context.getRequestHeaders?.() ?? {}) },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/**
 * Returns `{ checked: false }` for anything that stops this from giving a real
 * answer (no extensionName, non-git install, network error) — never throws, and
 * callers must treat `checked:false` as "proceed normally, say nothing".
 * `{ checked: true, upToDate, currentCommitHash, currentBranchName, remoteUrl }`
 * otherwise — ST's own `/version` endpoint already returns those last three (a git
 * install's exact local commit/branch and its remote's URL); they used to be
 * discarded here, but update-diagnostics.js needs the real local commit hash to
 * independently cross-check `upToDate` against GitHub's actual branch HEAD (see
 * that file — this is what makes bug #3, "reports up to date but visibly isn't",
 * provable instead of just guessed at). Pass `{ global: true }` for an install from
 * ST's shared third-party directory (see isGlobalInstall) — omitted/false means
 * "look in the current user's own extensions", ST's default.
 */
export async function checkCoreUpdate(context, extensionName, { global = false } = {}) {
    if (!extensionName) return { checked: false };
    try {
        const data = await postJson(context, VERSION_ENDPOINT, { extensionName, ...(global ? { global: true } : {}) });
        return {
            checked: true,
            upToDate: Boolean(data?.isUpToDate),
            currentCommitHash: data?.currentCommitHash || null,
            currentBranchName: data?.currentBranchName || null,
            remoteUrl: data?.remoteUrl || null,
        };
    } catch (error) {
        console.info('[ST Module Engine] Core update check skipped (not a git install, or the check failed):', error?.message || error);
        return { checked: false };
    }
}

/** `{ applied: true }` on a successful `git pull`, `{ applied: false, error }` on any failure — never throws. Same `{ global }` option as checkCoreUpdate. */
export async function applyCoreUpdate(context, extensionName, { global = false } = {}) {
    if (!extensionName) return { applied: false, error: 'Could not determine this extension\'s folder name.' };
    try {
        const data = await postJson(context, UPDATE_ENDPOINT, { extensionName, ...(global ? { global: true } : {}) });
        return { applied: true, isUpToDate: Boolean(data?.isUpToDate) };
    } catch (error) {
        console.error('[ST Module Engine] Core self-update failed:', error);
        return { applied: false, error: error?.message || String(error) };
    }
}
