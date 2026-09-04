import { h, list, show, computed, signal, onDispose, Field, TextInput, Select, Button } from '../../core/widgets.js';

const MODULE_ID = 'dice';
const TOOL_NAME = 'Dice';
const MAX_DICE = 100;
const MAX_SIDES = 1000;
const HISTORY_LIMIT = 20;

// Every id is unique even though two entries share `sides: 100` — d100 and d%
// mean the same math but are different, real tabletop conventions people expect
// to pick separately. Select() (core/widgets.js) keys its <option> elements by
// `shape.value(item)`, not array position — an earlier version of this module
// keyed the dropdown by `sides` instead of `id`, so d100 and d% silently
// collapsed into one <option> (whichever was processed last won the visible
// label), making "d100" impossible to select on its own. Keying by `id` (the
// widget's own default shape) is what keeps them distinct entries.
export const DICE_TYPES = Object.freeze([
    { id: 'd2', name: 'd2', sides: 2 },
    { id: 'd3', name: 'd3', sides: 3 },
    { id: 'd4', name: 'd4', sides: 4 },
    { id: 'd6', name: 'd6', sides: 6 },
    { id: 'd8', name: 'd8', sides: 8 },
    { id: 'd10', name: 'd10', sides: 10 },
    { id: 'd12', name: 'd12', sides: 12 },
    { id: 'd20', name: 'd20', sides: 20 },
    { id: 'd30', name: 'd30', sides: 30 },
    { id: 'd100', name: 'd100', sides: 100 },
    { id: 'd%', name: 'd%', sides: 100 },
]);

