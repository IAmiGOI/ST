const HISTORY_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_WRITES = 20;
const MIN_PULL_INTERVAL_MS = 5000;
const BUS_METADATA_KEY = 'stme_bus';

/** `schema` is a validator function `(value) => true | undefined | string(error)`, or a shape descriptor `{ type, required }`. Returns an error string, or null if valid. */
function validateValue(schema, value) {
    if (!schema) return null;
    if (typeof schema === 'function') {
        const result = schema(value);
        if (result === true || result === undefined) return null;
        return typeof result === 'string' ? result : 'Value failed its channel schema.';
    }
    if (typeof schema === 'object') {
        const { type, required } = schema;
        if (type) {
            const actual = Array.isArray(value) ? 'array' : typeof value;
            if (actual !== type) return `Expected ${type}, got ${actual}.`;
        }
        if (required?.length) {
            if (typeof value !== 'object' || value === null) return 'Expected an object with required fields.';
            for (const field of required) if (!(field in value)) return `Missing required field "${field}".`;
        }
        return null;
    }
    return null;
}

/**
 * Namespaced pub/sub value store shared between engine modules ("the bus"),
 * plus an opt-in layer on top: a module can RESERVE one of its own keys as a
 * named, schema-checked, access-controlled CHANNEL — the difference between
 * "somebody wrote something" and "this is a known, protected contract other
 * code can rely on." Reservation is optional; plain get/set/subscribe on an
 * unreserved key works exactly as before (no schema, no protection).
 *
 * Protections, applied on every write to a reserved channel:
 *  - schema: a malformed value is rejected, logged, and never reaches subscribers.
 *  - ownership: a write from outside the owning module is rejected unless the
 *    channel was reserved with `allowExternalWrite: true`.
 *  - rate limit: more than RATE_LIMIT_MAX_WRITES writes/second to one channel
 *    trips a circuit breaker for that channel (guards against a runaway loop
 *    in a misbehaving module).
 *  - macro name collisions: reserving a `macro` name already used by a different
 *    channel is refused for the newcomer — the first channel keeps the macro.
 * A rejected write is called "contamination" here — it never reaches `#values`
 * or subscribers, and the last valid value stays in place.
 *
 * Backup: every accepted write keeps the last HISTORY_LIMIT values with
 * timestamps (`history()`), and a reserved channel can be rolled back to any
 * of them (`restore()`) without going through validation again.
 */
export class ModuleDataBus {
    #values = new Map();
    #history = new Map();
    #listeners = new Map();
    #channels = new Map();
    #macros = new Map();
    #writeTimestamps = new Map();
    #pullTimers = new Map();
    #getContext;
    #onContaminate;

    constructor({ getContext, onContaminate } = {}) {
        this.#getContext = getContext;
        this.#onContaminate = onContaminate;
    }

    #id(namespace, key) { return `${namespace}:${key}`; }

    get(namespace, key, fallback) {
        const id = this.#id(namespace, key);
        return this.#values.has(id) ? this.#values.get(id) : fallback;
    }

    /** Owner write (namespace === the writer). Validated if the key is reserved. */
    set(namespace, key, value) {
        return this.#applyWrite(namespace, key, value, namespace);
    }

    /** Cross-module write: `writerNamespace` is whoever is actually calling this, not `namespace`. */
    write(namespace, key, value, writerNamespace) {
        return this.#applyWrite(namespace, key, value, writerNamespace ?? namespace);
    }

