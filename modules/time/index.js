import { h, list, show, signal, computed, Field, TextInput, Button, Select, Chip } from '../../core/widgets.js';

const TIME_EXTRA_KEY = 'stme_rp_time';
const MAX_TIME_LENGTH = 120;
const MAX_FIELD_NAME_LENGTH = 40;
const MAX_INSTRUCTION_LENGTH = 200;
// How many past labeled timestamps to show SideCar as a trend — see
// getRecentTimeline()'s own doc comment for why a single anchor point isn't enough.
const MAX_TIMELINE_ENTRIES = 5;

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

/**
 * `timeline`: an array of past labels, oldest first (see getRecentTimeline()) — NOT
 * a single "current time" string any more. Two real, reported problems with the
 * previous prompt, both about ambiguity rather than the JSON contract itself
 * (that part parses fine):
 *
 *  1. One bare anchor point ("the current known time is X") gives SideCar no sense
 *     of PACE — nothing stopped it from re-deriving an arbitrary rate of time
 *     passage from the whole 10-message context window on every single call,
 *     causing wildly inconsistent jumps call to call. A short timeline shows the
 *     established pace to extrapolate from instead.
 *  2. Nothing told SideCar that the context window is scene-setting, not a ledger
 *     of elapsed time still waiting to be counted — every point in the timeline
 *     already accounts for everything before the newest message, so re-reading
 *     the whole window as "time to add up" double-counts what earlier calls
 *     already resolved. The prompt below says this explicitly and pins the delta
 *     to the newest exchange only, with a default toward small steps unless the
 *     text itself signals a real skip.
 */
