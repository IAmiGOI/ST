import { h, list, show, signal, computed, Field, TextInput, Button, Select, Chip } from '../../core/widgets.js';

const TIME_EXTRA_KEY = 'stme_rp_time';
const MAX_TIME_LENGTH = 120;
const MAX_FIELD_NAME_LENGTH = 40;
const MAX_INSTRUCTION_LENGTH = 200;

// One source of truth: a list of fields (name + optional formatting note), the same
// mental model Tracker already uses. Previously this was 3 separate hand-typed
// strings — "JSON fields" (a comma list), "Time format" (a style description for
// SideCar), and "Display template" — that all had to independently mention the same
// field names and stay in sync by hand. Now there's exactly one list to edit; the
// SideCar instructions and the JSON key whitelist are both derived from it below
// (see describeFields()/buildTimeRequest()), and only the display template remains a
// separate, OPTIONAL thing to write (with click-to-insert tokens, same as Tracker).
const TIME_DEFAULTS = Object.freeze({
    startTime: 'Year 1, Month 1, Day 1, 08:00 (Morning)',
    fields: [
        { name: 'year', instruction: '' },
        { name: 'month', instruction: '' },
        { name: 'day', instruction: '' },
        { name: 'time', instruction: '24-hour HH:MM format' },
        { name: 'period', instruction: 'One of: Morning, Afternoon, Evening, Night' },
    ],
    displayTemplate: 'Year {year}, Month {month}, Day {day}, {time} ({period})',
    sidecarProfile: 'default',
});

export const TIME_PRESETS = Object.freeze([
    {
        id: 'full-date',
        name: 'Year · Month · Day · Time · Period',
        startTime: 'Year 1, Month 1, Day 1, 08:00 (Morning)',
        fields: [
            { name: 'year', instruction: '' },
            { name: 'month', instruction: '' },
            { name: 'day', instruction: '' },
            { name: 'time', instruction: '24-hour HH:MM format' },
            { name: 'period', instruction: 'One of: Morning, Afternoon, Evening, Night' },
        ],
        displayTemplate: 'Year {year}, Month {month}, Day {day}, {time} ({period})',
    },
    {
        id: 'day-counter',
        name: 'Day counter · Time · Period',
        startTime: 'Day 0, 08:00 (Morning)',
        fields: [
            { name: 'day', instruction: '' },
            { name: 'time', instruction: '24-hour HH:MM format' },
            { name: 'period', instruction: 'One of: Morning, Afternoon, Evening, Night' },
        ],
        displayTemplate: 'Day {day}, {time} ({period})',
    },
    {
        id: 'natural-date-12h',
        name: 'Natural date · 12-hour clock · Period',
        startTime: '2026 March 5 09:20 AM(Morning)',
        fields: [
            { name: 'year', instruction: '' },
            { name: 'month', instruction: 'Full month name, e.g. March' },
            { name: 'day', instruction: '' },
            { name: 'time', instruction: '12-hour clock with AM/PM, e.g. 09:20 AM' },
            { name: 'period', instruction: 'One of: Morning, Afternoon, Evening, Night' },
        ],
        displayTemplate: '{year} {month} {day} {time}({period})',
    },
]);

/** Trims a raw field name and makes it JSON-key safe (no whitespace, bounded length) — same rule Tracker uses, same mental model for whoever's editing it. */
export function normalizeFieldName(value) {
    return String(value ?? '').trim().replace(/\s+/g, '_').slice(0, MAX_FIELD_NAME_LENGTH);
}

/** Normalizes a field list to unique `{ name, instruction }` entries. */
export function sanitizeFields(fields) {
    const seen = new Set();
    const result = [];
    for (const field of Array.isArray(fields) ? fields : []) {
        const name = normalizeFieldName(typeof field === 'string' ? field : field?.name);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const instruction = String((typeof field === 'string' ? '' : field?.instruction) ?? '').trim().slice(0, MAX_INSTRUCTION_LENGTH);
        result.push({ name, instruction });
    }
    return result;
}

