import { SidecarManager } from './sidecar-manager.js';
import { ModuleDataBus } from './data-bus.js';
import { h, show, signal, computed, effectOn, Button, TextInput, Toggle, DraggableList } from './widgets.js';

const SETTINGS_KEY = 'st_module_engine';

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
    #data = new ModuleDataBus();
    #moduleStyles = new Map();

    #registeredIds = signal([]);
    #layoutVersion = signal(0);
    #enabledMap = signal({});
    #errorMap = signal({});
    #forceTicks = new Map();
    #orderedSignal;

    constructor(getContext) {
        this.getContext = getContext;
        this.sidecar = new SidecarManager(() => this.settings(), () => this.saveSettings());
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
            const handler = () => { for (const listener of this.#chatListeners) listener(); };
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, handler);
            this.#subscriptions.push(() => context.eventSource.off?.(context.eventTypes.CHAT_CHANGED, handler));
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

    /** Builds the whole reactive UI tree once. Cards persist for the life of the page from here on. */
    mount(root) {
        this.#root = root;
        const moduleList = root.querySelector('#stme-module-list');
        const baseList = root.querySelector('#stme-base-list');
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
            h('div', {}, h('strong', {}, 'SideCar Manager'), h('small', {}, 'Balanced shared model workers and profiles for all modules.')));
        const sidecarContent = h('div', {});
        sidecarCard.append(sidecarHeader, sidecarContent);
        this.sidecar.render(sidecarContent, (level, message, title) => this.#toast(level, message, title));
        baseList.append(sidecarCard);

        baseList.append(this.#renderModuleLoader());
    }

    #renderModuleHeader(module) {
        const enabledDisplay = computed(() => this.#enabledMap()[module.id] ?? false);
        return [
            h('div', {}, h('strong', {}, module.title), h('small', {}, module.description ?? '')),
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
            if (state === 'disabled') return null;
            if (state === 'error') return this.#renderErrorCard(module, this.#errorMap()[module.id]);
            const body = h('div', {});
            try {
                module.render(body, this.#hostFor(module));
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
        const raw = String(url).trim().replace('github.com/', 'raw.githubusercontent.com/').replace('/blob/', '/');
        const response = await fetch(raw);
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
            h('div', {}, h('strong', {}, 'Module loader'), h('small', {}, 'Load a self-contained module from a GitHub raw URL.')));
        const content = h('div', { class: 'stme-module-content stme-loader' },
            TextInput(url, { type: 'url', placeholder: 'https://raw.githubusercontent.com/user/repo/main/module.js' }),
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
                write: (namespace, key, value) => this.#data.set(namespace, key, value),
                subscribe: (namespace, key, listener) => this.#data.subscribe(namespace, key, listener),
            }),
            onEvent: (eventType, listener) => {
                const context = this.getContext();
                const eventName = context.eventTypes?.[eventType] ?? eventType;
                if (!context.eventSource?.on) throw new Error('SillyTavern event API is unavailable.');
                const guarded = (...args) => { try { const result = listener(...args); Promise.resolve(result).catch(error => this.#log('error', module.id, `Event ${eventType} failed: ${error?.message || String(error)}`, error)); return result; } catch (error) { this.#log('error', module.id, `Event ${eventType} failed: ${error?.message || String(error)}`, error); } };
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
