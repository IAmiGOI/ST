import { SidecarService } from './sidecar-service.js';

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

        const cleanup = await module.activate(this.#hostFor(module));
        this.#active.set(id, typeof cleanup === 'function' ? cleanup : () => {});
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

    refresh() {
        const list = this.#root?.querySelector('#stme-module-list');
        if (!list) return;
        list.replaceChildren();

        for (const module of this.#modules.values()) {
            const enabled = this.isEnabled(module.id);
            const card = document.createElement('section');
            card.className = 'stme-module';
            card.dataset.moduleId = module.id;

            const header = document.createElement('header');
            header.className = 'stme-module-header';
            const title = document.createElement('div');
            title.innerHTML = `<strong>${module.title}</strong><small>${module.description ?? ''}</small>`;
            const control = document.createElement('label');
            control.className = 'stme-toggle';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = enabled;
            checkbox.addEventListener('change', async () => {
                checkbox.disabled = true;
                try {
                    await this.setEnabled(module.id, checkbox.checked);
                } catch (error) {
                    checkbox.checked = !checkbox.checked;
                    this.#toast('error', error?.message || String(error), module.title);
                } finally {
                    checkbox.disabled = false;
                }
            });
            control.append(checkbox, document.createTextNode(' Enabled'));
            header.append(title, control);
            card.append(header);

            if (enabled) {
                const content = document.createElement('div');
                content.className = 'stme-module-content';
                module.render(content, this.#hostFor(module));
                card.append(content);
            }
            list.append(card);
        }

        const sidecar = document.createElement('section');
        list.append(sidecar);
        this.sidecar.render(sidecar, (level, message, title) => this.#toast(level, message, title));
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
            onEvent: (eventType, listener) => {
                const context = this.getContext();
                const eventName = context.eventTypes?.[eventType] ?? eventType;
                if (!context.eventSource?.on) throw new Error('SillyTavern event API is unavailable.');
                context.eventSource.on(eventName, listener);
                return () => context.eventSource.off?.(eventName, listener);
            },
            onChatChanged: (listener) => {
                this.#chatListeners.add(listener);
                return () => this.#chatListeners.delete(listener);
            },
        };
    }

    #toast(level, message, title) {
        window.toastr?.[level]?.(message, title);
    }
}
