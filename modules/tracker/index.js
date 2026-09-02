import { createTrackerStore } from './store.js';
import {
    h, list, show, signal, computed, onDispose, effectOn,
    Field, TextInput, TextArea, Select, Toggle, Button, Chip, DraggableList,
} from '../../core/widgets.js';

const MODULE_ID = 'tracker';
const TRACKER_EXTRA_KEY = 'stme_tracker_snapshot';
const MAX_FIELD_LENGTH = 200;
const MAX_FIELD_NAME_LENGTH = 40;
const MAX_INSTRUCTION_LENGTH = 200;

const IGNORED_MESSAGE_TYPES = ['swipe', 'continue', 'appendFinal', 'first_message', 'command', 'extension', 'regenerate'];

const DEFAULT_SYSTEM_PROMPT =
    'You are a state tracker for a roleplay chat. Track only the fields below, using each note to decide how to fill it in:\n' +
    '{fields}\n\n' +
    'Known current values: {current}. ' +
    'Read the recent context and infer updated values only for fields that plausibly changed; keep the others as given. ' +
    'Return ONLY a JSON object with exactly these keys: {fieldsJson}. No extra keys, no markdown, no explanation.';
const DEFAULT_PROMPT = 'RECENT CONTEXT:\n{context}\n\nThe character is about to respond. Return the updated JSON object only.';

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

    const vars = {
        fields: describeFields(fields),
        fieldsJson: fields.map(field => `"${field.name}"`).join(', '),
        current: JSON.stringify(currentState ?? {}),
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
    };
}

function createBadge(title, label) {
    const badge = document.createElement('section');
    badge.className = 'stme-tracker';
    badge.innerHTML = `
        <div class="stme-tracker-head">
            <span class="stme-tracker-icon">◆</span>
            <span class="stme-tracker-label"></span>
        </div>
        <div class="stme-tracker-value"></div>
    `;
    badge.querySelector('.stme-tracker-label').textContent = title;
    badge.querySelector('.stme-tracker-value').textContent = label;
    return badge;
}

