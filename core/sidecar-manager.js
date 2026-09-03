import { SidecarService } from './sidecar-service.js';
import { MainLlmService } from './main-llm-service.js';
import { h, list, signal, Button } from './widgets.js';

/** Schedules module requests over several SideCar configurations for lowest queue wait. */
export class SidecarManager {
    #root; #save; #getContext; #services = new Map(); #queue = []; #running = new Map();
    #mainLlm;
    // Per-worker live status for state-track.js — see workerStates() below. Plain
    // Map, not signals: #statesTick is the one signal that changes, and
    // workerStates() reads it (for dependency tracking, e.g. inside an effect())
    // then recomputes the array fresh from #root's current worker list plus
    // whatever's in this map. Same "bump a tick signal, recompute on read" shape
    // ModuleEngine's own #layoutVersion/#orderedSignal already use.
    #workerStatus = new Map();
    #statesTick = signal(0);
    // null = not yet checked (no blink — avoids a false-positive flash before the
    // startup check below has had a chance to run); true = at least one configured
    // worker answered; false = either nothing is configured at all, or every
    // configured worker failed to answer — core/module-engine.js's mount() reads
    // this to blink the outer card's border blue. Exposed as a plain public field
    // (the raw signal), same convention as e.g. full-screen-panel.js's `visible`.
    healthy = signal(null);
    // Lazy accessor, not a direct reference — mirrors #getContext/#root above.
    // Needed because RoutePlanner itself is constructed FROM a SidecarManager
    // (see core/module-engine.js: `new RoutePlanner(bus, this.sidecar)`), so a
    // direct reference here would be circular; a function that's only ever
    // CALLED later, once both objects exist, isn't. Defaults to a no-op
    // returning null so every existing caller/test that constructs a
    // SidecarManager without a 4th argument keeps today's exact behavior —
    // request() below treats "no route planner" the same as "route planner
    // said proceed."
    #getRoutePlanner;
    constructor(settingsRoot, save, getContext, getRoutePlanner = () => null) {
        this.#root = settingsRoot;
        this.#save = save;
        this.#getContext = getContext;
        this.#getRoutePlanner = getRoutePlanner;
        this.#mainLlm = new MainLlmService(getContext);
    }
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
    // Deliberately excludes the main-LLM fallback — it is priority-0 by design, never
    // part of the normal round-robin pool `request()`/`#pick()` draw from. See
    // requestFallback() below, the only way anything reaches it.
    available() { return this.configs().filter(config => this.service(config.id).isConfigured()); }
    isConfigured() { return this.available().length > 0; }
    profiles() { const seen = new Map(); for (const config of this.configs()) for (const profile of this.service(config.id).profiles()) seen.set(profile.id, profile); return [...seen.values()].map(({ id, name }) => ({ id, name })); }

