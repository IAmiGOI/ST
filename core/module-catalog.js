/**
 * Fetches and parses the community module catalog — a single, hand-curated
 * `catalog.json` living in its own repository (not this one), separate from any
 * individual module's own code. A contributor's PR there only ever touches their own
 * module's files; the maintainer adds the one corresponding line to `catalog.json`
 * by hand when accepting it (see MODULES.md's "Community module catalog" section).
 * This file is UI-independent on purpose — it only fetches/validates/normalizes;
 * nothing here renders anything.
 */

export const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/IAmiGOI/SillyTavernME-Modules/main/catalog.json';
// Same repository/branch as the URL above, in link (not raw-file) form — used to build
// the GitHub "create new file" link core/module-browser.js's submission form opens.
export const CATALOG_REPO_URL = 'https://github.com/IAmiGOI/SillyTavernME-Modules';
export const CATALOG_REPO_BRANCH = 'main';

/**
 * Normalizes one raw catalog entry, or returns null if it's missing something a
 * consumer can't work without (id/title/url). Every other field is optional and
 * coerced to a string (or null) so a maintainer's typo — a stray number, a missing
 * quote fixed by JSON.parse either way — never produces something a renderer chokes
 * on downstream. Unknown extra fields on the raw entry are dropped, not passed
 * through — this is a deliberately narrow, known shape, not a passthrough.
 */
export function parseCatalogEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id ?? '').trim();
    const title = String(raw.title ?? '').trim();
    const url = String(raw.url ?? '').trim();
    if (!id || !title || !url) return null;
    return {
        id,
        title,
        url,
        description: raw.description ? String(raw.description) : '',
        author: raw.author ? String(raw.author) : null,
        version: raw.version ? String(raw.version) : null,
        repo: raw.repo ? String(raw.repo) : null,
        // Metadata for the catalog browser (core/module-browser.js) — none of this is
        // used by installModule() itself, only for display before installing.
        tags: Array.isArray(raw.tags) ? raw.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
        minEngineVersion: raw.minEngineVersion ? String(raw.minEngineVersion) : null,
        updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
        // Set by hand by the maintainer when accepting an entry into catalog.json — NOT
        // something a contributor's own submission form can set (see the submission
        // form in core/module-browser.js, which deliberately omits this field). Marks a
        // module the maintainer personally vouches for, as opposed to an unreviewed
        // community submission that just happens to be listed.
        official: Boolean(raw.official),
    };
}

/**
 * Fetches `catalog.json` (the shared community catalog by default, or any other URL
 * shaped the same way) and returns the list of valid entries. A malformed individual
 * entry is skipped with a console warning rather than failing the whole catalog —
 * same per-item error isolation used everywhere else in this codebase — but a
 * network failure or an unparseable file throws a clear error, since (unlike core
 * self-update) there's no "silently do nothing" case here: a caller asking to browse
 * the catalog needs to know when that failed so it can say so.
 */
export async function fetchCatalog(url = DEFAULT_CATALOG_URL, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Could not load the module catalog (HTTP ${response.status}).`);
    const data = await response.json();
    const rawEntries = Array.isArray(data?.modules) ? data.modules : [];
    const entries = [];
    for (const raw of rawEntries) {
        const entry = parseCatalogEntry(raw);
        if (entry) entries.push(entry);
        else console.warn('[ST Module Engine] Skipped a malformed catalog entry:', raw);
    }
    return entries;
}
