import { SidecarService } from './sidecar-service.js';
import { ModuleDataBus } from './data-bus.js';

const SETTINGS_KEY = 'st_module_engine';

/**
 * Lifecycle host for feature modules. A module only knows the small host API
 * passed to activate(), so it can be developed and enabled independently.
 */
export class ModuleEngine {
    #modules = new Map();
    #active = new Map();
    #subscriptions = [];
    #chatListeners = new Set();
    #root;
    #failures = new Map();
    #logs = [];
    #data = new ModuleDataBus();

    constructor(getContext) {
        this.getContext = getContext;
        this.sidecar = new SidecarService(() => this.settings(), () => this.saveSettings());
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
            const handler = () => {
                for (const listener of this.#chatListeners) listener();
                this.refresh();
            };
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
            this.#failures.delete(id);
            this.#log('info', id, 'Module started.');
        } catch (error) {
            this.#failures.set(id, error);
            this.#log('error', id, `Start failed: ${error?.message || String(error)}`, error);
        }
        this.refresh();
    }

    async disable(id) {
        const cleanup = this.#active.get(id);
        if (!cleanup) return;
        await cleanup();
        this.#active.delete(id);
        this.refresh();
    }

    async setEnabled(id, enabled) {
        if (!this.#modules.has(id)) throw new Error(`Unknown module: ${id}`);
        this.settings().modules[id] = { ...this.settings().modules[id], enabled };
        this.saveSettings();
        if (enabled) await this.enable(id);
        else await this.disable(id);
    }

    mount(root) {
        this.#root = root;
        this.refresh();
    }

    layout() {
        const layout = this.settings().layout ??= { moduleOrder: [], collapsed: {} };
        layout.moduleOrder ??= [];
        layout.collapsed ??= {};
        return layout;
    }

    orderedModules() {
        const order = this.layout().moduleOrder;
        return [...this.#modules.values()].sort((a, b) => {
            const aIndex = order.indexOf(a.id); const bIndex = order.indexOf(b.id);
            return (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) - (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex);
        });
    }

    refresh() {
        const list = this.#root?.querySelector('#stme-module-list');
        const baseList = this.#root?.querySelector('#stme-base-list');
        if (!list || !baseList) return;
        list.replaceChildren(); baseList.replaceChildren();
        const layout = this.layout();

        for (const module of this.orderedModules()) {
            const enabled = this.isEnabled(module.id);
            const failure = this.#failures.get(module.id);
            const card = document.createElement('details');
            card.className = 'stme-module'; card.dataset.moduleId = module.id; card.draggable = true;
            card.open = !layout.collapsed[module.id];
            card.addEventListener('toggle', () => { layout.collapsed[module.id] = !card.open; this.saveSettings(); });
            card.addEventListener('dragstart', event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', module.id); card.classList.add('stme-dragging'); });
            card.addEventListener('dragend', () => card.classList.remove('stme-dragging'));

            const header = document.createElement('summary'); header.className = 'stme-module-header';
            const title = document.createElement('div'); title.innerHTML = `<strong>${module.title}</strong><small>${module.description ?? ''}</small>`;
            const control = document.createElement('label'); control.className = 'stme-toggle';
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = enabled;
            checkbox.addEventListener('click', event => event.stopPropagation());
            checkbox.addEventListener('change', async () => { checkbox.disabled = true; try { await this.setEnabled(module.id, checkbox.checked); } catch (error) { checkbox.checked = !checkbox.checked; this.#toast('error', error?.message || String(error), module.title); } finally { checkbox.disabled = false; } });
            control.append(checkbox, document.createTextNode(' Enabled'));
            header.append(title, control); card.append(header);
            if (failure) { const content = document.createElement('div'); content.className = 'stme-module-content stme-module-error'; content.textContent = `Module did not start: ${failure?.message || String(failure)}`; const retry = document.createElement('button'); retry.className = 'menu_button'; retry.type = 'button'; retry.textContent = 'Retry module'; retry.addEventListener('click', () => { this.#failures.delete(module.id); this.enable(module.id); }); content.append(retry); card.append(content); }
            else if (enabled) { const content = document.createElement('div'); content.className = 'stme-module-content'; try { module.render(content, this.#hostFor(module)); } catch (error) { this.#failures.set(module.id, error); this.#log('error', module.id, `UI render failed: ${error?.message || String(error)}`, error); content.replaceChildren(); content.classList.add('stme-module-error'); content.textContent = `Module UI failed: ${error?.message || String(error)}`; } card.append(content); }
            list.append(card);
        }

        list.ondragover = event => event.preventDefault();
        list.ondrop = event => {
            event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (!this.#modules.has(id)) return;
            const target = event.target.closest?.('[data-module-id]'); const order = this.orderedModules().map(module => module.id).filter(item => item !== id);
            const at = target ? order.indexOf(target.dataset.moduleId) : order.length; order.splice(at < 0 ? order.length : at, 0, id);
            layout.moduleOrder = order; this.saveSettings(); this.refresh();
        };

        const baseCard = document.createElement('details'); baseCard.className = 'stme-base-card'; baseCard.open = !layout.collapsed.sidecar;
        baseCard.addEventListener('toggle', () => { layout.collapsed.sidecar = !baseCard.open; this.saveSettings(); });
        const baseHeader = document.createElement('summary'); baseHeader.className = 'stme-module-header'; baseHeader.innerHTML = '<div><strong>SideCar</strong><small>Shared model and sampler settings for all modules.</small></div>';
        const baseContent = document.createElement('div'); baseCard.append(baseHeader, baseContent); baseList.append(baseCard);
        this.sidecar.render(baseContent, (level, message, title) => this.#toast(level, message, title), false);
    }

    #hostFor(module) {
        return {
            id: module.id,
            context: () => this.getContext(),
            refresh: () => this.refresh(),
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

    #log(level, moduleId, message, error) {
        const entry = { time: new Date().toISOString(), level, moduleId, message };
        this.#logs.unshift(entry); this.#logs.length = Math.min(this.#logs.length, 100);
        console[level === 'error' ? 'error' : 'info'](`[ST Module Engine][${moduleId}] ${message}`, error ?? '');
    }

    #toast(level, message, title) {
        window.toastr?.[level]?.(message, title);
    }
}
