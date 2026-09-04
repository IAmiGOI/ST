import test from 'node:test';
import assert from 'node:assert/strict';
import { postprocessModule } from '../modules/postprocess/index.js';

/**
 * The reported bug: editing an EXISTING pass's Instruction (or any other
 * per-pass field) silently failed to persist. Root cause was in render():
 * `signal(sanitizePasses(settings.passes))` builds a signal from a freshly
 * COPIED array of freshly-copied pass objects — every per-pass field handler
 * then mutates one of those copies and calls host.saveModuleSettings(), but
 * `settings.passes` (what actually gets persisted) still points at the
 * ORIGINAL, unmutated array. The fix reassigns `settings.passes =
 * sanitizePasses(settings.passes)` first, so the signal and the persisted
 * settings share the exact same array/objects from the start — exactly the
 * pattern RP Time/Tracker's own render() already use for their own field/block
 * lists.
 *
 * This drives `postprocessModule.render()` through a real (if minimal) fake
 * DOM — the actual bug lived in object identity established at the top of
 * render(), before any UI is even built, so only a real render() call
 * (building the real TextArea/bind:value wiring) can catch a regression here;
 * a test that only calls sanitizePasses() in isolation would not.
 */

// --- A minimal but real DOM: `core/dom.js`'s h()/list()/show() need actual
// tree operations (append/prepend/after/remove/firstChild/nextSibling) and an
// `instanceof Node` check — a plain object graph without a shared base class
// would make every appended child look like "not a Node" and get stringified
// instead. Event listeners are recorded, not really dispatched — tests fire
// them directly via `.fire(type)`, which is all a real browser's dispatch
// would do differently is IS the recorded handler.
class FakeNode {
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

function installFakeDom() {
    const created = { textarea: [], select: [] };
    globalThis.Node = FakeNode;
    globalThis.document = {
        createElement: tag => {
            const node = new FakeNode(tag);
            if (tag === 'textarea') created.textarea.push(node);
            if (tag === 'select') created.select.push(node);
            return node;
        },
        createTextNode: text => { const node = new FakeNode('#text'); node.textContent = text; return node; },
    };
    return created;
}

const originalDocument = globalThis.document;
const originalNode = globalThis.Node;
test.afterEach(() => { globalThis.document = originalDocument; globalThis.Node = originalNode; });

function makeHost(settings) {
    return {
        moduleSettings: () => settings,
        saveModuleSettings: () => {},
        sidecar: { profiles: () => [{ id: 'default', name: 'Default' }] },
        toast: () => {},
    };
}

test('editing an EXISTING pass\'s instruction through the real render() UI actually persists into settings.passes', () => {
    const created = installFakeDom();
    const settings = {
        autoRun: true,
        // Shaped exactly like data loaded from a PREVIOUS session — never touched
        // by persistPasses() in this render() call, which is the precondition the
        // bug needed: settings.passes must NOT already be the sanitized array.
        passes: [{ id: 'p1', name: 'Polish', prompt: 'Old instruction.', profileId: 'default', enabled: true }],
    };
    const host = makeHost(settings);
    const container = document.createElement('div');

    postprocessModule.render(container, host);

    const promptArea = created.textarea.find(el => el.value === 'Old instruction.');
    assert.ok(promptArea, 'the rendered prompt textarea for the existing pass was not found');

    // Simulate real typing, then blur — the exact sequence a browser produces.
    promptArea.value = 'New instruction.';
    promptArea.fire('input');
    promptArea.fire('change');

    assert.equal(settings.passes[0].prompt, 'New instruction.', 'the edit must land in the SAME object settings.passes points at, not a detached copy');
});

test('editing the pass NAME through the real render() UI also persists — the bug affected every per-pass field, not just the instruction', () => {
    installFakeDom();
    const settings = { autoRun: true, passes: [{ id: 'p1', name: 'Old name', prompt: 'x', profileId: 'default', enabled: true }] };
    const host = makeHost(settings);
    const container = document.createElement('div');

    postprocessModule.render(container, host);

    // The name field is a TextInput (an <input>), not a textarea — this fake only
    // tracks textarea/select creation explicitly, so walk the tree for the one
    // node populated with the pass's current name instead.
    function findByValue(node, value) {
        if (node.value === value) return node;
        for (const child of node.childNodes) {
            const found = findByValue(child, value);
            if (found) return found;
        }
        return null;
    }
    const found = findByValue(container, 'Old name');
    assert.ok(found, 'the rendered name input for the existing pass was not found');

    found.value = 'New name';
    found.fire('input');
    found.fire('change');

    assert.equal(settings.passes[0].name, 'New name');
});

test('settings.passes and the array actually rendered are the same objects from the very first render() call — no add/remove/reorder needed to sync them', () => {
    installFakeDom();
    const settings = { autoRun: true, passes: [{ id: 'p1', name: 'A', prompt: 'x', profileId: 'default', enabled: true }] };
    const host = makeHost(settings);
    const container = document.createElement('div');

    postprocessModule.render(container, host);

    // render() must have sanitized settings.passes IN PLACE (same reference
    // reassigned), not left it as whatever was originally passed in with a
    // separate, detached sanitized copy living only inside the UI.
    assert.equal(settings.passes.length, 1);
    assert.deepEqual(Object.keys(settings.passes[0]).sort(), ['contextDepth', 'enabled', 'id', 'includeContext', 'name', 'profileId', 'prompt'].sort());
});
