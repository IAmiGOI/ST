import { createTrackerStore } from './store.js';
import {
    h, list, show, signal, computed, onDispose, effectOn,
    Field, TextInput, TextArea, Select, SliderField, Toggle, Button, Chip, DraggableList,
    makeDraggable, applyFloatingPosition,
} from '../../core/widgets.js';

const MODULE_ID = 'tracker';
const TRACKER_EXTRA_KEY = 'stme_tracker_snapshot';
const MAX_FIELD_LENGTH = 200;
const MAX_FIELD_NAME_LENGTH = 40;
const MAX_INSTRUCTION_LENGTH = 200;

// 'regenerate' and 'swipe' are deliberately NOT here — both are real generations of a
// genuinely new response (ST's own reroll mechanics) and must still trigger a fresh
// tracker update; excluding them used to silently swallow every reroll's result (see
// the message.extra-clearing step in the MESSAGE_RECEIVED handler below for the other
// half of that fix — the reused message object's stale snapshot also had to be
// cleared, or the "already has a snapshot" guard would have skipped it anyway).
const IGNORED_MESSAGE_TYPES = ['continue', 'appendFinal', 'first_message', 'command', 'extension'];

const DEFAULT_SYSTEM_PROMPT =
    'You are a state tracker for a roleplay chat. Track only the fields below, using each note to decide how to fill it in:\n' +
    '{fields}\n\n' +
    'Known current values: {current}. ' +
    'Read the recent context and infer updated values only for fields that plausibly changed; keep the others as given. ' +
    'Return ONLY a JSON object with exactly these keys: {fieldsJson}. No extra keys, no markdown, no explanation.';
const DEFAULT_PROMPT = 'RECENT CONTEXT:\n{context}\n\nThe character is about to respond. Return the updated JSON object only.';

// --- Poll modes: WHEN a block asks SideCar for a fresh reading, per-block —
// see MODULES.md's own section on this for the full design rationale.
//  - 'user-message': the instant the PLAYER's own message is sent, before the AI
//    has replied at all. No message-.extra snapshot (there's no new AI message
//    yet to attach one to) — only the live bus/HUD update.
//  - 'after-turn' (the default — "после хода"): after the AI's reply has fully
//    landed AND, if Post-Turn Processor is enabled, after IT has finished
//    deciding what to do with that same message too — see waitForPostProcess()
//    below. This is the direct descendant of what this module used to do
//    unconditionally for every block (GENERATION_STARTED-parallel dispatch,
//    MESSAGE_RECEIVED apply); the difference now is only that it explicitly
//    waits for Post-Turn Processor's rewrite first, so a tracked field is never
//    read off text that's about to change out from under it.
//  - 'every-n-turns': same as 'after-turn', but only once every N real AI
//    replies (counted per block, in memory only — resets on module re-enable).
//  - 'every-n-time': a real wall-clock timer, independent of message events
//    entirely — see syncPollTimers(). No message to snapshot onto, so it only
//    ever updates the live bus/HUD, same as 'user-message'.
const POLL_MODES = Object.freeze(['user-message', 'after-turn', 'every-n-turns', 'every-n-time']);
const POLL_MODE_OPTIONS = Object.freeze([
    { id: 'user-message', name: 'During the turn (on your message)' },
    { id: 'after-turn', name: 'After the reply completes (default)' },
    { id: 'every-n-turns', name: 'Every N turns' },
    { id: 'every-n-time', name: 'Every N minutes' },
]);
const DEFAULT_POLL_MODE = 'after-turn';
const DEFAULT_POLL_TURNS = 3;
const MIN_POLL_TURNS = 1;
const MAX_POLL_TURNS = 50;
const DEFAULT_POLL_MINUTES = 5;
const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 180;
// How long a mode-2 block waits for Post-Turn Processor's own "done with this
// message" signal before giving up and proceeding anyway — same "never wait
// forever, even for a module that's mistaken about needing to" discipline
// RoutePlanner.waitFor() already established for a conceptually identical problem.
const POST_PROCESS_WAIT_TIMEOUT_MS = 15000;

/** `block.pollMode`, defensively resolved — falls back to the default for a block saved before this feature existed, or a corrupted/unrecognized value. */
export function resolvePollMode(block) {
    return POLL_MODES.includes(block?.pollMode) ? block.pollMode : DEFAULT_POLL_MODE;
}
/** `block.pollTurns`, clamped — how many real AI replies between polls in 'every-n-turns' mode. */
export function resolvePollTurns(block) {
    const turns = Math.round(Number(block?.pollTurns));
    return Number.isFinite(turns) ? Math.min(MAX_POLL_TURNS, Math.max(MIN_POLL_TURNS, turns)) : DEFAULT_POLL_TURNS;
}
/** `block.pollIntervalMinutes`, clamped and converted to milliseconds — the real setInterval() period for 'every-n-time' mode. */
export function resolvePollIntervalMs(block) {
    const minutes = Math.round(Number(block?.pollIntervalMinutes));
    const clamped = Number.isFinite(minutes) ? Math.min(MAX_POLL_MINUTES, Math.max(MIN_POLL_MINUTES, minutes)) : DEFAULT_POLL_MINUTES;
    return clamped * 60000;
}

const MODULE_DEFAULTS = Object.freeze({
    blocks: [],
    // `hud` and `blocks` are reassigned wholesale on every change, never mutated in place —
    // both come straight from this shared frozen default on first use.
    hud: { enabled: false, collapsed: false, x: null, y: null },
});

/** Trims a raw field name and makes it JSON-key safe (no whitespace, bounded length). */
export function normalizeFieldName(value) {
    return String(value ?? '').trim().replace(/\s+/g, '_').slice(0, MAX_FIELD_NAME_LENGTH);
}