    remove(namespace, key) {
        const id = this.#id(namespace, key);
        if (this.#channels.get(id)?.persist) this.#clearPersisted(id);
        return this.#values.delete(id);
    }

    subscribe(namespace, key, listener) {
        const id = this.#id(namespace, key);
        const listeners = this.#listeners.get(id) ?? new Set();
        listeners.add(listener);
        this.#listeners.set(id, listeners);
        return () => { listeners.delete(listener); if (!listeners.size) this.#listeners.delete(id); };
    }

    /**
     * Declares a channel owned by `namespace`. There is no id-level "owner
     * conflict" to detect: `id` is `${namespace}:${key}` and `reserve()` is
     * only ever called through `host.data.reserve()`, which hardcodes the
     * caller's own module id as `namespace` — two different modules can never
     * produce the same id. Re-reserving is always the SAME module redeclaring
     * its own channel (e.g. after a settings change), so it's just applied —
     * except the `macro` name, which lives in a separate, shared namespace and
     * CAN collide with a different channel (see the `macro` handling below).
     *
     * `persist: true` backs the channel with `chatMetadata` (point 3: the bus
     * survives a page reload) — see the "Per-chat persistence" section.
     */
    reserve(namespace, key, { name, schema, allowExternalWrite = false, macro, webhook, persist = false } = {}) {
        const id = this.#id(namespace, key);
        const existing = this.#channels.get(id);
        if (existing?.macro && existing.macro !== macro) this.#unregisterMacro(existing.macro);
        if (existing?.webhook) this.#stopPulling(id);

        const channel = { namespace, key, name, schema, allowExternalWrite, macro, webhook, persist, ownerId: namespace };
        this.#channels.set(id, channel);

        if (persist && !this.#values.has(id)) {
            const stored = this.#readPersisted(id);
            if (stored !== undefined) this.#values.set(id, stored);
        }

        if (macro) {
            const collidingId = this.#macros.get(macro);
            if (collidingId && collidingId !== id) {
                this.#contaminate({ type: 'macro-collision', id, message: `Macro name "${macro}" is already used by channel "${collidingId}" — not registered for "${id}".` });
            } else {
                this.#registerMacro(macro, id);
                this.#macros.set(macro, id);
            }
        }
        if (webhook?.pullUrl) {
            if (!allowExternalWrite) console.warn(`[ST Module Engine][bus] "${id}" has a pull webhook but allowExternalWrite is false — pulled data will be rejected until it's enabled.`);
            this.#startPulling(id, channel);
        }

        return Object.freeze({ id, unreserve: () => this.#unreserve(id) });
    }

    #unreserve(id) {
        const channel = this.#channels.get(id);
        if (!channel) return;
        if (channel.macro) this.#unregisterMacro(channel.macro);
        this.#stopPulling(id);
        this.#channels.delete(id);
    }

    /** Called by the engine when a module is disabled — cleans up every channel/macro/timer it owned, even if the module's own cleanup forgot to. */
    releaseNamespace(namespace) {
        for (const [id, channel] of [...this.#channels.entries()]) if (channel.ownerId === namespace) this.#unreserve(id);
        const prefix = `${namespace}:`;
        for (const id of [...this.#values.keys()]) if (id.startsWith(prefix)) this.#values.delete(id);
        for (const id of [...this.#history.keys()]) if (id.startsWith(prefix)) this.#history.delete(id);
    }

    describe(namespace, key) {
        const channel = this.#channels.get(this.#id(namespace, key));
        return channel ? { ...channel } : null;
    }

    listChannels(namespace) {
        return [...this.#channels.values()]
            .filter(channel => !namespace || channel.ownerId === namespace)
            .map(channel => ({
                id: this.#id(channel.namespace, channel.key), namespace: channel.namespace, key: channel.key, name: channel.name ?? null,
                hasSchema: Boolean(channel.schema), allowExternalWrite: channel.allowExternalWrite, persist: Boolean(channel.persist),
                macro: channel.macro ?? null, webhook: channel.webhook ? { push: Boolean(channel.webhook.pushUrl), pull: Boolean(channel.webhook.pullUrl) } : null,
            }));
    }

    /** Finds a channel by its human `name` (reservation logistics can address a channel by id OR by name). */
    findByName(name) {
        const channel = [...this.#channels.values()].find(item => item.name === name);
        return channel ? { id: this.#id(channel.namespace, channel.key), ...channel } : null;
    }

    history(namespace, key) {
        return [...(this.#history.get(this.#id(namespace, key)) ?? [])];
    }

    /** Rolls a reserved (or plain) key back to a past value. `stepsBack: 1` = the value right before the current one. Bypasses validation — restoring a once-valid value is always allowed. */
    restore(namespace, key, stepsBack = 1) {
        const id = this.#id(namespace, key);
        const entry = (this.#history.get(id) ?? [])[stepsBack];
        if (!entry) return false;
        this.#values.set(id, entry.value);
        for (const listener of this.#listeners.get(id) ?? []) listener(entry.value);
        return true;
    }

    #applyWrite(namespace, key, value, writerNamespace) {
        const id = this.#id(namespace, key);
        const channel = this.#channels.get(id);

        if (channel && writerNamespace !== channel.ownerId && !channel.allowExternalWrite) {
            this.#contaminate({ type: 'unauthorized-write', id, writer: writerNamespace, message: `"${writerNamespace}" tried to write into "${id}" (owned by "${channel.ownerId}"); rejected — allowExternalWrite is off.` });
            return false;
        }
        if (channel?.schema) {
            const error = validateValue(channel.schema, value);
            if (error) { this.#contaminate({ type: 'schema-violation', id, writer: writerNamespace, message: `"${id}": ${error}` }); return false; }
        }
        if (this.#isRateLimited(id)) {
            this.#contaminate({ type: 'rate-limited', id, writer: writerNamespace, message: `"${id}" received more than ${RATE_LIMIT_MAX_WRITES} writes/s — throttled, this write was dropped.` });
            return false;
        }

        const list = this.#history.get(id) ?? [];
        list.unshift({ value, at: Date.now() });
        list.length = Math.min(list.length, HISTORY_LIMIT);
        this.#history.set(id, list);

        this.#values.set(id, value);
        for (const listener of this.#listeners.get(id) ?? []) listener(value);
        if (channel?.persist) this.#writePersisted(id, value);
        if (channel?.webhook?.pushUrl) this.#pushWebhook(channel, value);
        return true;
    }

    #isRateLimited(id) {
        const now = Date.now();
        const recent = (this.#writeTimestamps.get(id) ?? []).filter(at => now - at < RATE_LIMIT_WINDOW_MS);
        recent.push(now);
        this.#writeTimestamps.set(id, recent);
        return recent.length > RATE_LIMIT_MAX_WRITES;
    }

    #contaminate(report) {
        console.warn(`[ST Module Engine][bus] ${report.type}: ${report.message}`);
        this.#onContaminate?.(report);
    }

    // --- Per-chat persistence (point 3: a reserved channel survives a page reload) ---
    //
    // Backed by chatMetadata, exactly like Tracker/Notebook's own durable state — so
    // "inside the chat" here means the same thing it already means everywhere else in
    // this codebase. Opt-in per channel (`persist: true`): most bus traffic is cheap,
    // derived, or simply not worth writing to disk on every tick, so nothing is ever
    // persisted unless a channel explicitly asks for it. Values only, never functions
    // or DOM nodes — those were never serializable in the first place (see MODULES.md).

    #readPersisted(id) {
        const store = this.#getContext?.()?.chatMetadata?.[BUS_METADATA_KEY];
        return store && Object.prototype.hasOwnProperty.call(store, id) ? store[id] : undefined;
    }

    #writePersisted(id, value) {
        const context = this.#getContext?.();
        if (!context) return;
        context.chatMetadata ??= {};
        const store = context.chatMetadata[BUS_METADATA_KEY] ??= {};
        store[id] = value;
        context.saveMetadataDebounced?.();
    }

    #clearPersisted(id) {
        const context = this.#getContext?.();
        const store = context?.chatMetadata?.[BUS_METADATA_KEY];
        if (store && id in store) { delete store[id]; context.saveMetadataDebounced?.(); }
    }

    // --- ST macro exposure (block kind 2: readable anywhere ST itself parses {{macros}}) ---

    #registerMacro(name, id) {
        const context = this.#getContext?.();
        if (!context) return;
        const read = () => {
            const value = this.#values.get(id);
            if (value == null) return '';
            return typeof value === 'string' ? value : JSON.stringify(value);
        };
        // Modern engine (staging-only as of this writing) first; legacy getContext() API as the fallback everyone on a stable release actually has.
        if (typeof context.macros?.register === 'function') {
            context.macros.register(name, { handler: read, category: 'STATE', description: `ST Module Engine bus channel "${id}".` });
        } else if (typeof context.registerMacro === 'function') {
            context.registerMacro(name, read);
        }
    }

    #unregisterMacro(name) {
        const context = this.#getContext?.();
        if (!context) return;
        if (typeof context.macros?.registry?.unregisterMacro === 'function') context.macros.registry.unregisterMacro(name);
        else context.unregisterMacro?.(name);
    }

    // --- External-world I/O (block kind 3): push on write, pull on an interval. Never a listening server — a browser extension cannot accept inbound connections. ---

    async #pushWebhook(channel, value) {
        if (!channel.webhook?.pushUrl) return;
        try {
            await fetch(channel.webhook.pushUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: this.#id(channel.namespace, channel.key), name: channel.name ?? null, value, at: Date.now() }),
            });
        } catch (error) {
            console.warn(`[ST Module Engine][bus] webhook push failed for "${this.#id(channel.namespace, channel.key)}":`, error);
        }
    }

    #startPulling(id, channel) {
        this.#stopPulling(id);
        if (!channel.webhook?.pullUrl) return;
        const intervalMs = Math.max(Number(channel.webhook.pullIntervalMs) || MIN_PULL_INTERVAL_MS, MIN_PULL_INTERVAL_MS);
        const timer = setInterval(async () => {
            try {
                const response = await fetch(channel.webhook.pullUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                this.#applyWrite(channel.namespace, channel.key, data, '__external_pull__');
            } catch (error) {
                console.warn(`[ST Module Engine][bus] webhook pull failed for "${id}":`, error);
            }
        }, intervalMs);
        this.#pullTimers.set(id, timer);
    }

    #stopPulling(id) {
        const timer = this.#pullTimers.get(id);
        if (timer) { clearInterval(timer); this.#pullTimers.delete(id); }
    }
}
