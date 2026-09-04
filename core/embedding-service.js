import { h, signal, Field, TextInput, Toggle, Select, Button } from './widgets.js';

const FORMAT_OPTIONS = Object.freeze([
    { id: 'openai', name: 'OpenAI-compatible' },
    { id: 'google', name: 'Google Gemini' },
]);
// Anthropic is deliberately absent — they don't ship an embeddings endpoint at
// all, unlike the generation SideCar's three formats. Listing it here would be
// a fake option with nothing real behind it.

const DEFAULTS = Object.freeze({
    enabled: false,
    endpoint: '',
    apiKey: '',
    model: '',
    format: 'openai',
    timeoutMs: 60000,
});

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/**
 * A separate, single shared embedding connection — deliberately NOT part of
 * SidecarService's generation worker pool (core/sidecar-service.js). Embeddings
 * are a fundamentally different contract (text in, a fixed-length vector out; no
 * sampler, no reasoning, no chat messages) and aren't interchangeable with a
 * chat-completion endpoint, so round-robin-ing requests across several "workers"
 * the way generation SideCars do makes little sense here: one endpoint is the
 * common case, since every vector you ever produce must stay comparable against
 * every other one — switching models mid-project silently corrupts every
 * similarity comparison downstream. Exposed to modules as `host.embedding`,
 * parallel to (not nested under) `host.sidecar`.
 *
 * Deliberately infrastructure-only for now: no built-in module reads from this
 * yet. It exists so a future module that actually needs real semantic search/
 * similarity (over Notebook entries, Lorebook entries, chat history, …) has a
 * real, configured connection to call instead of inventing its own.
 */
export class EmbeddingService {
    #settingsRoot;
    #save;

    constructor(settingsRoot, save) {
        this.#settingsRoot = settingsRoot;
        this.#save = save;
    }

    settings() {
        const settings = this.#settingsRoot().embedding ??= { ...DEFAULTS };
        settings.enabled = Boolean(settings.enabled);
        settings.endpoint = String(settings.endpoint ?? '').trim();
        settings.apiKey = String(settings.apiKey ?? '').trim();
        settings.model = String(settings.model ?? '').trim();
        settings.format = ['openai', 'google'].includes(settings.format) ? settings.format : 'openai';
        settings.timeoutMs = Math.round(clamp(settings.timeoutMs, 1000, 300000, DEFAULTS.timeoutMs));
        return settings;
    }

    update(values) {
        const settings = this.settings();
        Object.assign(settings, values);
        this.settings();
        this.#save();
        return { ...settings };
    }

    isConfigured() {
        const settings = this.settings();
        return settings.enabled && Boolean(settings.endpoint);
    }

    publicSettings() {
        const { apiKey, ...safe } = this.settings();
        return safe;
    }

    forModule(moduleId) {
        return Object.freeze({
            /** `input`: a string, or an array of strings for a batch — the return shape mirrors it (one vector, or one vector per input, in the same order). */
            request: input => this.request(input, { moduleId }),
            isConfigured: () => this.isConfigured(),
        });
    }

    /** `input`: a string or an array of strings. Returns one vector (number[]) for a single string, or one vector per input (in the same order) for an array. */
    async request(input, { moduleId = 'unknown', timeoutMs } = {}) {
        if (!this.isConfigured()) throw new Error('Embedding SideCar is not configured. Enable it and provide an endpoint in ST Module Engine settings.');
        const batch = Array.isArray(input) ? input : [input];
        const texts = batch.map(item => String(item ?? ''));
        if (!texts.length || texts.every(text => !text.trim())) throw new Error('Embedding request requires at least one non-empty input.');
        const settings = this.settings();
        const effectiveTimeout = Math.round(clamp(timeoutMs, 1000, 300000, settings.timeoutMs));
        console.debug(`[ST Module Engine] Embedding request from ${moduleId} (${texts.length} input(s)).`);
        const vectors = settings.format === 'google'
            ? await this.#google(settings, texts, effectiveTimeout)
            : await this.#openAi(settings, texts, effectiveTimeout);
        return Array.isArray(input) ? vectors : vectors[0];
    }

