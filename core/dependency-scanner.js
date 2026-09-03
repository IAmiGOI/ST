/**
 * Aggregates a STATIC graph of what could depend on what — built from two
 * kinds of source, neither of which requires reading a module's JS source or
 * executing anything to find out:
 *
 *  - **Self-published edges**: ANY module MAY
 *    `host.data.set('dependencies', edges)` in its own namespace, where
 *    `edges` is a plain array of `{ owner, kind, detail? }` describing another
 *    module/namespace it depends on and HOW it honestly knows that — a generic
 *    convention, not special-cased per module, exactly like `host.services`
 *    already lets any module be a provider without the engine having built-in
 *    knowledge of what a service name means. The first real publisher is the
 *    Macros module: it safely PARSES its own programs (a small, purpose-built
 *    grammar with a real parser, not arbitrary JS) to find every
 *    `get "namespace:key"` it contains — see
 *    modules/macros/language.js's `collectGetKeys()` and
 *    modules/macros/index.js's `sync()`.
 *  - **Webhook edges**: derived directly from every module's own reserved
 *    channels' `webhook` config — already generic bus metadata (see
 *    `#webhookEdges()` below), so no module cooperation/publishing is needed
 *    for this source at all.
 *  - **Service-contract edges** (`scanServiceContracts()`, async, separate
 *    from the two synchronous sources above): regex-parses every module's own
 *    RAW SOURCE TEXT for `host.services.register/request/get/ask('name')`
 *    literal calls. This project ships with no build step — every module's
 *    file, built-in or externally-loaded, is plain, unbundled, fetchable text
 *    at a real URL — so this is genuine PARSING of what's actually there
 *    (the same technique `core/module-engine.js`'s own
 *    `checkModuleUpdateAvailable()` already uses to read a module's declared
 *    `version` field), not a claim the module's author had to type by hand.
 *    Deliberately NOT the self-published convention above for this one
 *    source: a hand-typed `host.data.set('dependencies', ...)` for a service
 *    call would just be a declared claim wearing the same shape as a parsed
 *    fact, and re-trusting a module's own honesty about itself is exactly
 *    what this whole "parse it instead" approach was chosen to avoid.
 *
 *  - **Activation-condition edges** (`scanActivationConditions()`, async, its
 *    own fetch pass — see that method's doc comment for why this isn't just
 *    folded into `scanServiceContracts()` above): regex-parses every module's
 *    source for `host.onEvent('NAME', ...)` / `host.onChatChanged(...)` and
 *    any cross-namespace `host.data.read/subscribe('namespace', ...)` call. An
 *    ST event isn't owned by any module (`st-event:<NAME>` pseudo-node, same
 *    idea as `external:<host>`/`service:<name>` above); a cross-namespace bus
 *    read IS a real namespace, so its edge is owned by that namespace
 *    directly — no pseudo-node wrapping needed.
 *
 * Separately, `activationInfo(id)` (synchronous, NOT part of `edges()`) exposes
 * `defaultEnabled`/`minEngineVersion` — real per-module metadata already sitting
 * in memory (no parsing needed at all), but not a "depends on" relationship to
 * anything, so it deliberately doesn't pretend to be one.
 *
 * An edge here means "this module's own config could touch that module," not
 * "it did, just now." Phase 2a/2b/2c/2d of the dependency work State-Track's
 * Phase 1 (core/state-track.js) was built as a foundation for — see
 * MODULES.md's State-Track section. A later, separate phase watches which of
 * these possible edges actually fire during live processing, and a further
 * phase after that would act on the combined picture (a "director" that
 * sequences module requests) — neither is attempted here.
 */

/** The bare hostname of a URL, or 'unknown' for anything that doesn't parse — never throws. */
function hostnameOf(url) {
    try { return new URL(String(url)).hostname || 'unknown'; }
    catch { return 'unknown'; }
}

