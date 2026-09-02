const DEFAULTS = Object.freeze({
    enabled: false,
    endpoint: '',
    apiKey: '',
    model: '',
    format: 'openai',
    temperature: 0.3,
    maxTokens: 1000,
    timeoutMs: 60000,
});

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** A shared, configuration-owned LLM sidecar for all engine modules. */
export class SidecarService {
    #settingsRoot;
    #save;
    #leases = new Map();
    #sequence = 0;

    constructor(settingsRoot, save) {
        this.#settingsRoot = settingsRoot;
        this.#save = save;
    }

    settings() {
        const settings = this.#settingsRoot().sidecar ??= { ...DEFAULTS };
        settings.enabled = Boolean(settings.enabled);
        settings.endpoint = String(settings.endpoint ?? '').trim();
        settings.apiKey = String(settings.apiKey ?? '').trim();
        settings.model = String(settings.model ?? '').trim();
        settings.format = ['openai', 'anthropic', 'google'].includes(settings.format) ? settings.format : 'openai';
        settings.temperature = clamp(settings.temperature, 0, 2, DEFAULTS.temperature);
        settings.maxTokens = Math.round(clamp(settings.maxTokens, 1, 32768, DEFAULTS.maxTokens));
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

    forModule(moduleId) {
        return Object.freeze({
            /** One-shot request. No persistent allocation is retained. */
            request: (options) => this.request({ ...options, moduleId }),
            /**
             * Reserve a client for the module lifecycle. A lease does not keep an
             * HTTP connection open; it gives repeated requests one central config
             * and is released explicitly (usually from the module cleanup).
             */
            acquire: (label = moduleId) => this.acquire(moduleId, label),
            isConfigured: () => this.isConfigured(),
            getSettings: () => this.publicSettings(),
        });
    }

    acquire(moduleId, label = moduleId) {
        const id = `${moduleId}:${++this.#sequence}`;
        this.#leases.set(id, { moduleId, label, createdAt: Date.now() });
        let released = false;
        return Object.freeze({
            request: (options) => {
                if (released) throw new Error('This SideCar lease has been released.');
                return this.request({ ...options, moduleId });
            },
            release: () => { released = true; this.#leases.delete(id); },
            isConfigured: () => this.isConfigured(),
        });
    }

    publicSettings() {
        const { apiKey, ...safe } = this.settings();
        return { ...safe, activeLeases: this.#leases.size };
    }

    async request({ prompt, systemPrompt = '', temperature, maxTokens, timeoutMs, signal, moduleId = 'unknown' } = {}) {
        if (!this.isConfigured()) throw new Error('SideCar is not configured. Enable it and provide an endpoint in ST Module Engine settings.');
        if (!String(prompt ?? '').trim()) throw new Error('SideCar request requires a prompt.');
        const settings = this.settings();
        const request = {
            prompt: String(prompt), systemPrompt: String(systemPrompt ?? ''),
            temperature: clamp(temperature, 0, 2, settings.temperature),
            maxTokens: Math.round(clamp(maxTokens, 1, 32768, settings.maxTokens)),
            timeoutMs: Math.round(clamp(timeoutMs, 1000, 300000, settings.timeoutMs)),
            signal,
        };
        console.debug(`[ST Module Engine] SideCar request from ${moduleId}.`);
        if (settings.format === 'anthropic') return this.#anthropic(settings, request);
        if (settings.format === 'google') return this.#google(settings, request);
        return this.#openAi(settings, request);
    }

    async test() {
        const started = Date.now();
        const text = await this.request({ prompt: 'Reply with exactly: OK', maxTokens: 16, moduleId: 'sidecar-test' });
        return { text, latencyMs: Date.now() - started };
    }

    async #fetchJson(url, options, timeoutMs, signal) {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('SideCar request timed out.')), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 300);
                throw new Error(`SideCar HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
            }
            return await response.json();
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    async #openAi(settings, request) {
        const endpoint = /\/chat\/completions$/.test(settings.endpoint)
            ? settings.endpoint : `${settings.endpoint.replace(/\/+$/, '')}/chat/completions`;
        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
        const messages = request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : [];
        messages.push({ role: 'user', content: request.prompt });
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: settings.model, messages, temperature: request.temperature, max_tokens: request.maxTokens }) }, request.timeoutMs, request.signal);
        return String(data.choices?.[0]?.message?.content ?? '').trim();
    }

    async #anthropic(settings, request) {
        const endpoint = /\/messages$/.test(settings.endpoint) ? settings.endpoint : `${settings.endpoint.replace(/\/+$/, '')}/messages`;
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: settings.model, max_tokens: request.maxTokens, temperature: request.temperature, system: request.systemPrompt, messages: [{ role: 'user', content: request.prompt }] }) }, request.timeoutMs, request.signal);
        return String(data.content?.find(block => block.type === 'text')?.text ?? '').trim();
    }

    async #google(settings, request) {
        const endpoint = `${settings.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
        const text = request.systemPrompt ? `${request.systemPrompt}\n\n---\n\n${request.prompt}` : request.prompt;
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxTokens } }) }, request.timeoutMs, request.signal);
        return String(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    }

    render(container, toast) {
        const settings = this.settings();
        container.className = 'stme-sidecar';
        container.innerHTML = `<header><div><strong>SideCar</strong><small>One shared model profile for all modules.</small></div></header>
            <div class="stme-sidecar-fields">
              <label class="stme-check"><input data-field="enabled" type="checkbox"> Enable SideCar</label>
              <label>Format <select class="text_pole" data-field="format"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option><option value="google">Google Gemini</option></select></label>
              <label>Endpoint <input class="text_pole" data-field="endpoint" type="url" placeholder="https://api.example.com/v1"></label>
              <label>API key <input class="text_pole" data-field="apiKey" type="password" autocomplete="off" placeholder="Optional for local endpoints"></label>
              <label>Model <input class="text_pole" data-field="model" type="text" placeholder="Model name"></label>
              <label>Temperature <input class="text_pole" data-field="temperature" type="number" min="0" max="2" step="0.05"></label>
              <label>Max tokens <input class="text_pole" data-field="maxTokens" type="number" min="1" max="32768"></label>
              <div><button class="menu_button" data-action="save" type="button">Save SideCar</button> <button class="menu_button" data-action="test" type="button">Test connection</button></div>
            </div>`;
        for (const [key, value] of Object.entries(settings)) {
            const input = container.querySelector(`[data-field="${key}"]`);
            if (!input) continue;
            if (input.type === 'checkbox') input.checked = value;
            else input.value = value;
        }
        const read = () => Object.fromEntries(['enabled', 'format', 'endpoint', 'apiKey', 'model', 'temperature', 'maxTokens'].map(key => {
            const input = container.querySelector(`[data-field="${key}"]`);
            return [key, input.type === 'checkbox' ? input.checked : input.value];
        }));
        container.querySelector('[data-action="save"]').addEventListener('click', () => { this.update(read()); toast('success', 'SideCar settings saved.', 'SideCar'); });
        container.querySelector('[data-action="test"]').addEventListener('click', async (event) => {
            event.currentTarget.disabled = true;
            try { this.update(read()); const result = await this.test(); toast('success', `Connected in ${result.latencyMs} ms: ${result.text || '(empty response)'}`, 'SideCar'); }
            catch (error) { toast('error', error?.message || String(error), 'SideCar'); }
            finally { event.currentTarget.disabled = false; }
        });
    }
}
