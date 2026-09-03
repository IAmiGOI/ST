import { SidecarManager } from './sidecar-manager.js';
import { ModuleDataBus } from './data-bus.js';
import { h, show, signal, computed, effectOn, Button, TextInput, Toggle, DraggableList, InfoDot } from './widgets.js';
import { createDevPanel } from './dev-panel.js';
import { resolveModuleUrl } from './module-loader.js';

const SETTINGS_KEY = 'st_module_engine';
// A module's onChatChanged listener that (directly or via some ST API it calls)
// causes CHAT_CHANGED to fire again before it's done handling the first one is a
// real failure mode we've hit in practice — without a guard, that nested fire
// calls every listener again, which can trigger the same thing again, forming a
// tight loop that eats memory until the tab or the whole browser locks up. Two
// independent guards below stop this at the engine level, for every module, not
// just the one that happened to trigger it:
const CHAT_CHANGED_BURST_WINDOW_MS = 2000;
const CHAT_CHANGED_BURST_LIMIT = 8;

/**
 * Lifecycle host for feature modules. A module only knows the small host API
 * passed to activate(), so it can be developed and enabled independently.
 *
 * UI is reactive: a module's `render()` runs exactly once per enable — never
 * again just because something else on the page changed. Cards and their
 * content divs are created once and kept alive across reorders/collapses;
 * `host.refresh()` still exists as an escape hatch, but now only remounts the
 * calling module's own content, never its siblings.
 */
export class ModuleEngine {
    #modules = new Map();
    #active = new Map();
    #subscriptions = [];
    #chatListeners = new Set();
    #root;
    #logs = [];
    #data;
    #moduleStyles = new Map();
    #services = new Map();
    #chatChangedDispatching = false;
    #chatChangedBurst = [];
    #chatChangedStormLoggedAt = 0;
    // mount() can now be called more than once — once for the drawer, again for the
    // full-screen panel's own skeleton (core/full-screen-panel.js) — so the dev panel
    // (a single floating window, not per-root) must only ever be built the first time.
    #devPanelCreated = false;

    #registeredIds = signal([]);
    #layoutVersion = signal(0);
    #enabledMap = signal({});
    #errorMap = signal({});
    #forceTicks = new Map();
    #orderedSignal;