export function buildTimeRequest(chat, settings = TIME_DEFAULTS, timeline = [settings.startTime]) {
    settings = { ...TIME_DEFAULTS, ...settings };
    if (!Array.isArray(timeline) || !timeline.length) timeline = [settings.startTime];
    const fields = sanitizeFields(settings.fields);
    const recent = (chat ?? []).filter(item => !item.is_system).slice(-10).map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`).join('\n\n');
    const timelineText = timeline.map(label => `"${label}"`).join(' → ');
    return {
        systemPrompt: `You are an in-world time tracker for a roleplay chat. Track only the fields below, using each note to decide how to format it:
${describeFields(fields)}

Recent known in-world time, oldest to most recent: ${timelineText}. This shows the actual pace time has been moving at — extrapolate from it, don't invent a different pace.

The roleplay text below is scene context only, not a log of elapsed time still to be counted — everything up through the second-to-last message is already reflected in the timeline above. Estimate the time step using ONLY the newest exchange (the character's latest reply, at the end of the context): how long would plausibly pass for that one exchange to happen?

Default to a SMALL step (seconds to a few minutes) unless the newest exchange explicitly signals a skip (e.g. "the next morning", "hours later", "after the long walk") or a scene transition.

Return ONLY a JSON object with exactly these keys: ${fields.map(field => `"${field.name}"`).join(', ')}. No markdown, no explanation.`,
        // "already responded" (past tense) — this now runs AFTER generation
        // completes (see activate()'s MESSAGE_RECEIVED handler), with the
        // character's actual new reply already the last entry in `recent`
        // above, not before it happens as an earlier version of this module did.
        prompt: `ROLEPLAY CONTEXT:\n${recent}\n\nThe character just responded (see the end of the context above). Return the updated JSON time object only.`,
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
/** This module's own chat-badges renderer (see core/chat-badge-service.js) — pure, derived fresh from the message's own `.extra` every time, never a cached label. */
function renderTimeBadge(message) { const label = message?.extra?.[TIME_EXTRA_KEY]; return label ? createBadge(label) : null; }
export function appendTime(message, time, settings = TIME_DEFAULTS) { const parsed = parseTimeResponse(time, settings); if (!parsed.label || message?.extra?.[TIME_EXTRA_KEY]) return false; message.extra ??= {}; message.extra[TIME_EXTRA_KEY] = parsed.label; message.extra.stme_rp_time_data = parsed.data; return true; }
function resolveMessage(chat, id) { if (Number.isInteger(id) && chat[id]) return { message: chat[id], index: id }; const index = chat.findIndex(item => item.mesid === id || item.send_date === id); return index >= 0 ? { message: chat[index], index } : null; }
function updateMessage(context, index, message) { context.updateMessageBlock?.(index, message); context.saveChatConditional?.(); context.saveChat?.(); }

/**
 * The last `count` labeled timestamps before `beforeIndex`, oldest first — found by
 * scanning `context.chat` backward — NOT a separately maintained value. An earlier
 * version tracked a single `chatMetadata.stme_rp_time_current` scalar that only ever
 * moved forward, with nothing to roll it back when a message got rerolled or
 * deleted: a reroll's own next SideCar request would start from a "current time"
 * that was itself computed from the discarded draft, and a deleted message's own
 * time advance was never undone either. Scanning the chat fresh every time needs no
 * rollback logic for either case: the chat array IS the source of truth, and it's
 * already correct after ST removes or replaces a message — there's nothing left for
 * this module to separately keep in sync.
 *
 * Returning several past labels (not just the latest) rather than one bare "current
 * time" string exists for buildTimeRequest() below: a single anchor point tells
 * SideCar nothing about how FAST time has actually been moving, so nothing stopped
 * it from re-deriving an arbitrary pace from a whole window of chat context every
 * single call — a real, reported source of erratic jumps. A short timeline
 * ("08:00 -> 09:15 -> 09:40") gives it an established pace to extrapolate from
 * instead of guessing fresh each time.
 *
 * `beforeIndex`, optional, bounds the scan to messages strictly before that index —
 * used when building the request for a specific message (see activate() below) so a
 * reroll's own now-cleared label (or, if not yet cleared, a stale one) is never
 * mistaken for part of the real timeline. Falls back to `[settings.startTime]` when
 * nothing has been labeled yet at all.
 */
function getRecentTimeline(context, settings, beforeIndex = Infinity, count = MAX_TIMELINE_ENTRIES) {
    const chat = context.chat ?? [];
    const labels = [];
    for (let i = Math.min(beforeIndex, chat.length) - 1; i >= 0 && labels.length < count; i--) {
        const label = chat[i]?.extra?.[TIME_EXTRA_KEY];
        if (label) labels.push(label);
    }
    return labels.length ? labels.reverse() : [settings.startTime];
}

/**
 * The in-world time as of the most recent labeled character message — the last
 * entry of getRecentTimeline() above, kept as its own function since most callers
 * (the host.services provider, the {{rp_time}} macro's compute()) only ever want
 * the single latest value, unbounded, not the whole trend.
 */
function getCurrentTime(context, settings, beforeIndex = Infinity) {
    const timeline = getRecentTimeline(context, settings, beforeIndex, 1);
    return timeline[timeline.length - 1];
}

export const timeModule = {
    id: 'time', title: 'RP Time', description: 'Asks SideCar for the in-world time after each reply and appends it.',
    about: 'Keeps an in-story clock (day, time, morning/evening) that moves forward on its own as the story goes on, and shows it under each message — like a subtitle telling you what time it is in the scene. The current time is also available anywhere as {{rp_time}}, and inside the Macros module as get "time:current".',
    defaultEnabled: false,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/time',
    minEngineVersion: '0.1.0',
    activate(host) {
        const log = (...args) => console.info('[STME:time]', ...args);
        const warn = (...args) => console.warn('[STME:time]', ...args);
        let running = false;

        // The programmatic way another module reads RP Time's current value — see
        // MODULES.md's host.services section (the same request/provider pattern
        // Tracker's own track()/classify() service already uses). A consumer checks
        // host.services.isAvailable('time') first (false while this module is
        // disabled — registrations are released automatically on disable) rather than
        // ever reaching into chatMetadata directly.
        host.services.register('time', {
            getCurrent: () => getCurrentTime(host.context(), host.moduleSettings(TIME_DEFAULTS)),
        });

        // The bus/macro half — this was genuinely missing before: RP Time never
        // called host.data.reserve()/set() at all, so it had no real ST {{macro}}
        // (unlike Tracker's per-field ones) and, separately, Macros' own mini-
        // language couldn't read it either (`get "time:current"` needs a plain bus
        // value — host.data.read()/get() are NOT compute()-aware, only the real ST
        // macro handler is; see core/data-bus.js's #registerMacro).
        //
        // `compute` powers the real {{rp_time}} macro: called fresh on every
        // resolution, so it can NEVER show a stale value even mid-reroll (the exact
        // failure mode getCurrentTime()'s own doc comment above exists to avoid) —
        // there's nothing to keep in sync, it just re-scans context.chat live, same
        // as any other read of "the current time" in this module.
        //
        // publishCurrentTime() (below) additionally calls a plain set() on every
        // real update, purely for host.data.read()/get()/subscribe() consumers
        // (Macros' get "time:current", a future HUD, etc.) — those never see
        // compute(), only the last value actually set(). Same event-driven lag every
        // other producer module's bus values already have around their own trigger
        // event; nothing here claims otherwise.
        host.data.reserve('current', {
            name: 'RP Time — current',
            schema: { type: 'string' },
            macro: 'rp_time',
            compute: () => getCurrentTime(host.context(), host.moduleSettings(TIME_DEFAULTS)),
        });
        const publishCurrentTime = () => host.data.set('current', getCurrentTime(host.context(), host.moduleSettings(TIME_DEFAULTS)));
        publishCurrentTime(); // full current state right away — see MODULES.md's "a producer publishes, it doesn't just notify"

        // Chat-badges: an independent core service (core/chat-badge-service.js),
        // not host.services — reached the same way LorebookService already is.
        // Registering here means a SIBLING module (Post-Turn Processor rewriting
        // this same message's text) can wipe this badge via its own
        // updateMessageBlock() call and have it correctly redrawn by ITS OWN
        // reapply() call afterward — this module never has to know that happened.
        const chatBadges = host.data.read('chat-badges', 'api');
        const unregisterBadge = chatBadges?.register?.('time', renderTimeBadge);

        // Fires once per real reply, AFTER it exists — not at GENERATION_STARTED any
        // more. An earlier version started the SideCar request in parallel with
        // generation for a faster badge, but that meant asking SideCar to infer the
        // time from context that didn't yet include what the character was about to
        // say — a real accuracy cost for a latency win. This trades that latency back
        // for a request that can actually see the finished reply, and removes the
        // GENERATION_STARTED/"pending request" bookkeeping entirely — there's no
        // longer a race between generation finishing and a SideCar call started
        // earlier to synchronize with.
        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            log(`MESSAGE_RECEIVED (messageId=${messageId}, type=${type}).`);
            if (running) { log('Ignored — already processing a previous MESSAGE_RECEIVED.'); return; }
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
            // Clearing it FIRST, before reading "the current time" below, also means
            // getCurrentTime()'s own backward scan naturally lands on whatever came
            // BEFORE this message — no separate rollback state to maintain for a
            // reroll (see getCurrentTime()'s own doc comment).
            if ((type === 'regenerate' || type === 'swipe') && resolved.message.extra?.[TIME_EXTRA_KEY]) {
                log(`Message #${resolved.index} was rerolled (type="${type}") — clearing its stale time label so it recomputes.`);
                delete resolved.message.extra[TIME_EXTRA_KEY];
                delete resolved.message.extra.stme_rp_time_data;
            }
            if (resolved.message.extra?.[TIME_EXTRA_KEY]) { log('Ignored — this message already has a time label.'); return; }
            if (!host.sidecar.isConfigured()) { warn('MESSAGE_RECEIVED ignored — SideCar is not configured. Per-worker state:', host.sidecar.diagnostics()); return; }
            running = true;
            try {
                const built = buildTimeRequest(context.chat, settings, getRecentTimeline(context, settings, resolved.index));
                log(`MESSAGE_RECEIVED — sending SideCar request (profile "${settings.sidecarProfile}").`);
                const result = await host.sidecar.request({ ...built, profileId: settings.sidecarProfile });
                if (!appendTime(resolved.message, result, settings)) throw new Error('SideCar returned no usable time label.');
                log(`Applying time label "${resolved.message.extra[TIME_EXTRA_KEY]}" to message #${resolved.index}.`);
                updateMessage(context, resolved.index, resolved.message);
                publishCurrentTime();
                setTimeout(() => {
                    const mesid = resolved.message.mesid ?? resolved.index;
                    if (!document.querySelector(`.mes[mesid="${mesid}"] .mes_text, #chat .mes[mesid="${mesid}"] .mes_text`)) {
                        warn(`Badge DOM target not found for mesid ${mesid} — badge was not appended to the chat.`);
                    }
                    chatBadges?.reapply?.(mesid, resolved.message);
                });
            }
            catch (error) { console.error('[ST Module Engine] RP Time SideCar request failed:', error); host.toast('warning', error?.message || 'Could not determine RP time.', 'RP Time'); } finally { running = false; }
        });
        // Badge re-application on a chat switch is handled centrally by
        // ChatBadgeService's own start() (index.js) now — this only needs to keep
        // the "current time" bus value itself in sync, since a different chat has
        // its own independent timeline.
        const changed = host.onChatChanged(() => publishCurrentTime());
        log('activate() complete.');
        return () => { received(); changed(); unregisterBadge?.(); };
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
        // A real report: a user edits a field, then closes/navigates away from the
        // settings panel without the input ever cleanly losing focus first (common
        // on mobile) — a save that only ever runs on 'change' (blur) never fires,
        // and the edit is silently lost with no way to force it through. The 'input'
        // listener below persists the RAW current value on every keystroke instead,
        // so there's always something saved regardless of how the field is left;
        // 'change' still runs the FULL normalizeTime() cleanup pass once the user
        // is actually done, same as before. 'input' deliberately never calls
        // startTime.set(...) — TextInput's own bind:value already keeps the signal
        // (and what's on screen) in sync on every keystroke by itself; re-setting it
        // here too would fight the user's own cursor position mid-type.
        startTimeInput.addEventListener('input', () => {
            settings.startTime = startTimeInput.value.slice(0, 120) || TIME_DEFAULTS.startTime;
            host.saveModuleSettings();
        });
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
            // Same "don't rely on blur alone" fix as startTimeInput above — see its
            // own comment for why. Raw save on every keystroke, full trim on blur.
            input.addEventListener('input', () => {
                field.instruction = input.value.slice(0, MAX_INSTRUCTION_LENGTH);
                host.saveModuleSettings();
            });
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
        // Same "don't rely on blur alone" fix as startTimeInput/field rows above.
        displayInput.addEventListener('input', () => {
            settings.displayTemplate = displayInput.value;
            host.saveModuleSettings();
        });
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