    /** Whether the main-LLM fallback (below) is allowed to be used at all — on by default; a silent "no fallback exists" defeats the point, but this is still an explicit, callable escape hatch, never automatic. */
    mainLlmFallbackEnabled() { return this.#root().mainLlmFallbackEnabled !== false; }
    setMainLlmFallbackEnabled(value) { this.#root().mainLlmFallbackEnabled = Boolean(value); this.#save(); }
    isMainLlmFallbackAvailable() { return this.mainLlmFallbackEnabled() && this.#mainLlm.isConfigured(); }

    /**
     * Routes a request through ST's own main LLM connection instead of any
     * configured SideCar — see core/main-llm-service.js. Never called by
     * request()/#pump() themselves; a module calls this directly, by name, only
     * after deciding a specific failure warrants it (e.g. every configured worker
     * just failed). Bypasses the queue entirely — this isn't one of the rate-limited
     * HTTP workers request() balances load across, it's a fundamentally different,
     * already-shared resource ST itself manages.
     */
    async requestFallback(options) {
        if (!this.mainLlmFallbackEnabled()) throw new Error('The main LLM fallback is turned off.');
        return this.#mainLlm.request(options);
    }

    forModule(moduleId) {
        return Object.freeze({
            request: options => this.request({ ...options, moduleId }),
            requestFallback: options => this.requestFallback({ ...options, moduleId }),
            acquire: label => this.acquire(moduleId, label),
            isConfigured: () => this.isConfigured(),
            isFallbackAvailable: () => this.isMainLlmFallbackAvailable(),
            profiles: () => this.profiles(),
            getSettings: () => ({ workers: this.configs().length, queued: this.#queue.length, running: [...this.#running.values()].reduce((a, b) => a + b, 0) }),
            diagnostics: () => this.configs().map(config => { const settings = this.service(config.id).settings(); return { id: config.id, name: config.name, enabled: settings.enabled, hasEndpoint: Boolean(settings.endpoint), hasModel: Boolean(settings.model), configured: this.service(config.id).isConfigured() }; }),
        });
    }
    acquire(moduleId, label = moduleId) {
        let released = false;
        return Object.freeze({
            request: options => { if (released) throw new Error('This SideCar lease has been released.'); return this.request({ ...options, moduleId }); },
            requestFallback: options => { if (released) throw new Error('This SideCar lease has been released.'); return this.requestFallback({ ...options, moduleId }); },
            release: () => { released = true; },
            isConfigured: () => this.isConfigured(),
            isFallbackAvailable: () => this.isMainLlmFallbackAvailable(),
            label,
        });
    }
    /**
     * Phase 4 of the State-Track/Dependency-Scanner/Route-Planner work (see
     * MODULES.md's State-Track section) — the one point in this codebase where
     * RoutePlanner's decision actually changes real behavior, chosen
     * deliberately as a SINGLE centralized integration point rather than
     * touching every module's own request-timing code: every SideCar request
     * from every module already passes through here.
     *
     * `routePlanner.decide(moduleId)` (see core/route-planner.js) runs first —
     * a pure TIMING question. `'proceed'` (or no route planner at all, or
     * decide() being unavailable) is exactly today's original behavior — queue
     * and pump immediately. `'wait'` genuinely delays — awaits
     * `routePlanner.waitFor(...)` (bounded, see that method's own doc comment
     * for the timeout) — before this request is even queued; every OTHER
     * already-queued/future request from any other module is completely
     * unaffected, since only THIS ONE request's own dispatch is deferred.
     *
     * ONLY once that wait has actually resolved does worker CHOICE become a
     * separate question: `routePlanner.pickIdleWorker()` is consulted then (and
     * only then) to skip the normal queue/#pick() round-robin if something is
     * sitting idle right that moment — never to skip the wait itself. An
     * earlier version of this method let a 'reroute' decision skip the wait
     * entirely; a real end-to-end test proved that wrong (see
     * route-planner.js's own doc comment) — which worker runs a request never
     * changes whether it's actually safe to run yet.
     */
    request(options) {
        const moduleId = options.moduleId ?? 'unknown';
        const routePlanner = this.#getRoutePlanner?.();
        const decision = routePlanner?.decide?.(moduleId);

        if (decision?.decision === 'wait') {
            return routePlanner.waitFor(decision.for).then(() => this.#dispatchAfterWait(options, routePlanner));
        }
        return this.#enqueue(options);
    }
    /** Only ever called once a real wait has already resolved — prefers a genuinely idle worker over the normal queue, but falls back to the normal queue exactly like any other request when nothing's idle. */
    #dispatchAfterWait(options, routePlanner) {
        const idleWorker = routePlanner.pickIdleWorker?.();
        if (idleWorker) return new Promise((resolve, reject) => this.#runOn(idleWorker.id, { options, resolve, reject }));
        return this.#enqueue(options);
    }
    #enqueue(options) { return new Promise((resolve, reject) => { this.#queue.push({ options, resolve, reject }); this.#pump(); }); }
    #pick() { const workers = this.available(); return workers.sort((a, b) => (this.#running.get(a.id) ?? 0) - (this.#running.get(b.id) ?? 0))[0]; }
    #pump() {
        while (this.#queue.length) {
            const config = this.#pick();
            if (!config) { const item = this.#queue.shift(); item.reject(new Error('No configured SideCar is available.')); continue; }
            const running = this.#running.get(config.id) ?? 0;
            if (running > 0) return;
            this.#runOn(config.id, this.#queue.shift());
        }
    }
    /** Actually dispatches one item to one worker (bypassing the queue/#pick() entirely when called directly, e.g. for a RoutePlanner reroute) and keeps #running/#workerStatus bookkeeping consistent either way. */
    #runOn(configId, item) {
        const running = this.#running.get(configId) ?? 0;
        this.#running.set(configId, running + 1);
        this.#setWorkerStatus(configId, { status: 'requesting' });
        this.service(configId).request(item.options).then(
            result => { this.#setWorkerStatus(configId, { status: 'idle', lastOutcome: 'success', lastError: null, lastAt: Date.now() }); item.resolve(result); },
            error => { this.#setWorkerStatus(configId, { status: 'idle', lastOutcome: 'failed', lastError: error?.message || String(error), lastAt: Date.now() }); item.reject(error); },
        ).finally(() => { this.#running.set(configId, (this.#running.get(configId) ?? 1) - 1); this.#pump(); });
    }

    #setWorkerStatus(id, patch) {
        this.#workerStatus.set(id, { ...this.#workerStatus.get(id), ...patch });
        this.#statesTick.update(n => n + 1);
    }

    /**
     * One row per currently-configured worker, for state-track.js. `status` is
     * live (idle/requesting, right now); `lastOutcome`/`lastError`/`lastAt`
     * persist from the most recent completed request until the next one
     * overwrites them — same "live vs. sticky-until-overwritten" split
     * MainLlmStateTrack uses for phase vs. lastOutcome, so both halves of
     * State-Track read the same way.
     */
    workerStates() {
        this.#statesTick();
        return this.configs().map(config => {
            const status = this.#workerStatus.get(config.id);
            return {
                id: config.id,
                name: config.name,
                configured: this.service(config.id).isConfigured(),
                status: status?.status ?? 'idle',
                lastOutcome: status?.lastOutcome ?? null,
                lastError: status?.lastError ?? null,
                lastAt: status?.lastAt ?? null,
            };
        });
    }
    remove(id) { if (id === 'primary') return false; const configs = this.configs(); const index = configs.findIndex(item => item.id === id); if (index < 0) return false; configs.splice(index, 1); this.#services.delete(id); this.#running.delete(id); this.#workerStatus.delete(id); this.#statesTick.update(n => n + 1); this.#save(); this.checkHealth(); return true; }
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