/** Normalizes a block's field list to unique `{ name, instruction }` entries. */
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
export function describeFields(fields) {
    return fields.map(field => field.instruction ? `- ${field.name}: ${field.instruction}` : `- ${field.name}`).join('\n');
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

/** Builds the SideCar request for one tracker block from its own templates and fields. */
export function buildTrackerRequest(chat, block, currentState = {}) {
    const fields = sanitizeFields(block?.fields);

    const context = (chat ?? [])
        .filter(item => !item.is_system)
        .slice(-10)
        .map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`)
        .join('\n\n');

    // store.get() (store.js) returns EVERYTHING ever saved for this block,
    // including a stale value from a field that's since been renamed or
    // removed — store.set() never deletes those, by design (see its own doc
    // comment: "stale keys ... are simply ignored rather than deleted", so a
    // later restore/rename doesn't lose history). Filtering to just the
    // block's CURRENTLY configured fields here, right before it goes into the
    // prompt, applies that same whitelist discipline on the read side —
    // otherwise "Known current values" would list fields that no longer
    // exist, bloating the prompt and inviting SideCar to reference dead data.
    const activeFieldNames = new Set(fields.map(field => field.name));
    const activeState = Object.fromEntries(Object.entries(currentState ?? {}).filter(([key]) => activeFieldNames.has(key)));

    const vars = {
        fields: describeFields(fields),
        fieldsJson: fields.map(field => `"${field.name}"`).join(', '),
        current: JSON.stringify(activeState),
        context,
    };

    return {
        systemPrompt: fillTemplate(block?.systemPromptTemplate ?? DEFAULT_SYSTEM_PROMPT, vars),
        prompt: fillTemplate(block?.promptTemplate ?? DEFAULT_PROMPT, vars),
        fields: fields.map(field => field.name),
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

/**
 * Runs ONE block's SideCar request against the CURRENT chat/state and writes the
 * result into the store — the one piece of work shared by all 4 poll modes; only
 * WHEN this gets called, and what (if anything) happens to the label afterward (a
 * message-.extra snapshot, or nothing), differs between them. Never throws:
 * `{ ok: true, nextState, label, fields }` on success, `{ ok: false, error }` on
 * any failure (no fields configured, SideCar rejected, an unparseable reply) — the
 * caller decides what to do with a failure (toast, log, snapshot-or-not).
 */
export async function runBlockPoll(host, store, block) {
    const fields = sanitizeFields(block.fields);
    if (!fields.length) return { ok: false, error: new Error(`Tracker "${block.title}" has no fields configured.`) };
    try {
        const context = host.context();
        const built = buildTrackerRequest(context.chat, block, store.get(block.id));
        const text = await host.sidecar.request({ systemPrompt: built.systemPrompt, prompt: built.prompt, profileId: block.sidecarProfile });
        const parsed = parseTrackerResponse(text, built.fields);
        if (!parsed.data) throw new Error(`Tracker "${block.title}" got no usable data from SideCar.`);
        const nextState = store.set(block.id, parsed.data, built.fields);
        const label = buildLabel(nextState, built.fields, block.displayTemplate);
        return { ok: true, nextState, label, fields: built.fields };
    } catch (error) {
        return { ok: false, error };
    }
}

/**
 * Waits for Post-Turn Processor (see modules/postprocess/index.js) to finish
 * deciding what to do with `messageId` — including deciding to do nothing, if
 * autoRun is off or the message type is excluded — before an 'after-turn' block's
 * own request reads that message's FINAL text. Resolves immediately if Post-Turn
 * Processor isn't enabled at all (no 'postprocess' service registered) — "if it's
 * present," per the actual ask; never waits longer than
 * POST_PROCESS_WAIT_TIMEOUT_MS regardless, so a module mistaken about whether
 * Post-Turn will really signal can never hang a poll forever.
 *
 * Must be called SYNCHRONOUSLY (no `await` before it) from inside the very same
 * MESSAGE_RECEIVED handler Post-Turn Processor's own listener will also run
 * from — ST invokes every listener for one event in registration order, and each
 * one's SYNCHRONOUS portion (up to its first `await`) always runs before the
 * next listener is invoked, regardless of whether ST awaits each listener's own
 * promise. Calling this before any await guarantees the subscription below is in
 * place before Post-Turn Processor's own handler can possibly emit — otherwise a
 * signal that already fired before this subscribed would be missed entirely,
 * and this would wait out the full timeout for nothing every time.
 */
export function waitForPostProcess(host, messageId, timeoutMs = POST_PROCESS_WAIT_TIMEOUT_MS) {
    if (!host.services.isAvailable('postprocess')) return Promise.resolve();
    const postprocess = host.services.request('postprocess');
    if (typeof postprocess.onMessageHandled !== 'function') return Promise.resolve();
    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsubscribe();
            resolve();
        };
        const unsubscribe = postprocess.onMessageHandled(handledId => { if (handledId === messageId) finish(); });
        const timer = setTimeout(finish, timeoutMs);
    });
}

/**
 * Shape of one tracker block as published on the shared data bus (namespace
 * "tracker", key `block:<id>`, this description merged with `{ state, updatedAt }`)
 * and in the `blocks` index. Never includes the block's SideCar profile, prompt
 * templates, or the raw sanitized field objects — only what other modules or a
 * visual panel need to read: which fields exist and what to call them.
 */
export function describeBlockForBus(block) {
    return {
        id: block.id,
        title: block.title,
        enabled: block.enabled !== false,
        fields: sanitizeFields(block.fields).map(field => field.name),
    };
}

// --- Scene classification (the pull half of Tracker's service, alongside track()'s
// push half): any module can ask `host.services.ask('tracker', 'classify', { vocabulary })`
// to have Tracker run ONE SideCar call and pick which of the ASKER's own keys match
// the current scene. Tracker doesn't own the vocabulary — the asker supplies it (e.g.
// Music's up-to-50 mood/location keys) — Tracker only owns the classification step,
// so this is reusable by any future module that needs "which of my keys fit right now".

const MAX_CLASSIFY_VOCABULARY = 50;

/** Trims, dedupes, and caps a caller-supplied key list at MAX_CLASSIFY_VOCABULARY. */
export function sanitizeVocabulary(vocabulary) {
    const seen = new Set();
    const result = [];
    for (const raw of Array.isArray(vocabulary) ? vocabulary : []) {
        const key = String(raw ?? '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(key);
        if (result.length >= MAX_CLASSIFY_VOCABULARY) break;
    }
    return result;
}

/** Builds the SideCar request for "which of these keys fit the current scene". */
export function buildClassifyRequest(vocabulary, chat) {
    const recent = (chat ?? [])
        .filter(item => !item.is_system)
        .slice(-10)
        .map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`)
        .join('\n\n');
    return {
        systemPrompt: `You classify the CURRENT scene of a roleplay chat using a fixed set of keys. Available keys: ${vocabulary.join(', ')}. Pick every key from that exact list that genuinely applies to the current scene — as many or as few as fit, none if nothing fits. Return ONLY a JSON array of strings, using ONLY keys from the list above, spelled exactly as given. No markdown, no explanation.`,
        prompt: `RECENT CONTEXT:\n${recent}\n\nReturn the matching keys as a JSON array.`,
    };
}

/** Parses the SideCar reply, keeping only strings that are actually in the asker's vocabulary — the model cannot invent a key that doesn't exist. */
export function parseClassifyResponse(value, vocabulary) {
    const raw = String(value ?? '').replace(/```(?:json)?|```/gi, '').trim();
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end < start) return { keys: [] };
    try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const keys = Array.isArray(parsed) ? parsed.filter(key => typeof key === 'string' && vocabulary.includes(key)) : [];
        return { keys };
    } catch {
        return { keys: [] };
    }
}

/** `{{tracker_vitals_health}}`-safe macro name from a block title + field name. */
function macroSlug(...parts) {
    return ['tracker', ...parts].join('_')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 60);
}

