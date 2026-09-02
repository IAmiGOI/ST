import { effect, isSignal } from './reactive.js';

const disposers = new WeakMap();

function own(node, dispose) {
    if (!disposers.has(node)) disposers.set(node, []);
    disposers.get(node).push(dispose);
    return dispose;
}

function disposeTree(node) {
    const list = disposers.get(node);
    if (list) { for (const dispose of list) dispose(); disposers.delete(node); }
    for (const child of node.childNodes ?? []) disposeTree(child);
}

/**
 * Watches `container` for removed nodes and disposes their effects automatically,
 * so a module never has to manually track/unsubscribe DOM-bound effects — removing
 * an element from the tree (directly, or as part of a `list()` diff) is enough.
 * Returns a function that stops watching (call it from the module's own cleanup).
 */
export function autoDispose(container) {
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) for (const node of mutation.removedNodes) disposeTree(node);
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
}

function setAttr(el, key, value) {
    if (value === false || value == null) { el.removeAttribute(key); return; }
    el.setAttribute(key, value === true ? '' : String(value));
}

const DOM_PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'textContent', 'className', 'open']);

function applyProp(el, key, value) {
    if (key.startsWith('on:')) { el.addEventListener(key.slice(3), value); return; }
    if (key.startsWith('bind:')) { bindValue(el, key.slice(5), value); return; }
    if (key === 'ref') { if (typeof value === 'function') value(el); return; }
    if (key === 'class') {
        if (isSignal(value)) own(el, effect(() => { el.className = value() ?? ''; }));
        else el.className = value ?? '';
        return;
    }
    if (key === 'style' && value && typeof value === 'object') { Object.assign(el.style, value); return; }

    if (isSignal(value)) {
        own(el, effect(() => setProp(el, key, value())));
        return;
    }
    setProp(el, key, value);
}

function setProp(el, key, value) {
    if (DOM_PROPS.has(key)) { el[key] = value; return; }
    setAttr(el, key, value);
}

/** Two-way binds an <input>/<textarea>/<select> to a signal via `bind:value` or `bind:checked`. */
function bindValue(el, kind, sig) {
    own(el, effect(() => { const next = sig(); if (el[kind] !== next) el[kind] = next; }));
    el.addEventListener(kind === 'checked' ? 'change' : 'input', () => sig.set(el[kind]));
}

/** Hyperscript element builder. Props ending in a signal are kept live; children may be signals, nodes, or text. */
export function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) for (const [key, value] of Object.entries(props)) if (value !== undefined) applyProp(el, key, value);
    appendChildren(el, children.flat(Infinity));
    return el;
}

function appendChildren(el, children) {
    for (const child of children) {
        if (child == null || child === false) continue;
        if (child instanceof Node) { el.append(child); continue; }
        if (isSignal(child)) {
            const text = document.createTextNode('');
            own(el, effect(() => { text.textContent = child() ?? ''; }));
            el.append(text);
            continue;
        }
        el.append(document.createTextNode(String(child)));
    }
}

/**
 * Reactive keyed list: reuses and repositions existing DOM nodes across updates
 * instead of tearing everything down, so input focus/value and identity survive
 * an item being added/removed/reordered elsewhere in the same items array.
 *
 * Renders into an invisible `display:contents` wrapper rather than an anchor
 * comment: reordering via `cursor.after(node)` needs `cursor` to already have a
 * parent, and building against a bare comment fails silently while the caller's
 * `h()` tree is still detached. A wrapper's children can always be manipulated
 * even while the wrapper itself is detached, so this works regardless of when
 * the returned node gets attached.
 *
 * Not for elements with a strict content model (`<select>`, `<table>`/`<tbody>`)
 * — a wrapper div there is invisible to CSS but still breaks HTML parsing rules
 * (e.g. `<option>` inside a `<div>` inside `<select>` renders no options at all).
 * `widgets.js`'s `Select()` reconciles `<option>` children directly for that reason.
 */
export function list(itemsSignal, keyFn, renderItem) {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    const nodes = new Map();
    own(wrapper, effect(() => {
        const items = itemsSignal();
        const seen = new Set();
        let cursor = null;
        for (const item of items) {
            const key = keyFn(item);
            seen.add(key);
            let node = nodes.get(key);
            if (!node) { node = renderItem(item); nodes.set(key, node); }
            const desiredNext = cursor ? cursor.nextSibling : wrapper.firstChild;
            if (desiredNext !== node) { if (cursor) cursor.after(node); else wrapper.prepend(node); }
            cursor = node;
        }
        for (const [key, node] of nodes) {
            if (seen.has(key)) continue;
            node.remove();
            disposeTree(node);
            nodes.delete(key);
        }
    }));
    return wrapper;
}

/**
 * Reactively swaps a single child based on a signal's value — a `list()` of one,
 * for "which panel is showing" style state instead of a keyed collection. Whatever
 * `renderFn(value)` returns (a Node, or null/false to show nothing) fully replaces
 * the previous content whenever `valueSignal` changes to a genuinely different value
 * (dedup follows the same `Object.is` rule as `signal.set`, so a `computed()` that
 * settles back on an unchanged value correctly does not cause a re-render).
 */
export function show(valueSignal, renderFn) {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    let current = null;
    own(wrapper, effect(() => {
        const node = renderFn(valueSignal());
        if (current) { current.remove(); disposeTree(current); }
        current = node instanceof Node ? node : null;
        if (current) wrapper.append(current);
    }));
    return wrapper;
}

/** Replaces `root`'s content with `child` once. Use for the outer container render() receives. */
export function mount(root, child) {
    disposeTree(root);
    root.replaceChildren(child);
}

/** Ties an effect's lifetime to `node`: disposed automatically when `node` leaves a watched tree. For widget authors. */
export function effectOn(node, fn) {
    return own(node, effect(fn));
}

/**
 * Ties an arbitrary cleanup callback (not a reactive effect — e.g. a `host.data.subscribe`
 * unsubscribe, or an `onChatChanged` unsubscribe) to `node`'s lifetime. `render()` has no
 * cleanup of its own in the module contract, so this is how a module wires up bus/event
 * listeners from inside `render()` without leaking them when the module is disabled.
 */
export function onDispose(node, cleanup) {
    return own(node, cleanup);
}

export { effect, signal, computed, isSignal, unwrap } from './reactive.js';
