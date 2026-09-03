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
 * ".../scripts/extensions/third-party/<name>/index.js" (or ".../extensions/<name>/index.js"
 * for a first-party one) — the folder name right before the script file is exactly the
 * `extensionName` ST's own update endpoints expect. Falls back to null (never throws) if
 * the URL doesn't match that shape, e.g. when run outside a real ST page (tests, the
 * jsdom smoke harness).
 */
export function deriveExtensionName(url) {
    const match = String(url ?? '').match(/\/extensions\/(?:third-party\/)?([^/]+)\/[^/]*$/);
    return match ? decodeURIComponent(match[1]) : null;
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
 * `{ checked: true, upToDate }` otherwise.
 */
export async function checkCoreUpdate(context, extensionName) {
    if (!extensionName) return { checked: false };
    try {
        const data = await postJson(context, VERSION_ENDPOINT, { extensionName });
        return { checked: true, upToDate: Boolean(data?.isUpToDate) };
    } catch (error) {
        console.info('[ST Module Engine] Core update check skipped (not a git install, or the check failed):', error?.message || error);
        return { checked: false };
    }
}

/** `{ applied: true }` on a successful `git pull`, `{ applied: false, error }` on any failure — never throws. */
export async function applyCoreUpdate(context, extensionName) {
    if (!extensionName) return { applied: false, error: 'Could not determine this extension\'s folder name.' };
    try {
        const data = await postJson(context, UPDATE_ENDPOINT, { extensionName });
        return { applied: true, isUpToDate: Boolean(data?.isUpToDate) };
    } catch (error) {
        console.error('[ST Module Engine] Core self-update failed:', error);
        return { applied: false, error: error?.message || String(error) };
    }
}