    constructor(getContext) {
        this.getContext = getContext;
        this.sidecar = new SidecarManager(() => this.settings(), () => this.saveSettings());
        this.#data = new ModuleDataBus({
            getContext: () => this.getContext(),
            onContaminate: report => this.#log('warning', report.id?.split(':')[0] ?? 'bus', report.message),
        });
        this.#orderedSignal = computed(() => {
            this.#layoutVersion();
            const order = this.layout().moduleOrder;
            return [...this.#registeredIds()]
                .map(id => this.#modules.get(id))
                .filter(Boolean)
                .sort((a, b) => {
                    const ai = order.indexOf(a.id); const bi = order.indexOf(b.id);
                    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
                });
        });
    }

    register(module) {
        if (!module?.id || !module?.title || typeof module.activate !== 'function' || typeof module.render !== 'function') {
            throw new Error('A module needs id, title, activate(), and render().');
        }
        if (!/^[a-z][a-z0-9-]*$/.test(module.id)) {
            throw new Error(`Invalid module id: ${module.id}`);
        }
        if (this.#modules.has(module.id)) {
            throw new Error(`Module "${module.id}" is already registered.`);
        }
        this.#modules.set(module.id, module);
        this.#installModuleCss(module);
        this.#forceTicks.set(module.id, signal(0));
        this.#registeredIds.update(ids => [...ids, module.id]);
        return this;
    }

    settings() {
        const context = this.getContext();
        const root = context.extensionSettings ?? (context.extensionSettings = {});
        const settings = root[SETTINGS_KEY] ?? (root[SETTINGS_KEY] = { modules: {} });
        settings.modules ??= {};
        return settings;
    }

    moduleSettings(id, defaults = {}) {
        const entry = this.settings().modules[id] ??= {};
        entry.settings ??= { ...defaults };
        for (const [key, value] of Object.entries(defaults)) entry.settings[key] ??= value;
        return entry.settings;
    }

    isEnabled(id) {
        const module = this.#modules.get(id);
        return this.settings().modules[id]?.enabled ?? module.defaultEnabled ?? true;
    }

    saveSettings() {
        const context = this.getContext();
        // SillyTavern versions expose one of these persistence methods.
        context.saveSettingsDebounced?.();
        context.saveSettings?.();
    }

    async start() {
        for (const module of this.#modules.values()) {
            if (this.isEnabled(module.id)) await this.enable(module.id);
        }

        const context = this.getContext();
        if (context.eventTypes?.CHAT_CHANGED && context.eventSource?.on) {
            // Modules that care about the current chat subscribe themselves via
            // onChatChanged() and update their own signals — no engine-wide
            // rebuild needed here any more.
            const handler = () => this.#dispatchChatChanged();
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, handler);
            this.#subscriptions.push(() => context.eventSource.off?.(context.eventTypes.CHAT_CHANGED, handler));
        }
    }

    /**
     * Runs every onChatChanged() listener, guarded two ways:
     *  - reentrancy: if a listener's own work (synchronously, or via something ST
     *    does in reaction to it) causes CHAT_CHANGED to fire again before this
     *    dispatch returns, the nested call is dropped instead of recursing.
     *  - burst limit: more than CHAT_CHANGED_BURST_LIMIT fires within
     *    CHAT_CHANGED_BURST_WINDOW_MS (not normal chat-switching pace) is treated
     *    as a runaway loop and further dispatches are skipped until the burst
     *    window quiets down on its own.
     * Each listener also gets the same per-listener try/catch + rejected-promise
     * handling as onEvent() — one broken module must not stop another's.
     */
    #dispatchChatChanged() {
        if (this.#chatChangedDispatching) {
            this.#log('error', 'engine', 'CHAT_CHANGED fired again while still handling the previous one (reentrant) — the nested dispatch was skipped to break a possible infinite loop. A module\'s onChatChanged listener (or something it calls into ST) is likely triggering another CHAT_CHANGED synchronously.');
            return;
        }
        const now = Date.now();
        this.#chatChangedBurst = this.#chatChangedBurst.filter(at => now - at < CHAT_CHANGED_BURST_WINDOW_MS);
        this.#chatChangedBurst.push(now);
        if (this.#chatChangedBurst.length > CHAT_CHANGED_BURST_LIMIT) {
            if (now - this.#chatChangedStormLoggedAt > CHAT_CHANGED_BURST_WINDOW_MS) {
                this.#log('error', 'engine', `CHAT_CHANGED fired ${this.#chatChangedBurst.length} times within ${CHAT_CHANGED_BURST_WINDOW_MS}ms — that's a runaway loop, not normal chat-switching. Skipping dispatches until it quiets down; if it keeps recurring, find and fix whatever's re-triggering it.`);
                this.#chatChangedStormLoggedAt = now;
            }
            return;
        }
        this.#chatChangedDispatching = true;
        const dispatchStart = Date.now();
        console.info(`[STME:engine] CHAT_CHANGED dispatch starting — ${this.#chatListeners.size} listener(s).`);
        try {
            let index = 0;
            for (const listener of [...this.#chatListeners]) {
                index++;
                const listenerStart = Date.now();
                try {
                    const result = listener();
                    Promise.resolve(result).catch(error => this.#log('error', 'engine', `A chat-changed listener failed: ${error?.message || String(error)}`, error));
                } catch (error) {
                    this.#log('error', 'engine', `A chat-changed listener failed: ${error?.message || String(error)}`, error);
                }
                console.info(`[STME:engine] CHAT_CHANGED listener ${index}/${this.#chatListeners.size} took ${Date.now() - listenerStart}ms.`);
            }
        } finally {
            this.#chatChangedDispatching = false;
            console.info(`[STME:engine] CHAT_CHANGED dispatch finished in ${Date.now() - dispatchStart}ms.`);
        }
    }

    async enable(id) {
        if (this.#active.has(id)) return;
        const module = this.#modules.get(id);
        if (!module) throw new Error(`Unknown module: ${id}`);

        try {
            const cleanup = await module.activate(this.#hostFor(module));
            this.#active.set(id, typeof cleanup === 'function' ? cleanup : () => {});
            this.#errorMap.update(map => { if (!(id in map)) return map; const next = { ...map }; delete next[id]; return next; });
            this.#log('info', id, 'Module started.');
        } catch (error) {
            this.#errorMap.update(map => ({ ...map, [id]: error }));
            this.#log('error', id, `Start failed: ${error?.message || String(error)}`, error);
        }
        this.#enabledMap.update(map => ({ ...map, [id]: true }));
    }

    async disable(id) {
        const cleanup = this.#active.get(id);
        if (!cleanup) return;
        await cleanup();
        this.#active.delete(id);
        // Belt-and-suspenders: release every bus channel/macro/pull-timer this module
        // owned, even if its own cleanup() forgot to unreserve something.
        this.#data.releaseNamespace(id);
        // Same for any service this module registered (e.g. Tracker's 'tracker' service) —
        // a module that stops providing a service should stop being found by others.
        for (const [name, entry] of [...this.#services.entries()]) if (entry.ownerId === id) this.#services.delete(name);
        this.#enabledMap.update(map => ({ ...map, [id]: false }));
        this.#errorMap.update(map => { if (!(id in map)) return map; const next = { ...map }; delete next[id]; return next; });
    }

    async setEnabled(id, enabled) {
        if (!this.#modules.has(id)) throw new Error(`Unknown module: ${id}`);
        this.settings().modules[id] = { ...this.settings().modules[id], enabled };
        this.saveSettings();
        if (enabled) await this.enable(id); else await this.disable(id);
    }

    layout() {
        const layout = this.settings().layout ??= { moduleOrder: [], collapsed: {} };
        layout.moduleOrder ??= [];
        layout.collapsed ??= {};
        return layout;
    }

    orderedModules() {
        return this.#orderedSignal();
    }

    /** The shared data bus — read-only introspection surface for `core/dev-panel.js`. Modules use `host.data`, not this directly. */
    get bus() {
        return this.#data;
    }

    /** One row per registered module: id, title, and current enabled/error state. For the dev panel. */
    listModuleStates() {
        return [...this.#modules.values()].map(module => ({
            id: module.id,
            title: module.title,
            enabled: Boolean(this.#enabledMap()[module.id]),
            error: this.#errorMap()[module.id]?.message ?? null,
        }));
    }

    /** Most recent log entries first (see #log()). For the dev panel. */
    logs() {
        return [...this.#logs];
    }

    /** Position/visibility for the floating ModuleEngine Developer panel — engine-level, not per-module. */
    devPanelSettings() {
        const settings = this.settings();
        settings.devPanel ??= { visible: false, collapsed: false, x: null, y: null };
        return settings.devPanel;
    }

    /** Visibility/options for the full-screen panel (core/full-screen-panel.js) — engine-level, not per-module. */
    fullScreenSettings() {
        const settings = this.settings();
        settings.fullScreen ??= { visible: false, hideTopBar: false };
        return settings.fullScreen;
    }

    /** Builds the whole reactive UI tree once. Cards persist for the life of the page from here on. */
    mount(root) {
        this.#root = root;
        // Attribute selectors, not #id — mount() can now be called more than once (the
        // drawer, and separately the full-screen panel's own skeleton), and a literal id
        // duplicated elsewhere in the document makes querySelector('#id') unreliable even
        // scoped to a subtree (confirmed in jsdom; browsers vary too — HTML with a
        // duplicate id is invalid to begin with, so don't rely on ids being unique here).
        const moduleList = root.querySelector('[data-stme-module-list]');
        const baseList = root.querySelector('[data-stme-base-list]');
        if (!moduleList || !baseList) return;

        moduleList.append(DraggableList(this.#orderedSignal, module => module.id, {
            isOpen: module => !this.layout().collapsed[module.id],
            onToggleOpen: (module, open) => { this.layout().collapsed[module.id] = !open; this.saveSettings(); },
            onReorder: modules => {
                this.layout().moduleOrder = modules.map(module => module.id);
                this.saveSettings();
                this.#layoutVersion.update(v => v + 1);
            },
            renderHeader: module => this.#renderModuleHeader(module),
            renderContent: module => this.#renderModuleBody(module),
        }));

        const sidecarCard = h('details', { class: 'stme-base-card', open: !this.layout().collapsed.sidecar });
        sidecarCard.addEventListener('toggle', () => { this.layout().collapsed.sidecar = !sidecarCard.open; this.saveSettings(); });
        const sidecarHeader = h('summary', { class: 'stme-module-header' },
            h('div', {}, h('strong', {}, 'SideCar Manager', InfoDot('This is where you connect the extension to an AI model — a separate one from your main chat model — that the tools above use to do their own thinking (like summarizing, tracking values, or picking music). Nothing here works until you fill this in.')), h('small', {}, 'Balanced shared model workers and profiles for all modules.')));
        const sidecarContent = h('div', {});
        sidecarCard.append(sidecarHeader, sidecarContent);
        this.sidecar.render(sidecarContent, (level, message, title) => this.#toast(level, message, title));
        baseList.append(sidecarCard);

        baseList.append(this.#renderModuleLoader());

        // Not a module, not nested in either list above — a floating window
        // toggled from one button at the very bottom of the whole drawer, so it
        // reads as its own detached tool rather than another card in this UI.
        // Built only on the first mount() call — a second call (the full-screen
        // panel's own skeleton) must not spawn a second floating dev panel.
        if (!this.#devPanelCreated) {
            this.#devPanelCreated = true;
            const devPanel = createDevPanel(this);
            const devFooter = h('div', { class: 'stme-dev-footer' },
                Button('⚙ ModuleEngine Developer', () => devPanel.toggle()));
            (root.querySelector('.inline-drawer-content') ?? root).append(devFooter);
        }
    }

    #renderModuleHeader(module) {
        const enabledDisplay = computed(() => this.#enabledMap()[module.id] ?? false);
        return [
            h('div', {}, h('strong', {}, module.title, module.about ? InfoDot(module.about) : null), h('small', {}, module.description ?? '')),
            Toggle('Enabled', enabledDisplay, {
                onChange: async (checked, input) => {
                    input.disabled = true;
                    try { await this.setEnabled(module.id, checked); }
                    catch (error) { input.checked = !checked; this.#toast('error', error?.message || String(error), module.title); }
                    finally { input.disabled = false; }
                },
            }),
        ];
    }

    /** Reactively swaps between "nothing" / an error card / the module's own once-rendered content. */
    #renderModuleBody(module) {
        const stateKey = computed(() => {
            const tick = this.#forceTicks.get(module.id)();
            const error = this.#errorMap()[module.id];
            const enabled = this.#enabledMap()[module.id];
            const state = error ? 'error' : enabled ? 'enabled' : 'disabled';
            return `${state}#${tick}`;
        });
        return show(stateKey, key => {
            const state = key.split('#')[0];
            console.info(`[STME:engine] #renderModuleBody("${module.id}") — state="${state}".`);
            if (state === 'disabled') return null;
            if (state === 'error') return this.#renderErrorCard(module, this.#errorMap()[module.id]);
            const body = h('div', {});
            try {
                module.render(body, this.#hostFor(module));
                console.info(`[STME:engine] "${module.id}".render() completed, ${body.children.length} top-level child node(s).`);
            } catch (renderError) {
                this.#log('error', module.id, `UI render failed: ${renderError?.message || String(renderError)}`, renderError);
                body.replaceChildren();
                body.classList.add('stme-module-error');
                body.textContent = `Module UI failed: ${renderError?.message || String(renderError)}`;
                queueMicrotask(() => this.#errorMap.update(map => ({ ...map, [module.id]: renderError })));
            }
            return body;
        });
    }

    #renderErrorCard(module, error) {
        return h('div', { class: 'stme-module-error' },
            `Module did not start: ${error?.message || String(error)}`,
            Button('Retry module', () => this.#retryModule(module)),
        );
    }

    #retryModule(module) {
        if (this.#active.has(module.id)) {
            // activate() already succeeded — only render() failed. Clearing the error
            // alone flips #renderModuleBody back to "enabled", which re-attempts render().
            this.#errorMap.update(map => { const next = { ...map }; delete next[module.id]; return next; });
            return;
        }
        this.enable(module.id);
    }

    async #loadRemoteModule(url) {
        const resolved = await resolveModuleUrl(url);
        const response = await fetch(resolved);
        if (!response.ok) throw new Error(`Module download failed: HTTP ${response.status}`);
        const source = await response.text();
        const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try { const imported = await import(blob); const module = imported.default ?? imported.module; this.register(module); await this.enable(module.id); } finally { URL.revokeObjectURL(blob); }
    }

    #renderModuleLoader() {
        const url = signal('');
        const busy = signal(false);
        const card = h('details', { class: 'stme-base-card' });
        const header = h('summary', { class: 'stme-module-header' },
            h('div', {}, h('strong', {}, 'Module loader', InfoDot('Lets you add a new tool to this extension by pasting a link, instead of installing and managing a whole separate extension for every single feature.')), h('small', {}, 'Load a self-contained module from a GitHub repo or a direct .js link.')));
        const content = h('div', { class: 'stme-module-content stme-loader' },
            TextInput(url, { type: 'url', placeholder: 'https://github.com/user/repo (or a direct .js URL)' }),
            Button('Load module', async () => {
                busy.set(true);
                try {
                    await this.#loadRemoteModule(url.peek());
                    this.#toast('success', 'Module loaded.', 'ST Module Engine');
                } catch (error) {
                    this.#log('error', 'loader', error?.message || String(error), error);
                    this.#toast('error', error?.message || String(error), 'Module loader');
                } finally { busy.set(false); }
            }),
        );
        effectOn(content, () => { content.querySelector('button').disabled = busy(); });
        card.append(header, content);
        return card;
    }

    #hostFor(module) {
        return {
            id: module.id,
            context: () => this.getContext(),
            refresh: () => { this.#forceTicks.get(module.id)?.update(n => n + 1); },
            setPrompt: (key, prompt, position = 1, depth = 4, role = 0) => this.getContext().setExtensionPrompt(key, prompt, position, depth, false, role),
            registerTool: (definition) => {
                const context = this.getContext();
                context.unregisterFunctionTool?.(definition.name);
                context.registerFunctionTool?.(definition);
            },
            unregisterTool: (name) => this.getContext().unregisterFunctionTool?.(name),
            toast: (level, message, title = module.title) => this.#toast(level, message, title),
            sidecar: this.sidecar.forModule(module.id),
            moduleSettings: (defaults = {}) => this.moduleSettings(module.id, defaults),
            saveModuleSettings: () => this.saveSettings(),
            data: Object.freeze({
                get: (key, fallback) => this.#data.get(module.id, key, fallback),
                set: (key, value) => this.#data.set(module.id, key, value),
                remove: key => this.#data.remove(module.id, key),
                read: (namespace, key, fallback) => this.#data.get(namespace, key, fallback),
                write: (namespace, key, value) => this.#data.write(namespace, key, value, module.id),
                subscribe: (namespace, key, listener) => this.#data.subscribe(namespace, key, listener),
                /**
                 * Declares `key` (in this module's own namespace) as a protected channel.
                 * options: { name, schema, allowExternalWrite, macro, webhook: { pushUrl, pullUrl, pullIntervalMs } }.
                 * Returns { id, unreserve() } — call unreserve() in your cleanup if the
                 * channel shouldn't outlive some narrower scope than the whole module
                 * (the engine already releases everything on disable regardless).
                 */
                reserve: (key, options) => this.#data.reserve(module.id, key, options),
                /** Retires a previously reserved channel (and clears its value/macro/history) without needing to have kept the handle reserve() returned — for a module whose own list of channels can shrink over time (a removable field, a deletable block). Safe to call on a key that was never reserved. */
                unreserve: key => this.#data.unreserve(module.id, key),
                history: key => this.#data.history(module.id, key),
                restore: (key, stepsBack) => this.#data.restore(module.id, key, stepsBack),
                describe: (namespace, key) => this.#data.describe(namespace, key),
                listChannels: namespace => this.#data.listChannels(namespace),
                findByName: name => this.#data.findByName(name),
            }),
            /**
             * Generic inter-module service registry — the same request/provider
             * shape as `host.sidecar`, but for a service another MODULE offers
             * (rather than the engine-native LLM access). ANY module can be a
             * provider (`register(name, api)` in activate()) or a consumer
             * (`get`/`request`) of ANY named service — the engine has no built-in
             * knowledge of what "tracker" or any other service name means; nothing
             * module-specific is hardcoded here, so this scales to as many
             * provider/consumer modules as anyone builds without ever touching
             * this file again. Registrations are released automatically when
             * their owner is disabled. See MODULES.md for the full contract and
             * the `track()` example.
             */
            services: Object.freeze({
                register: (name, api) => { this.#services.set(name, { api, ownerId: module.id }); },
                unregister: (name) => {
                    const entry = this.#services.get(name);
                    if (entry?.ownerId === module.id) this.#services.delete(name);
                },
                isAvailable: (name) => this.#services.has(name),
                /** Undefined if `name` isn't currently provided — check before using it, exactly like `host.sidecar.isConfigured()`. */
                get: (name) => this.#services.get(name)?.api,
                /**
                 * Like `get()`, but never undefined: if `name` isn't available, returns
                 * a "void" object where every property access is a callable that logs
                 * a warning and returns another void object — so `host.services.request('tracker').track(...).set(...)`
                 * is always safe to call, chained arbitrarily deep, for ANY service
                 * shape, with no per-service code in the engine to make that true.
                 */
                request: (name) => this.#services.get(name)?.api ?? createVoidService(name, module.id),
                /**
                 * The pull half of the protocol — push is `register()`+ad hoc methods
                 * like `track()` above; this is a provider ANSWERING a typed question.
                 * A provider opts in by exposing `handleRequest(type, payload, askerId)`
                 * on the object it registered; `type` is a string the provider defines
                 * and documents (its own request vocabulary), `payload` is whatever
                 * shape that type expects. Always resolves — never rejects — even if
                 * the service is missing, doesn't support `handleRequest`, doesn't
                 * recognize `type`, or its handler throws: each of those logs a
                 * warning and resolves to `undefined`, so a consumer never needs a
                 * try/catch just to ask a question that might not be answerable.
                 */
                ask: async (name, type, payload) => {
                    const entry = this.#services.get(name);
                    if (!entry) { console.warn(`[ST Module Engine][${module.id}] ask("${name}", "${type}") ignored — service not available.`); return undefined; }
                    if (typeof entry.api.handleRequest !== 'function') { console.warn(`[ST Module Engine][${module.id}] Service "${name}" does not answer requests (no handleRequest).`); return undefined; }
                    try { return await entry.api.handleRequest(type, payload, module.id); }
                    catch (error) { this.#log('error', module.id, `ask("${name}", "${type}") failed: ${error?.message || String(error)}`, error); return undefined; }
                },
            }),
            onEvent: (eventType, listener) => {
                const context = this.getContext();
                const eventName = context.eventTypes?.[eventType] ?? eventType;
                if (!context.eventSource?.on) throw new Error('SillyTavern event API is unavailable.');
                if (context.eventTypes && !(eventType in context.eventTypes)) {
                    console.warn(`[STME:engine] "${module.id}".onEvent("${eventType}") — this key is NOT present in context.eventTypes; ST will never fire an event with this exact name, so this listener will silently never run. Check the real ST event name.`);
                }
                console.info(`[STME:engine] "${module.id}" subscribed to event "${eventType}" (resolved to eventSource name "${eventName}").`);
                const guarded = (...args) => {
                    console.info(`[STME:engine] Event "${eventType}" (as "${eventName}") fired for "${module.id}".`, args);
                    try { const result = listener(...args); Promise.resolve(result).catch(error => this.#log('error', module.id, `Event ${eventType} failed: ${error?.message || String(error)}`, error)); return result; } catch (error) { this.#log('error', module.id, `Event ${eventType} failed: ${error?.message || String(error)}`, error); }
                };
                context.eventSource.on(eventName, guarded);
                return () => context.eventSource.off?.(eventName, guarded);
            },
            onChatChanged: (listener) => {
                this.#chatListeners.add(listener);
                return () => this.#chatListeners.delete(listener);
            },
        };
    }

    #installModuleCss(module) {
        if (!module.css || this.#moduleStyles.has(module.id) || typeof document === 'undefined') return;
        const style = document.createElement('style');
        style.dataset.stmeModule = module.id;
        style.textContent = String(module.css);
        document.head.append(style);
        this.#moduleStyles.set(module.id, style);
    }

    #log(level, moduleId, message, error) {
        const entry = { time: new Date().toISOString(), level, moduleId, message };
        this.#logs.unshift(entry); this.#logs.length = Math.min(this.#logs.length, 100);
        console[level === 'error' ? 'error' : 'info'](`[ST Module Engine][${moduleId}] ${message}`, error ?? '');
    }

    #toast(level, message, title) {
        window.toastr?.[level]?.(message, title);
    }
}

/**
 * An infinitely chainable no-op: `voidService.anything(1, 2).another(3).whatever`
 * never throws — every property access returns a function that logs once and
 * returns the same void object again. Used by `host.services.request()` so a
 * consumer of an unavailable service degrades safely without the engine having
 * to know that service's actual shape (a `track()` call, a `set()` on whatever
 * `track()` returned, anything) — the alternative would be hand-writing one
 * stub per service, which is exactly the kind of per-module special-casing
 * this registry exists to avoid.
 */
function createVoidService(name, moduleId) {
    const proxy = new Proxy(() => proxy, {
        get: (_target, prop) => {
            if (prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
            return (...args) => {
                console.warn(`[ST Module Engine][${moduleId}] Called "${String(prop)}" on unavailable service "${name}" — ignored.`);
                return proxy;
            };
        },
        apply: () => proxy,
    });
    return proxy;
}