// Matches a literal string argument only — `host.services.request(someVar)` is
// invisible to this, same "a non-literal is simply not found" limitation the
// existing `version` field regex in module-engine.js already accepts. Assumes
// the host parameter is actually named `host`, the one convention every module
// contract in this codebase already follows (`activate(host)`/`render(container, host)`
// — see MODULES.md's module contract). Both real, honest limitations of
// regex-based parsing — not attempting a real JS parser/AST for this.
//
// `\s*` between `host.services` and the method name tolerates the call being
// split across lines (`host.services\n    .ask('tracker', ...)`, common with
// this codebase's own formatting for a long argument list) — confirmed against
// modules/music/index.js's real `host.services\n.ask('tracker', 'classify', ...)`
// call, which a stricter same-line-only pattern missed entirely on first pass.
const SERVICE_REGISTER_RE = /host\.services\s*\.\s*register\(\s*['"`]([\w-]+)['"`]/g;
const SERVICE_CONSUME_RE = /host\.services\s*\.\s*(?:request|get|ask)\(\s*['"`]([\w-]+)['"`]/g;

// Same literal-string-only, `host`-parameter-named limitations as the service
// patterns above. `EVENT_SUBSCRIBE_RE` also matches host.onChatChanged() as a
// zero-width fake "event name" isn't possible with one shared pattern, so it's
// its own check below instead of trying to force it into this regex.
const EVENT_SUBSCRIBE_RE = /host\s*\.\s*onEvent\(\s*['"`]([\w]+)['"`]/g;
const CHAT_CHANGED_RE = /host\s*\.\s*onChatChanged\(/;
const DATA_READ_RE = /host\s*\.\s*data\s*\.\s*(?:read|subscribe)\(\s*['"`]([\w-]+)['"`]/g;
const DATA_WRITE_RE = /host\s*\.\s*data\s*\.\s*write\(\s*['"`]([\w-]+)['"`]/g;

export class DependencyScanner {
    #bus;
    #listModuleIds;
    #getModuleMeta;
    // Populated by scanServiceContracts() / scanActivationConditions() — unlike
    // the two synchronous sources above, neither can be recomputed fresh+cheap
    // on every edges() call (both mean fetching every module's source over the
    // network), so each is scanned once and cached until its own next scan.
    #serviceEdges = [];
    #activationEdges = [];

    /**
     * `getModuleMeta(id)`, optional, is ONLY for `activationInfo()` below — a
     * `{ defaultEnabled, minEngineVersion }` accessor (or nullish fields/null
     * for an unknown id). Kept separate from `listModuleIds`/`bus` because it's
     * real per-module metadata, not something this class discovers by parsing
     * or aggregating — see the file doc comment for why that's not an edge.
     */
    constructor(bus, listModuleIds, getModuleMeta = () => null) {
        this.#bus = bus;
        this.#listModuleIds = listModuleIds;
        this.#getModuleMeta = getModuleMeta;
    }

    /**
     * Every edge, across every registered module, right now —
     * `{ consumer, owner, kind, detail }`. Combines two synchronous sources
     * (self-published edges via #publishedEdges, webhook edges via
     * #webhookEdges — no parsing/fetching happens in either, recomputed fresh
     * on every call) with whatever scanServiceContracts()/
     * scanActivationConditions() last found (cached — see their own doc
     * comments for why).
     */
    edges() {
        return [...this.#publishedEdges(), ...this.#webhookEdges(), ...this.#serviceEdges, ...this.#activationEdges];
    }

    /**
     * `{ defaultEnabled, minEngineVersion }` for one module — real, already-
     * in-memory metadata (no parsing/fetching needed at all), deliberately
     * NOT part of `edges()`: neither field is a "depends on another module"
     * relationship, so forcing them into the edge shape would be a stretch
     * just to reuse one abstraction for two different kinds of fact. Returns
     * `{ defaultEnabled: null, minEngineVersion: null }` for an unknown id or
     * when no `getModuleMeta` was given, never throws/returns undefined.
     */
    activationInfo(id) {
        const meta = this.#getModuleMeta(id);
        return { defaultEnabled: meta?.defaultEnabled ?? null, minEngineVersion: meta?.minEngineVersion ?? null };
    }

    /**
     * Fetches every module's own raw source (via `getSourceUrl(id)`, which the
     * caller supplies — this class stays decoupled from "how to find a
     * module's file," same as it doesn't know what a service name means
     * elsewhere) and regex-parses it for `host.services.*` calls — see the
     * file-level doc comment for what this technique is and its real, honest
     * limitations. Never throws: a module whose source can't be fetched/read
     * (network failure, no URL available, a 404) just contributes no edges —
     * this is a best-effort static graph, not a guarantee.
     *
     * A consumed service name with no known provider still becomes an edge —
     * owned by a `service:<name>` pseudo-node (same "still visible even when
     * unresolved" idea as `external:<hostname>` for webhooks above) — rather
     * than silently dropped, since "this module wants a service that doesn't
     * exist" is itself useful information (a typo, or a provider not yet
     * scanned/registered).
     */
    async scanServiceContracts(getSourceUrl, { fetchImpl = fetch } = {}) {
        const ids = this.#listModuleIds();
        const sources = await Promise.all(ids.map(async id => {
            try {
                const url = await getSourceUrl(id);
                if (!url) return [id, null];
                const response = await fetchImpl(url);
                return [id, response.ok ? await response.text() : null];
            } catch {
                return [id, null];
            }
        }));

        const providerOf = new Map();
        for (const [id, text] of sources) {
            if (!text) continue;
            for (const match of text.matchAll(SERVICE_REGISTER_RE)) providerOf.set(match[1], id);
        }

        const seen = new Set();
        const edges = [];
        for (const [id, text] of sources) {
            if (!text) continue;
            for (const match of text.matchAll(SERVICE_CONSUME_RE)) {
                const serviceName = match[1];
                const owner = providerOf.get(serviceName) ?? `service:${serviceName}`;
                if (owner === id) continue; // a module "consuming" its own registered service isn't a dependency
                const key = `${id} ${owner} ${serviceName}`;
                if (seen.has(key)) continue; // request()/get()/ask() on the same service in one module: one fact, not three edges
                seen.add(key);
                edges.push({ consumer: id, owner, kind: 'service', detail: serviceName });
            }
        }
        this.#serviceEdges = edges;
        return edges;
    }

    /**
     * Same fetch-and-regex-parse technique as scanServiceContracts() (see its
     * doc comment for the underlying "no build step -> every module's source
     * is fetchable text" reasoning and the shared, honest limitations), applied
     * to a different question: not "which module talks to which," but "what
     * triggers this module at all, and does it read anything outside its own
     * namespace." Kept as its OWN fetch pass rather than folded into
     * scanServiceContracts() — yes, that means fetching every module's source
     * a second time; a deliberate simplicity-over-micro-optimization choice
     * for a handful of small files fetched once per boot, not a fundamental
     * design fork (unlike the sourced-vs-published question scanServiceContracts
     * itself resolved).
     *
     * Three facts, three edge shapes:
     *  - `host.onEvent('NAME', ...)` → `{kind: 'event-subscription', owner: 'st-event:NAME'}`
     *    — an ST event isn't owned by any module, hence the pseudo-node, same
     *    idea as `external:<host>`/`service:<name>` elsewhere in this file.
     *  - `host.onChatChanged(...)` → the same shape, owner `'st-event:CHAT_CHANGED'`
     *    (ST's own real event name for it), just detected by presence rather
     *    than a captured argument.
     *  - `host.data.read/subscribe('namespace', ...)` where `namespace` isn't
     *    this module's own id → `{kind: 'data-read', owner: namespace}` — a
     *    REAL namespace, not a pseudo-node (unlike the two above, there IS a
     *    real thing on the other end: another module's own bus data, or
     *    `state-track` specifically).
     *  - `host.data.write('namespace', ...)` (only meaningful against a channel
     *    reserved with `allowExternalWrite: true`) → the same shape, one level
     *    up: `{kind: 'data-write', owner: namespace}` — the opposite direction
     *    from `data-read` (this module reaches INTO another namespace to write,
     *    not just observe it), kept as its own `kind` so a future consumer of
     *    this graph can tell read-only dependence from a write reaching across
     *    a module boundary.
     *
     *  No built-in module does either of the last two today (see MODULES.md —
     *  everything cross-module currently goes through `host.services` by
     *  convention, confirmed by grep before any of this was built), so both
     *  exist for third-party/future modules and to make a future State-Track
     *  dependency actually visible once something reads it.
     */
    async scanActivationConditions(getSourceUrl, { fetchImpl = fetch } = {}) {
        const ids = this.#listModuleIds();
        const sources = await Promise.all(ids.map(async id => {
            try {
                const url = await getSourceUrl(id);
                if (!url) return [id, null];
                const response = await fetchImpl(url);
                return [id, response.ok ? await response.text() : null];
            } catch {
                return [id, null];
            }
        }));

        const seen = new Set();
        const edges = [];
        const push = (id, owner, kind, detail) => {
            const key = `${id} ${owner} ${kind} ${detail}`;
            if (seen.has(key)) return;
            seen.add(key);
            edges.push({ consumer: id, owner, kind, detail });
        };
        for (const [id, text] of sources) {
            if (!text) continue;
            for (const match of text.matchAll(EVENT_SUBSCRIBE_RE)) push(id, `st-event:${match[1]}`, 'event-subscription', match[1]);
            if (CHAT_CHANGED_RE.test(text)) push(id, 'st-event:CHAT_CHANGED', 'event-subscription', 'CHAT_CHANGED');
            for (const match of text.matchAll(DATA_READ_RE)) {
                const namespace = match[1];
                if (namespace === id) continue; // reading your own namespace isn't a dependency
                push(id, namespace, 'data-read', namespace);
            }
            for (const match of text.matchAll(DATA_WRITE_RE)) {
                const namespace = match[1];
                if (namespace === id) continue; // writing your own namespace isn't a dependency
                push(id, namespace, 'data-write', namespace);
            }
        }
        this.#activationEdges = edges;
        return edges;
    }

    /** Edges a module explicitly published about itself — see the class doc comment above (Macros' `scanDependencies()` is the first real example). */
    #publishedEdges() {
        const rows = [];
        for (const consumer of this.#listModuleIds()) {
            const published = this.#bus.get(consumer, 'dependencies', []);
            if (!Array.isArray(published)) continue;
            for (const edge of published) {
                if (!edge?.owner || edge.owner === consumer) continue; // no self-edges — reading your own namespace isn't a dependency
                rows.push({ consumer, owner: String(edge.owner), kind: edge.kind ?? 'unknown', detail: edge.detail ?? null });
            }
        }
        return rows;
    }

    /**
     * Edges derived directly from every module's own reserved channels' webhook
     * config (`reserve()`'s `webhook: { pushUrl, pullUrl }` option — see
     * core/data-bus.js) — no per-module parsing needed, this is already generic
     * bus metadata. `pull` (the channel's value depends on an external source)
     * and `push` (the channel notifies an external system on every write) are
     * tagged with different `kind`s: they're opposite directions — a push is an
     * outbound EFFECT, not something this module depends on, but the user asked
     * for both to be visible in the graph, just distinguishable.
     *
     * The owner of both is a generic `external:<hostname>` pseudo-node, not a
     * real module id — an external HTTP endpoint isn't part of the module
     * ordering this graph is ultimately for, and isn't something a future
     * director would ever need to sequence relative to generation (it polls or
     * gets pushed to on its own schedule, independent of any generation cycle —
     * "it already delivered the information," not something to wait on). Only
     * the bare hostname is kept, deliberately — a webhook URL can carry a
     * token/key in its query string, and that has no business ending up in a
     * graph that may surface in the dev panel or logs later.
     */
    #webhookEdges() {
        const rows = [];
        for (const consumer of this.#listModuleIds()) {
            for (const channel of this.#bus.listChannels(consumer)) {
                if (!channel.webhook) continue;
                const full = this.#bus.describe(channel.namespace, channel.key);
                if (channel.webhook.pull && full?.webhook?.pullUrl) {
                    const host = hostnameOf(full.webhook.pullUrl);
                    rows.push({ consumer, owner: `external:${host}`, kind: 'webhook-pull', detail: host });
                }
                if (channel.webhook.push && full?.webhook?.pushUrl) {
                    const host = hostnameOf(full.webhook.pushUrl);
                    rows.push({ consumer, owner: `external:${host}`, kind: 'webhook-push', detail: host });
                }
            }
        }
        return rows;
    }

    /** Every distinct module/namespace id `consumerId` has been observed possibly depending on, across every kind. */
    dependenciesOf(consumerId) {
        return [...new Set(this.edges().filter(edge => edge.consumer === consumerId).map(edge => edge.owner))];
    }

    /** The opposite direction — every module that depends on `ownerId` ("who needs me before I change"). */
    dependentsOf(ownerId) {
        return [...new Set(this.edges().filter(edge => edge.owner === ownerId).map(edge => edge.consumer))];
    }
}
