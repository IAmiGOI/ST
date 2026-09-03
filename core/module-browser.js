import { h, list, show, signal, computed, effectOn, Button } from './widgets.js';
import { fetchCatalog } from './module-catalog.js';
import { ENGINE_VERSION, compareVersions } from './module-engine.js';

/**
 * The "Browser" tab (core/module-browser.js's caller in index.js) opens this same
 * full-viewport overlay `core/full-screen-panel.js` uses (`.stme-fullscreen`) — reused
 * on purpose rather than building a second, different "big page" mechanism. Built
 * lazily on first open, exactly like the full-screen panel, so a user who never opens
 * the browser pays nothing for it.
 *
 * Search and the filter row are visual placeholders for now (disabled inputs) — the
 * catalog's tag/category taxonomy isn't settled yet, so wiring real filtering ahead of
 * that would just be filtering against a shape likely to change. Same for the rating
 * row on each card: no rating system exists yet, it's a stub showing where one will
 * go. Everything else (fetching the catalog, showing compatibility/installed state,
 * actually installing) is real.
 *
 * `engine` needs: installModule(url), listModuleStates().
 */
export function createModuleBrowserPanel(engine) {
    const visible = signal(false);
    const status = signal('idle'); // 'idle' | 'loading' | 'ready' | 'error'
    const entries = signal([]);
    const errorMessage = signal('');
    const installingIds = signal(new Set());
    let loaded = false;

    // Reactive, not a one-off read: install/enable/disable a module anywhere else in
    // the UI while this panel is open and cards update on their own.
    const installedIds = computed(() => new Set(engine.listModuleStates().map(m => m.id)));

    async function load() {
        status.set('loading');
        try {
            const result = await fetchCatalog();
            entries.set(result);
            status.set('ready');
        } catch (error) {
            errorMessage.set(error?.message || String(error));
            status.set('error');
        }
    }

    async function install(entry) {
        installingIds.update(ids => new Set(ids).add(entry.id));
        try {
            await engine.installModule(entry.url);
            window.toastr?.success?.(`${entry.title} installed.`, 'ST Module Engine');
        } catch (error) {
            window.toastr?.error?.(error?.message || String(error), entry.title);
        } finally {
            installingIds.update(ids => { const next = new Set(ids); next.delete(entry.id); return next; });
        }
    }

    function renderCard(entry) {
        const isInstalled = computed(() => installedIds().has(entry.id));
        const isInstalling = computed(() => installingIds().has(entry.id));
        const incompatible = entry.minEngineVersion ? compareVersions(entry.minEngineVersion, ENGINE_VERSION) > 0 : false;

        const card = h('div', { class: 'stme-browser-card' },
            h('div', { class: 'stme-browser-card-head' },
                h('strong', {}, entry.title),
                entry.version ? h('span', { class: 'stme-module-version' }, `v${entry.version}`) : null,
            ),
            entry.author ? h('div', { class: 'stme-browser-card-author' }, `by ${entry.author}`) : null,
            h('p', { class: 'stme-browser-card-desc' }, entry.description || 'No description provided.'),
            entry.tags.length ? h('div', { class: 'stme-browser-tags' }, ...entry.tags.map(tag => h('span', { class: 'stme-browser-tag' }, tag))) : null,
            h('div', { class: 'stme-browser-card-meta' },
                h('span', { class: incompatible ? 'stme-browser-compat stme-browser-compat-bad' : 'stme-browser-compat stme-browser-compat-ok' },
                    incompatible ? `⚠ Requires v${entry.minEngineVersion}+` : '✓ Compatible'),
                h('span', { class: 'stme-browser-updated' }, entry.updatedAt ? `Updated ${entry.updatedAt}` : 'Update date unknown'),
            ),
            // Placeholder — no rating system exists yet (see the doc comment above).
            h('div', { class: 'stme-browser-rating', title: 'Ratings are not available yet' }, '☆ ☆ ☆ ☆ ☆', h('small', {}, 'No ratings yet')),
            show(isInstalled, installed => installed
                ? h('div', { class: 'stme-browser-installed-badge' }, '✓ Installed')
                : Button('Install', () => install(entry))),
        );
        effectOn(card, () => {
            card.classList.toggle('stme-browser-card-installed', isInstalled());
            // The Install button lives inside show()'s own wrapper div, not as a direct
            // child of the card — querySelector still finds it fine (a "display:contents"
            // wrapper doesn't affect the DOM tree, only layout). Absent while installed
            // (show() swapped in the badge instead), hence the guard.
            const button = card.querySelector('button');
            if (!button) return;
            button.disabled = isInstalling();
            button.textContent = isInstalling() ? 'Installing…' : 'Install';
        });
        return card;
    }

    // The list() wrapper is display:contents (transparent to CSS grid, same trick
    // DraggableList's own wrapper uses) — grid layout is applied to gridContainer,
    // its actual parent, not to the wrapper itself.
    const grid = list(entries, entry => entry.id, renderCard);
    const gridContainer = h('div', { class: 'stme-browser-grid' }, grid);

    const emptyState = h('p', { class: 'stme-browser-empty' }, 'No modules in the catalog yet.');
    const loadingState = h('p', { class: 'stme-browser-empty' }, 'Loading the module catalog…');
    const errorState = h('div', { class: 'stme-browser-empty stme-browser-error' });
    const retryButton = Button('Retry', () => load());

    const body = h('div', { class: 'stme-browser-body' },
        h('div', { class: 'stme-browser-toolbar' },
            h('input', { class: 'text_pole', type: 'search', placeholder: 'Search — coming soon', disabled: true, title: 'Search is not wired up yet' }),
            h('div', { class: 'stme-browser-filters', title: 'Filters are not wired up yet' },
                h('span', { class: 'stme-browser-filter-chip' }, 'All'),
                h('span', { class: 'stme-browser-filter-chip' }, 'Tags'),
                h('span', { class: 'stme-browser-filter-chip' }, 'Compatible only'),
            ),
            Button('↻ Refresh', () => load()),
        ),
        loadingState,
        errorState,
        emptyState,
        gridContainer,
    );

    effectOn(body, () => {
        const current = status();
        loadingState.hidden = current !== 'loading';
        errorState.hidden = current !== 'error';
        emptyState.hidden = !(current === 'ready' && entries().length === 0);
        gridContainer.hidden = !(current === 'ready' && entries().length > 0);
        if (current === 'error') { errorState.replaceChildren(`Couldn't load the module catalog: ${errorMessage()}`, retryButton); }
    });

    const panel = h('div', { class: 'stme-fullscreen stme-browser-overlay', hidden: true });
    const head = h('div', { class: 'stme-fullscreen-head' },
        h('strong', {}, 'Module Browser'),
        Button('× Close', () => visible.set(false)),
    );
    panel.append(head, body);
    document.body.append(panel);

    effectOn(panel, () => {
        const isVisible = visible();
        panel.hidden = !isVisible;
        if (isVisible && !loaded) { loaded = true; load(); }
    });

    return {
        node: panel,
        visible,
        toggle: () => visible.update(v => !v),
        show: () => visible.set(true),
        hide: () => visible.set(false),
    };
}

/** The clickable "Browser" tab — placed right after the Modules section in the drawer (see index.js). */
export function renderBrowserTab(panel) {
    return h('button', { type: 'button', class: 'stme-browser-tab', 'on:click': () => panel.show() },
        h('strong', {}, 'Browser'),
        h('small', {}, 'Find and install community-made modules.'),
    );
}
