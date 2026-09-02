/** In-memory, namespaced data exchange between engine modules; it does not use ST state. */
export class ModuleDataBus {
    #values = new Map();
    #listeners = new Map();
    #key(namespace, key) { return `${namespace}:${key}`; }
    get(namespace, key, fallback) { return this.#values.has(this.#key(namespace, key)) ? this.#values.get(this.#key(namespace, key)) : fallback; }
    set(namespace, key, value) { const id = this.#key(namespace, key); this.#values.set(id, value); for (const listener of this.#listeners.get(id) ?? []) listener(value); return value; }
    remove(namespace, key) { return this.#values.delete(this.#key(namespace, key)); }
    subscribe(namespace, key, listener) { const id = this.#key(namespace, key); const listeners = this.#listeners.get(id) ?? new Set(); listeners.add(listener); this.#listeners.set(id, listeners); return () => { listeners.delete(listener); if (!listeners.size) this.#listeners.delete(id); }; }
}