    async test() {
        const started = Date.now();
        const [vector] = await this.request(['ping'], { moduleId: 'embedding-test' });
        return { dimensions: vector.length, latencyMs: Date.now() - started };
    }

    async #fetchJson(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Embedding request timed out.')), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 300);
                throw new Error(`Embedding HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
            }
            return await response.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async #openAi(settings, texts, timeoutMs) {
        const endpoint = /\/embeddings$/.test(settings.endpoint) ? settings.endpoint : `${settings.endpoint.replace(/\/+$/, '')}/embeddings`;
        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: settings.model, input: texts }) }, timeoutMs);
        // Sorted by index rather than trusted as already-ordered — OpenAI's own docs
        // say results come back in the same order, but not every OpenAI-compatible
        // server necessarily honors that; sorting is cheap insurance either way.
        const items = Array.isArray(data?.data) ? [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
        if (items.length !== texts.length) throw new Error(`Embedding response returned ${items.length} vector(s) for ${texts.length} input(s).`);
        return items.map(item => item.embedding ?? []);
    }

    async #google(settings, texts, timeoutMs) {
        // Gemini's batch endpoint: one request, N contents, N embeddings back in the
        // same order — same endpoint-construction convention as sidecar-service.js's
        // own #google() (base URL ends in `.../models`, model+action appended).
        const endpoint = `${settings.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(settings.model)}:batchEmbedContents?key=${encodeURIComponent(settings.apiKey)}`;
        const requests = texts.map(text => ({ model: `models/${settings.model}`, content: { parts: [{ text }] } }));
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) }, timeoutMs);
        const embeddings = Array.isArray(data?.embeddings) ? data.embeddings : [];
        if (embeddings.length !== texts.length) throw new Error(`Embedding response returned ${embeddings.length} vector(s) for ${texts.length} input(s).`);
        return embeddings.map(item => item.values ?? []);
    }

    /** Builds the embedding SideCar form — deliberately minimal: no sampler, no reasoning, no profiles (a single connection, unlike generation's per-profile sampler settings). Reuses the same `.stme-sidecar` box styling as the generation card. */
    render(container, toast) {
        const settings = this.settings();
        const enabled = signal(settings.enabled);
        const format = signal(settings.format);
        const endpoint = signal(settings.endpoint);
        const apiKey = signal(settings.apiKey);
        const model = signal(settings.model);

        const apiKeyInput = TextInput(apiKey, { type: 'password', placeholder: 'Optional for local endpoints' });
        apiKeyInput.autocomplete = 'off';

        const readAll = () => ({ enabled: enabled.peek(), format: format.peek(), endpoint: endpoint.peek(), apiKey: apiKey.peek(), model: model.peek() });

        container.className = 'stme-sidecar';
        container.append(
            h('div', { class: 'stme-sidecar-fields' },
                Toggle('Enable embedding SideCar', enabled),
                Field('Format', Select(format, signal(FORMAT_OPTIONS))),
                Field('Endpoint', TextInput(endpoint, { type: 'url', placeholder: 'https://api.example.com/v1' })),
                Field('API key', apiKeyInput),
                Field('Model', TextInput(model, { placeholder: 'e.g. text-embedding-3-small' })),
                h('div', {},
                    Button('Save embedding SideCar', () => {
                        this.update(readAll());
                        toast('success', 'Embedding SideCar saved.', 'Embedding SideCar');
                    }),
                    ' ',
                    Button('Test connection', async event => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            this.update(readAll());
                            const result = await this.test();
                            toast('success', `Connected in ${result.latencyMs} ms — ${result.dimensions} dimensions.`, 'Embedding SideCar');
                        } catch (error) {
                            toast('error', error?.message || String(error), 'Embedding SideCar');
                        } finally {
                            button.disabled = false;
                        }
                    }),
                ),
            ),
        );
    }
}
