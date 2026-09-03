import { h, list, effectOn, effect } from './dom.js';

const stopPropagation = event => event.stopPropagation();

/**
 * A small "ⓘ" badge that reveals a plain-language explanation on hover (or keyboard
 * focus — it's a real focusable element, not just a `title=` attribute, so the
 * tooltip is readable without a mouse and isn't stuck with the browser's own
 * unstyled, delayed native tooltip). Meant for the one-sentence "what is this,
 * really" explanation next to a card's title — aimed at someone who has never
 * configured an LLM extension before, not a technical reference (that belongs in
 * `description`/MODULES.md instead). `on:click` stops propagation so it never
 * toggles a parent `<details>` card open/closed.
 *
 * The tooltip anchors `left: 0` by default (CSS) and stays under `max-width` even on
 * a narrow panel — but a dot after a long title can sit far enough right in a narrow
 * card that a left-anchored tooltip still runs past the actual browser viewport (CSS
 * alone can't know where the dot ends up; `min(…, 100vw)` bounds the tooltip's own
 * size, not its position). `visibility: hidden` (not `display: none`) keeps the
 * tooltip laid out even while closed, so its real width is measurable before it's
 * ever shown — on hover/focus we check whether it would overflow the viewport at its
   default left-anchored position and flip to right-anchored if so.
 */
export function InfoDot(text) {
    const tooltip = h('span', { class: 'stme-info-tooltip' }, text);
    const reposition = () => {
        // Reset to the CSS default (flush with the dot's own left edge) before measuring —
        // `left` here is relative to the dot (position:relative), so the tooltip's actual
        // viewport position is dotRect.left + this offset. Clamp that viewport position into
        // [8, innerWidth - width - 8] and convert back to a dot-relative offset — this
        // handles overflow on EITHER side symmetrically (a binary left-vs-right flip alone
        // can still overflow the opposite edge on a narrow enough viewport, since the
        // tooltip's own width can approach the viewport's width there).
        tooltip.style.left = '0px';
        const dotRect = dot.getBoundingClientRect();
        const width = tooltip.offsetWidth;
        const clampedViewportLeft = Math.min(Math.max(dotRect.left, 8), window.innerWidth - width - 8);
        tooltip.style.left = `${clampedViewportLeft - dotRect.left}px`;
    };
    const dot = h('span', {
        class: 'stme-info-dot', tabindex: '0', role: 'note', 'aria-label': text, 'on:click': stopPropagation,
        'on:mouseenter': reposition, 'on:focus': reposition,
    }, 'i', tooltip);
    return dot;
}

/** Label + control row, matching the shared `.stme-field` look used across every module. */
export function Field(labelText, control, { hint, stack = false } = {}) {
    return h('label', { class: stack ? 'stme-field stme-field-stack' : 'stme-field' },
        h('span', { class: 'stme-field-label' }, labelText, hint ? h('small', {}, hint) : null),
        control,
    );
}

export function TextInput(valueSignal, { placeholder, maxlength, type = 'text' } = {}) {
    return h('input', { class: 'text_pole', type, placeholder, maxlength, 'bind:value': valueSignal });
}

export function TextArea(valueSignal, { placeholder, rows = 3 } = {}) {
    return h('textarea', { class: 'text_pole', placeholder, rows, 'bind:value': valueSignal });
}

/**
 * A real slider switch (not a bare checkbox) — the default building block for any
 * on/off setting. `checkedSignal` is shown live and, by default, written back to
 * directly on toggle. Pass `onChange(nextChecked, inputEl)` instead when the flip
 * needs to go through something else first (persistence, an async call that can
 * fail and must roll the visual switch back) — in that case the caller is
 * responsible for eventually reflecting the outcome into `checkedSignal`.
 */
export function Toggle(labelText, checkedSignal, { hint, onChange } = {}) {
    const input = h('input', { type: 'checkbox', 'on:click': stopPropagation });
    effectOn(input, () => { input.checked = checkedSignal(); });
    input.addEventListener('change', () => {
        if (onChange) onChange(input.checked, input);
        else checkedSignal.set(input.checked);
    });
    return h('label', { class: 'stme-switch' },
        input,
        h('span', { class: 'stme-switch-track' }),
        labelText || hint ? h('span', { class: 'stme-switch-label' }, labelText, hint ? h('small', {}, hint) : null) : null,
    );
}

export function Button(labelText, onClick, { variant } = {}) {
    return h('button', { class: variant === 'danger' ? 'menu_button stme-worker-remove' : 'menu_button', type: 'button', 'on:click': onClick }, labelText);
}

/**
 * A dropdown reconciled directly against `<option>` children (never through the
 * generic `list()` wrapper — a `<select>`'s content model ignores options nested
 * inside anything but itself or an `<optgroup>`, so a wrapper div silently drops
 * every option). `shape` maps each item in `optionsSignal` to `{ value, label }`.
 */
