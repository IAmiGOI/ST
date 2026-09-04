/**
 * An independent core service — NOT a module, NOT owned by `ModuleEngine` (same
 * reasoning as core/lorebook-service.js's own "Independent core services" doc
 * comment). It only ever touches the DOM and the `ModuleDataBus` instance it's
 * given; `index.js` constructs and shares it the same way it shares
 * `LorebookService` — reached by modules purely through the bus:
 * `host.data.read('chat-badges', 'api')`.
 *
 * The problem this exists to fix: a "badge" (RP Time's clock, Post-Turn
 * Processor's change diff) is a small DOM decoration appended under a message,
 * separate from `message.mes`/`.extra` — but `context.updateMessageBlock()`
 * re-renders that message's DOM straight from its stored `.mes`/`.extra`, and
 * anything a DIFFERENT module had separately appended into that same
 * `.mes_text` element is wiped out by that re-render, since it was never part
 * of what `updateMessageBlock()` reproduces. Before this service existed, each
 * badge-owning module only ever re-applied its OWN badge reactively (its own
 * event handler, or a chat reload) — with no way to know a SIBLING module's
 * later `updateMessageBlock()` call had just erased it from underneath.
 * Confirmed live: Post-Turn Processor rewriting a message RP Time had already
 * time-stamped silently erased the time badge from the visible chat, even
 * though `message.extra.stme_rp_time` was still correctly set the whole time.
 *
 * Fix: whoever calls `updateMessageBlock()` also calls this service's own
 * `reapply(mesid, message)` right after — it re-renders EVERY registered
 * badge for that message (not just the caller's own), so no other module's
 * decoration is ever silently lost to someone else's content rewrite. Each
 * renderer is a pure `(message) => Node | null` derived fresh from the
 * message's own current `.extra`, never from a cached label — the same
 * "re-derive, don't separately track" discipline RP Time's own
 * `getCurrentTime()` already uses for the same class of staleness bug.
 */
export class ChatBadgeService {
    #getContext;
    #renderers = new Map(); // ownerId -> (message, mesid) => Node|null
    #chatChangedDispatching = false;
    #unsubscribeChatChanged = null;

    constructor(getContext, bus) {
        this.#getContext = getContext;
        bus.set('chat-badges', 'api', {
            register: (ownerId, render) => this.register(ownerId, render),
            reapply: (mesid, message) => this.reapply(mesid, message),
            refreshAll: () => this.refreshAll(),
        });
    }

    /**
     * Subscribes to CHAT_CHANGED so a fresh page load or chat switch re-applies
     * every registered badge on its own — no participating module needs its own
     * near-identical "re-walk the whole chat on chat-changed" handler just for
     * this. Same lightweight reentrancy guard as LorebookService's own start():
     * refreshAll() never calls anything on ST that plausibly re-triggers
     * CHAT_CHANGED (pure DOM reads/writes), so a simple "don't re-enter while
     * already refreshing" flag is enough — no burst window needed. Call once,
     * from index.js.
     */
    start() {
        const context = this.#getContext();
        if (context.eventTypes?.CHAT_CHANGED && context.eventSource?.on) {
            const handler = () => {
                if (this.#chatChangedDispatching) return;
                this.#chatChangedDispatching = true;
                try { this.refreshAll(); }
                catch (error) { console.error('[ST Module Engine][chat-badges] refreshAll() on CHAT_CHANGED failed:', error); }
                finally { this.#chatChangedDispatching = false; }
            };
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, handler);
            this.#unsubscribeChatChanged = () => context.eventSource.off?.(context.eventTypes.CHAT_CHANGED, handler);
        }
    }

    /** Stops reacting to chat changes. Not currently called anywhere (this service lives for the page's lifetime), provided for symmetry/tests. */
    stop() {
        this.#unsubscribeChatChanged?.();
        this.#unsubscribeChatChanged = null;
    }

    /**
     * Declares `ownerId`'s badge renderer. `render(message, mesid)` must be pure
     * and cheap — called on every reapply()/refreshAll(), for every message, not
     * just ones this owner actually stamped; return `null` for a message with
     * nothing to show. Returns an unregister function — call it from the owning
     * module's own cleanup (this service has no way to know when a module
     * disables itself; it only ever holds what's registered).
     *
     * The returned function also sweeps this owner's already-rendered badges out
     * of the whole current chat, not just future ones — a disabled module's own
     * decoration should stop being visible immediately, the same way its bus
     * channels/tools/tool registrations are actively cleared on disable rather
     * than merely stopping future updates (see ModuleEngine.disable()'s own
     * belt-and-suspenders sweeps). Without this, unregistering only stops the
     * badge from being refreshed going forward — the last-rendered node would
     * silently linger in the DOM until an unrelated chat reload happened to
     * rebuild it away.
     */
    register(ownerId, render) {
        this.#renderers.set(ownerId, render);
        return () => {
            if (this.#renderers.get(ownerId) !== render) return;
            this.#renderers.delete(ownerId);
            const chat = this.#getContext()?.chat ?? [];
            for (const [index, message] of chat.entries()) {
                const mesid = message.mesid ?? index;
                document.querySelector(`.mes[mesid="${mesid}"] .mes_text, #chat .mes[mesid="${mesid}"] .mes_text`)
                    ?.querySelector(`[data-stme-badge-owner="${ownerId}"]`)?.remove();
            }
        };
    }

    /**
     * Re-renders every registered badge for ONE message, replacing whatever this
     * service itself previously appended (tagged via `data-stme-badge-owner`) —
     * never touching any other DOM under the message that isn't one of its own
     * tagged badges. A no-op if that message isn't currently in the DOM at all
     * (e.g. scrolled out in a virtualized chat, or applied before the first
     * render) — there's nothing to fix up yet; the next real chat load calls
     * refreshAll() instead.
     */
    reapply(mesid, message) {
        const root = document.querySelector(`.mes[mesid="${mesid}"] .mes_text, #chat .mes[mesid="${mesid}"] .mes_text`);
        if (!root) return;
        for (const [ownerId, render] of this.#renderers) {
            root.querySelector(`[data-stme-badge-owner="${ownerId}"]`)?.remove();
            let node;
            try { node = render(message, mesid); }
            catch (error) { console.error(`[ST Module Engine][chat-badges] "${ownerId}"'s badge renderer threw:`, error); continue; }
            if (node) { node.dataset.stmeBadgeOwner = ownerId; root.append(node); }
        }
    }

    /** Re-applies every registered badge across the WHOLE current chat — for a fresh page load or chat switch, where the DOM itself is new rather than one message's content having just changed. */
    refreshAll() {
        const chat = this.#getContext()?.chat ?? [];
        chat.forEach((message, index) => this.reapply(message.mesid ?? index, message));
    }
}