function createRollId() {
    return `roll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function rollDie(sides, random = Math.random) {
    const count = Number(sides);
    if (!Number.isInteger(count) || count < 2 || count > MAX_SIDES) {
        throw new Error(`Dice sides must be an integer from 2 to ${MAX_SIDES}.`);
    }
    return Math.floor(random() * count) + 1;
}

export function rollDice(count, sides, random = Math.random) {
    const dice = Number(count);
    if (!Number.isInteger(dice) || dice < 1 || dice > MAX_DICE) {
        throw new Error(`Dice count must be an integer from 1 to ${MAX_DICE}.`);
    }
    return Array.from({ length: dice }, () => rollDie(sides, random));
}

export function parseDiceNotation(value) {
    const match = String(value ?? '').trim().match(/^(\d*)d(\d+|%)$/i);
    if (!match) throw new Error('Use dice notation like d20, 2d6, or 4d%.');
    const count = match[1] ? Number(match[1]) : 1;
    const sides = match[2] === '%' ? 100 : Number(match[2]);
    if (!Number.isInteger(count) || count < 1 || count > MAX_DICE) throw new Error(`Dice count must be 1–${MAX_DICE}.`);
    if (!Number.isInteger(sides) || sides < 2 || sides > MAX_SIDES) throw new Error(`Dice sides must be 2–${MAX_SIDES}.`);
    return { count, sides };
}

/**
 * Stamps a fresh, stable `id` on every roll (same `createXId()` shape every other
 * module already uses for list entries) — NOT derived from the roll's own array
 * position. An earlier version keyed the history `list()` by
 * `notation-results-total-index`, and since a new roll is prepended (`[result,
 * ...history]`), every EXISTING entry's index — and therefore its key — shifted on
 * every subsequent roll. That defeated list()'s whole point (see MODULES.md): the
 * entire history section was torn down and rebuilt from scratch on every single
 * roll instead of just gaining one new node at the top.
 */
function formatRoll(count, sides, results) {
    const notation = `${count}d${sides}`;
    const total = results.reduce((sum, value) => sum + value, 0);
    return { id: createRollId(), notation, results, total, text: `${notation}: [${results.join(', ')}] = ${total}` };
}

function macroSlug(...parts) {
    return ['dice', ...parts].join('_')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 60);
}

/** One read-only row: a value some other module pushed via track(). No inputs, no remove button — the requesting module owns its lifecycle via the handle track() returned it. Mirrors Tracker's own renderQuickRow exactly (modules/tracker/index.js). */
function renderQuickRow(entry, host) {
    const value = signal(host.data.get(`quick:${entry.id}`, ''));
    const wrap = h('div', { class: 'stme-dice-quick-row' });
    onDispose(wrap, host.data.subscribe(MODULE_ID, `quick:${entry.id}`, next => value.set(next ?? '')));
    wrap.append(
        h('span', { class: 'stme-dice-quick-name' }, entry.name),
        h('code', { class: 'stme-dice-quick-value' }, value),
        h('small', { class: 'stme-dice-quick-owner' }, entry.requesterId),
    );
    return wrap;
}

/** Compact, always read-only — deliberately no editor: these values are pushed programmatically by other modules, not configured here. Mirrors Tracker's own renderQuickSection. */
function renderQuickSection(quickIndex, host) {
    return h('div', { class: 'stme-dice-quick' },
        h('div', { class: 'stme-dice-quick-head' },
            h('strong', {}, 'Quick rolls'),
            h('small', {}, "Pushed by other modules via host.services.request('dice').track() — read-only here. Any module can also PULL a roll on demand via host.services.ask('dice', 'roll', { notation })."),
        ),
        show(computed(() => quickIndex().length === 0), empty => empty ? h('p', { class: 'stme-dice-empty' }, 'No modules are tracking a quick roll yet.') : null),
        h('div', { class: 'stme-dice-quick-list' }, list(quickIndex, entry => entry.id, entry => renderQuickRow(entry, host))),
    );
}

export const diceModule = {
    id: MODULE_ID,
    title: 'Dice',
    description: 'Simple tabletop dice roller with single rolls, dice pools, notation, and history.',
    about: 'Roll common tabletop dice from the module UI or through the Dice function tool. Supports d2, d3, d4, d6, d8, d10, d12, d20, d30, d100 and percentile d%. Other modules can also push a named quick roll into view, or ask Dice to roll for them, via host.services.',
    // Off by default like every other module here except Notebook — this one
    // registers a real function tool the character LLM can call on its own, which
    // is exactly the kind of thing a user should opt into rather than get silently
    // on upgrade.
    defaultEnabled: false,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/dice',
    minEngineVersion: '0.1.0',

    activate(host) {
        host.registerTool({
            name: TOOL_NAME,
            displayName: 'Dice',
            description: 'Roll tabletop dice. Use notation such as d20, 2d6, 4d8, or 1d%.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    dice: { type: 'string', description: 'Dice notation, for example d20, 2d6, or 4d%.' },
                },
                required: ['dice'],
            },
            action: async args => {
                try {
                    const { count, sides } = parseDiceNotation(args?.dice);
                    return formatRoll(count, sides, rollDice(count, sides)).text;
                } catch (error) {
                    return error?.message || String(error);
                }
            },
            formatMessage: args => `Rolling ${String(args?.dice || 'dice')}…`,
            stealth: false,
        });

        // --- Two-way service, mirroring Tracker's own (see MODULES.md's "Worked
        // example: Tracker as a two-way service"): PUSH lets another module record
        // an externally-computed roll into Dice's own "Quick rolls" display (Dice
        // just shows it, the requester owns the value); PULL lets another module ask
        // Dice to actually perform a roll and get the number back — a pure
        // computation with no side effect on Dice's own history, same as Tracker's
        // own `classify` never touches its stored blocks.
        const quickEntries = new Map(); // entryId -> { requesterId, key, name, unreserve }
        const publishQuickIndex = () => {
            host.data.set('quickIndex', [...quickEntries.values()].map(entry => ({ id: `${entry.requesterId}:${entry.key}`, requesterId: entry.requesterId, name: entry.name })));
        };
        host.services.register('dice', {
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
            async handleRequest(type, payload) {
                if (type !== 'roll') throw new Error(`Dice does not support request type "${type}".`);
                try {
                    const { count, sides } = parseDiceNotation(payload?.notation);
                    const result = formatRoll(count, sides, rollDice(count, sides));
                    return { text: result.text, notation: result.notation, results: result.results, total: result.total };
                } catch (error) {
                    return { error: error?.message || String(error) };
                }
            },
        });
        publishQuickIndex();

        return () => host.unregisterTool(TOOL_NAME);
        // No manual quickEntries/host.data cleanup needed — the engine's
        // releaseNamespace('dice') after this runs unreserve()s every channel
        // (and its macro) this module owns, same as Tracker relies on.
    },

    render(container, host) {
        const type = signal('d20');
        const count = signal(1);
        const notation = signal('d20');
        const history = signal([]);
        const lastResult = signal(null);

        const quickIndex = signal(host.data.get('quickIndex', []));
        onDispose(container, host.data.subscribe(MODULE_ID, 'quickIndex', next => quickIndex.set(next ?? [])));

        const record = result => {
            lastResult.set(result);
            history.set([result, ...history.peek()].slice(0, HISTORY_LIMIT));
        };

        const roll = () => {
            try {
                const diceCount = Math.max(1, Math.min(MAX_DICE, Number.parseInt(count.peek(), 10) || 1));
                const sides = DICE_TYPES.find(item => item.id === type.peek())?.sides ?? 20;
                count.set(diceCount);
                record(formatRoll(diceCount, sides, rollDice(diceCount, sides)));
            } catch (error) {
                host.toast('error', error?.message || String(error));
            }
        };

        const notationInput = TextInput(notation, { placeholder: 'e.g. 2d6 or d20' });
        const rollNotation = () => {
            try {
                const parsed = parseDiceNotation(notation.peek());
                record(formatRoll(parsed.count, parsed.sides, rollDice(parsed.count, parsed.sides)));
                count.set(parsed.count);
                const matchingPreset = DICE_TYPES.find(item => item.sides === parsed.sides);
                if (matchingPreset) type.set(matchingPreset.id);
            } catch (error) {
                host.toast('error', error?.message || String(error));
            }
        };

        const preset = Select(type, signal(DICE_TYPES));
        const resultBox = h('div', { class: 'stme-dice-result' }, computed(() => {
            const result = lastResult();
            return result ? result.text : 'No rolls yet.';
        }));
        const historyList = h('div', { class: 'stme-dice-history' },
            list(history, item => item.id, item => h('div', { class: 'stme-dice-roll' }, item.text)));

        container.append(
            h('p', { class: 'stme-dice-help' }, 'Roll a single die, a pool, or enter dice notation.'),
            Field('Die type', preset),
            Field('Number of dice', TextInput(count, { type: 'number', min: 1, max: MAX_DICE })),
            Button('Roll dice', roll),
            h('hr'),
            Field('Dice notation', notationInput),
            Button('Roll notation', rollNotation),
            h('div', { class: 'stme-dice-label' }, h('strong', {}, 'Latest result')),
            resultBox,
            h('div', { class: 'stme-dice-label' }, h('strong', {}, 'History')),
            historyList,
            renderQuickSection(quickIndex, host),
        );
    },

    css: `
        .stme-settings .stme-dice-help { margin: 0 0 10px; line-height: 1.4; opacity: .85; }
        .stme-settings .stme-dice-empty { margin: 0 0 10px; padding: 8px; opacity: .65; font-size: .9em; }
        .stme-settings .stme-dice-label { margin: 12px 0 6px; font-size: .9em; opacity: .85; }
        .stme-settings .stme-dice-result { padding: 8px 10px; border-radius: var(--stme-radius); background: rgba(0, 0, 0, .08); font-weight: 600; overflow-wrap: anywhere; }
        .stme-settings .stme-dice-history { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
        .stme-settings .stme-dice-roll { padding: 5px 8px; border-radius: var(--stme-radius-sm); background: var(--SmartThemeBlurTintColor); border: 1px solid var(--SmartThemeBorderColor); font-size: .88em; overflow-wrap: anywhere; }
        .stme-settings hr { margin: 14px 0; border: none; border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor) 70%, transparent); }

        /* Quick rolls — pushed by other modules, read-only. Same shape as Tracker's own quick section. */
        .stme-settings .stme-dice-quick { margin-top: 14px; padding-top: 12px; border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor) 70%, transparent); }
        .stme-settings .stme-dice-quick-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
        .stme-settings .stme-dice-quick-head small { opacity: .65; }
        .stme-settings .stme-dice-quick-list { display: flex; flex-direction: column; gap: 4px; }
        .stme-settings .stme-dice-quick-row { display: grid; grid-template-columns: minmax(90px, .35fr) 1fr auto; gap: 8px; align-items: center; padding: 4px 8px; border-radius: var(--stme-radius-sm); background: rgba(0, 0, 0, .07); font-size: .9em; }
        .stme-settings .stme-dice-quick-name { opacity: .85; overflow-wrap: anywhere; }
        .stme-settings .stme-dice-quick-value { font-weight: 600; overflow-wrap: anywhere; }
        .stme-settings .stme-dice-quick-owner { opacity: .55; text-align: right; white-space: nowrap; }
    `,
};
