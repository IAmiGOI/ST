/**
 * A small, generic named-event pub/sub — not specific to any one core service. Any
 * independent core that wants "fire a named event, let others subscribe" without
 * pulling in the whole `ModuleDataBus` channel machinery (schema/ownership/persist)
 * can use this directly. Deliberately minimal: three methods, no wildcard/namespace
 * support, no history — a service that wants more can build it on top of this.
 */
export class EventEmitter {
    #listeners = new Map(); // type -> Set<listener>

    /** Subscribes `listener` to `type`. Returns an unsubscribe function. */
    on(type, listener) {
        const set = this.#listeners.get(type) ?? new Set();
        set.add(listener);
        this.#listeners.set(type, set);
        return () => this.off(type, listener);
    }

    off(type, listener) {
        const set = this.#listeners.get(type);
        if (!set) return;
        set.delete(listener);
        if (!set.size) this.#listeners.delete(type);
    }

    /**
     * Calls every listener subscribed to `type` with `payload`. A snapshot, not a live
     * iteration (see core/data-bus.js's own listener dispatch for why that matters — a
     * listener that subscribes a new listener to the same type mid-dispatch must not
     * have that new listener visited in the same pass). One listener throwing is
     * caught and logged, never blocks the others.
     */
    emit(type, payload) {
        for (const listener of [...(this.#listeners.get(type) ?? [])]) {
            try { listener(payload); }
            catch (error) { console.error(`[EventEmitter] A "${type}" listener threw:`, error); }
        }
    }
}