export function Select(valueSignal, optionsSignal, shape = { value: item => item.id, label: item => item.name }) {
    const select = document.createElement('select');
    select.className = 'text_pole';
    const optionNodes = new Map();
    effectOn(select, () => {
        const options = optionsSignal();
        const seen = new Set();
        let cursor = null;
        for (const item of options) {
            const key = String(shape.value(item));
            seen.add(key);
            let node = optionNodes.get(key);
            if (!node) { node = document.createElement('option'); node.value = key; optionNodes.set(key, node); }
            node.textContent = shape.label(item);
            const desiredNext = cursor ? cursor.nextSibling : select.firstChild;
            if (desiredNext !== node) { if (cursor) cursor.after(node); else select.prepend(node); }
            cursor = node;
        }
        for (const [key, node] of optionNodes) {
            if (seen.has(key)) continue;
            node.remove();
            optionNodes.delete(key);
        }
    });
    effectOn(select, () => { const next = String(valueSignal()); if (select.value !== next) select.value = next; });
    select.addEventListener('change', () => valueSignal.set(select.value));
    return select;
}

/** A range input with a live numeric readout, matching the SideCar sampler sliders. */
export function SliderField(labelText, valueSignal, { min = 0, max = 100, step = 1 } = {}) {
    const output = h('output', {}, valueSignal);
    const input = h('input', { type: 'range', min, max, step, 'bind:value': numeric(valueSignal) });
    return h('label', { class: 'stme-slider' }, h('span', {}, labelText, output), input);
}

/** Adapts a numeric signal to `<input type=range>`, whose value is always a string. */
function numeric(valueSignal) {
    const proxy = () => String(valueSignal());
    proxy.isSignal = true;
    proxy.peek = () => String(valueSignal.peek());
    proxy.set = (next) => valueSignal.set(Number(next));
    return proxy;
}

/** A small removable pill, e.g. one field-address token or one selected tag. */
export function Chip(content, { onRemove, onClick, title } = {}) {
    return h('button', { type: 'button', class: 'stme-chip', title, 'on:click': onClick },
        content,
        onRemove ? h('span', { class: 'stme-chip-remove', 'on:click': event => { event.stopPropagation(); onRemove(); } }, '×') : null,
    );
}

/**
 * The collapsible, draggable card list used for both the engine's own module
 * list and any module's internal reorderable collection (e.g. Tracker's blocks).
 * `items` is a signal of plain data; `renderHeader`/`renderContent` receive one
 * item and return its `<summary>`/content children. Reordering calls `onReorder`
 * with the new array — the caller owns persistence, this widget owns only drag UX.
 */
export function DraggableList(items, keyFn, { renderHeader, renderContent, isOpen, onToggleOpen, onReorder, className = 'stme-module' } = {}) {
    const container = h('div', { class: 'stme-draggable-list' },
        list(items, keyFn, item => {
            const card = h('details', { class: className, draggable: true });
            card.open = isOpen ? isOpen(item) : true;
            card.dataset.key = String(keyFn(item));
            if (onToggleOpen) card.addEventListener('toggle', () => onToggleOpen(item, card.open));
            card.addEventListener('dragstart', event => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(keyFn(item)));
                card.classList.add('stme-dragging');
            });
            card.addEventListener('dragend', () => card.classList.remove('stme-dragging'));
            const header = h('summary', { class: 'stme-module-header' }, renderHeader(item));
            const content = h('div', { class: 'stme-module-content' }, renderContent(item));
            card.append(header, content);
            return card;
        }),
    );
    if (onReorder) {
        container.addEventListener('dragover', event => event.preventDefault());
        container.addEventListener('drop', event => {
            event.preventDefault();
            const key = event.dataTransfer.getData('text/plain');
            const current = items();
            const moving = current.find(item => String(keyFn(item)) === key);
            if (!moving) return;
            const target = event.target.closest?.('[data-key]');
            const rest = current.filter(item => String(keyFn(item)) !== key);
            const at = target ? rest.findIndex(item => String(keyFn(item)) === target.dataset.key) : rest.length;
            rest.splice(at < 0 ? rest.length : at, 0, moving);
            onReorder(rest);
        });
    }
    return container;
}

/**
 * Drags `panel` by pointer events on `handle` (its header, typically), clamped
 * to the viewport. Calls `onDrop({ x, y })` with the final on-screen position
 * once the drag ends — the caller decides whether/where to persist it. Used by
 * any floating window appended to `document.body` (Tracker's HUD, the engine's
 * Developer panel). Returns a cleanup function.
 */
export function makeDraggable(panel, handle, { onDrop } = {}) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onPointerDown = event => {
        if (event.target.closest('button')) return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        handle.setPointerCapture(event.pointerId);
    };
    const onPointerMove = event => {
        if (!dragging) return;
        const x = Math.min(Math.max(0, event.clientX - offsetX), window.innerWidth - panel.offsetWidth);
        const y = Math.min(Math.max(0, event.clientY - offsetY), window.innerHeight - panel.offsetHeight);
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    };
    const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        onDrop?.({ x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10) });
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);

    return () => {
        handle.removeEventListener('pointerdown', onPointerDown);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerUp);
    };
}

/** Places a floating panel at a saved `{x, y}`, or the bottom-right corner if there isn't one yet. */
export function applyFloatingPosition(panel, position) {
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        panel.style.left = `${position.x}px`;
        panel.style.top = `${position.y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    } else {
        panel.style.right = '20px';
        panel.style.bottom = '20px';
        panel.style.left = 'auto';
        panel.style.top = 'auto';
    }
}

export { h, list, show, effect, effectOn, onDispose, autoDispose, mount } from './dom.js';
export { signal, computed, isSignal, unwrap } from './reactive.js';
