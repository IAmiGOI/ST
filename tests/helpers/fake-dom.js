/**
 * A minimal but real fake DOM for tests that need to drive `core/dom.js`'s
 * `h()`/`list()`/`show()` for real — actual tree operations
 * (append/prepend/after/remove/firstChild/nextSibling) and a real `instanceof
 * Node` check are needed, or `appendChildren()` treats every child as "not a
 * Node" and stringifies it instead. Event listeners are recorded, not really
 * dispatched — call `.fire(type)` directly, which is all a real browser's
 * dispatch would do differently is invoke the same recorded handler.
 *
 * First built for tests/postprocess-render-persistence.test.js (a real render()
 * bug only a real render() call — building the real TextArea/bind:value wiring —
 * could catch); factored out here once a second module needed the same thing.
 */
export class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.childNodes = [];
        this.parentNode = null;
        this.dataset = {};
        this.style = {};
        this.value = '';
        this.textContent = '';
        this.className = '';
        this.checked = false;
        this._listeners = new Map();
        this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
    }
    addEventListener(type, fn) { const set = this._listeners.get(type) ?? new Set(); set.add(fn); this._listeners.set(type, set); }
    removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
    fire(type, eventOverrides = {}) {
        for (const fn of [...(this._listeners.get(type) ?? [])]) {
            fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...eventOverrides });
        }
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    get nextSibling() {
        if (!this.parentNode) return null;
        return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null;
    }
    append(...nodes) {
        for (const raw of nodes) {
            const child = typeof raw === 'string' ? document.createTextNode(raw) : raw;
            child.parentNode?._removeChild(child);
            this.childNodes.push(child);
            child.parentNode = this;
        }
    }
    prepend(...nodes) {
        for (const raw of [...nodes].reverse()) {
            raw.parentNode?._removeChild(raw);
            this.childNodes.unshift(raw);
            raw.parentNode = this;
        }
    }
    after(...nodes) {
        if (!this.parentNode) return;
        const idx = this.parentNode.childNodes.indexOf(this);
        this.parentNode.childNodes.splice(idx + 1, 0, ...nodes);
        for (const n of nodes) n.parentNode = this.parentNode;
    }
    remove() { this.parentNode?._removeChild(this); }
    _removeChild(child) {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        child.parentNode = null;
    }
    replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
    querySelector() { return null; }
    setAttribute(key, value) { this[key] = value; }
    removeAttribute(key) { delete this[key]; }
    setSelectionRange() {}
    get selectionStart() { return String(this.value ?? '').length; }
    get selectionEnd() { return String(this.value ?? '').length; }
}

/**
 * Installs `globalThis.Node`/`globalThis.document` and returns `{ created }`,
 * a map of tag name -> array of every element created of that tag, for tests
 * that need to find a specific rendered node without walking the whole tree by
 * hand. Pair with `restoreFakeDom(previous)` (capture via `captureRealDom()`
 * before installing) in a `test.afterEach`.
 */
export function installFakeDom(trackedTags = ['textarea', 'select', 'input']) {
    const created = Object.fromEntries(trackedTags.map(tag => [tag, []]));
    globalThis.Node = FakeNode;
    globalThis.document = {
        createElement: tag => {
            const node = new FakeNode(tag);
            if (created[tag]) created[tag].push(node);
            return node;
        },
        createTextNode: text => { const node = new FakeNode('#text'); node.textContent = text; return node; },
    };
    return { created };
}

export function captureRealDom() {
    return { document: globalThis.document, Node: globalThis.Node };
}

export function restoreRealDom(previous) {
    globalThis.document = previous.document;
    globalThis.Node = previous.Node;
}

/** Depth-first search for the first descendant (or `root` itself) whose `.value` strictly equals `value`. */
export function findByValue(root, value) {
    if (root.value === value) return root;
    for (const child of root.childNodes) {
        const found = findByValue(child, value);
        if (found) return found;
    }
    return null;
}
