import { execute, DEFAULT_TIME_LIMIT_MS } from './language.js';
import {
    h, show, signal, computed, onDispose,
    Field, TextInput, TextArea, Toggle, Select, Button, DraggableList,
} from '../../core/widgets.js';

const MODULE_ID = 'macros';
const MAX_NAME_LENGTH = 60;
const MAX_MACRO_NAME_LENGTH = 60;
const MODULE_DEFAULTS = Object.freeze({ programs: [] });

/** JS-identifier-safe macro name — same spirit as Tracker's field-name sanitizing (no whitespace, bounded length). */
export function sanitizeMacroName(value) {
    return String(value ?? '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, MAX_MACRO_NAME_LENGTH);
}

function createProgram() {
    return {
        id: `macro_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: 'New macro', macroName: '', kind: 'text', source: '', enabled: true, collapsed: false,
    };
}

/**
 * Runs one program and returns the string {{macro}} should resolve to — NEVER
 * throws, no matter what the program does (parse error, runtime error, or the
 * language's own fixed time limit). Callable from both activate() (the real
 * `compute` wired into the bus) and render()'s "Test run" button — a plain function
 * of (host, program), not a closure captured by either, so both call sites share
 * the exact same behavior.
 *
 * `get`/`save` bindings: a BAREWORD key (no colon) addresses this PROGRAM'S OWN
 * saved state (`host.data` under this module's namespace, keyed by the program's
 * own id — so two different macro programs can each `save x as "count"` without
 * colliding). A key WITH a colon (`"tracker:field:vitals:health"`) is a
 * fully-qualified cross-module bus read — `get` only, read-only, via
 * `host.data.read()`; `save` always writes to this module's own namespace only
 * (that's what `host.data.set()` already does for every module, by construction —
 * no extra guardrail code needed here to keep a macro from writing into another
 * module's state).
 */
export function runProgram(host, program) {
    const get = raw => {
        const key = String(raw ?? '');
        const colon = key.indexOf(':');
        if (colon < 0) return host.data.get(`${program.id}:${key}`);
        return host.data.read(key.slice(0, colon), key.slice(colon + 1));
    };
    const save = (key, value) => host.data.set(`${program.id}:${key}`, value);

    const result = execute(program.source, { get, save, timeLimitMs: DEFAULT_TIME_LIMIT_MS });
    if (result.ok) {
        host.data.set(`status:${program.id}`, { ok: true, value: result.value, at: Date.now() });
        return result.value;
    }
    console.error(`[STME:macros] "${program.name}" ({{${program.macroName}}}) failed:`, result.error);
    host.data.set(`status:${program.id}`, { ok: false, error: result.error.message, at: Date.now() });
    return `[macro error: ${program.name || program.macroName || program.id}]`;
}

export const macrosModule = {
    id: MODULE_ID,
    title: 'Macros',
    description: 'Define {{macro}} values by hand — a fixed string, or a small computed program.',
    about: 'Lets you create your own {{macro}} — either a fixed bit of text, or a tiny program that does simple math on other modules\' tracked values (like health + shield) and saves/reads its own numbers. Runs in a safe, purpose-built mini-language, not real code — it cannot reach outside this engine.',
    defaultEnabled: false,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/macros',
    minEngineVersion: '0.1.0',

    activate(host) {
        const log = (...args) => console.info('[STME:macros]', ...args);
        // Tracks which program ids currently own a reserved bus channel, so the next
        // sync can tell "removed/disabled since last time" from "still current" and
        // unreserve() the ones that are gone — same reconciliation pattern Tracker's
        // own publish() already established (see MODULES.md's "Pattern: reconciling
        // a dynamic set of channels").
        let registeredIds = new Set();

        const sync = () => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            const currentIds = new Set(settings.programs.map(program => program.id));
            for (const id of [...registeredIds]) {
                if (currentIds.has(id)) continue;
                host.data.unreserve(id);
                registeredIds.delete(id);
                log(`Program ${id} no longer exists — retired its macro.`);
            }
            for (const program of settings.programs) {
                const macroName = sanitizeMacroName(program.macroName);
                if (!program.enabled || !macroName) {
                    if (registeredIds.has(program.id)) { host.data.unreserve(program.id); registeredIds.delete(program.id); }
                    continue;
                }
                host.data.reserve(program.id, {
                    name: program.name || macroName,
                    schema: { type: 'string' },
                    macro: macroName,
                    compute: program.kind === 'code' ? () => runProgram(host, program) : undefined,
                });
                if (program.kind === 'text') host.data.set(program.id, String(program.source ?? ''));
                registeredIds.add(program.id);
            }
            log(`sync(): ${settings.programs.length} program(s) — ${registeredIds.size} active macro(s).`);
        };
        host.data.set('sync', sync);
        sync();

        const chatChangedUnsub = host.onChatChanged(() => sync());
        log('activate() complete.');

        return () => {
            chatChangedUnsub();
            // No manual host.data.unreserve() loop needed — the engine calls
            // releaseNamespace('macros') right after this cleanup runs, which drops
            // every channel/macro this module owns regardless of what's in
            // registeredIds.
        };
    },

    render(container, host) {
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        const programs = signal(settings.programs);
        const blockUiCache = new Map();

        const persistPrograms = next => {
            programs.set(next);
            settings.programs = next;
            host.saveModuleSettings();
            host.data.get('sync')?.();
        };

        function getUi(program) {
            if (!blockUiCache.has(program.id)) {
                blockUiCache.set(program.id, {
                    name: signal(program.name),
                    macroName: signal(program.macroName),
                    kind: signal(program.kind),
                    source: signal(program.source),
                    enabled: signal(program.enabled !== false),
                });
            }
            return blockUiCache.get(program.id);
        }

        function renderHeader(program, ui) {
            return [
                h('div', { class: 'stme-macro-title' }, h('strong', {}, ui.name), h('small', {}, computed(() => `{{${sanitizeMacroName(ui.macroName()) || '…'}}} · ${ui.kind() === 'code' ? 'code' : 'text'}`))),
                Toggle('Enabled', ui.enabled, {
                    onChange: checked => {
                        program.enabled = checked;
                        ui.enabled.set(checked);
                        host.saveModuleSettings();
                        host.data.get('sync')?.();
                    },
                }),
                Button('Remove', event => {
                    event.preventDefault(); event.stopPropagation();
                    persistPrograms(programs.peek().filter(item => item.id !== program.id));
                }, { variant: 'danger' }),
            ];
        }

        function renderContent(program, ui) {
            const status = signal(host.data.get(`status:${program.id}`, null));
            const wrap = h('div', { class: 'stme-macro-block' });
            const unsubStatus = host.data.subscribe(MODULE_ID, `status:${program.id}`, next => status.set(next ?? null));
            onDispose(wrap, unsubStatus);

            const testResult = signal(null);
            const kindSelect = Select(ui.kind, signal([{ id: 'text', name: 'Plain text' }, { id: 'code', name: 'Code' }]));

            const save = () => {
                program.name = ui.name.peek().trim().slice(0, MAX_NAME_LENGTH) || 'New macro';
                program.macroName = sanitizeMacroName(ui.macroName.peek());
                program.kind = ui.kind.peek() === 'code' ? 'code' : 'text';
                program.source = String(ui.source.peek() ?? '');
                ui.name.set(program.name); ui.macroName.set(program.macroName); ui.kind.set(program.kind); ui.source.set(program.source);
                host.saveModuleSettings();
                host.data.get('sync')?.();
                host.toast('success', `"${program.name}" saved.`, 'Macros');
            };

            wrap.append(
                Field('Macro name', TextInput(ui.macroName, { placeholder: 'my_macro' }), { hint: 'Used as {{this}} — letters, digits, underscore.' }),
                Field('Name', TextInput(ui.name, { maxlength: MAX_NAME_LENGTH, placeholder: 'What is this for?' })),
                Field('Kind', kindSelect),
                show(computed(() => ui.kind()), kind => kind === 'code'
                    ? h('div', { class: 'stme-macro-code' },
                        TextArea(ui.source, { rows: 8, placeholder: 'set x to get "tracker:field:vitals:health"\nreturn x' }),
                        h('small', {}, `Time limit: ${DEFAULT_TIME_LIMIT_MS}ms per run. A macro that fails or times out shows a visible "[macro error: name]" placeholder instead of silently disappearing.`),
                        h('div', { class: 'stme-macro-actions' },
                            Button('Save macro', save),
                            // Runs the LIVE editor content, not the last-saved program —
                            // the whole point of Test run is iterating before saving.
                            Button('Test run', () => {
                                const draft = { ...program, name: ui.name.peek() || program.name, macroName: sanitizeMacroName(ui.macroName.peek()) || program.macroName, kind: ui.kind.peek(), source: ui.source.peek() };
                                testResult.set(runProgram(host, draft));
                            }),
                        ),
                        show(testResult, value => value === null ? null : h('div', { class: 'stme-macro-test-result' }, h('strong', {}, 'Result: '), String(value))),
                    )
                    : h('div', { class: 'stme-macro-code' },
                        TextArea(ui.source, { rows: 3, placeholder: 'Fixed text this macro always resolves to.' }),
                        h('div', { class: 'stme-macro-actions' }, Button('Save macro', save)),
                    )),
                show(status, value => {
                    if (!value) return null;
                    return h('div', { class: value.ok ? 'stme-macro-status stme-macro-status-ok' : 'stme-macro-status stme-macro-status-error' },
                        value.ok ? `Last result: ${value.value || '(empty)'}` : `Last error: ${value.error}`);
                }),
            );
            return wrap;
        }

        const draggableList = DraggableList(programs, program => program.id, {
            isOpen: program => !program.collapsed,
            onToggleOpen: (program, open) => { program.collapsed = !open; host.saveModuleSettings(); },
            onReorder: next => { programs.set(next); settings.programs = next; host.saveModuleSettings(); },
            renderHeader: program => renderHeader(program, getUi(program)),
            renderContent: program => renderContent(program, getUi(program)),
            className: 'stme-macro',
        });

        const guide = h('details', { class: 'stme-sampler stme-macro-guide' },
            h('summary', {}, 'How to write a macro ', h('small', {}, 'Syntax reference and examples')),
            h('div', { class: 'stme-macro-guide-body' },
                h('p', {}, 'A macro is either ', h('strong', {}, 'plain text'), ' (always resolves to the exact text you type — no code needed at all) or a small ', h('strong', {}, 'code'), ' program in a tiny, purpose-built language — not real JavaScript, and it cannot reach outside this engine.'),
                h('table', { class: 'stme-macro-guide-table' },
                    h('tbody', {},
                        h('tr', {}, h('td', {}, h('code', {}, 'set x to 5')), h('td', {}, 'stores a value in a variable')),
                        h('tr', {}, h('td', {}, h('code', {}, 'if x > 5 then … else … end')), h('td', {}, 'branches on a condition')),
                        h('tr', {}, h('td', {}, h('code', {}, 'repeat 5 times … end')), h('td', {}, 'runs the block a fixed number of times')),
                        h('tr', {}, h('td', {}, h('code', {}, 'while x < 5 … end')), h('td', {}, 'runs while a condition holds')),
                        h('tr', {}, h('td', {}, h('code', {}, 'get "tracker:field:vitals:health"')), h('td', {}, "reads another module's bus value")),
                        h('tr', {}, h('td', {}, h('code', {}, 'save x as "count"')), h('td', {}, "remembers a value for this macro's next run")),
                        h('tr', {}, h('td', {}, h('code', {}, 'return x')), h('td', {}, 'the text this {{macro}} resolves to')),
                    ),
                ),
                h('p', {}, h('strong', {}, 'Example (plain text): '), h('code', {}, '"The old oak door"'), ' — that\'s the whole program.'),
                h('p', {}, h('strong', {}, 'Example (code): ')),
                h('pre', {}, 'set health to get "tracker:field:vitals:health"\nset shield to get "tracker:field:vitals:shield"\nreturn health + shield'),
                h('p', {}, `Every macro run gets a fixed ${DEFAULT_TIME_LIMIT_MS}ms — plenty for simple math, not enough to hang the page. A macro that fails shows a visible placeholder like `, h('code', {}, '[macro error: name]'), ' instead of silently vanishing.'),
            ),
        );

        container.append(
            h('p', { class: 'stme-macro-help' }, 'Each macro below becomes its own ', h('code', {}, '{{name}}'), ' usable anywhere ST resolves macros — prompts, World Info, character cards.'),
            guide,
            show(computed(() => programs().length === 0), empty => empty ? h('p', { class: 'stme-macro-empty' }, 'No macros yet. Add one below.') : null),
            draggableList,
            Button('+ Add macro', () => persistPrograms([...programs.peek(), createProgram()])),
        );
    },
};
