import { h, list, show, signal, computed, effectOn, Button, Field, TextInput, TextArea } from './widgets.js';
import { fetchCatalog, CATALOG_REPO_URL, CATALOG_REPO_BRANCH } from './module-catalog.js';
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
 * `engine` needs: installModule(url), listModuleStates(), checkAllModuleUpdates().
 * This is also the ONLY place a module can be loaded from a raw link — the old
 * standalone "Module loader" card (core/module-engine.js) was merged in here so
 * "how do I get a module into the engine" has a single home, catalog browsing and
 * direct-link loading side by side.
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

    // --- Load a module directly from a link — the same mechanism the catalog's own
    // "Install" button uses (engine.installModule()), just for a URL you already have
    // (a repo not yet in the catalog, a friend's fork, your own work in progress)
    // instead of one picked from a card below. Lives here, not as its own separate
    // card elsewhere, so "how do I get a module into the engine" has one home.
    const loadUrl = signal('');
    const loadBusy = signal(false);
    const checkingUpdates = signal(false);
    const loadButton = Button('Load module', async () => {
        loadBusy.set(true);
        try {
            await engine.installModule(loadUrl.peek());
            window.toastr?.success?.('Module loaded.', 'ST Module Engine');
            loadUrl.set('');
        } catch (error) {
            window.toastr?.error?.(error?.message || String(error), 'Module loader');
        } finally { loadBusy.set(false); }
    });
    const checkUpdatesButton = Button('Check for updates', async () => {
        checkingUpdates.set(true);
        try {
            const count = await engine.checkAllModuleUpdates();
            window.toastr?.success?.(count ? `Checked ${count} loaded module(s).` : 'No externally-loaded modules to check.', 'ST Module Engine');
        } finally { checkingUpdates.set(false); }
    });
    const loadSection = h('div', { class: 'stme-browser-load' },
        h('div', { class: 'stme-browser-load-head' },
            h('strong', {}, 'Load from a link'),
            h('small', {}, 'A GitHub repo or a direct .js URL — for anything not in the catalog above.'),
        ),
        h('div', { class: 'stme-browser-load-row' },
            TextInput(loadUrl, { type: 'url', placeholder: 'https://github.com/user/repo (or a direct .js URL)' }),
            loadButton,
            checkUpdatesButton,
        ),
    );
    effectOn(loadSection, () => { loadButton.disabled = loadBusy(); checkUpdatesButton.disabled = checkingUpdates(); });

    // --- "Propose a module" — generates a GitHub link that creates a new file
    // (submissions/<id>.json) in the catalog repo and opens it pre-filled. GitHub's
    // own /new/<branch>?filename=&value= URL does the rest: if the visitor has write
    // access it's a direct commit; if not (the common case), GitHub silently forks the
    // repo and opens a pull request for them — no OAuth, no backend, nothing built here
    // beyond constructing the URL. The maintainer reviews the submission file's PR and
    // copies its content into catalog.json by hand (see MODULES.md) — "official" is
    // deliberately NOT a field on this form; only the maintainer sets that when curating.
    const showForm = signal(false);
    const formFields = {
        id: signal(''), title: signal(''), url: signal(''), description: signal(''),
        author: signal(''), version: signal(''), repo: signal(''), tags: signal(''),
        minEngineVersion: signal(''),
    };
    const formError = signal('');

    function buildSubmissionUrl() {
        const id = formFields.id.peek().trim();
        const title = formFields.title.peek().trim();
        const url = formFields.url.peek().trim();
        if (!id || !title || !url) throw new Error('Module id, title, and URL are required.');
        if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Module id must be lowercase letters, digits, and hyphens, starting with a letter — the same format a real module\'s own id uses.');

        const entry = {
            id, title, url,
            description: formFields.description.peek().trim(),
            author: formFields.author.peek().trim(),
            version: formFields.version.peek().trim(),
            repo: formFields.repo.peek().trim(),
            tags: formFields.tags.peek().split(',').map(tag => tag.trim()).filter(Boolean),
            minEngineVersion: formFields.minEngineVersion.peek().trim(),
            updatedAt: new Date().toISOString().slice(0, 10),
        };
        for (const key of Object.keys(entry)) {
            if (entry[key] === '' || (Array.isArray(entry[key]) && entry[key].length === 0)) delete entry[key];
        }

        const filename = `submissions/${id}.json`;
        const params = new URLSearchParams({ filename, value: JSON.stringify(entry, null, 2) });
        return `${CATALOG_REPO_URL}/new/${CATALOG_REPO_BRANCH}?${params.toString()}`;
    }

    const formNote = h('p', { class: 'stme-browser-form-intro' },
        'Fill in your module\'s catalog entry, then open GitHub to submit it as a new file. ',
        'If you don\'t have write access to the catalog repo, GitHub automatically forks it and opens a pull request for you — nothing to set up.');
    const formErrorNode = h('p', { class: 'stme-browser-form-error', hidden: true });
    const submissionForm = h('div', { class: 'stme-browser-form', hidden: true },
        formNote,
        Field('Module id *', TextInput(formFields.id, { placeholder: 'dice-roller' }), { hint: 'lowercase letters, digits, hyphens — matches your module\'s own id' }),
        Field('Title *', TextInput(formFields.title, { placeholder: 'Dice Roller' })),
        Field('Module URL *', TextInput(formFields.url, { type: 'url', placeholder: 'https://github.com/you/repo/blob/main/index.js' }), { hint: 'a direct file link, or a repo/tree link — same as the Module Loader field' }),
        Field('Description', TextArea(formFields.description, { placeholder: 'What does it do?', rows: 2 })),
        Field('Author', TextInput(formFields.author, { placeholder: 'your name or handle' })),
        Field('Version', TextInput(formFields.version, { placeholder: '1.0.0' })),
        Field('Repo (view source link)', TextInput(formFields.repo, { type: 'url', placeholder: 'https://github.com/you/repo' })),
        Field('Tags', TextInput(formFields.tags, { placeholder: 'utility, chat' }), { hint: 'comma-separated' }),
        Field('Minimum engine version', TextInput(formFields.minEngineVersion, { placeholder: '0.1.0' }), { hint: `this engine is v${ENGINE_VERSION}` }),
        formErrorNode,
        Button('Open PR on GitHub →', () => {
            try {
                const url = buildSubmissionUrl();
                formError.set('');
                window.open(url, '_blank', 'noopener');
            } catch (error) {
                formError.set(error?.message || String(error));
            }
        }),
    );
    effectOn(submissionForm, () => { submissionForm.hidden = !showForm(); });
    effectOn(formErrorNode, () => {
        const message = formError();
        formErrorNode.hidden = !message;
        formErrorNode.textContent = message;
    });

    function renderCard(entry) {
        const isInstalled = computed(() => installedIds().has(entry.id));
        const isInstalling = computed(() => installingIds().has(entry.id));
        const incompatible = entry.minEngineVersion ? compareVersions(entry.minEngineVersion, ENGINE_VERSION) > 0 : false;

        const card = h('div', { class: 'stme-browser-card' },
            h('div', { class: 'stme-browser-card-head' },
                h('strong', {}, entry.title),
                entry.official ? h('span', { class: 'stme-browser-official-badge', title: 'Vetted by the ST Module Engine maintainer' }, '★ Official') : null,
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
            Button('+ Propose a module', () => showForm.update(v => !v)),
        ),
        loadSection,
        submissionForm,
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
