import { SidecarService } from './sidecar-service.js';
import { h, list, signal, Button } from './widgets.js';

/** Schedules module requests over several SideCar configurations for lowest queue wait. */
export class SidecarManager {
    #root; #save; #services = new Map(); #queue = []; #running = new Map();
    // null = not yet checked (no blink — avoids a false-positive flash before the
    // startup check below has had a chance to run); true = at least one configured
    // worker answered; false = either nothing is configured at all, or every
    // configured worker failed to answer — core/module-engine.js's mount() reads
    // this to blink the outer card's border blue. Exposed as a plain public field
    // (the raw signal), same convention as e.g. full-screen-panel.js's `visible`.
    healthy = signal(null);
    constructor(settingsRoot, save) { this.#root = settingsRoot; this.#save = save; }
    configs() {
        const root = this.#root();
        if (!Array.isArray(root.sidecars)) {
            const legacy = root.sidecar ?? {};
            root.sidecars = [{ id: 'primary', name: 'Primary SideCar', ...legacy }];
            delete root.sidecar;
        }
        if (!root.sidecars.length) root.sidecars.push({ id: 'primary', name: 'Primary SideCar' });
        return root.sidecars;
    }
    service(id) {
        const config = this.configs().find(item => item.id === id) ?? this.configs()[0];
        if (!this.#services.has(config.id)) this.#services.set(config.id, new SidecarService(() => ({ sidecar: config }), this.#save));
        return this.#services.get(config.id);
    }
    available() { return this.configs().filter(config => this.service(config.id).isConfigured()); }
    isConfigured() { return this.available().length > 0; }
    profiles() { const seen = new Map(); for (const config of this.configs()) for (const profile of this.service(config.id).profiles()) seen.set(profile.id, profile); return [...seen.values()].map(({ id, name }) => ({ id, name })); }
    forModule(moduleId) { return Object.freeze({ request: options => this.request({ ...options, moduleId }), acquire: label => this.acquire(moduleId, label), isConfigured: () => this.isConfigured(), profiles: () => this.profiles(), getSettings: () => ({ workers: this.configs().length, queued: this.#queue.length, running: [...this.#running.values()].reduce((a, b) => a + b, 0) }), diagnostics: () => this.configs().map(config => { const settings = this.service(config.id).settings(); return { id: config.id, name: config.name, enabled: settings.enabled, hasEndpoint: Boolean(settings.endpoint), hasModel: Boolean(settings.model), configured: this.service(config.id).isConfigured() }; }) }); }
    acquire(moduleId, label = moduleId) { let released = false; return Object.freeze({ request: options => { if (released) throw new Error('This SideCar lease has been released.'); return this.request({ ...options, moduleId }); }, release: () => { released = true; }, isConfigured: () => this.isConfigured(), label }); }
    request(options) { return new Promise((resolve, reject) => { this.#queue.push({ options, resolve, reject }); this.#pump(); }); }
    #pick() { const workers = this.available(); return workers.sort((a, b) => (this.#running.get(a.id) ?? 0) - (this.#running.get(b.id) ?? 0))[0]; }
    #pump() { while (this.#queue.length) { const config = this.#pick(); if (!config) { const item = this.#queue.shift(); item.reject(new Error('No configured SideCar is available.')); continue; } const running = this.#running.get(config.id) ?? 0; if (running > 0) return; const item = this.#queue.shift(); this.#running.set(config.id, running + 1); this.service(config.id).request(item.options).then(item.resolve, item.reject).finally(() => { this.#running.set(config.id, (this.#running.get(config.id) ?? 1) - 1); this.#pump(); }); } }
    remove(id) { if (id === 'primary') return false; const configs = this.configs(); const index = configs.findIndex(item => item.id === id); if (index < 0) return false; configs.splice(index, 1); this.#services.delete(id); this.#running.delete(id); this.#save(); this.checkHealth(); return true; }
    add() { const id = `sidecar_${Date.now().toString(36)}`; const source = this.configs()[0]; this.configs().push({ ...structuredClone(source), id, name: `SideCar ${this.configs().length + 1}` }); this.#save(); this.checkHealth(); return id; }

    /**
     * Silently probes every currently-configured worker (`.test()` — a real, tiny
     * request each) and sets `healthy` to whether ANY of them answered. No toast:
     * this is exactly what mount() blinks the card's border on instead of announcing
     * anything (see `healthy`'s own doc comment). Runs once automatically when the
     * engine starts (ModuleEngine.start()) and again after anything that could change
     * the answer — add/remove a worker here, or a worker's own Save/Test button via
     * the onChange callback passed into SidecarService.render() below.
     */
    async checkHealth() {
        const workers = this.available();
        if (!workers.length) { this.healthy.set(false); return false; }
        const results = await Promise.allSettled(workers.map(config => this.service(config.id).test()));
        const ok = results.some(result => result.status === 'fulfilled');
        this.healthy.set(ok);
        return ok;
    }

    /**
     * Builds the manager UI once. Each worker's own SideCar form is built once too
     * (via list()'s keyed reuse) — adding or removing a worker only touches that one
     * card, so an in-progress edit on another worker's form is never discarded.
     */
    render(container, toast) {
        container.className = 'stme-sidecar-manager';
        const configsSig = signal(this.configs());

        // No title/description here — the outer .stme-base-card's own summary
        // (core/module-engine.js's mount()) already says "SideCar Manager" with its
        // own description right above this; a second, near-identical header row
        // used to read as a stray seam between two near-duplicate title bars.
        const toolbar = h('div', { class: 'stme-sidecar-manager-head' },
            Button('+ SideCar', () => { this.add(); configsSig.set(this.configs()); }),
        );

        const workers = list(configsSig, config => config.id, config => {
            const summary = h('summary', {}, h('span', {}, config.name));
            if (config.id !== 'primary') {
                summary.append(Button('Remove', event => {
                    event.preventDefault(); event.stopPropagation();
                    this.remove(config.id);
                    configsSig.set(this.configs());
                }, { variant: 'danger' }));
            }
            const content = h('div', {});
            this.service(config.id).render(content, toast, false, () => this.checkHealth());
            const card = h('details', { class: 'stme-sidecar-worker', open: true }, summary, content);
            return card;
        });

        container.replaceChildren(toolbar, workers);
    }
}
