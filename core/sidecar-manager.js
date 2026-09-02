import { SidecarService } from './sidecar-service.js';

/** Schedules module requests over several SideCar configurations for lowest queue wait. */
export class SidecarManager {
    #root; #save; #services = new Map(); #queue = []; #running = new Map();
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
    forModule(moduleId) { return Object.freeze({ request: options => this.request({ ...options, moduleId }), acquire: label => this.acquire(moduleId, label), isConfigured: () => this.isConfigured(), profiles: () => this.profiles(), getSettings: () => ({ workers: this.configs().length, queued: this.#queue.length, running: [...this.#running.values()].reduce((a, b) => a + b, 0) }) }); }
    acquire(moduleId, label = moduleId) { let released = false; return Object.freeze({ request: options => { if (released) throw new Error('This SideCar lease has been released.'); return this.request({ ...options, moduleId }); }, release: () => { released = true; }, isConfigured: () => this.isConfigured(), label }); }
    request(options) { return new Promise((resolve, reject) => { this.#queue.push({ options, resolve, reject }); this.#pump(); }); }
    #pick() { const workers = this.available(); return workers.sort((a, b) => (this.#running.get(a.id) ?? 0) - (this.#running.get(b.id) ?? 0))[0]; }
    #pump() { while (this.#queue.length) { const config = this.#pick(); if (!config) { const item = this.#queue.shift(); item.reject(new Error('No configured SideCar is available.')); continue; } const running = this.#running.get(config.id) ?? 0; if (running > 0) return; const item = this.#queue.shift(); this.#running.set(config.id, running + 1); this.service(config.id).request(item.options).then(item.resolve, item.reject).finally(() => { this.#running.set(config.id, (this.#running.get(config.id) ?? 1) - 1); this.#pump(); }); } }
    add() { const id = `sidecar_${Date.now().toString(36)}`; const source = this.configs()[0]; this.configs().push({ ...structuredClone(source), id, name: `SideCar ${this.configs().length + 1}` }); this.#save(); return id; }
    render(container, toast) { container.className = 'stme-sidecar-manager'; container.replaceChildren(); const header = document.createElement('div'); header.className = 'stme-sidecar-manager-head'; header.innerHTML = '<div><strong>SideCar Manager</strong><small>Requests are sent to the first free SideCar; queued work is balanced for minimum total wait.</small></div>'; const add = document.createElement('button'); add.className = 'menu_button'; add.type = 'button'; add.textContent = '+ SideCar'; add.addEventListener('click', () => { this.add(); this.render(container, toast); }); header.append(add); container.append(header); for (const config of this.configs()) { const card = document.createElement('details'); card.className = 'stme-sidecar-worker'; card.open = true; const summary = document.createElement('summary'); summary.textContent = config.name; const content = document.createElement('div'); card.append(summary, content); container.append(card); this.service(config.id).render(content, toast, false); } }
}
