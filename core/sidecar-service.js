import { h, signal, Field, TextInput, Toggle, Select, SliderField, Button } from './widgets.js';

const FORMAT_OPTIONS = Object.freeze([{ id: 'openai', name: 'OpenAI-compatible' }, { id: 'anthropic', name: 'Anthropic Messages' }, { id: 'google', name: 'Google Gemini' }]);
const REASONING_MODE_OPTIONS = Object.freeze([{ id: 'inherit', name: 'Provider default' }, { id: 'enabled', name: 'Enabled' }, { id: 'disabled', name: 'Disabled' }]);
const REASONING_EFFORT_OPTIONS = Object.freeze([{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }]);
const SLIDERS = Object.freeze([
    ['temperature', 'Temperature', 0, 2, 0.05], ['topP', 'Top P', 0, 1, 0.01], ['topK', 'Top K', 0, 200, 1], ['minP', 'Min P', 0, 1, 0.01],
    ['typicalP', 'Typical P', 0, 1, 0.01], ['repetitionPenalty', 'Repetition penalty', 0, 2, 0.01], ['frequencyPenalty', 'Frequency penalty', -2, 2, 0.01],
    ['presencePenalty', 'Presence penalty', -2, 2, 0.01], ['maxTokens', 'Max tokens', 1, 32768, 1], ['seed', 'Seed (0 = random)', 0, 999999, 1],
]);

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

    profile(id = 'default') {
        const profile = this.profiles().find(item => item.id === id) ?? this.profiles().find(item => item.id === 'default');
        const fallback = this.#profileValues(this.settings());
        profile.temperature = clamp(profile.temperature, 0, 2, fallback.temperature);
        profile.topP = clamp(profile.topP, 0, 1, fallback.topP);
        profile.topK = Math.round(clamp(profile.topK, 0, 200, fallback.topK));
        profile.minP = clamp(profile.minP, 0, 1, fallback.minP);
        profile.typicalP = clamp(profile.typicalP, 0, 1, fallback.typicalP);
        profile.repetitionPenalty = clamp(profile.repetitionPenalty, 0, 2, fallback.repetitionPenalty);
        profile.frequencyPenalty = clamp(profile.frequencyPenalty, -2, 2, fallback.frequencyPenalty);
        profile.presencePenalty = clamp(profile.presencePenalty, -2, 2, fallback.presencePenalty);
        profile.maxTokens = Math.round(clamp(profile.maxTokens, 1, 32768, fallback.maxTokens));
        profile.seed = Math.round(clamp(profile.seed, 0, 999999, fallback.seed));
        profile.reasoningMode = ['inherit', 'enabled', 'disabled'].includes(profile.reasoningMode) ? profile.reasoningMode : fallback.reasoningMode;
        profile.reasoningEffort = ['low', 'medium', 'high'].includes(profile.reasoningEffort) ? profile.reasoningEffort : fallback.reasoningEffort;
        profile.reasoningMaxTokens = Math.round(clamp(profile.reasoningMaxTokens, 0, 32768, fallback.reasoningMaxTokens));
        profile.reasoningExclude = Boolean(profile.reasoningExclude);
        return profile;
    }

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

    /** Builds the SideCar form once. Connection fields are shared; sampler/reasoning fields reload per selected profile. */
    render(container, toast, includeHeader = true) {
        const settings = this.settings();

        const profileId = signal(this.#editingProfile);
        const profiles = signal(this.profiles());

        const enabled = signal(settings.enabled);
        const format = signal(settings.format);
        const endpoint = signal(settings.endpoint);
        const apiKey = signal(settings.apiKey);
        const model = signal(settings.model);

        const sliderSignals = Object.fromEntries(SLIDERS.map(([key]) => [key, signal(0)]));
        const reasoningMode = signal(DEFAULTS.reasoningMode);
        const reasoningEffort = signal(DEFAULTS.reasoningEffort);
        const reasoningMaxTokens = signal(DEFAULTS.reasoningMaxTokens);
        const reasoningExclude = signal(DEFAULTS.reasoningExclude);

        const loadProfile = id => {
            const profile = this.profile(id);
            for (const [key] of SLIDERS) sliderSignals[key].set(profile[key]);
            reasoningMode.set(profile.reasoningMode);
            reasoningEffort.set(profile.reasoningEffort);
            reasoningMaxTokens.set(profile.reasoningMaxTokens);
            reasoningExclude.set(profile.reasoningExclude);
        };
        loadProfile(this.#editingProfile);

        const readAll = () => ({
            enabled: enabled.peek(), format: format.peek(), endpoint: endpoint.peek(), apiKey: apiKey.peek(), model: model.peek(),
            ...Object.fromEntries(SLIDERS.map(([key]) => [key, sliderSignals[key].peek()])),
            reasoningMode: reasoningMode.peek(), reasoningEffort: reasoningEffort.peek(), reasoningMaxTokens: reasoningMaxTokens.peek(), reasoningExclude: reasoningExclude.peek(),
        });

        const profileSelect = Select(profileId, profiles);
        profileSelect.addEventListener('change', () => {
            this.#editingProfile = profileSelect.value;
            profileId.set(profileSelect.value);
            loadProfile(profileSelect.value);
        });

        const apiKeyInput = TextInput(apiKey, { type: 'password', placeholder: 'Optional for local endpoints' });
        apiKeyInput.autocomplete = 'off';

        container.className = 'stme-sidecar';
        const header = includeHeader ? h('header', {}, h('div', {}, h('strong', {}, 'SideCar'), h('small', {}, 'One shared model profile for all modules.'))) : null;

        if (header) container.append(header);
        container.append(
            h('div', { class: 'stme-sidecar-fields' },
                h('div', { class: 'stme-profile-row' },
                    Field('Sampler profile', profileSelect),
                    Button('New profile', () => {
                        const id = this.createProfile(window.prompt('Profile name', 'New profile'));
                        profiles.set(this.profiles());
                        profileId.set(id);
                        loadProfile(id);
                    }),
                ),
                Toggle('Enable SideCar', enabled),
                Field('Format', Select(format, signal(FORMAT_OPTIONS))),
                Field('Endpoint', TextInput(endpoint, { type: 'url', placeholder: 'https://api.example.com/v1' })),
                Field('API key', apiKeyInput),
                Field('Model', TextInput(model, { placeholder: 'Model name' })),
                h('details', { class: 'stme-sampler' },
                    h('summary', {}, 'Sampler settings ', h('small', {}, 'Unsupported fields may be ignored by your provider.')),
                    h('div', { class: 'stme-sampler-grid' }, SLIDERS.map(([key, label, min, max, step]) => SliderField(label, sliderSignals[key], { min, max, step }))),
                ),
                h('details', { class: 'stme-reasoning' },
                    h('summary', {}, 'Reasoning ', h('small', {}, 'OpenRouter only')),
                    h('div', { class: 'stme-reasoning-grid' },
                        Field('Mode', Select(reasoningMode, signal(REASONING_MODE_OPTIONS))),
                        Field('Effort', Select(reasoningEffort, signal(REASONING_EFFORT_OPTIONS))),
                        SliderField('Reasoning tokens', reasoningMaxTokens, { min: 0, max: 32768, step: 1 }),
                        Toggle('Hide reasoning from the reply', reasoningExclude),
                    ),
                ),
                h('div', {},
                    Button('Save SideCar', () => {
                        const values = readAll();
                        this.update(values);
                        Object.assign(this.profile(this.#editingProfile), Object.fromEntries([...SLIDERS.map(([key]) => key), 'reasoningMode', 'reasoningEffort', 'reasoningMaxTokens', 'reasoningExclude'].map(key => [key, values[key]])));
                        this.settings().profiles[this.#editingProfile] = this.profile(this.#editingProfile);
                        this.#save();
                        toast('success', 'SideCar profile saved.', 'SideCar');
                    }),
                    ' ',
                    Button('Test connection', async event => {
                        const button = event.currentTarget;
                        button.disabled = true;
                        try {
                            this.update(readAll());
                            const result = await this.test();
                            toast('success', `Connected in ${result.latencyMs} ms: ${result.text || '(empty response)'}`, 'SideCar');
                        } catch (error) {
                            toast('error', error?.message || String(error), 'SideCar');
                        } finally {
                            button.disabled = false;
                        }
                    }),
                ),
            ),
        );
    }
}
