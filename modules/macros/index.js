import { execute, tokenize, parse, collectGetKeys, DEFAULT_TIME_LIMIT_MS } from './language.js';
import {
    h, list, show, signal, computed, onDispose,
    Field, TextInput, TextArea, Toggle, Select, Button, Chip, DraggableList,
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

/**
 * Static dependency edges this module can honestly derive from its OWN config
 * — see core/dependency-scanner.js. Parses every enabled `code` program (never
 * runs it) and collects every `get "namespace:key"` it contains; a bareword
 * key (no colon) is this program's own saved state, not a cross-module read,
 * same split `runProgram()`'s own `get` binding makes. A program with a syntax
 * error simply contributes no edges here — its own status channel already
 * surfaces that error; this isn't the place to report it again.
 */
export function scanDependencies(programs) {
    const edges = [];
    for (const program of programs) {
        if (program.kind !== 'code' || program.enabled === false) continue;
        let ast;
        try { ast = parse(tokenize(program.source)); }
        catch { continue; }
        for (const key of collectGetKeys(ast)) {
            const colon = key.indexOf(':');
            if (colon < 0) continue;
            edges.push({ owner: key.slice(0, colon), kind: 'macro-get', detail: key });
        }
    }
    return edges;
}

/**
 * Inserts `text` at the caret in `textarea` and keeps `sourceSignal` (the bound
 * signal driving it) in sync — same cursor-preserving insert Tracker's own display-
 * template tokens and RP Time's display tokens already use, generalized here for a
 * <textarea> instead of a one-line <input>. Kept local rather than shared/imported —
 * this codebase's own convention (see Music's sanitizeVocabulary comment): modules
 * don't import from one another.
 */
export function insertAtCursor(textarea, sourceSignal, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const next = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    textarea.value = next;
    sourceSignal.set(next);
    textarea.focus();
    const caret = start + text.length;
    textarea.setSelectionRange(caret, caret);
}

/**
 * A real block's id is an opaque, auto-generated string (`tracker_<timestamp>_<rand>`
 * — see modules/tracker/index.js's createBlock()), never its human title — so a
 * hand-typed `get "tracker:field:vitals:health"` only works by coincidence, never for
 * a block someone actually created through the UI. This reads Tracker's own published
 * index (`host.data.read('tracker', 'blocks', ...)` — the same `{ id, title, enabled,
 * fields }` shape its floating panel and other consumers already use) and lists every
 * real field as a clickable chip that inserts the exact, correct key — nobody ever
 * needs to type or guess a block id by hand.
 *
 * RP Time gets its own row here too — it publishes exactly one value (`time:current`,
 * see modules/time/index.js), not a dynamic list, so `timeAvailable` (checked once at
 * render() time via host.services.isAvailable('time') — same one-off freshness Music's
 * own "requires Tracker" hint already uses, not live-reactive) is enough to decide
 * whether to show it at all; no bus subscription needed for a key that's always spelled
 * the same way.
 *
 * `lorebookEntries` is the Lorebook service's own `publishedEntries` index (see
 * core/lorebook-service.js's `#refreshPublishedIndex()`) — every entry a user has
 * toggled "Publish" on from that service's own settings card, each one a real
 * `get "lorebook:entry:<book>:<uid>"` key, same "real address, never a hand-typed
 * guess" reasoning the tracker fields above already follow. Unpublished entries
 * (the vast majority of any real lorebook) never show up here — publishing is the
 * explicit, per-entry opt-in that makes an entry's content readable at all.
 */
function renderInsertPicker(sourceArea, ui, trackerBlocks, timeAvailable, lorebookEntries) {
    return h('details', { class: 'stme-macro-tracker-picker' },
        h('summary', {}, 'Insert a value ', h('small', {}, "Real keys for your other modules — click one to insert it at the cursor.")),
        h('div', { class: 'stme-macro-tracker-picker-body' },
            timeAvailable ? h('div', { class: 'stme-macro-tracker-block' },
                h('strong', {}, 'RP Time'),
                h('div', { class: 'stme-macro-tracker-fields' },
                    Chip('current time', {
                        title: 'get "time:current"',
                        onClick: () => insertAtCursor(sourceArea, ui.source, 'get "time:current"'),
                    }),
                ),
            ) : null,
            show(computed(() => trackerBlocks().length === 0 && !timeAvailable && lorebookEntries().length === 0), empty => empty
                ? h('p', { class: 'stme-macro-empty' }, 'No trackers configured yet — add one in the Tracker module first.')
                : null),
            list(trackerBlocks, block => block.id, block => h('div', { class: 'stme-macro-tracker-block' },
                h('strong', {}, block.title),
                h('div', { class: 'stme-macro-tracker-fields' },
                    (block.fields ?? []).length
                        ? (block.fields ?? []).map(field => Chip(field, {
                            title: `get "tracker:field:${block.id}:${field}"`,
                            onClick: () => insertAtCursor(sourceArea, ui.source, `get "tracker:field:${block.id}:${field}"`),
                        }))
                        : h('small', { class: 'stme-macro-empty' }, 'No fields on this tracker yet.'),
                ),
            )),
            show(computed(() => lorebookEntries().length > 0), any => any ? h('div', { class: 'stme-macro-tracker-block' },
                h('strong', {}, 'Lorebook'),
                h('div', { class: 'stme-macro-tracker-fields' },
                    list(lorebookEntries, entry => `${entry.book}:${entry.uid}`, entry => Chip(entry.name, {
                        title: `get "lorebook:entry:${entry.book}:${entry.uid}"`,
                        onClick: () => insertAtCursor(sourceArea, ui.source, `get "lorebook:entry:${entry.book}:${entry.uid}"`),
                    })),
                ),
            ) : null),
        ),
    );
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
            host.data.set('dependencies', scanDependencies(settings.programs));
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

        // Feeds renderInsertPicker() below — read-only, another module's namespace
        // (see MODULES.md's host.data.read/subscribe). Empty (never undefined) while
        // Tracker is disabled or has no blocks yet; the picker shows its own "add one
        // first" message for that case rather than erroring.
        const trackerBlocks = signal(host.data.read('tracker', 'blocks', []));
        onDispose(container, host.data.subscribe('tracker', 'blocks', next => trackerBlocks.set(next ?? [])));
        const timeAvailable = host.services.isAvailable('time');
        // Same read-only cross-module wiring, for the Lorebook service's own
        // publishedEntries index (core/lorebook-service.js) — independent of
        // ModuleEngine (not a module to check isAvailable() against), so this reads
        // straight off the shared bus namespace like the tracker index above.
        const lorebookEntries = signal(host.data.read('lorebook', 'publishedEntries', []));
        onDispose(container, host.data.subscribe('lorebook', 'publishedEntries', next => lorebookEntries.set(next ?? [])));

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

        function renderContent(program, ui, trackerBlocks, timeAvailable, lorebookEntries) {
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
                show(computed(() => ui.kind()), kind => {
                    if (kind !== 'code') {
                        return h('div', { class: 'stme-macro-code' },
                            TextArea(ui.source, { rows: 3, placeholder: 'Fixed text this macro always resolves to.' }),
                            h('div', { class: 'stme-macro-actions' }, Button('Save macro', save)),
                        );
                    }
                    // Built here (not hoisted above show()'s callback) so a real DOM
                    // element exists for the tracker picker to insert into, and so it's
                    // rebuilt cleanly if `kind` ever flips back and forth — see show()'s
                    // own doc comment on why reusing a node across hide/show is unsafe.
                    const sourceArea = TextArea(ui.source, { rows: 8, placeholder: 'set x to get "tracker:field:<id>:health"\nreturn x' });
                    return h('div', { class: 'stme-macro-code' },
                        sourceArea,
                        renderInsertPicker(sourceArea, ui, trackerBlocks, timeAvailable, lorebookEntries),
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
                    );
                }),
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
            renderContent: program => renderContent(program, getUi(program), trackerBlocks, timeAvailable, lorebookEntries),
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
                        h('tr', {}, h('td', {}, h('code', {}, 'get "tracker:field:<id>:<field>"')), h('td', {}, "reads another module's bus value — a tracker's real <id> is a random string, not its title, so use the picker under the code editor to insert a working one instead of typing it by hand")),
                        h('tr', {}, h('td', {}, h('code', {}, 'save x as "count"')), h('td', {}, "remembers a value for this macro's next run")),
                        h('tr', {}, h('td', {}, h('code', {}, 'return x')), h('td', {}, 'the text this {{macro}} resolves to')),
                    ),
                ),
                h('p', {}, h('strong', {}, 'Example (plain text): '), h('code', {}, '"The old oak door"'), ' — that\'s the whole program.'),
                h('p', {}, h('strong', {}, 'Example (code): ')),
                h('pre', {}, 'set health to get "tracker:field:<id>:health"\nset shield to get "tracker:field:<id>:shield"\nreturn health + shield'),
                h('p', {}, `Every macro run gets a fixed ${DEFAULT_TIME_LIMIT_MS}ms — plenty for simple math, not enough to hang the page. A macro that fails shows a visible placeholder like `, h('code', {}, '[macro error: name]'), ' instead of silently vanishing.'),
                h('p', {}, `A tracker's real <id> is generated automatically and looks nothing like its title — never type one by hand. Switch a macro to `, h('strong', {}, 'Code'), ' and open ', h('strong', {}, '"Insert a value"'), ' under the editor to click a real field (or RP Time\'s current time, if that module is enabled) in instead.'),
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
