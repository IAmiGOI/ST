import { createTrackerStore } from './store.js';

const TRACKER_EXTRA_KEY = 'stme_tracker_snapshot';
const MAX_FIELD_LENGTH = 200;

const TRACKER_DEFAULTS = Object.freeze({
    fields: 'health,location,mood',
    systemPromptTemplate:
        'You are a state tracker for a roleplay chat. Track only these fields: {fields}. ' +
        'Known current values: {current}. ' +
        'Read the recent context and infer updated values only for fields that plausibly changed; keep the others as given. ' +
        'Return ONLY a JSON object with exactly these keys: {fieldsJson}. No extra keys, no markdown, no explanation.',
    promptTemplate: 'RECENT CONTEXT:\n{context}\n\nThe character is about to respond. Return the updated JSON object only.',
    sidecarProfile: 'default',
    displayTemplate: '',
});

const IGNORED_MESSAGE_TYPES = ['swipe', 'continue', 'appendFinal', 'first_message', 'command', 'extension', 'regenerate'];

/** Splits a comma/newline separated field list into unique, trimmed, non-empty names. */
export function parseFieldList(value) {
    const seen = new Set();
    for (const raw of String(value ?? '').split(/[,\n]/)) {
        const field = raw.trim();
        if (field) seen.add(field);
    }
    return [...seen];
}

