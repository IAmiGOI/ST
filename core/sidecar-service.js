const DEFAULTS = Object.freeze({
    enabled: false,
    endpoint: '',
    apiKey: '',
    model: '',
    format: 'openai',
    temperature: 0.3,
    topP: 1,
    topK: 0,
    minP: 0,
    typicalP: 1,
    repetitionPenalty: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 1000,
    seed: 0,
    reasoningMode: 'inherit',
    reasoningEffort: 'medium',
    reasoningMaxTokens: 0,
    reasoningExclude: true,
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
    #editingProfile = 'default';

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
        settings.topP = clamp(settings.topP, 0, 1, DEFAULTS.topP);
        settings.topK = Math.round(clamp(settings.topK, 0, 200, DEFAULTS.topK));
        settings.minP = clamp(settings.minP, 0, 1, DEFAULTS.minP);
        settings.typicalP = clamp(settings.typicalP, 0, 1, DEFAULTS.typicalP);
        settings.repetitionPenalty = clamp(settings.repetitionPenalty, 0, 2, DEFAULTS.repetitionPenalty);
        settings.frequencyPenalty = clamp(settings.frequencyPenalty, -2, 2, DEFAULTS.frequencyPenalty);
        settings.presencePenalty = clamp(settings.presencePenalty, -2, 2, DEFAULTS.presencePenalty);
        settings.maxTokens = Math.round(clamp(settings.maxTokens, 1, 32768, DEFAULTS.maxTokens));
        settings.seed = Math.round(clamp(settings.seed, 0, 999999, DEFAULTS.seed));
        settings.reasoningMode = ['inherit', 'enabled', 'disabled'].includes(settings.reasoningMode) ? settings.reasoningMode : DEFAULTS.reasoningMode;
        settings.reasoningEffort = ['low', 'medium', 'high'].includes(settings.reasoningEffort) ? settings.reasoningEffort : DEFAULTS.reasoningEffort;
        settings.reasoningMaxTokens = Math.round(clamp(settings.reasoningMaxTokens, 0, 32768, DEFAULTS.reasoningMaxTokens));
        settings.reasoningExclude = Boolean(settings.reasoningExclude);
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


    profiles() {
        const settings = this.settings();
        settings.profiles ??= { default: { id: 'default', name: 'Default', ...this.#profileValues(settings) } };
        if (!settings.profiles.default) settings.profiles.default = { id: 'default', name: 'Default', ...this.#profileValues(settings) };
        return Object.values(settings.profiles);
    }

    #profileValues(settings) { return { temperature: settings.temperature, topP: settings.topP, topK: settings.topK, minP: settings.minP, typicalP: settings.typicalP, repetitionPenalty: settings.repetitionPenalty, frequencyPenalty: settings.frequencyPenalty, presencePenalty: settings.presencePenalty, maxTokens: settings.maxTokens, seed: settings.seed, reasoningMode: settings.reasoningMode, reasoningEffort: settings.reasoningEffort, reasoningMaxTokens: settings.reasoningMaxTokens, reasoningExclude: settings.reasoningExclude }; }

    profile(id = 'default') { const profiles = this.profiles(); return profiles.find(profile => profile.id === id) ?? profiles.find(profile => profile.id === 'default'); }

    createProfile(name) { const id = `profile_${Date.now().toString(36)}`; const source = this.profile(this.#editingProfile); this.settings().profiles[id] = { ...source, id, name: String(name || 'New profile').trim().slice(0, 80) || 'New profile' }; this.#editingProfile = id; this.#save(); return id; }

    isConfigured() {
        const settings = this.settings();
        return settings.enabled && Boolean(settings.endpoint);
    }

    forModule(moduleId) {
        return Object.freeze({
            /** One-shot request. No persistent allocation is retained. */
            request: (options) => this.request({ ...options, moduleId }),
            profiles: () => this.profiles().map(({ id, name }) => ({ id, name })),
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

    async request({ prompt, systemPrompt = '', temperature, maxTokens, timeoutMs, signal, profileId = 'default', moduleId = 'unknown' } = {}) {
        if (!this.isConfigured()) throw new Error('SideCar is not configured. Enable it and provide an endpoint in ST Module Engine settings.');
        if (!String(prompt ?? '').trim()) throw new Error('SideCar request requires a prompt.');
        const settings = this.settings();
        const profile = this.profile(profileId);
        const request = {
            prompt: String(prompt), systemPrompt: String(systemPrompt ?? ''),
            temperature: clamp(temperature, 0, 2, profile.temperature),
            maxTokens: Math.round(clamp(maxTokens, 1, 32768, profile.maxTokens)),
            timeoutMs: Math.round(clamp(timeoutMs, 1000, 300000, settings.timeoutMs)),
            signal,
            sampler: { topP: profile.topP, topK: profile.topK, minP: profile.minP, typicalP: profile.typicalP, repetitionPenalty: profile.repetitionPenalty, frequencyPenalty: profile.frequencyPenalty, presencePenalty: profile.presencePenalty, seed: profile.seed },
            reasoning: { mode: profile.reasoningMode, effort: profile.reasoningEffort, maxTokens: profile.reasoningMaxTokens, exclude: profile.reasoningExclude },
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
        const reasoning = /openrouter\.ai/i.test(settings.endpoint) && request.reasoning.mode !== 'inherit' ? { reasoning: { enabled: request.reasoning.mode === 'enabled', effort: request.reasoning.effort, ...(request.reasoning.maxTokens ? { max_tokens: request.reasoning.maxTokens } : {}), ...(request.reasoning.exclude ? { exclude: true } : {}) } } : {};
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: settings.model, messages, temperature: request.temperature, top_p: request.sampler.topP, frequency_penalty: request.sampler.frequencyPenalty, presence_penalty: request.sampler.presencePenalty, max_tokens: request.maxTokens, ...(request.sampler.topK ? { top_k: request.sampler.topK } : {}), ...(request.sampler.minP ? { min_p: request.sampler.minP } : {}), ...(request.sampler.typicalP !== 1 ? { typical_p: request.sampler.typicalP } : {}), ...(request.sampler.repetitionPenalty !== 1 ? { repetition_penalty: request.sampler.repetitionPenalty } : {}), ...(request.sampler.seed ? { seed: request.sampler.seed } : {}), ...reasoning }) }, request.timeoutMs, request.signal);
        return String(data.choices?.[0]?.message?.content ?? '').trim();
    }

    async #anthropic(settings, request) {
        const endpoint = /\/messages$/.test(settings.endpoint) ? settings.endpoint : `${settings.endpoint.replace(/\/+$/, '')}/messages`;
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: settings.model, max_tokens: request.maxTokens, temperature: request.temperature, top_p: request.sampler.topP, top_k: request.sampler.topK || undefined, system: request.systemPrompt, messages: [{ role: 'user', content: request.prompt }] }) }, request.timeoutMs, request.signal);
        return String(data.content?.find(block => block.type === 'text')?.text ?? '').trim();
    }

    async #google(settings, request) {
        const endpoint = `${settings.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
        const text = request.systemPrompt ? `${request.systemPrompt}\n\n---\n\n${request.prompt}` : request.prompt;
        const data = await this.#fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: request.temperature, topP: request.sampler.topP, topK: request.sampler.topK || undefined, maxOutputTokens: request.maxTokens, ...(request.sampler.seed ? { seed: request.sampler.seed } : {}) } }) }, request.timeoutMs, request.signal);
        return String(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    }

    render(container, toast, includeHeader = true) {
        const settings = this.settings();
        const profile = this.profile(this.#editingProfile);
        const sliders = [
            ['temperature', 'Temperature', 0, 2, 0.05], ['topP', 'Top P', 0, 1, 0.01], ['topK', 'Top K', 0, 200, 1], ['minP', 'Min P', 0, 1, 0.01], ['typicalP', 'Typical P', 0, 1, 0.01], ['repetitionPenalty', 'Repetition penalty', 0, 2, 0.01], ['frequencyPenalty', 'Frequency penalty', -2, 2, 0.01], ['presencePenalty', 'Presence penalty', -2, 2, 0.01], ['maxTokens', 'Max tokens', 1, 32768, 1], ['seed', 'Seed (0 = random)', 0, 999999, 1],
        ];
        const sliderHtml = sliders.map(([key, label, min, max, step]) => `<label class="stme-slider"><span>${label} <output data-output="${key}"></output></span><input data-field="${key}" type="range" min="${min}" max="${max}" step="${step}"></label>`).join('');
        container.className = 'stme-sidecar';
        const header = includeHeader ? '<header><div><strong>SideCar</strong><small>One shared model profile for all modules.</small></div></header>' : '';
        container.innerHTML = `${header}<div class="stme-sidecar-fields"><div class="stme-profile-row"><label>Sampler profile <select class="text_pole" data-field="profileId"></select></label><button class="menu_button" data-action="new-profile" type="button">New profile</button></div><label class="stme-check"><input data-field="enabled" type="checkbox"> Enable SideCar</label><label>Format <select class="text_pole" data-field="format"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option><option value="google">Google Gemini</option></select></label><label>Endpoint <input class="text_pole" data-field="endpoint" type="url" placeholder="https://api.example.com/v1"></label><label>API key <input class="text_pole" data-field="apiKey" type="password" autocomplete="off" placeholder="Optional for local endpoints"></label><label>Model <input class="text_pole" data-field="model" type="text" placeholder="Model name"></label><details class="stme-sampler"><summary>Sampler settings <small>Unsupported fields may be ignored by your provider.</small></summary><div class="stme-sampler-grid">${sliderHtml}</div></details><details class="stme-reasoning"><summary>Reasoning <small>OpenRouter only</small></summary><div class="stme-reasoning-grid"><label>Mode <select class="text_pole" data-field="reasoningMode"><option value="inherit">Provider default</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label><label>Effort <select class="text_pole" data-field="reasoningEffort"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label class="stme-slider"><span>Reasoning tokens <output data-output="reasoningMaxTokens"></output></span><input data-field="reasoningMaxTokens" type="range" min="0" max="32768" step="1"></label><label class="stme-check"><input data-field="reasoningExclude" type="checkbox"> Hide reasoning from the reply</label></div></details><div><button class="menu_button" data-action="save" type="button">Save SideCar</button> <button class="menu_button" data-action="test" type="button">Test connection</button></div></div>`;
        for (const [key, value] of Object.entries({ ...settings, ...profile })) { const input = container.querySelector(`[data-field="${key}"]`); if (!input) continue; if (input.type === 'checkbox') input.checked = value; else input.value = value; const output = container.querySelector(`[data-output="${key}"]`); if (output) output.value = value; }
        for (const input of container.querySelectorAll('input[type="range"]')) input.addEventListener('input', () => { container.querySelector(`[data-output="${input.dataset.field}"]`).value = input.value; });
        const fields = ['enabled', 'format', 'endpoint', 'apiKey', 'model', ...sliders.map(([key]) => key), 'reasoningMode', 'reasoningEffort', 'reasoningMaxTokens', 'reasoningExclude'];
        const profileSelect = container.querySelector('[data-field="profileId"]'); for (const item of this.profiles()) { const option = new Option(item.name, item.id); option.selected = item.id === this.#editingProfile; profileSelect.add(option); }
        profileSelect.addEventListener('change', () => { this.#editingProfile = profileSelect.value; this.render(container, toast, includeHeader); });
        container.querySelector('[data-action="new-profile"]').addEventListener('click', () => { this.createProfile(window.prompt('Profile name', 'New profile')); this.render(container, toast, includeHeader); });
        const read = () => Object.fromEntries(fields.map(key => { const input = container.querySelector(`[data-field="${key}"]`); return [key, input.type === 'checkbox' ? input.checked : input.value]; }));
        container.querySelector('[data-action="save"]').addEventListener('click', () => { const values = read(); this.update(values); Object.assign(this.profile(this.#editingProfile), Object.fromEntries([...sliders.map(([key]) => key), 'reasoningMode', 'reasoningEffort', 'reasoningMaxTokens', 'reasoningExclude'].map(key => [key, values[key]]))); this.settings().profiles[this.#editingProfile] = this.profile(this.#editingProfile); this.#save(); toast('success', 'SideCar profile saved.', 'SideCar'); });
        container.querySelector('[data-action="test"]').addEventListener('click', async event => { event.currentTarget.disabled = true; try { this.update(read()); const result = await this.test(); toast('success', `Connected in ${result.latencyMs} ms: ${result.text || '(empty response)'}`, 'SideCar'); } catch (error) { toast('error', error?.message || String(error), 'SideCar'); } finally { event.currentTarget.disabled = false; } });
    }
}