function createBlock() {
    return {
        id: `tracker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title: 'New tracker',
        collapsed: false,
        enabled: true,
        fields: [],
        sidecarProfile: 'default',
        systemPromptTemplate: DEFAULT_SYSTEM_PROMPT,
        promptTemplate: DEFAULT_PROMPT,
        displayTemplate: '',
        pollMode: DEFAULT_POLL_MODE,
        pollTurns: DEFAULT_POLL_TURNS,
        pollIntervalMinutes: DEFAULT_POLL_MINUTES,
    };
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

/**
 * A standalone, draggable panel appended to document.body — never to the chat
 * transcript or its DOM — so it can only ever show data pulled from the bus.
 * It has no path into `message.mes` and is never read by the character LLM.
 */
function createHudPanel() {
    const panel = document.createElement('div');
    panel.className = 'stme-tracker-hud';
    panel.innerHTML = `
        <div class="stme-tracker-hud-head">
            <span class="stme-tracker-hud-grip">⠿</span>
            <strong>Tracked state</strong>
            <button type="button" class="stme-tracker-hud-collapse" title="Collapse">–</button>
            <button type="button" class="stme-tracker-hud-close" title="Hide panel">×</button>
        </div>
        <div class="stme-tracker-hud-body"></div>
    `;
    document.body.append(panel);
    return panel;
}

function applyHudPosition(panel, settings) {
    applyFloatingPosition(panel, settings.hud);
}

/** Drags the panel by its header (grip) and persists the dropped position. Returns a cleanup function. */
function makeHudDraggable(panel, host) {
    return makeDraggable(panel, panel.querySelector('.stme-tracker-hud-head'), {
        onDrop: position => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            settings.hud = { ...settings.hud, ...position };
            host.saveModuleSettings();
        },
    });
}

/**
 * Per-block reactive state, cached for the life of the render() call so the
 * card built for a block id is never rebuilt — only these signals change, and
 * only the DOM that reads them patches. `renderHeader`/`renderContent` share
 * one entry per block since DraggableList calls both for the same item.
 */
function getBlockUi(cache, block) {
    if (!cache.has(block.id)) {
        cache.set(block.id, {
            title: signal(block.title),
            enabled: signal(block.enabled !== false),
            fields: signal(sanitizeFields(block.fields)),
            sidecarProfile: signal(block.sidecarProfile),
            systemPromptTemplate: signal(block.systemPromptTemplate),
            promptTemplate: signal(block.promptTemplate),
            displayTemplate: signal(block.displayTemplate),
            pollMode: signal(resolvePollMode(block)),
            pollTurns: signal(resolvePollTurns(block)),
            pollIntervalMinutes: signal(Math.round(resolvePollIntervalMs(block) / 60000)),
        });
    }
    return cache.get(block.id);
}

function renderFieldRow(block, field, ui, host) {
    const instruction = signal(field.instruction);
    const input = TextInput(instruction, { maxlength: MAX_INSTRUCTION_LENGTH, placeholder: 'How should SideCar decide it? (optional)' });
    input.addEventListener('change', () => {
        field.instruction = instruction.peek().trim().slice(0, MAX_INSTRUCTION_LENGTH);
        instruction.set(field.instruction);
        host.saveModuleSettings();
    });
    return h('div', { class: 'stme-tracker-field-row' },
        h('code', { class: 'stme-tracker-field-name' }, field.name),
        input,
        Button('×', () => {
            const next = ui.fields.peek().filter(item => item !== field);
            block.fields = next;
            ui.fields.set(next);
            host.saveModuleSettings();
            host.data.get('publish')?.();
        }, { variant: 'danger' }),
    );
}

function renderBlockHeader(block, ui, blocks, persistBlocks, profiles, host) {
    const titleInput = TextInput(ui.title, { maxlength: 60, placeholder: 'Tracker title' });
    titleInput.addEventListener('click', event => event.stopPropagation());
    titleInput.addEventListener('change', () => {
        block.title = ui.title.peek().trim() || 'Tracker';
        ui.title.set(block.title);
        host.saveModuleSettings();
        host.data.get('publish')?.();
    });

    const caption = computed(() => {
        const fields = ui.fields();
        const profileName = profiles().find(item => item.id === ui.sidecarProfile())?.name ?? ui.sidecarProfile();
        return `${fields.length} field${fields.length === 1 ? '' : 's'} · profile: ${profileName}`;
    });

    return [
        h('div', { class: 'stme-tracker-title' }, titleInput, h('small', {}, caption)),
        Toggle('Enabled', ui.enabled, {
            onChange: checked => {
                block.enabled = checked;
                ui.enabled.set(checked);
                host.saveModuleSettings();
                host.data.get('publish')?.();
            },
        }),
        Button('Remove', event => {
            event.preventDefault(); event.stopPropagation();
            // persistBlocks() re-runs publish(), whose reconciliation retires every bus
            // channel (block + per-field, macros included) this block owned — no separate
            // cleanup needed here.
            persistBlocks(blocks.peek().filter(item => item.id !== block.id));
        }, { variant: 'danger' }),
    ];
}

function renderBlockContent(block, ui, store, profiles, host) {
    const wrap = h('div', { class: 'stme-tracker-block' });

    const nameInput = signal('');
    const instructionInput = signal('');
    const addField = () => {
        const name = normalizeFieldName(nameInput.peek());
        if (!name) { host.toast('warning', 'Enter a field name first.', block.title); return; }
        if (ui.fields.peek().some(item => item.name === name)) { host.toast('warning', `Field "${name}" already exists.`, block.title); return; }
        const next = [...ui.fields.peek(), { name, instruction: instructionInput.peek().trim().slice(0, MAX_INSTRUCTION_LENGTH) }];
        block.fields = next;
        ui.fields.set(next);
        nameInput.set(''); instructionInput.set('');
        host.saveModuleSettings();
        host.data.get('publish')?.();
    };
    const nameField = TextInput(nameInput, { placeholder: 'Field name (e.g. health)', maxlength: MAX_FIELD_NAME_LENGTH });
    const instructionField = TextInput(instructionInput, { placeholder: 'How should SideCar decide it? (optional)', maxlength: MAX_INSTRUCTION_LENGTH });
    for (const input of [nameField, instructionField]) {
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addField(); } });
    }

    const fieldsSection = h('div', { class: 'stme-tracker-fields' },
        h('span', { class: 'stme-tracker-fields-label' }, 'Tracked fields', h('small', {}, "Each field becomes one JSON key SideCar must fill in; the note tells it how.")),
        show(computed(() => ui.fields().length === 0), empty => empty ? h('p', { class: 'stme-tracker-empty' }, 'No fields yet — add one below.') : null),
        h('div', { class: 'stme-tracker-field-list' }, list(ui.fields, field => field.name, field => renderFieldRow(block, field, ui, host))),
        h('div', { class: 'stme-tracker-field-add' }, nameField, instructionField, Button('+ Add field', addField)),
    );

    const profileSelect = Select(ui.sidecarProfile, profiles);
    const pollModeSelect = Select(ui.pollMode, signal(POLL_MODE_OPTIONS));
    pollModeSelect.addEventListener('change', () => {
        block.pollMode = resolvePollMode({ pollMode: ui.pollMode.peek() });
        ui.pollMode.set(block.pollMode);
        host.saveModuleSettings();
        host.data.get('publish')?.();
    });
    const pollSettings = h('div', { class: 'stme-tracker-poll-settings' },
        show(computed(() => ui.pollMode() === 'every-n-turns'), on => {
            if (!on) return null;
            const slider = SliderField('Poll every N turns', ui.pollTurns, { min: MIN_POLL_TURNS, max: MAX_POLL_TURNS, step: 1 });
            slider.querySelector('input').addEventListener('change', () => {
                block.pollTurns = resolvePollTurns({ pollTurns: ui.pollTurns.peek() });
                ui.pollTurns.set(block.pollTurns);
                host.saveModuleSettings();
            });
            return slider;
        }),
        show(computed(() => ui.pollMode() === 'every-n-time'), on => {
            if (!on) return null;
            const slider = SliderField('Poll every N minutes', ui.pollIntervalMinutes, { min: MIN_POLL_MINUTES, max: MAX_POLL_MINUTES, step: 1 });
            slider.querySelector('input').addEventListener('change', () => {
                block.pollIntervalMinutes = Math.round(resolvePollIntervalMs({ pollIntervalMinutes: ui.pollIntervalMinutes.peek() }) / 60000);
                ui.pollIntervalMinutes.set(block.pollIntervalMinutes);
                host.saveModuleSettings();
                host.data.get('publish')?.(); // reconciles the running setInterval() via syncPollTimers()
            });
            return slider;
        }),
    );
    const systemPromptArea = TextArea(ui.systemPromptTemplate, { rows: 4 });
    const promptArea = TextArea(ui.promptTemplate, { rows: 3 });
    const displayInput = TextInput(ui.displayTemplate, { placeholder: '❤ {health} · 📍 {location}' });

    const tokens = h('div', { class: 'stme-tracker-tokens' },
        show(computed(() => ui.fields().length === 0), empty => empty ? h('span', { class: 'stme-tracker-empty' }, 'Add fields above to get insertable tokens.') : null),
        list(ui.fields, field => field.name, field => Chip(
            [h('span', {}, field.name), h('code', {}, `{${field.name}}`)],
            {
                title: `Insert {${field.name}} — this field's address in the template.`,
                onClick: () => {
                    const start = displayInput.selectionStart ?? displayInput.value.length;
                    const end = displayInput.selectionEnd ?? displayInput.value.length;
                    const insert = `{${field.name}}`;
                    const next = displayInput.value.slice(0, start) + insert + displayInput.value.slice(end);
                    displayInput.value = next;
                    ui.displayTemplate.set(next);
                    displayInput.focus();
                    const caret = start + insert.length;
                    displayInput.setSelectionRange(caret, caret);
                },
            },
        )),
    );

    const currentState = signal(store.get(block.id));
    onDispose(wrap, host.data.subscribe(MODULE_ID, `block:${block.id}`, entry => currentState.set(entry?.state ?? {})));
    const currentLabel = computed(() => {
        const fieldNames = ui.fields().map(field => field.name);
        return fieldNames.length ? (buildLabel(currentState(), fieldNames, ui.displayTemplate()) || '(no data yet)') : '(no fields configured)';
    });

    wrap.append(
        fieldsSection,
        Field('SideCar profile', profileSelect),
        Field('Poll timing', pollModeSelect, { hint: 'When to ask SideCar for this tracker\'s state.' }),
        pollSettings,
        h('details', { class: 'stme-sampler' },
            h('summary', {}, 'Prompt templates ', h('small', {}, 'Advanced — placeholders: {fields}, {fieldsJson}, {current}, {context}')),
            h('div', { class: 'stme-tracker-templates' },
                Field('System prompt', systemPromptArea, { stack: true }),
                Field('User prompt', promptArea, { stack: true }),
            ),
        ),
        h('div', { class: 'stme-tracker-display' },
            h('div', { class: 'stme-tracker-display-head' },
                h('strong', {}, 'Display template'),
                h('small', {}, 'Optional — leave empty for an automatic "name: value" list. Click a token to insert its address.'),
            ),
            displayInput,
            tokens,
        ),
        h('div', { class: 'stme-tracker-current' }, h('strong', {}, 'Current state'), h('span', { class: 'stme-tracker-current-value' }, currentLabel)),
        h('div', { class: 'stme-tracker-actions' },
            Button('Save tracker', () => {
                block.sidecarProfile = ui.sidecarProfile.peek();
                block.systemPromptTemplate = String(ui.systemPromptTemplate.peek()).trim() || DEFAULT_SYSTEM_PROMPT;
                block.promptTemplate = String(ui.promptTemplate.peek()).trim() || DEFAULT_PROMPT;
                block.displayTemplate = String(ui.displayTemplate.peek()).trim();
                ui.systemPromptTemplate.set(block.systemPromptTemplate);
                ui.promptTemplate.set(block.promptTemplate);
                ui.displayTemplate.set(block.displayTemplate);
                host.saveModuleSettings();
                host.data.get('publish')?.();
                host.toast('success', `"${block.title}" saved.`, 'Tracker');
            }),
            Button('Reset tracked state', () => {
                store.reset(block.id);
                host.data.get('publish')?.();
                host.toast('success', `Tracked state cleared for "${block.title}".`, 'Tracker');
            }),
        ),
    );

    return wrap;
}

