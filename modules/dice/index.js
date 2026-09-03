import { h, computed, signal, Field, TextInput, Select, Button, list } from '../../core/widgets.js';

const TOOL_NAME = 'Dice';
const MAX_DICE = 100;
const MAX_SIDES = 1000;
const HISTORY_LIMIT = 20;

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

function formatRoll(count, sides, results) {
    const notation = `${count}d${sides === 100 ? '100' : sides}`;
    const total = results.reduce((sum, value) => sum + value, 0);
    return { notation, results, total, text: `${notation}: [${results.join(', ')}] = ${total}` };
}

export const diceModule = {
    id: 'dice',
    title: 'Dice',
    description: 'Simple tabletop dice roller with single rolls, dice pools, notation, and history.',
    about: 'Roll common tabletop dice from the module UI or through the Dice function tool. Supports d2, d3, d4, d6, d8, d10, d12, d20, d30, d100 and percentile d%.',
    defaultEnabled: true,
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
        return () => host.unregisterTool(TOOL_NAME);
    },

    render(container, host) {
        const type = signal('20');
        const count = signal(1);
        const notation = signal('d20');
        const history = signal([]);
        const lastResult = signal(null);

        const roll = () => {
            try {
                const diceCount = Math.max(1, Math.min(MAX_DICE, Number.parseInt(count.peek(), 10) || 1));
                const sides = Math.max(2, Math.min(MAX_SIDES, Number.parseInt(type.peek(), 10) || 20));
                count.set(diceCount);
                type.set(String(sides));
                const result = formatRoll(diceCount, sides, rollDice(diceCount, sides));
                lastResult.set(result);
                history.set([result, ...history.peek()].slice(0, HISTORY_LIMIT));
            } catch (error) {
                host.toast('error', error?.message || String(error));
            }
        };

        const notationInput = TextInput(notation, { placeholder: 'e.g. 2d6 or d20' });
        const rollNotation = () => {
            try {
                const parsed = parseDiceNotation(notation.peek());
                const result = formatRoll(parsed.count, parsed.sides, rollDice(parsed.count, parsed.sides));
                lastResult.set(result);
                history.set([result, ...history.peek()].slice(0, HISTORY_LIMIT));
                count.set(parsed.count);
                type.set(String(parsed.sides));
            } catch (error) {
                host.toast('error', error?.message || String(error));
            }
        };

        const preset = Select(type, signal(DICE_TYPES), { value: item => String(item.sides), label: item => item.name });
        const resultBox = h('div', { class: 'stme-dice-result' }, computed(() => {
            const result = lastResult();
            return result ? `${result.text}` : 'No rolls yet.';
        }));
        const historyList = h('div', { class: 'stme-dice-history' }, list(history, item => `${item.notation}-${item.results.join('.')}-${item.total}-${history.peek().indexOf(item)}`, item =>
            h('div', { class: 'stme-dice-roll' }, item.text)));

        container.append(
            h('p', {}, 'Roll a single die, a pool, or enter dice notation.'),
            Field('Die type', preset),
            Field('Number of dice', TextInput(count, { type: 'number', min: 1, max: MAX_DICE })),
            Button('Roll dice', roll),
            h('hr'),
            Field('Dice notation', notationInput),
            Button('Roll notation', rollNotation),
            h('div', { class: 'stme-dice-last-label' }, h('strong', {}, 'Latest result')),
            resultBox,
            h('div', { class: 'stme-dice-history-label' }, h('strong', {}, 'History')),
            historyList,
        );
    },
};
