import { h, signal, Field, TextInput, Button, Select } from '../../core/widgets.js';

const TIME_EXTRA_KEY = 'stme_rp_time';
const MAX_TIME_LENGTH = 120;
const TIME_DEFAULTS = Object.freeze({ startTime: 'Year 1, Month 1, Day 1, 08:00 (Morning)', format: 'Year {year}, Month {month}, Day {day}, {time} ({period})', sidecarProfile: 'default', jsonFields: 'year,month,day,time,period', displayTemplate: 'Year {year} · Month {month} · Day {day} · {time} · {period}' });

export const TIME_PRESETS = Object.freeze([
    {
        id: 'full-date',
        name: 'Year · Month · Day · Time · Period',
        startTime: 'Year 1, Month 1, Day 1, 08:00 (Morning)',
        format: 'Year {year}, Month {month}, Day {day}, {time} ({period})',
        jsonFields: 'year,month,day,time,period',
        displayTemplate: 'Year {year} · Month {month} · Day {day} · {time} · {period}',
    },
    {
        id: 'day-counter',
        name: 'Day counter · Time · Period',
        startTime: 'Day 0, 08:00 (Morning)',
        format: 'Day {day}, {time} ({period})',
        jsonFields: 'day,time,period',
        displayTemplate: 'Day {day} · {time} · {period}',
    },
]);

export function normalizeTime(value) { return String(value ?? '').replace(/```[\s\S]*?```/g, '').replace(/^(?:time|rp time|время)\s*[:—-]\s*/i, '').replace(/[\r\n]+/g, ' ').replace(/["`]/g, '').replace(/^\[|\]$/g, '').trim().slice(0, MAX_TIME_LENGTH); }
export function buildTimeRequest(chat, settings = TIME_DEFAULTS, currentTime = settings.startTime) {
    settings = { ...TIME_DEFAULTS, ...settings };
    currentTime ??= settings.startTime;
    const recent = (chat ?? []).filter(item => !item.is_system).slice(-10).map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`).join('\n\n');
    const fields = String(settings.jsonFields).split(',').map(item => item.trim()).filter(Boolean);
    return { systemPrompt: `You are an RPG time tracker. The configured time format is "${settings.format}". The current known in-world time is "${currentTime}". Infer the next current in-world time. Return ONLY a JSON object with these fields: ${fields.join(', ')}. No markdown and no explanation.`, prompt: `ROLEPLAY CONTEXT:\n${recent}\n\nThe character is about to respond. Return the JSON time object only.` };
}
export function parseTimeResponse(value, settings = TIME_DEFAULTS) {
    settings = { ...TIME_DEFAULTS, ...settings };
    const raw = String(value ?? '').replace(/```(?:json)?|```/gi, '').trim();
    try {
        const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        const fields = String(settings.jsonFields).split(',').map(item => item.trim()).filter(Boolean);
        const label = String(settings.displayTemplate).replace(/\{([a-zA-Z0-9_-]+)\}/g, (_all, key) => String(data[key] ?? '')).replace(/\s*[·|,]\s*(?=[·|,]|$)/g, '').trim();
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
            if (['swipe', 'continue', 'appendFinal', 'first_message', 'command', 'extension', 'regenerate'].includes(type)) { log(`Ignored — message type "${type}" is excluded.`); return; }
            const context = host.context(); const settings = host.moduleSettings(TIME_DEFAULTS); const resolved = resolveMessage(context.chat ?? [], messageId); const request = pending; pending = null;
            if (!resolved?.message) { warn(`Ignored — could not resolve a chat message for id ${messageId}.`); return; }
            if (resolved.message.is_user || resolved.message.is_system) { log('Ignored — message is from the user or is a system message.'); return; }
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
        const profiles = signal(host.sidecar.profiles());

        const startTime = signal(settings.startTime);
        const format = signal(settings.format);
        const jsonFields = signal(settings.jsonFields);
        const displayTemplate = signal(settings.displayTemplate);
        const sidecarProfile = signal(settings.sidecarProfile);

        const profileSelect = Select(sidecarProfile, profiles);
        // Persist immediately on switch, so a refresh triggered elsewhere (e.g. a chat change) never reverts an unsaved pick.
        profileSelect.addEventListener('change', () => { settings.sidecarProfile = profileSelect.value; host.saveModuleSettings(); });

        const applyPreset = preset => {
            startTime.set(preset.startTime); format.set(preset.format); jsonFields.set(preset.jsonFields); displayTemplate.set(preset.displayTemplate);
            Object.assign(settings, { startTime: preset.startTime, format: preset.format, jsonFields: preset.jsonFields, displayTemplate: preset.displayTemplate });
            host.saveModuleSettings();
            host.toast('success', `Preset "${preset.name}" applied.`, 'RP Time');
        };

        container.append(
            h('p', { class: 'stme-time-help' }, 'The SideCar request starts with generation, then a styled time badge is appended beneath the completed response.'),
            h('div', { class: 'stme-time-presets' },
                h('span', { class: 'stme-time-presets-label' }, 'Presets'),
                h('div', { class: 'stme-time-preset-buttons' }, TIME_PRESETS.map(preset => Button(preset.name, () => applyPreset(preset)))),
            ),
            h('div', { class: 'stme-time-form' },
                Field('Starting time', TextInput(startTime, { maxlength: 120 })),
                Field('Time format', TextInput(format, { maxlength: 120, placeholder: 'Day {day}, HH:MM' })),
                Field('SideCar profile', profileSelect),
                Field('JSON fields', TextInput(jsonFields, { placeholder: 'day,time,period' })),
                Field('Display template', TextInput(displayTemplate, { placeholder: 'Day {day} · {time}' })),
                Button('Save time settings', () => {
                    settings.startTime = normalizeTime(startTime.peek()) || TIME_DEFAULTS.startTime;
                    settings.format = String(format.peek()).trim() || TIME_DEFAULTS.format;
                    settings.sidecarProfile = sidecarProfile.peek();
                    settings.jsonFields = String(jsonFields.peek()).trim() || TIME_DEFAULTS.jsonFields;
                    settings.displayTemplate = String(displayTemplate.peek()).trim() || TIME_DEFAULTS.displayTemplate;
                    startTime.set(settings.startTime); format.set(settings.format); jsonFields.set(settings.jsonFields); displayTemplate.set(settings.displayTemplate);
                    host.saveModuleSettings();
                    host.toast('success', 'RP Time settings saved.', 'RP Time');
                }),
            ),
        );
    },
};