/** One read-only row: a value some other module asked Tracker to track. No inputs, no remove button — the requesting module owns its lifecycle via the handle it got back from track(). */
function renderQuickRow(entry, host) {
    const value = signal(host.data.get(`quick:${entry.id}`, ''));
    const wrap = h('div', { class: 'stme-tracker-quick-row' });
    onDispose(wrap, host.data.subscribe(MODULE_ID, `quick:${entry.id}`, next => value.set(next ?? '')));
    wrap.append(
        h('span', { class: 'stme-tracker-quick-name' }, entry.name),
        h('code', { class: 'stme-tracker-quick-value' }, value),
        h('small', { class: 'stme-tracker-quick-owner' }, entry.requesterId),
    );
    return wrap;
}

/** Compact, always read-only — deliberately no editor: these values are provided programmatically by other modules, not configured here. */
function renderQuickSection(quickIndex, host) {
    return h('div', { class: 'stme-tracker-quick' },
        h('div', { class: 'stme-tracker-quick-head' },
            h('strong', {}, 'Quick tracked values'),
            h('small', {}, "Requested by other modules via host.services.request('tracker').track() — read-only here."),
        ),
        show(computed(() => quickIndex().length === 0), empty => empty ? h('p', { class: 'stme-tracker-empty' }, 'No modules are tracking a quick value yet.') : null),
        h('div', { class: 'stme-tracker-quick-list' }, list(quickIndex, entry => entry.id, entry => renderQuickRow(entry, host))),
    );
}

