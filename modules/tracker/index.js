import { createTrackerStore } from './store.js';

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

const MODULE_DEFAULTS = Object.freeze({ blocks: [] });

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

function renderFieldRow(block, field, host) {
    const row = document.createElement('div');
    row.className = 'stme-tracker-field-row';
    row.innerHTML = `
        <code class="stme-tracker-field-name"></code>
        <input class="text_pole stme-tracker-field-instruction" type="text" maxlength="${MAX_INSTRUCTION_LENGTH}" placeholder="How should SideCar decide it? (optional)">
        <button class="menu_button stme-worker-remove" type="button" title="Remove field">×</button>
    `;
    row.querySelector('.stme-tracker-field-name').textContent = field.name;
    const instructionInput = row.querySelector('.stme-tracker-field-instruction');
    instructionInput.value = field.instruction;
    instructionInput.addEventListener('change', () => {
        field.instruction = instructionInput.value.trim().slice(0, MAX_INSTRUCTION_LENGTH);
        host.saveModuleSettings();
    });
    row.querySelector('.stme-worker-remove').addEventListener('click', () => {
        block.fields = block.fields.filter(item => item !== field);
        host.saveModuleSettings();
        host.refresh();
    });
    return row;
}

function renderBlockContent(block, store, profiles, host) {
    const wrap = document.createElement('div');
    wrap.className = 'stme-tracker-block';
    wrap.innerHTML = `
        <div class="stme-tracker-fields">
            <span class="stme-tracker-fields-label">Tracked fields <small>Each field becomes one JSON key SideCar must fill in; the note tells it how.</small></span>
            <div class="stme-tracker-field-list"></div>
            <div class="stme-tracker-field-add">
                <input class="text_pole" data-field="name" placeholder="Field name (e.g. health)" maxlength="${MAX_FIELD_NAME_LENGTH}">
                <input class="text_pole" data-field="instruction" placeholder="How should SideCar decide it? (optional)" maxlength="${MAX_INSTRUCTION_LENGTH}">
                <button class="menu_button" type="button" data-action="add-field"><i class="fa-solid fa-plus"></i> Add field</button>
            </div>
        </div>
        <label>SideCar profile <select class="text_pole" data-field="sidecarProfile"></select></label>
        <details class="stme-sampler">
            <summary>Prompt templates <small>Advanced — placeholders: {fields}, {fieldsJson}, {current}, {context}</small></summary>
            <div class="stme-tracker-templates">
                <label>System prompt <textarea class="text_pole" data-field="systemPromptTemplate" rows="4"></textarea></label>
                <label>User prompt <textarea class="text_pole" data-field="promptTemplate" rows="3"></textarea></label>
            </div>
        </details>
        <div class="stme-tracker-display">
            <div class="stme-tracker-display-head">
                <strong>Display template</strong>
                <small>Optional — leave empty for an automatic "name: value" list. Click a token to insert its address.</small>
            </div>
            <input class="text_pole" data-field="displayTemplate" placeholder="&#10084; {health} &middot; &#128205; {location}">
            <div class="stme-tracker-tokens"></div>
        </div>
        <div class="stme-tracker-current"><strong>Current state</strong><span class="stme-tracker-current-value"></span></div>
        <div class="stme-tracker-actions">
            <button class="menu_button" data-action="save" type="button">Save tracker</button>
            <button class="menu_button" data-action="reset" type="button">Reset tracked state</button>
        </div>
    `;

    const fieldList = wrap.querySelector('.stme-tracker-field-list');
    if (!block.fields.length) {
        const empty = document.createElement('p');
        empty.className = 'stme-tracker-empty';
        empty.textContent = 'No fields yet — add one below.';
        fieldList.append(empty);
    } else {
        for (const field of block.fields) fieldList.append(renderFieldRow(block, field, host));
    }

    const nameInput = wrap.querySelector('[data-field="name"]');
    const instructionInput = wrap.querySelector('[data-field="instruction"]');
    const addField = () => {
        const name = normalizeFieldName(nameInput.value);
        if (!name) { host.toast('warning', 'Enter a field name first.', block.title); return; }
        if (block.fields.some(item => item.name === name)) { host.toast('warning', `Field "${name}" already exists.`, block.title); return; }
        block.fields = [...block.fields, { name, instruction: String(instructionInput.value ?? '').trim().slice(0, MAX_INSTRUCTION_LENGTH) }];
        host.saveModuleSettings();
        host.refresh();
    };
    wrap.querySelector('[data-action="add-field"]').addEventListener('click', addField);
    for (const input of [nameInput, instructionInput]) {
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addField(); } });
    }

    const select = wrap.querySelector('[data-field="sidecarProfile"]');
    for (const profile of profiles) {
        const option = new Option(profile.name, profile.id);
        option.selected = profile.id === block.sidecarProfile;
        select.add(option);
    }

    wrap.querySelector('[data-field="systemPromptTemplate"]').value = block.systemPromptTemplate;
    wrap.querySelector('[data-field="promptTemplate"]').value = block.promptTemplate;

    const fieldNames = sanitizeFields(block.fields).map(field => field.name);

    const displayInput = wrap.querySelector('[data-field="displayTemplate"]');
    displayInput.value = block.displayTemplate;
    const tokens = wrap.querySelector('.stme-tracker-tokens');
    if (!fieldNames.length) {
        const hint = document.createElement('span');
        hint.className = 'stme-tracker-empty';
        hint.textContent = 'Add fields above to get insertable tokens.';
        tokens.append(hint);
    } else {
        for (const name of fieldNames) {
            const token = document.createElement('button');
            token.type = 'button';
            token.className = 'stme-tracker-token';
            token.title = `Insert {${name}} — this field's address in the template.`;
            token.innerHTML = `<span class="stme-tracker-token-name"></span><code>{${name}}</code>`;
            token.querySelector('.stme-tracker-token-name').textContent = name;
            token.addEventListener('click', () => {
                const start = displayInput.selectionStart ?? displayInput.value.length;
                const end = displayInput.selectionEnd ?? displayInput.value.length;
                const insert = `{${name}}`;
                displayInput.value = displayInput.value.slice(0, start) + insert + displayInput.value.slice(end);
                displayInput.focus();
                const caret = start + insert.length;
                displayInput.setSelectionRange(caret, caret);
            });
            tokens.append(token);
        }
    }

    const currentState = store.get(block.id);
    wrap.querySelector('.stme-tracker-current-value').textContent = fieldNames.length
        ? (buildLabel(currentState, fieldNames, block.displayTemplate) || '(no data yet)')
        : '(no fields configured)';

    wrap.querySelector('[data-action="save"]').addEventListener('click', () => {
        block.sidecarProfile = select.value;
        block.systemPromptTemplate = String(wrap.querySelector('[data-field="systemPromptTemplate"]').value).trim() || DEFAULT_SYSTEM_PROMPT;
        block.promptTemplate = String(wrap.querySelector('[data-field="promptTemplate"]').value).trim() || DEFAULT_PROMPT;
        block.displayTemplate = String(wrap.querySelector('[data-field="displayTemplate"]').value).trim();
        host.saveModuleSettings();
        host.toast('success', `"${block.title}" saved.`, 'Tracker');
        host.refresh();
    });

    wrap.querySelector('[data-action="reset"]').addEventListener('click', () => {
        store.reset(block.id);
        host.toast('success', `Tracked state cleared for "${block.title}".`, 'Tracker');
        host.refresh();
    });

    return wrap;
}

