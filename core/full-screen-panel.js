import { h, signal, effectOn, Button, Toggle } from './widgets.js';

// The same module/base-list skeleton index.js builds for the drawer, minus the
// <details> wrapper — this panel is already the "opened" view, so there's nothing to
// collapse. engine.mount() looks for [data-stme-base-list]/[data-stme-module-list] (not
// #id — the drawer's own skeleton uses the same markers, and querySelector('#id') is
// unreliable once that id exists more than once in the document).
const SKELETON = `
<div class="stme-settings">
    <p class="stme-intro">Independent modules managed from one place.</p>
    <section class="stme-section"><h4>Base settings</h4><div data-stme-base-list class="stme-base-list"></div></section>
    <section class="stme-section"><h4>Modules <small>Drag cards to reorder them.</small></h4><div data-stme-module-list class="stme-module-list"></div></section>
</div>`;

/**
 * A full-viewport overlay that gives ST Module Engine a real "app" entry point instead
 * of only living inside the Extensions drawer — toggled from a launcher icon index.js
 * adds to SillyTavern's own top bar (see core/full-screen-panel.js's caller).
 *
 * Deliberately does NOT reparent the drawer's already-mounted DOM into this panel:
 * core/dom.js's autoDispose() watches for a node being removed from its tracked
 * container via MutationObserver, and appendChild()-ing an already-mounted subtree into
 * a new parent fires exactly that removal — disposeTree() would tear down every live
 * effect/subscription the drawer's UI depends on. Instead, engine.mount() is called a
 * SECOND, independent time on this panel's own skeleton, built lazily on first open (so
 * a user who never opens this panel pays nothing for it). Both mounts read/write the
 * same underlying engine.settings()/moduleSettings(), so they stay in sync through
 * shared state — the same way two browser tabs on the same page would.
 *
 * `engine` needs: fullScreenSettings(), saveSettings(), mount().
 */
export function createFullScreenPanel(engine) {
    const settings = engine.fullScreenSettings();
    const visible = signal(Boolean(settings.visible));
    const hideTopBar = signal(Boolean(settings.hideTopBar));
    let mounted = false;

    const panel = h('div', { class: 'stme-fullscreen', hidden: true });
    const body = h('div', { class: 'stme-fullscreen-body' });
    const head = h('div', { class: 'stme-fullscreen-head' },
        h('strong', {}, 'ST Module Engine'),
        Toggle('Hide ST top bar while open', hideTopBar),
        Button('× Close', () => visible.set(false)),
    );
    panel.append(head, body);
    document.body.append(panel);

    effectOn(panel, () => {
        const isVisible = visible();
        panel.hidden = !isVisible;
        document.body.classList.toggle('stme-fullscreen-open', isVisible);
        persist();
        if (isVisible && !mounted) {
            mounted = true;
            body.innerHTML = SKELETON;
            engine.mount(body);
        }
    });
    // Both state classes live on <body> (not one on body, one on the panel) so the CSS
    // rule that hides ST's own top bar can require both at once with a single selector.
    effectOn(panel, () => { document.body.classList.toggle('stme-fullscreen-hide-topbar', hideTopBar()); persist(); });

    function persist() {
        const next = engine.fullScreenSettings();
        next.visible = visible.peek();
        next.hideTopBar = hideTopBar.peek();
        engine.saveSettings();
    }

    return {
        node: panel,
        visible,
        toggle: () => visible.update(v => !v),
        show: () => visible.set(true),
        hide: () => visible.set(false),
    };
}