/** Replaces {key} placeholders in a template with the matching value from vars. */
export function fillTemplate(template, vars) {
    return String(template ?? '').replace(/\{([a-zA-Z0-9_-]+)\}/g, (_all, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '');
}

function normalizeValue(value) {
    return String(value ?? '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/["`]/g, '')
        .trim()
        .slice(0, MAX_FIELD_LENGTH);
}

export function buildTrackerRequest(chat, settings = TRACKER_DEFAULTS, currentState = {}) {
    settings = { ...TRACKER_DEFAULTS, ...settings };
    const fields = parseFieldList(settings.fields);

    const context = (chat ?? [])
        .filter(item => !item.is_system)
        .slice(-10)
        .map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`)
        .join('\n\n');

    const vars = {
        fields: fields.join(', '),
        fieldsJson: fields.map(field => `"${field}"`).join(', '),
        current: JSON.stringify(currentState ?? {}),
        context,
    };

    return {
        systemPrompt: fillTemplate(settings.systemPromptTemplate, vars),
        prompt: fillTemplate(settings.promptTemplate, vars),
        fields,
    };
}

/** Parses a SideCar reply and keeps only the whitelisted fields, normalized to plain strings. */
export function parseTrackerResponse(value, fields) {
    const raw = String(value ?? '').replace(/```(?:json)?|```/gi, '').trim();
    try {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('No JSON object found in SideCar response.');
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const data = {};
        for (const field of fields) {
            if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
            const normalized = normalizeValue(parsed[field]);
            if (normalized) data[field] = normalized;
        }
        return { data, raw };
    } catch {
        return { data: null, raw };
    }
}

/** Builds the badge label either from a custom template or, if empty, an automatic "key: value" list. */
export function buildLabel(state, fields, displayTemplate) {
    const template = String(displayTemplate ?? '').trim();
    if (template) return normalizeValue(fillTemplate(template, state));
    return fields
        .map(field => (state[field] ? `${field}: ${state[field]}` : null))
        .filter(Boolean)
        .join(' · ');
}

function createBadge(label) {
    const badge = document.createElement('section');
    badge.className = 'stme-tracker';
    badge.dataset.stmeTracker = 'true';
    badge.innerHTML = `
        <div class="stme-tracker-head">
            <span class="stme-tracker-icon">◆</span>
            <span class="stme-tracker-label">Tracked state</span>
        </div>
        <div class="stme-tracker-value"></div>
    `;
    badge.querySelector('.stme-tracker-value').textContent = label;
    return badge;
}

function renderBadge(index, label) {
    const root = document.querySelector(`.mes[mesid="${index}"] .mes_text, #chat .mes[mesid="${index}"] .mes_text`);
    if (!root || root.querySelector('.stme-tracker')) return;
    root.append(createBadge(label));
}

function resolveMessage(chat, id) {
    if (Number.isInteger(id) && chat[id]) return { message: chat[id], index: id };
    const index = chat.findIndex(item => item.mesid === id || item.send_date === id);
    return index >= 0 ? { message: chat[index], index } : null;
}

function updateMessage(context, index, message) {
    context.updateMessageBlock?.(index, message);
    context.saveChatConditional?.();
    context.saveChat?.();
}

export const trackerModule = {
    id: 'tracker',
    title: 'Tracker',
    description: 'Tracks a custom set of fields (health, location, mood, ...) into chat metadata using a fully customizable SideCar prompt.',
    defaultEnabled: false,

    activate(host) {
        const store = createTrackerStore(host.context);
        let pending = null;
        let running = false;

        const start = host.onEvent('GENERATION_STARTED', () => {
            if (pending || !host.sidecar.isConfigured()) return;
            const context = host.context();
            const settings = host.moduleSettings(TRACKER_DEFAULTS);
            const built = buildTrackerRequest(context.chat, settings, store.get());
            pending = host.sidecar
                .request({ systemPrompt: built.systemPrompt, prompt: built.prompt, profileId: settings.sidecarProfile })
                .then(text => ({ text, fields: built.fields }))
                .catch(error => ({ error }));
        });

        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            if (running || IGNORED_MESSAGE_TYPES.includes(type)) return;

            const context = host.context();
            const resolved = resolveMessage(context.chat ?? [], messageId);
            const request = pending;
            pending = null;

            if (!resolved?.message || resolved.message.is_user || resolved.message.is_system ||
                resolved.message.extra?.[TRACKER_EXTRA_KEY] || !request) {
                return;
            }

            running = true;
            try {
                const result = await request;
                if (result?.error) throw result.error;

                const settings = host.moduleSettings(TRACKER_DEFAULTS);
                const parsed = parseTrackerResponse(result.text, result.fields);
                if (!parsed.data) throw new Error('SideCar returned no usable tracker data.');

                const nextState = store.set(parsed.data, result.fields);
                const label = buildLabel(nextState, result.fields, settings.displayTemplate);
                if (!label) throw new Error('Tracker fields are configured but produced no display value.');

                resolved.message.extra ??= {};
                resolved.message.extra[TRACKER_EXTRA_KEY] = label;
                updateMessage(context, resolved.index, resolved.message);

                setTimeout(() => renderBadge(resolved.message.mesid ?? resolved.index, label));
            } catch (error) {
                console.error('[ST Module Engine] Tracker SideCar request failed:', error);
                host.toast('warning', error?.message || 'Could not update tracked state.', 'Tracker');
            } finally {
                running = false;
            }
        });

        const refreshBadges = () => {
            const context = host.context();
            (context.chat ?? []).forEach((message, index) => {
                if (message.extra?.[TRACKER_EXTRA_KEY]) renderBadge(message.mesid ?? index, message.extra[TRACKER_EXTRA_KEY]);
            });
        };
        const changed = host.onChatChanged(refreshBadges);

        return () => { start(); received(); changed(); };
    },

    render(container, host) {
        const settings = host.moduleSettings(TRACKER_DEFAULTS);
        const store = createTrackerStore(host.context);
        const profiles = host.sidecar.profiles();
        const currentState = store.get();
        const fields = parseFieldList(settings.fields);

        container.innerHTML = `
            <p class="stme-tracker-help">
                The SideCar request starts with generation, using your prompt templates below;
                once the response completes, only the listed fields are parsed out and saved to this chat's metadata.
            </p>
            <div class="stme-tracker-form">
                <label>Tracked fields
                    <input class="text_pole" data-field="fields" placeholder="health,location,mood">
                </label>
                <label>System prompt
                    <textarea class="text_pole" data-field="systemPromptTemplate" rows="4"></textarea>
                </label>
                <label>User prompt
                    <textarea class="text_pole" data-field="promptTemplate" rows="3"></textarea>
                </label>
                <label>SideCar profile
                    <select class="text_pole" data-field="sidecarProfile"></select>
                </label>
                <label>Display template <small>optional — leave empty for an automatic "key: value" list</small>
                    <input class="text_pole" data-field="displayTemplate" placeholder="&#10084; {health} &middot; &#128205; {location}">
                </label>
                <p class="stme-tracker-hint">
                    Placeholders: <code>{fields}</code>, <code>{fieldsJson}</code>, <code>{current}</code>, <code>{context}</code> in the prompts;
                    any tracked field name (e.g. <code>{health}</code>) in the display template.
                </p>
                <div class="stme-tracker-current"><strong>Current state</strong><span class="stme-tracker-current-value"></span></div>
                <div>
                    <button class="menu_button" data-action="save" type="button">Save tracker settings</button>
                    <button class="menu_button" data-action="reset" type="button">Reset tracked state</button>
                </div>
            </div>
        `;

        container.querySelector('[data-field="fields"]').value = settings.fields;
        container.querySelector('[data-field="systemPromptTemplate"]').value = settings.systemPromptTemplate;
        container.querySelector('[data-field="promptTemplate"]').value = settings.promptTemplate;
        container.querySelector('[data-field="displayTemplate"]').value = settings.displayTemplate;
        container.querySelector('.stme-tracker-current-value').textContent =
            fields.length ? (buildLabel(currentState, fields, settings.displayTemplate) || '(no data yet)') : '(no fields configured)';

        const select = container.querySelector('[data-field="sidecarProfile"]');
        for (const profile of profiles) {
            const option = new Option(profile.name, profile.id);
            option.selected = profile.id === settings.sidecarProfile;
            select.add(option);
        }

        container.querySelector('[data-action="save"]').addEventListener('click', () => {
            settings.fields = parseFieldList(container.querySelector('[data-field="fields"]').value).join(',') || TRACKER_DEFAULTS.fields;
            settings.systemPromptTemplate = String(container.querySelector('[data-field="systemPromptTemplate"]').value).trim() || TRACKER_DEFAULTS.systemPromptTemplate;
            settings.promptTemplate = String(container.querySelector('[data-field="promptTemplate"]').value).trim() || TRACKER_DEFAULTS.promptTemplate;
            settings.sidecarProfile = select.value;
            settings.displayTemplate = String(container.querySelector('[data-field="displayTemplate"]').value).trim();
            host.saveModuleSettings();
            host.toast('success', 'Tracker settings saved.', 'Tracker');
            host.refresh();
        });

        container.querySelector('[data-action="reset"]').addEventListener('click', () => {
            store.reset();
            host.toast('success', 'Tracked state cleared.', 'Tracker');
            host.refresh();
        });
    },
};