export const trackerModule = {
    id: 'tracker',
    title: 'Tracker',
    description: 'Independent tracker blocks, each with its own SideCar profile, prompt, and fields.',
    about: 'Watches the story and keeps a running scoreboard of things you define — health, mood, relationship points, anything with a value that changes over time — shown in an optional floating panel, never in the chat itself.',
    defaultEnabled: false,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/tracker',
    minEngineVersion: '0.1.0',

    activate(host) {
        const log = (...args) => console.info('[STME:tracker]', ...args);
        const warn = (...args) => console.warn('[STME:tracker]', ...args);
        log('activate() starting.');
        const store = createTrackerStore(host.context);
        // blockId currently mid-poll, across ANY of the 4 modes — guards against two
        // overlapping requests for the same block (e.g. its 'every-n-time' timer firing
        // again before a slow previous request has even resolved).
        const running = new Set();
        // blockId -> real AI replies seen since its last poll, for 'every-n-turns' —
        // in-memory only, resets on module re-enable/page reload (same lifetime as
        // `running` above; not worth persisting for a counter this cheap to just start
        // fresh from).
        const turnCounters = new Map();
        // blockId -> { timer, intervalMs } for every block currently in 'every-n-time'
        // mode — reconciled on every publish() call (i.e. every settings change), see
        // syncPollTimers() below.
        const pollTimers = new Map();

        // Publishes every block's description + current state to the shared data bus
        // (namespace "tracker": a `blocks` index plus one `block:<id>` entry each).
        // This is the ONLY place tracked fields leave the module — never into
        // `message.mes` or anything sent to the character LLM, only onto `host.data`,
        // which other modules or this module's own floating panel can read or subscribe to.
        // Reservation makes each channel a checked contract instead of a bare value:
        // a shape schema (rejects a malformed write instead of corrupting the HUD/macro),
        // and — for the per-field channels — a registered ST macro (block kind 2: readable
        // anywhere ST itself resolves {{macros}} — prompts, World Info, character cards,
        // Quick Replies) plus `persist: true` so the value survives a page reload.
        const DISABLED_NOTICE = '(tracking disabled)';
        // Tracks which per-field bus channels this module owns right now, keyed by block id,
        // so the NEXT publish() can tell a field/block that's gone (removed, or the whole
        // block deleted) from one that's merely unchanged — and unreserve() the ones that are
        // gone. Without this, a channel/macro reserved for a field the user later removes (or
        // a block they delete) just keeps resolving to its last known value forever: the bus
        // has no other signal that it should stop.
        let publishedFields = new Map(); // blockId -> Set<fieldName>

        const publish = () => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            log(`publish(): ${settings.blocks.length} block(s) — ${settings.blocks.map(b => `"${b.title}" (${sanitizeFields(b.fields).length} field(s), enabled=${b.enabled !== false})`).join('; ') || 'none configured'}.`);

            host.data.reserve('blocks', { name: 'Tracker blocks index', schema: { type: 'array' } });
            host.data.set('blocks', settings.blocks.map(describeBlockForBus));

            const currentBlockIds = new Set(settings.blocks.map(block => block.id));
            for (const [blockId, fieldNames] of [...publishedFields]) {
                if (currentBlockIds.has(blockId)) continue;
                // The whole block was removed since the last publish() — retire everything it owned.
                for (const fieldName of fieldNames) host.data.unreserve(`field:${blockId}:${fieldName}`);
                host.data.unreserve(`block:${blockId}`);
                publishedFields.delete(blockId);
                log(`publish(): block ${blockId} no longer exists — retired its bus channels.`);
            }

            for (const block of settings.blocks) {
                const enabled = block.enabled !== false;
                const rawState = store.get(block.id);
                const fields = sanitizeFields(block.fields).map(field => field.name);
                // store.get() can carry orphaned keys from a field that used to exist on this
                // block (the store itself intentionally never deletes them, see store.js) —
                // filter to only the CURRENTLY configured fields before this goes on the bus,
                // so a consumer reading the raw `.state` object never sees ghost data either.
                const state = Object.fromEntries(fields.map(name => [name, enabled ? (rawState[name] ?? '') : DISABLED_NOTICE]));

                const previousFields = publishedFields.get(block.id) ?? new Set();
                for (const fieldName of previousFields) {
                    if (!fields.includes(fieldName)) {
                        host.data.unreserve(`field:${block.id}:${fieldName}`);
                        log(`publish(): field "${fieldName}" removed from block "${block.title}" — retired its bus channel.`);
                    }
                }
                publishedFields.set(block.id, new Set(fields));

                host.data.reserve(`block:${block.id}`, { name: `Tracker: ${block.title}`, schema: { type: 'object' }, persist: true });
                host.data.set(`block:${block.id}`, { ...describeBlockForBus(block), state, updatedAt: Date.now() });

                for (const fieldName of fields) {
                    const fieldKey = `field:${block.id}:${fieldName}`;
                    host.data.reserve(fieldKey, {
                        name: `${block.title} — ${fieldName}`,
                        schema: { type: 'string' },
                        macro: macroSlug(block.title, fieldName),
                        persist: true,
                    });
                    // Always set, even to an empty string or the disabled notice — a field
                    // that was just reset or disabled must stop showing its last real value,
                    // not keep it frozen because a falsy new value used to skip the write.
                    host.data.set(fieldKey, state[fieldName]);
                }
            }
            // Every settings change (add/remove/reorder a block, flip its mode, change
            // N) goes through publish() already (the UI always calls
            // host.data.get('publish')?.() after mutating settings) — reconciling
            // timers here too means a poll-mode edit takes effect immediately, not
            // just on next reload. Defined as a function declaration below (hoisted),
            // so referencing it here, before its own textual definition, is safe —
            // this call only ever actually RUNS once publish() itself is invoked.
            syncPollTimers();
        };
        host.data.set('publish', publish);

        /**
         * Reconciles the live setInterval() timers against whichever blocks are
         * CURRENTLY configured for 'every-n-time' — same "diff against last known
         * state, add what's missing, drop what's gone" idea publish() already
         * applies to bus channels, just for real timers instead. Called from
         * publish() itself (i.e. after every settings change, not on a separate
         * schedule) so switching a block's mode, changing N, disabling it, or
         * deleting it entirely all take effect immediately, not just on next
         * reload. A block whose interval is UNCHANGED keeps its already-running
         * timer untouched — no reason to reset its countdown just because some
         * OTHER block's settings changed too.
         */
        function syncPollTimers() {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            const currentIds = new Set();
            for (const block of settings.blocks) {
                if (block.enabled === false) continue;
                if (resolvePollMode(block) !== 'every-n-time') continue;
                currentIds.add(block.id);
                const intervalMs = resolvePollIntervalMs(block);
                const existing = pollTimers.get(block.id);
                if (existing?.intervalMs === intervalMs) continue;
                if (existing) clearInterval(existing.timer);
                const timer = setInterval(() => {
                    // Re-read the block fresh from settings on every tick — the
                    // closed-over `block` above could be stale (title/fields/profile
                    // edited) by the time a LATER tick fires.
                    const current = host.moduleSettings(MODULE_DEFAULTS).blocks.find(item => item.id === block.id);
                    if (current) runAndApply(current);
                }, intervalMs);
                pollTimers.set(block.id, { timer, intervalMs });
                log(`Block "${block.title}" — polling every ${Math.round(intervalMs / 60000)} minute(s).`);
            }
            for (const [blockId, entry] of [...pollTimers]) {
                if (currentIds.has(blockId)) continue;
                clearInterval(entry.timer);
                pollTimers.delete(blockId);
            }
        }

        /**
         * Runs one block's poll (runBlockPoll()) and applies the result: on
         * success, snapshots the label onto `snapshotMessage.extra` if one was
         * given (modes 2/3 only — see POLL_MODES' own doc comment for why modes
         * 1/4 never pass one), always publish()es afterward so the HUD/bus/macro
         * reflect the change immediately regardless of mode. Never throws — a
         * failure toasts and is logged, same as the module always did. Guards
         * against overlapping requests for the same block via `running`.
         */
        async function runAndApply(block, { snapshotMessage } = {}) {
            if (running.has(block.id)) { log(`Block "${block.title}" — already mid-request, skipped.`); return false; }
            if (!host.sidecar.isConfigured()) { warn(`Block "${block.title}" — SideCar not configured, skipped.`); return false; }
            running.add(block.id);
            try {
                const result = await runBlockPoll(host, store, block);
                if (!result.ok) throw result.error;
                log(`Block "${block.title}" — polled (mode "${resolvePollMode(block)}"), label "${result.label}".`);
                if (snapshotMessage && result.label) {
                    snapshotMessage.extra ??= {};
                    snapshotMessage.extra[TRACKER_EXTRA_KEY] ??= {};
                    snapshotMessage.extra[TRACKER_EXTRA_KEY][block.id] = { title: block.title, label: result.label };
                    return true; // a snapshot was actually written onto the message
                }
                if (snapshotMessage) warn(`Block "${block.title}" — parsed data produced an empty label, skipping this message's snapshot.`, result.nextState);
                return !snapshotMessage; // no snapshot requested (mode 1) still counts as a successful poll
            } catch (error) {
                console.error(`[ST Module Engine] Tracker "${block.title}" SideCar request failed:`, error);
                host.toast('warning', error?.message || 'Could not update tracked state.', block.title);
                return false;
            } finally {
                running.delete(block.id);
                publish();
            }
        }

        publish(); // also runs syncPollTimers() itself, see its own trailing comment above

        // --- Service: any other module can ask Tracker to track a value for it,
        // without configuring a block by hand. The REQUESTING module is the
        // "provider" here — it owns the value and pushes updates via the handle;
        // Tracker only stores/shows it, read-only, in a compact list (see render()).
        // A consumer reaches this via the generic registry:
        //   host.services.request('tracker').track(host.id, key, { name, initial })
        const quickEntries = new Map(); // entryId -> { requesterId, key, name, unreserve }
        const publishQuickIndex = () => {
            host.data.set('quickIndex', [...quickEntries.values()].map(entry => ({ id: `${entry.requesterId}:${entry.key}`, requesterId: entry.requesterId, name: entry.name })));
        };
        host.services.register('tracker', {
            track(requesterId, key, options = {}) {
                const entryId = `${requesterId}:${key}`;
                let entry = quickEntries.get(entryId);
                if (!entry) {
                    const name = String(options.name ?? key).trim().slice(0, 80) || key;
                    const reserved = host.data.reserve(`quick:${entryId}`, {
                        name, schema: { type: 'string' }, persist: true, macro: macroSlug('quick', requesterId, key),
                    });
                    entry = { requesterId, key, name, unreserve: reserved.unreserve };
                    quickEntries.set(entryId, entry);
                    publishQuickIndex();
                }
                if (options.initial !== undefined) host.data.set(`quick:${entryId}`, String(options.initial));
                return Object.freeze({
                    set: value => host.data.set(`quick:${entryId}`, String(value ?? '')),
                    remove: () => {
                        entry.unreserve();
                        host.data.remove(`quick:${entryId}`);
                        quickEntries.delete(entryId);
                        publishQuickIndex();
                    },
                });
            },
            // The pull half: host.services.ask('tracker', 'classify', { vocabulary, profileId? })
            // -> { keys } — asker supplies the vocabulary (≤50 keys), Tracker supplies one SideCar call.
            async handleRequest(type, payload) {
                if (type !== 'classify') throw new Error(`Tracker does not support request type "${type}".`);
                const vocabulary = sanitizeVocabulary(payload?.vocabulary);
                if (!vocabulary.length || !host.sidecar.isConfigured()) return { keys: [] };
                const built = buildClassifyRequest(vocabulary, host.context().chat);
                const text = await host.sidecar.request({ ...built, profileId: payload?.profileId ?? 'default' });
                return parseClassifyResponse(text, vocabulary);
            },
        });
        publishQuickIndex();

        // --- Floating panel: a separate, draggable, opt-in surface for the tracked
        // fields. It reads only from the bus above, so it structurally cannot leak
        // into the chat transcript or the main LLM's context.
        const initialSettings = host.moduleSettings(MODULE_DEFAULTS);
        const hud = createHudPanel();
        applyHudPosition(hud, initialSettings);
        hud.classList.toggle('stme-tracker-hud-collapsed', Boolean(initialSettings.hud.collapsed));
        hud.hidden = !initialSettings.hud.enabled;
        host.data.set('hudPanel', hud);

        const renderHud = () => {
            const blocksIndex = host.data.get('blocks', []).filter(block => block.enabled);
            log(`renderHud(): ${blocksIndex.length} enabled block(s) on the bus, panel hidden=${hud.hidden}.`);
            const body = hud.querySelector('.stme-tracker-hud-body');
            body.replaceChildren();
            if (!blocksIndex.length) {
                const empty = document.createElement('p');
                empty.className = 'stme-tracker-hud-empty';
                empty.textContent = 'No tracker fields to show yet.';
                body.append(empty);
                return;
            }
            for (const block of blocksIndex) {
                const entry = host.data.get(`block:${block.id}`, null);
                const state = entry?.state ?? {};
                const section = document.createElement('div');
                section.className = 'stme-tracker-hud-block';
                const title = document.createElement('strong');
                title.textContent = block.title;
                section.append(title);
                const list = document.createElement('div');
                list.className = 'stme-tracker-hud-fields';
                if (!block.fields.length) {
                    const none = document.createElement('span');
                    none.className = 'stme-tracker-hud-empty';
                    none.textContent = 'No fields configured.';
                    list.append(none);
                }
                for (const field of block.fields) {
                    const row = document.createElement('div');
                    row.className = 'stme-tracker-hud-field';
                    row.innerHTML = '<span class="stme-tracker-hud-field-name"></span><span class="stme-tracker-hud-field-value"></span>';
                    row.querySelector('.stme-tracker-hud-field-name').textContent = field;
                    row.querySelector('.stme-tracker-hud-field-value').textContent = state[field] || '—';
                    list.append(row);
                }
                section.append(list);
                body.append(section);
            }
        };

        let blockSubs = new Map();
        const resubscribeBlocks = () => {
            for (const unsub of blockSubs.values()) unsub();
            blockSubs = new Map();
            for (const block of host.data.get('blocks', [])) {
                blockSubs.set(block.id, host.data.subscribe(MODULE_ID, `block:${block.id}`, renderHud));
            }
            renderHud();
        };
        const unsubBlocksIndex = host.data.subscribe(MODULE_ID, 'blocks', resubscribeBlocks);
        resubscribeBlocks();

        hud.querySelector('.stme-tracker-hud-collapse').addEventListener('click', () => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            const collapsed = !hud.classList.contains('stme-tracker-hud-collapsed');
            hud.classList.toggle('stme-tracker-hud-collapsed', collapsed);
            settings.hud = { ...settings.hud, collapsed };
            host.saveModuleSettings();
        });
        hud.querySelector('.stme-tracker-hud-close').addEventListener('click', () => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            settings.hud = { ...settings.hud, enabled: false };
            host.saveModuleSettings();
            hud.hidden = true;
        });
        const unmakeDraggable = makeHudDraggable(hud, host);

        // --- Mode 1 ('user-message'): the instant the PLAYER's own message is sent,
        // before the AI has replied at all — no message to snapshot onto yet, only
        // the live bus/HUD gets updated (see runAndApply()'s own doc comment).
        const sent = host.onEvent('MESSAGE_SENT', () => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            const blocks = settings.blocks.filter(block => block.enabled !== false && resolvePollMode(block) === 'user-message');
            if (!blocks.length) return;
            log(`MESSAGE_SENT — polling ${blocks.length} 'user-message'-mode block(s).`);
            for (const block of blocks) runAndApply(block);
        });

        // --- Modes 2 ('after-turn', the default) and 3 ('every-n-turns'): both react
        // to the AI's reply actually landing; the only difference is whether EVERY
        // landing triggers a poll or only every Nth one.
        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            const afterTurnBlocks = settings.blocks.filter(block => block.enabled !== false && resolvePollMode(block) === 'after-turn');
            const everyNTurnsBlocks = settings.blocks.filter(block => block.enabled !== false && resolvePollMode(block) === 'every-n-turns');
            log(`MESSAGE_RECEIVED (messageId=${messageId}, type=${type}) — ${afterTurnBlocks.length} 'after-turn', ${everyNTurnsBlocks.length} 'every-n-turns' block(s) configured.`);

            // Subscribed HERE, synchronously, before any `await` below — see
            // waitForPostProcess()'s own doc comment for why this ordering is what
            // makes it race-free against Post-Turn Processor's own MESSAGE_RECEIVED
            // listener. Computed once per cycle and shared by every 'after-turn'
            // block below, not once per block — a SECOND, later subscribe() call
            // would miss a signal Post-Turn Processor already emitted for the first.
            const postProcessWait = afterTurnBlocks.length ? waitForPostProcess(host, messageId) : null;

            if (IGNORED_MESSAGE_TYPES.includes(type)) { log(`Ignored — message type "${type}" is excluded.`); return; }
            if (!afterTurnBlocks.length && !everyNTurnsBlocks.length) return;

            const context = host.context();
            const resolved = resolveMessage(context.chat ?? [], messageId);
            if (!resolved?.message) { warn(`Could not resolve a chat message for id ${messageId}.`); return; }
            if (resolved.message.is_user || resolved.message.is_system) { log('Ignored — message is from the user or is a system message.'); return; }

            // A reroll (regenerate, or swiping to a brand-new response) reuses the SAME
            // message object — ST doesn't reliably clear its .extra for us. Without this,
            // the per-block "already has a snapshot" guard below would see the PREVIOUS
            // response's snapshot and skip recomputing for the new one entirely.
            if ((type === 'regenerate' || type === 'swipe') && resolved.message.extra?.[TRACKER_EXTRA_KEY]) {
                log(`Message #${resolved.index} was rerolled (type="${type}") — clearing its stale snapshot so every block recomputes.`);
                delete resolved.message.extra[TRACKER_EXTRA_KEY];
            }

            let changed = false;

            for (const block of afterTurnBlocks) {
                if (resolved.message.extra?.[TRACKER_EXTRA_KEY]?.[block.id]) { log(`Block "${block.title}" — message already has a snapshot, skipped.`); continue; }
                await postProcessWait;
                if (await runAndApply(block, { snapshotMessage: resolved.message })) changed = true;
            }

            for (const block of everyNTurnsBlocks) {
                const target = resolvePollTurns(block);
                const count = (turnCounters.get(block.id) ?? 0) + 1;
                if (count < target) { turnCounters.set(block.id, count); log(`Block "${block.title}" — turn ${count}/${target}, not polling yet.`); continue; }
                turnCounters.set(block.id, 0);
                if (resolved.message.extra?.[TRACKER_EXTRA_KEY]?.[block.id]) { log(`Block "${block.title}" — message already has a snapshot, skipped.`); continue; }
                if (await runAndApply(block, { snapshotMessage: resolved.message })) changed = true;
            }

            if (changed) {
                updateMessage(context, resolved.index, resolved.message);
            } else {
                log('MESSAGE_RECEIVED handled — no block produced a usable snapshot, nothing changed on the message itself.');
            }
        });

        const chatChangedUnsub = host.onChatChanged(() => { publish(); });
        log('activate() complete.');

        return () => {
            sent(); received(); chatChangedUnsub();
            for (const entry of pollTimers.values()) clearInterval(entry.timer);
            pollTimers.clear();
            unsubBlocksIndex();
            for (const unsub of blockSubs.values()) unsub();
            unmakeDraggable();
            hud.remove();
            // No manual host.data.remove() calls needed here: the engine calls
            // releaseNamespace('tracker') right after this cleanup runs, which drops
            // every value AND unreserves every channel (unregistering its macro, in
            // one place) this module owns — including ones a future edit here might
            // forget to list by hand.
        };
    },

    render(container, host) {
        console.info('[STME:tracker]', `render() — ${host.moduleSettings(MODULE_DEFAULTS).blocks.length} block(s) in settings.`);
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        const store = createTrackerStore(host.context);
        const profiles = signal(host.sidecar.profiles());
        const blocks = signal(settings.blocks);
        const hudEnabled = signal(Boolean(settings.hud.enabled));
        const blockUiCache = new Map();
        const quickIndex = signal(host.data.get('quickIndex', []));
        onDispose(container, host.data.subscribe(MODULE_ID, 'quickIndex', next => quickIndex.set(next ?? [])));

        const persistBlocks = next => {
            blocks.set(next);
            settings.blocks = next;
            host.saveModuleSettings();
            host.data.get('publish')?.();
        };

        const draggableList = DraggableList(blocks, block => block.id, {
            isOpen: block => !block.collapsed,
            onToggleOpen: (block, open) => { block.collapsed = !open; host.saveModuleSettings(); },
            onReorder: persistBlocks,
            renderHeader: block => renderBlockHeader(block, getBlockUi(blockUiCache, block), blocks, persistBlocks, profiles, host),
            renderContent: block => renderBlockContent(block, getBlockUi(blockUiCache, block), store, profiles, host),
        });

        container.append(
            h('p', { class: 'stme-tracker-help' }, 'Each tracker below is independent: its own SideCar profile, its own prompt, its own fields. Drag a tracker by its grip to reorder it.'),
            h('div', { class: 'stme-tracker-hud-toggle' },
                Toggle('Show floating panel', hudEnabled, {
                    hint: 'A separate, movable tab with live field values — never sent to the main LLM.',
                    onChange: checked => {
                        hudEnabled.set(checked);
                        settings.hud = { ...settings.hud, enabled: checked };
                        host.saveModuleSettings();
                        const panel = host.data.get('hudPanel');
                        if (panel) panel.hidden = !checked;
                    },
                }),
            ),
            show(computed(() => blocks().length === 0), empty => empty ? h('p', { class: 'stme-tracker-empty' }, 'No trackers yet. Add one to start tracking custom state.') : null),
            draggableList,
            Button('+ Add tracker', () => persistBlocks([...blocks.peek(), createBlock()])),
            renderQuickSection(quickIndex, host),
        );
    },

    css: `
        .stme-settings .stme-tracker-help { margin: 0 0 10px; line-height: 1.4; opacity: .85; }
        .stme-settings .stme-tracker-blocks { display: flex; flex-direction: column; gap: 8px; }
        .stme-settings .stme-tracker-add { margin-top: 10px; }
        .stme-settings .stme-tracker-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
        .stme-settings .stme-tracker-title-input { border: none; background: transparent; padding: 0; font-weight: 700; font-size: 1em; color: inherit; width: 100%; }
        .stme-settings .stme-tracker-title-input:focus { outline: 1px solid var(--stme-accent, var(--SmartThemeQuoteColor, #8da8ff)); border-radius: 4px; }
        .stme-settings .stme-tracker-title small { opacity: .65; }
        .stme-settings .stme-tracker-block { display: flex; flex-direction: column; gap: 10px; }
        .stme-settings .stme-tracker-fields { display: flex; flex-direction: column; gap: 6px; }
        .stme-settings .stme-tracker-fields-label { display: flex; flex-direction: column; gap: 2px; font-weight: 600; font-size: .9em; opacity: .85; }
        .stme-settings .stme-tracker-fields-label small { font-weight: normal; opacity: .75; }
        .stme-settings .stme-tracker-field-list { display: flex; flex-direction: column; gap: 6px; }
        .stme-settings .stme-tracker-field-row { display: grid; grid-template-columns: minmax(70px, .3fr) 1fr auto; gap: 8px; align-items: center; padding: 5px 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: var(--stme-radius-sm); background: var(--SmartThemeBlurTintColor); }
        .stme-settings .stme-tracker-field-name { font-weight: 700; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-field-add { display: grid; grid-template-columns: minmax(120px, .35fr) 1fr auto; gap: 8px; align-items: center; }
        .stme-settings .stme-tracker-empty { margin: 0; padding: 8px; opacity: .65; font-size: .9em; }
        .stme-settings .stme-tracker-templates { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
        .stme-settings .stme-tracker-poll-settings:empty { display: none; }
        .stme-settings .stme-tracker-poll-settings { display: flex; flex-direction: column; gap: 4px; }
        .stme-settings .stme-tracker-display { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: var(--stme-radius); background: rgba(0, 0, 0, .06); }
        .stme-settings .stme-tracker-display-head { display: flex; flex-direction: column; gap: 2px; }
        .stme-settings .stme-tracker-display-head small { opacity: .7; }
        .stme-settings .stme-tracker-tokens { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .stme-settings .stme-tracker-current { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: var(--stme-radius); background: rgba(0, 0, 0, .06); }
        .stme-settings .stme-tracker-current-value { opacity: .85; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-actions { display: flex; gap: 8px; }
        .stme-settings .stme-tracker-hud-toggle { padding: 8px 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: var(--stme-radius); background: rgba(0, 0, 0, .05); }

        /* Quick tracked values: compact, read-only rows requested by other modules — deliberately no inputs. */
        .stme-settings .stme-tracker-quick { margin-top: 14px; padding-top: 12px; border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor) 70%, transparent); }
        .stme-settings .stme-tracker-quick-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
        .stme-settings .stme-tracker-quick-head small { opacity: .65; }
        .stme-settings .stme-tracker-quick-list { display: flex; flex-direction: column; gap: 4px; }
        .stme-settings .stme-tracker-quick-row { display: grid; grid-template-columns: minmax(90px, .35fr) 1fr auto; gap: 8px; align-items: center; padding: 4px 8px; border-radius: var(--stme-radius-sm); background: rgba(0, 0, 0, .07); font-size: .9em; }
        .stme-settings .stme-tracker-quick-name { opacity: .85; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-quick-value { font-weight: 600; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-quick-owner { opacity: .55; text-align: right; white-space: nowrap; }

        /* Floating panel: appended to document.body, not the chat transcript — reads only from the data bus. */
        .stme-tracker-hud { position: fixed; z-index: 5000; width: 260px; max-height: 70vh; display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #8da8ff) 70%, var(--SmartThemeBorderColor)); background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 90%, var(--SmartThemeQuoteColor, #8da8ff)); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); backdrop-filter: blur(6px); font-family: var(--mainFontFamily, inherit); color: var(--SmartThemeBodyColor); }
        .stme-tracker-hud[hidden] { display: none; }
        .stme-tracker-hud-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px; cursor: grab; background: linear-gradient(105deg, transparent, rgba(0, 0, 0, .14)); user-select: none; touch-action: none; }
        .stme-tracker-hud-head:active { cursor: grabbing; }
        .stme-tracker-hud-grip { opacity: .6; }
        .stme-tracker-hud-head strong { flex: 1; font-size: .85em; letter-spacing: .03em; }
        .stme-tracker-hud-collapse, .stme-tracker-hud-close { border: none; background: transparent; color: inherit; opacity: .7; cursor: pointer; width: 22px; height: 22px; line-height: 1; border-radius: var(--stme-radius-sm); font-size: 1em; }
        .stme-tracker-hud-collapse:hover, .stme-tracker-hud-close:hover { opacity: 1; background: rgba(255, 255, 255, .14); }
        .stme-tracker-hud-body { padding: 10px 11px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 11px; }
        .stme-tracker-hud.stme-tracker-hud-collapsed .stme-tracker-hud-body { display: none; }
        .stme-tracker-hud-empty { margin: 0; opacity: .65; font-size: .85em; }
        .stme-tracker-hud-block strong { display: block; font-size: .8em; opacity: .75; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
        .stme-tracker-hud-fields { display: flex; flex-direction: column; gap: 3px; }
        .stme-tracker-hud-field { display: flex; justify-content: space-between; gap: 8px; font-size: .88em; }
        .stme-tracker-hud-field-name { opacity: .7; }
        .stme-tracker-hud-field-value { font-weight: 600; text-align: right; overflow-wrap: anywhere; }
    `,
};