function renderBadges(index, snapshot) {
    const root = document.querySelector(`.mes[mesid="${index}"] .mes_text, #chat .mes[mesid="${index}"] .mes_text`);
    if (!root || !snapshot) return;
    for (const [blockId, entry] of Object.entries(snapshot)) {
        if (root.querySelector(`.stme-tracker[data-stme-tracker-block="${blockId}"]`)) continue;
        const badge = createBadge(entry.title, entry.label);
        badge.dataset.stmeTrackerBlock = blockId;
        root.append(badge);
    }
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
    if (Number.isFinite(settings.hud.x) && Number.isFinite(settings.hud.y)) {
        panel.style.left = `${settings.hud.x}px`;
        panel.style.top = `${settings.hud.y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    } else {
        panel.style.right = '20px';
        panel.style.bottom = '20px';
        panel.style.left = 'auto';
        panel.style.top = 'auto';
    }
}

/** Drags the panel by its header (grip) and persists the dropped position. Returns a cleanup function. */
function makeHudDraggable(panel, host) {
    const head = panel.querySelector('.stme-tracker-hud-head');
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onPointerDown = event => {
        if (event.target.closest('button')) return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        head.setPointerCapture(event.pointerId);
    };
    const onPointerMove = event => {
        if (!dragging) return;
        const x = Math.min(Math.max(0, event.clientX - offsetX), window.innerWidth - panel.offsetWidth);
        const y = Math.min(Math.max(0, event.clientY - offsetY), window.innerHeight - panel.offsetHeight);
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    };
    const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        settings.hud = { ...settings.hud, x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10) };
        host.saveModuleSettings();
    };

    head.addEventListener('pointerdown', onPointerDown);
    head.addEventListener('pointermove', onPointerMove);
    head.addEventListener('pointerup', onPointerUp);
    head.addEventListener('pointercancel', onPointerUp);

    return () => {
        head.removeEventListener('pointerdown', onPointerDown);
        head.removeEventListener('pointermove', onPointerMove);
        head.removeEventListener('pointerup', onPointerUp);
        head.removeEventListener('pointercancel', onPointerUp);
    };
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
            persistBlocks(blocks.peek().filter(item => item.id !== block.id));
            host.data.remove(`block:${block.id}`);
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

export const trackerModule = {
    id: 'tracker',
    title: 'Tracker',
    description: 'Independent tracker blocks, each with its own SideCar profile, prompt, and fields.',
    defaultEnabled: false,

    activate(host) {
        const store = createTrackerStore(host.context);
        const pending = new Map();
        const running = new Set();

        // Publishes every block's description + current state to the shared data bus
        // (namespace "tracker": a `blocks` index plus one `block:<id>` entry each).
        // This is the ONLY place tracked fields leave the module — never into
        // `message.mes` or anything sent to the character LLM, only onto `host.data`,
        // which other modules or this module's own floating panel can read or subscribe to.
        const publish = () => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            host.data.set('blocks', settings.blocks.map(describeBlockForBus));
            for (const block of settings.blocks) {
                host.data.set(`block:${block.id}`, { ...describeBlockForBus(block), state: store.get(block.id), updatedAt: Date.now() });
            }
        };
        host.data.set('publish', publish);
        publish();

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

        const start = host.onEvent('GENERATION_STARTED', () => {
            if (!host.sidecar.isConfigured()) return;
            const context = host.context();
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            for (const block of settings.blocks) {
                if (!block.enabled || pending.has(block.id)) continue;
                const fields = sanitizeFields(block.fields);
                if (!fields.length) continue;
                const built = buildTrackerRequest(context.chat, block, store.get(block.id));
                pending.set(block.id, host.sidecar
                    .request({ systemPrompt: built.systemPrompt, prompt: built.prompt, profileId: block.sidecarProfile })
                    .then(text => ({ text, fields: built.fields }))
                    .catch(error => ({ error })));
            }
        });

        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            if (!pending.size || IGNORED_MESSAGE_TYPES.includes(type)) return;

            const context = host.context();
            const resolved = resolveMessage(context.chat ?? [], messageId);
            const requests = [...pending.entries()];
            pending.clear();

            if (!resolved?.message || resolved.message.is_user || resolved.message.is_system) return;

            const settings = host.moduleSettings(MODULE_DEFAULTS);
            let changed = false;
            for (const [blockId, requestPromise] of requests) {
                if (running.has(blockId)) continue;
                const block = settings.blocks.find(item => item.id === blockId);
                if (!block || resolved.message.extra?.[TRACKER_EXTRA_KEY]?.[blockId]) continue;

                running.add(blockId);
                try {
                    const result = await requestPromise;
                    if (result?.error) throw result.error;
                    const parsed = parseTrackerResponse(result.text, result.fields);
                    if (!parsed.data) throw new Error(`Tracker "${block.title}" got no usable data from SideCar.`);

                    const nextState = store.set(blockId, parsed.data, result.fields);
                    const label = buildLabel(nextState, result.fields, block.displayTemplate);
                    if (!label) continue;

                    resolved.message.extra ??= {};
                    resolved.message.extra[TRACKER_EXTRA_KEY] ??= {};
                    resolved.message.extra[TRACKER_EXTRA_KEY][blockId] = { title: block.title, label };
                    changed = true;
                } catch (error) {
                    console.error(`[ST Module Engine] Tracker "${block?.title ?? blockId}" SideCar request failed:`, error);
                    host.toast('warning', error?.message || 'Could not update tracked state.', block?.title || 'Tracker');
                } finally {
                    running.delete(blockId);
                }
            }

            if (changed) {
                updateMessage(context, resolved.index, resolved.message);
                publish();
                setTimeout(() => renderBadges(resolved.message.mesid ?? resolved.index, resolved.message.extra[TRACKER_EXTRA_KEY]));
            }
        });

        const refreshBadges = () => {
            const context = host.context();
            (context.chat ?? []).forEach((message, index) => {
                if (message.extra?.[TRACKER_EXTRA_KEY]) renderBadges(message.mesid ?? index, message.extra[TRACKER_EXTRA_KEY]);
            });
        };
        const chatChangedUnsub = host.onChatChanged(() => { refreshBadges(); publish(); });

        return () => {
            start(); received(); chatChangedUnsub();
            unsubBlocksIndex();
            for (const unsub of blockSubs.values()) unsub();
            unmakeDraggable();
            hud.remove();
            host.data.remove('hudPanel');
            host.data.remove('publish');
            host.data.remove('blocks');
            for (const block of host.moduleSettings(MODULE_DEFAULTS).blocks) host.data.remove(`block:${block.id}`);
        };
    },

    render(container, host) {
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        const store = createTrackerStore(host.context);
        const profiles = signal(host.sidecar.profiles());
        const blocks = signal(settings.blocks);
        const hudEnabled = signal(Boolean(settings.hud.enabled));
        const blockUiCache = new Map();

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
        .stme-settings .stme-tracker-field-row { display: grid; grid-template-columns: minmax(70px, .3fr) 1fr auto; gap: 8px; align-items: center; padding: 5px 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; background: var(--SmartThemeBlurTintColor); }
        .stme-settings .stme-tracker-field-name { font-weight: 700; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-field-add { display: grid; grid-template-columns: minmax(120px, .35fr) 1fr auto; gap: 8px; align-items: center; }
        .stme-settings .stme-tracker-empty { margin: 0; padding: 8px; opacity: .65; font-size: .9em; }
        .stme-settings .stme-tracker-templates { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
        .stme-settings .stme-tracker-display { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; background: rgba(0, 0, 0, .06); }
        .stme-settings .stme-tracker-display-head { display: flex; flex-direction: column; gap: 2px; }
        .stme-settings .stme-tracker-display-head small { opacity: .7; }
        .stme-settings .stme-tracker-tokens { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .stme-settings .stme-tracker-current { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; background: rgba(0, 0, 0, .06); }
        .stme-settings .stme-tracker-current-value { opacity: .85; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-actions { display: flex; gap: 8px; }
        .stme-settings .stme-tracker-hud-toggle { padding: 8px 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; background: rgba(0, 0, 0, .05); }

        /* Floating panel: appended to document.body, not the chat transcript — reads only from the data bus. */
        .stme-tracker-hud { position: fixed; z-index: 5000; width: 260px; max-height: 70vh; display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #8da8ff) 70%, var(--SmartThemeBorderColor)); background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 90%, var(--SmartThemeQuoteColor, #8da8ff)); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); backdrop-filter: blur(6px); font-family: var(--mainFontFamily, inherit); color: var(--SmartThemeBodyColor); }
        .stme-tracker-hud[hidden] { display: none; }
        .stme-tracker-hud-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px; cursor: grab; background: linear-gradient(105deg, transparent, rgba(0, 0, 0, .14)); user-select: none; touch-action: none; }
        .stme-tracker-hud-head:active { cursor: grabbing; }
        .stme-tracker-hud-grip { opacity: .6; }
        .stme-tracker-hud-head strong { flex: 1; font-size: .8em; letter-spacing: .04em; text-transform: uppercase; opacity: .85; }
        .stme-tracker-hud-collapse, .stme-tracker-hud-close { border: none; background: transparent; color: inherit; opacity: .7; cursor: pointer; width: 20px; height: 20px; line-height: 1; border-radius: 5px; font-size: 1em; }
        .stme-tracker-hud-collapse:hover, .stme-tracker-hud-close:hover { opacity: 1; background: rgba(255, 255, 255, .14); }
        .stme-tracker-hud-body { padding: 9px 11px 11px; overflow-y: auto; display: flex; flex-direction: column; gap: 11px; }
        .stme-tracker-hud.stme-tracker-hud-collapsed .stme-tracker-hud-body { display: none; }
        .stme-tracker-hud-empty { margin: 0; opacity: .65; font-size: .85em; }
        .stme-tracker-hud-block strong { display: block; font-size: .8em; opacity: .75; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
        .stme-tracker-hud-fields { display: flex; flex-direction: column; gap: 3px; }
        .stme-tracker-hud-field { display: flex; justify-content: space-between; gap: 8px; font-size: .88em; }
        .stme-tracker-hud-field-name { opacity: .7; }
        .stme-tracker-hud-field-value { font-weight: 600; text-align: right; overflow-wrap: anywhere; }

        #chat .stme-tracker, .mes .stme-tracker {
            display: block !important;
            box-sizing: border-box;
            width: min(100%, 330px);
            margin: 10px 0 4px auto !important;
            padding: 10px 14px 11px !important;
            border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #8da8ff) 78%, var(--SmartThemeBorderColor)) !important;
            border-left: 4px solid var(--SmartThemeQuoteColor, #8da8ff) !important;
            border-radius: 10px !important;
            background: linear-gradient(120deg, color-mix(in srgb, var(--SmartThemeBlurTintColor) 84%, var(--SmartThemeQuoteColor, #8da8ff)), var(--SmartThemeBlurTintColor)) !important;
            box-shadow: 0 6px 18px rgba(0, 0, 0, .22) !important;
            font-family: var(--mainFontFamily, inherit);
            text-align: left;
        }
        #chat .stme-tracker-head, .mes .stme-tracker-head { display: flex !important; align-items: center; gap: 7px; margin-bottom: 4px; }
        #chat .stme-tracker-icon, .mes .stme-tracker-icon { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; background: var(--SmartThemeQuoteColor, #8da8ff); color: var(--SmartThemeBodyColor); font-size: 13px; line-height: 1; }
        #chat .stme-tracker-label, .mes .stme-tracker-label { color: var(--SmartThemeBodyColor); opacity: .7; font-size: .72em; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
        #chat .stme-tracker-value, .mes .stme-tracker-value { color: var(--SmartThemeBodyColor); font-size: 1em; font-weight: 600; line-height: 1.3; }
    `,
};
