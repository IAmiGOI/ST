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
 * Whether this script was served from ST's shared "third-party" extensions
 * directory — a "global" install (available to every user), as opposed to a
 * per-user one. ST's `/api/extensions/version` and `/update` endpoints need to be
 * told which directory to look in via a `global` request field; get this wrong and
 * the server looks in the wrong place, the request fails, and this whole mechanism
 * silently no-ops (checkCoreUpdate/applyCoreUpdate already treat any failure as
 * "nothing to do" by design) — which is exactly what happened for a real global
 * install before this existed. `global: true` also requires the caller to be an ST
 * admin; if they aren't, the request still just fails the same safe way.
 */
export function isGlobalInstall(url) {
    return /\/extensions\/third-party\/[^/]+\/[^/]*$/.test(String(url ?? ''));
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