function renderBlockCard(block, settings, store, profiles, host) {
    const fields = sanitizeFields(block.fields);
    const card = document.createElement('details');
    card.className = 'stme-module';
    card.dataset.blockId = block.id;
    card.draggable = true;
    card.open = !block.collapsed;
    card.addEventListener('toggle', () => { block.collapsed = !card.open; host.saveModuleSettings(); });
    card.addEventListener('dragstart', event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', block.id); card.classList.add('stme-dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('stme-dragging'));

    const header = document.createElement('summary');
    header.className = 'stme-module-header';
    const profileName = profiles.find(item => item.id === block.sidecarProfile)?.name ?? block.sidecarProfile;
    header.innerHTML = `
        <div class="stme-tracker-title">
            <input class="text_pole stme-tracker-title-input" type="text" placeholder="Tracker title" maxlength="60">
            <small>${fields.length} field${fields.length === 1 ? '' : 's'} · profile: ${profileName}</small>
        </div>
        <label class="stme-toggle"><input type="checkbox"> Enabled</label>
        <button class="menu_button stme-worker-remove" type="button">Remove</button>
    `;

    const titleInput = header.querySelector('.stme-tracker-title-input');
    titleInput.value = block.title;
    titleInput.addEventListener('click', event => event.stopPropagation());
    titleInput.addEventListener('change', () => { block.title = titleInput.value.trim() || 'Tracker'; host.saveModuleSettings(); });

    const enabledCheckbox = header.querySelector('.stme-toggle input');
    enabledCheckbox.checked = block.enabled;
    enabledCheckbox.addEventListener('click', event => event.stopPropagation());
    enabledCheckbox.addEventListener('change', () => { block.enabled = enabledCheckbox.checked; host.saveModuleSettings(); });

    header.querySelector('.stme-worker-remove').addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        settings.blocks = settings.blocks.filter(item => item.id !== block.id);
        host.saveModuleSettings();
        host.refresh();
    });

    card.append(header);
    const content = document.createElement('div');
    content.className = 'stme-module-content';
    content.append(renderBlockContent(block, store, profiles, host));
    card.append(content);
    return card;
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
                setTimeout(() => renderBadges(resolved.message.mesid ?? resolved.index, resolved.message.extra[TRACKER_EXTRA_KEY]));
            }
        });

        const refreshBadges = () => {
            const context = host.context();
            (context.chat ?? []).forEach((message, index) => {
                if (message.extra?.[TRACKER_EXTRA_KEY]) renderBadges(message.mesid ?? index, message.extra[TRACKER_EXTRA_KEY]);
            });
        };
        const changed = host.onChatChanged(refreshBadges);

        return () => { start(); received(); changed(); };
    },

    render(container, host) {
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        const store = createTrackerStore(host.context);
        const profiles = host.sidecar.profiles();

        container.innerHTML = `
            <p class="stme-tracker-help">Each tracker below is independent: its own SideCar profile, its own prompt, its own fields. Drag a tracker by its grip to reorder it.</p>
            <div class="stme-tracker-blocks"></div>
            <button class="menu_button stme-tracker-add" type="button"><i class="fa-solid fa-plus"></i> Add tracker</button>
        `;

        const list = container.querySelector('.stme-tracker-blocks');
        if (!settings.blocks.length) {
            const empty = document.createElement('p');
            empty.className = 'stme-tracker-empty';
            empty.textContent = 'No trackers yet. Add one to start tracking custom state.';
            list.append(empty);
        } else {
            for (const block of settings.blocks) list.append(renderBlockCard(block, settings, store, profiles, host));
        }

        list.ondragover = event => event.preventDefault();
        list.ondrop = event => {
            event.preventDefault();
            const id = event.dataTransfer.getData('text/plain');
            const moving = settings.blocks.find(item => item.id === id);
            if (!moving) return;
            const target = event.target.closest?.('[data-block-id]');
            const order = settings.blocks.filter(item => item.id !== id);
            const at = target ? order.findIndex(item => item.id === target.dataset.blockId) : order.length;
            order.splice(at < 0 ? order.length : at, 0, moving);
            settings.blocks = order;
            host.saveModuleSettings();
            host.refresh();
        };

        container.querySelector('.stme-tracker-add').addEventListener('click', () => {
            settings.blocks = [...settings.blocks, createBlock()];
            host.saveModuleSettings();
            host.refresh();
        });
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
        .stme-settings .stme-tracker-block > label:not(.stme-check) { display: grid; grid-template-columns: minmax(110px, .4fr) 1fr; gap: 10px; align-items: center; }
        .stme-settings .stme-tracker-fields { display: flex; flex-direction: column; gap: 6px; }
        .stme-settings .stme-tracker-fields-label { display: flex; flex-direction: column; gap: 2px; font-weight: 600; font-size: .9em; opacity: .85; }
        .stme-settings .stme-tracker-fields-label small { font-weight: normal; opacity: .75; }
        .stme-settings .stme-tracker-field-list { display: flex; flex-direction: column; gap: 6px; }
        .stme-settings .stme-tracker-field-row { display: grid; grid-template-columns: minmax(70px, .3fr) 1fr auto; gap: 8px; align-items: center; padding: 5px 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; background: var(--SmartThemeBlurTintColor); }
        .stme-settings .stme-tracker-field-name { font-weight: 700; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-field-add { display: grid; grid-template-columns: minmax(120px, .35fr) 1fr auto; gap: 8px; align-items: center; }
        .stme-settings .stme-tracker-empty { margin: 0; padding: 8px; opacity: .65; font-size: .9em; }
        .stme-settings .stme-tracker-templates { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
        .stme-settings .stme-tracker-templates label { display: flex; flex-direction: column; gap: 4px; }
        .stme-settings .stme-tracker-display { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; background: rgba(0, 0, 0, .06); }
        .stme-settings .stme-tracker-display-head { display: flex; flex-direction: column; gap: 2px; }
        .stme-settings .stme-tracker-display-head small { opacity: .7; }
        .stme-settings .stme-tracker-tokens { display: flex; flex-wrap: wrap; gap: 6px; }
        .stme-settings .stme-tracker-token { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 65%, var(--stme-accent, var(--SmartThemeQuoteColor, #8da8ff))); border-radius: 999px; background: var(--SmartThemeBlurTintColor); font-size: .82em; cursor: pointer; transition: transform .12s ease, filter .12s ease; }
        .stme-settings .stme-tracker-token:hover { transform: translateY(-1px); filter: brightness(1.12); }
        .stme-settings .stme-tracker-token-name { font-weight: 600; }
        .stme-settings .stme-tracker-token code { opacity: .65; }
        .stme-settings .stme-tracker-current { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; background: rgba(0, 0, 0, .06); }
        .stme-settings .stme-tracker-current-value { opacity: .85; overflow-wrap: anywhere; }
        .stme-settings .stme-tracker-actions { display: flex; gap: 8px; }

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