/** Turns the field list into a bullet list SideCar reads as its instruction for each JSON key. */
function describeFields(fields) {
    return fields.map(field => field.instruction ? `- ${field.name}: ${field.instruction}` : `- ${field.name}`).join('\n');
}

/** Replaces {key} placeholders in a template with the matching value from vars. */
function fillTemplate(template, vars) {
    return String(template ?? '').replace(/\{([a-zA-Z0-9_-]+)\}/g, (_all, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '');
}

/** Builds the final label either from a custom display template or, if empty, an automatic "name: value" list. */
export function buildLabel(state, fieldNames, displayTemplate) {
    const template = String(displayTemplate ?? '').trim();
    if (template) return fillTemplate(template, state);
    return fieldNames.map(name => (state[name] ? `${name}: ${state[name]}` : null)).filter(Boolean).join(' · ');
}

export function normalizeTime(value) { return String(value ?? '').replace(/```[\s\S]*?```/g, '').replace(/^(?:time|rp time|время)\s*[:—-]\s*/i, '').replace(/[\r\n]+/g, ' ').replace(/["`]/g, '').replace(/^\[|\]$/g, '').trim().slice(0, MAX_TIME_LENGTH); }

export function buildTimeRequest(chat, settings = TIME_DEFAULTS, currentTime = settings.startTime) {
    settings = { ...TIME_DEFAULTS, ...settings };
    currentTime ??= settings.startTime;
    const fields = sanitizeFields(settings.fields);
    const recent = (chat ?? []).filter(item => !item.is_system).slice(-10).map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`).join('\n\n');
    return {
        systemPrompt: `You are an in-world time tracker for a roleplay chat. Track only the fields below, using each note to decide how to format it:\n${describeFields(fields)}\n\nThe current known in-world time is "${currentTime}". Infer the next current in-world time based on how much time has plausibly passed. Return ONLY a JSON object with exactly these keys: ${fields.map(field => `"${field.name}"`).join(', ')}. No markdown, no explanation.`,
        prompt: `ROLEPLAY CONTEXT:\n${recent}\n\nThe character is about to respond. Return the updated JSON time object only.`,
    };
}
export function parseTimeResponse(value, settings = TIME_DEFAULTS) {
    settings = { ...TIME_DEFAULTS, ...settings };
    const raw = String(value ?? '').replace(/```(?:json)?|```/gi, '').trim();
    const fieldNames = sanitizeFields(settings.fields).map(field => field.name);
    try {
        const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        const label = buildLabel(data, fieldNames, settings.displayTemplate);
        return { label: normalizeTime(label), data, raw };
    } catch { return { label: normalizeTime(raw), data: null, raw }; }
}
function createBadge(label) { const badge = document.createElement('section'); badge.className = 'stme-rp-time'; badge.dataset.stmeRpTime = 'true'; badge.innerHTML = `<div class="stme-rp-time-head"><span class="stme-rp-time-icon">◷</span><span class="stme-rp-time-label">Current RP time</span></div><div class="stme-rp-time-value"></div>`; badge.querySelector('.stme-rp-time-value').textContent = label; return badge; }
function renderBadge(index, label) { const root = document.querySelector(`.mes[mesid="${index}"] .mes_text, #chat .mes[mesid="${index}"] .mes_text`); if (!root || root.querySelector('.stme-rp-time')) return; root.append(createBadge(label)); }
export function appendTime(message, time, settings = TIME_DEFAULTS) { const parsed = parseTimeResponse(time, settings); if (!parsed.label || message?.extra?.[TIME_EXTRA_KEY]) return false; message.extra ??= {}; message.extra[TIME_EXTRA_KEY] = parsed.label; message.extra.stme_rp_time_data = parsed.data; return true; }
function resolveMessage(chat, id) { if (Number.isInteger(id) && chat[id]) return { message: chat[id], index: id }; const index = chat.findIndex(item => item.mesid === id || item.send_date === id); return index >= 0 ? { message: chat[index], index } : null; }
function updateMessage(context, index, message) { context.updateMessageBlock?.(index, message); context.saveChatConditional?.(); context.saveChat?.(); }
function getCurrentTime(context, settings) { return context.chatMetadata?.stme_rp_time_current || settings.startTime; }
function setCurrentTime(context, time) { context.chatMetadata ??= {}; context.chatMetadata.stme_rp_time_current = time; context.saveMetadataDebounced?.(); }

export const timeModule = {
    id: 'time', title: 'RP Time', description: 'Runs SideCar in parallel with generation and appends the inferred in-world time.',
    about: 'Keeps an in-story clock (day, time, morning/evening) that moves forward on its own as the story goes on, and shows it under each message — like a subtitle telling you what time it is in the scene.',
    defaultEnabled: false,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/time',
    minEngineVersion: '0.1.0',
    activate(host) {
        const log = (...args) => console.info('[STME:time]', ...args);
        const warn = (...args) => console.warn('[STME:time]', ...args);
        let pending = null; let running = false;
        const start = host.onEvent('GENERATION_STARTED', () => {
            if (pending) { log('GENERATION_STARTED ignored — a request is already pending.'); return; }
            if (!host.sidecar.isConfigured()) { warn('GENERATION_STARTED ignored — SideCar is not configured. Per-worker state:', host.sidecar.diagnostics()); return; }
            const context = host.context(); const settings = host.moduleSettings(TIME_DEFAULTS);
            const built = buildTimeRequest(context.chat, settings, getCurrentTime(context, settings));
            log(`GENERATION_STARTED — sending SideCar request (profile "${settings.sidecarProfile}").`);
            pending = host.sidecar.request({ ...built, profileId: settings.sidecarProfile })
                .then(result => { log('SideCar request resolved:', result); return result; })
                .catch(error => { warn('SideCar request rejected:', error); return { error }; });
        });
        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            log(`MESSAGE_RECEIVED (messageId=${messageId}, type=${type}).`);
            if (running) { log('Ignored — already processing a previous MESSAGE_RECEIVED.'); return; }
            // Always drop whatever was pending once a MESSAGE_RECEIVED fires — even for
            // an excluded type — so it can never leak into a LATER, unrelated
            // generation (the next GENERATION_STARTED would otherwise see `pending`
            // still set and skip sending a fresh request, silently breaking tracking).
            const request = pending; pending = null;
            // 'regenerate'/'swipe' are deliberately NOT excluded here — both are a real
            // reroll (a genuinely new response) and must still trigger a fresh time
            // update; excluding them used to silently swallow every reroll's result.
            if (['continue', 'appendFinal', 'first_message', 'command', 'extension'].includes(type)) { log(`Ignored — message type "${type}" is excluded.`); return; }
            const context = host.context(); const settings = host.moduleSettings(TIME_DEFAULTS); const resolved = resolveMessage(context.chat ?? [], messageId);
            if (!resolved?.message) { warn(`Ignored — could not resolve a chat message for id ${messageId}.`); return; }
            if (resolved.message.is_user || resolved.message.is_system) { log('Ignored — message is from the user or is a system message.'); return; }
            // A reroll reuses the SAME message object — ST doesn't reliably clear its
            // .extra for us. Without this, the guard right below would see the PREVIOUS
            // response's time label and skip recomputing for the new one entirely.
            if ((type === 'regenerate' || type === 'swipe') && resolved.message.extra?.[TIME_EXTRA_KEY]) {
                log(`Message #${resolved.index} was rerolled (type="${type}") — clearing its stale time label so it recomputes.`);
                delete resolved.message.extra[TIME_EXTRA_KEY];
                delete resolved.message.extra.stme_rp_time_data;
            }
            if (resolved.message.extra?.[TIME_EXTRA_KEY]) { log('Ignored — this message already has a time label.'); return; }
            if (!request) { warn('Ignored — no pending SideCar request (GENERATION_STARTED never fired, or SideCar was not configured at that point).'); return; }
            running = true;
            try {
                const result = await request;
                if (result?.error) throw result.error;
                if (!appendTime(resolved.message, result, settings)) throw new Error('SideCar returned no usable time label.');
                log(`Applying time label "${resolved.message.extra[TIME_EXTRA_KEY]}" to message #${resolved.index}.`);
                setCurrentTime(context, resolved.message.extra[TIME_EXTRA_KEY]);
                updateMessage(context, resolved.index, resolved.message);
                setTimeout(() => {
                    const target = document.querySelector(`.mes[mesid="${resolved.message.mesid ?? resolved.index}"] .mes_text, #chat .mes[mesid="${resolved.message.mesid ?? resolved.index}"] .mes_text`);
                    if (!target) warn(`Badge DOM target not found for mesid ${resolved.message.mesid ?? resolved.index} — badge was not appended to the chat.`);
                    renderBadge(resolved.message.mesid ?? resolved.index, resolved.message.extra[TIME_EXTRA_KEY]);
                });
            }
            catch (error) { console.error('[ST Module Engine] RP Time SideCar request failed:', error); host.toast('warning', error?.message || 'Could not determine RP time.', 'RP Time'); } finally { running = false; }
        });
        const refreshBadges = () => {
            const context = host.context();
            let count = 0;
            (context.chat ?? []).forEach((message, index) => { if (message.extra?.[TIME_EXTRA_KEY]) { count++; renderBadge(message.mesid ?? index, message.extra[TIME_EXTRA_KEY]); } });
            log(`refreshBadges: re-applied ${count} existing time label(s) after a chat change.`);
        };
        const changed = host.onChatChanged(refreshBadges);
        log('activate() complete.');
        return () => { start(); received(); changed(); };
    },
    render(container, host) {
        console.info('[STME:time]', 'render() called.');
        const settings = host.moduleSettings(TIME_DEFAULTS);
        settings.fields = sanitizeFields(settings.fields);
        const profiles = signal(host.sidecar.profiles());

        const startTime = signal(settings.startTime);
        const fields = signal(settings.fields);
        const displayTemplate = signal(settings.displayTemplate);
        const sidecarProfile = signal(settings.sidecarProfile);

        const profileSelect = Select(sidecarProfile, profiles);
        profileSelect.addEventListener('change', () => { settings.sidecarProfile = profileSelect.value; host.saveModuleSettings(); });

        const startTimeInput = TextInput(startTime, { maxlength: 120 });
        startTimeInput.addEventListener('change', () => {
            settings.startTime = normalizeTime(startTime.peek()) || TIME_DEFAULTS.startTime;
            startTime.set(settings.startTime);
            host.saveModuleSettings();
        });

        const persistFields = next => {
            fields.set(next);
            settings.fields = next;
            host.saveModuleSettings();
        };

        const nameInput = signal('');
        const instructionInput = signal('');
        const addField = () => {
            const name = normalizeFieldName(nameInput.peek());
            if (!name) { host.toast('warning', 'Enter a field name first.', 'RP Time'); return; }
            if (fields.peek().some(item => item.name === name)) { host.toast('warning', `Field "${name}" already exists.`, 'RP Time'); return; }
            persistFields([...fields.peek(), { name, instruction: instructionInput.peek().trim().slice(0, MAX_INSTRUCTION_LENGTH) }]);
            nameInput.set(''); instructionInput.set('');
        };
        const nameField = TextInput(nameInput, { placeholder: 'Field name (e.g. day)', maxlength: MAX_FIELD_NAME_LENGTH });
        const instructionField = TextInput(instructionInput, { placeholder: 'How should SideCar format it? (optional)', maxlength: MAX_INSTRUCTION_LENGTH });
        for (const input of [nameField, instructionField]) {
            input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addField(); } });
        }
        const renderFieldRow = field => {
            const instruction = signal(field.instruction);
            const input = TextInput(instruction, { maxlength: MAX_INSTRUCTION_LENGTH, placeholder: 'How should SideCar format it? (optional)' });
            input.addEventListener('change', () => {
                field.instruction = instruction.peek().trim().slice(0, MAX_INSTRUCTION_LENGTH);
                instruction.set(field.instruction);
                host.saveModuleSettings();
            });
            return h('div', { class: 'stme-time-field-row' },
                h('code', { class: 'stme-time-field-name' }, field.name),
                input,
                Button('×', () => persistFields(fields.peek().filter(item => item !== field)), { variant: 'danger' }),
            );
        };

        const displayInput = TextInput(displayTemplate, { placeholder: 'Year {year} · {time} · {period}' });
        displayInput.addEventListener('change', () => {
            settings.displayTemplate = displayTemplate.peek().trim();
            displayTemplate.set(settings.displayTemplate);
            host.saveModuleSettings();
        });
        const tokens = h('div', { class: 'stme-time-tokens' },
            show(computed(() => fields().length === 0), empty => empty ? h('span', { class: 'stme-time-empty' }, 'Add fields above to get insertable tokens.') : null),
            list(fields, field => field.name, field => Chip(
                [h('span', {}, field.name), h('code', {}, `{${field.name}}`)],
                {
                    title: `Insert {${field.name}} — this field's address in the display.`,
                    onClick: () => {
                        const start = displayInput.selectionStart ?? displayInput.value.length;
                        const end = displayInput.selectionEnd ?? displayInput.value.length;
                        const insert = `{${field.name}}`;
                        const next = displayInput.value.slice(0, start) + insert + displayInput.value.slice(end);
                        displayInput.value = next;
                        settings.displayTemplate = next;
                        displayTemplate.set(next);
                        host.saveModuleSettings();
                        displayInput.focus();
                        const caret = start + insert.length;
                        displayInput.setSelectionRange(caret, caret);
                    },
                },
            )),
        );

        const applyPreset = preset => {
            const presetFields = sanitizeFields(preset.fields);
            startTime.set(preset.startTime);
            fields.set(presetFields);
            displayTemplate.set(preset.displayTemplate);
            Object.assign(settings, { startTime: preset.startTime, fields: presetFields, displayTemplate: preset.displayTemplate });
            host.saveModuleSettings();
            host.toast('success', `Preset "${preset.name}" applied.`, 'RP Time');
        };

        container.append(
            h('p', { class: 'stme-time-help' }, 'The SideCar request starts with generation, then the inferred in-world time is attached to the reply. Add or edit fields below — SideCar fills in whatever fields you list, formatted however you tell it to.'),
            h('div', { class: 'stme-time-presets' },
                h('span', { class: 'stme-time-presets-label' }, 'Presets'),
                h('div', { class: 'stme-time-preset-buttons' }, TIME_PRESETS.map(preset => Button(preset.name, () => applyPreset(preset)))),
            ),
            Field('Starting time', startTimeInput, { hint: 'The very first in-world time, before SideCar has inferred anything yet.' }),
            Field('SideCar profile', profileSelect),
            h('div', { class: 'stme-time-fields' },
                h('span', { class: 'stme-time-fields-label' }, 'Tracked fields', h('small', {}, 'Each field becomes one JSON key SideCar must fill in; the note tells it how to format that value.')),
                show(computed(() => fields().length === 0), empty => empty ? h('p', { class: 'stme-time-empty' }, 'No fields yet — add one below.') : null),
                h('div', { class: 'stme-time-field-list' }, list(fields, field => field.name, renderFieldRow)),
                h('div', { class: 'stme-time-field-add' }, nameField, instructionField, Button('+ Add field', addField)),
            ),
            h('div', { class: 'stme-time-display' },
                h('div', { class: 'stme-time-display-head' },
                    h('strong', {}, 'Display template'),
                    h('small', {}, 'Optional — leave empty for an automatic "name: value" list. Click a token to insert its address.'),
                ),
                displayInput,
                tokens,
            ),
        );
    },
};
