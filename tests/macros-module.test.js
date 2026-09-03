import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';
import { macrosModule, sanitizeMacroName } from '../modules/macros/index.js';
import { trackerModule } from '../modules/tracker/index.js';

/**
 * End-to-end coverage through the REAL ModuleEngine + ModuleDataBus — proves the
 * `compute` extension to reserve() (core/data-bus.js) actually wires a macro program
 * up to ST's own macro-resolution API, not just that the language interpreter works
 * in isolation (see tests/macros-language.test.js for that).
 *
 * `context.registerMacro`/`unregisterMacro` is the "legacy" ST macro API (see
 * core/data-bus.js's #registerMacro) — captured here into a plain Map so tests can
 * call the registered handler exactly like ST's own macro resolver would.
 */
function makeEngine() {
    const registeredMacros = new Map();
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
        registerMacro: (name, handler) => registeredMacros.set(name, handler),
        unregisterMacro: name => registeredMacros.delete(name),
    };
    const engine = new ModuleEngine(() => context);
    return { engine, context, registeredMacros };
}

function addProgram(engine, overrides = {}) {
    const settings = engine.moduleSettings('macros', {});
    settings.programs ??= [];
    const program = {
        id: `macro_${settings.programs.length}_${Math.random().toString(36).slice(2, 6)}`,
        name: 'Test macro', macroName: 'test_macro', kind: 'text', source: '', enabled: true, collapsed: false,
        ...overrides,
    };
    settings.programs.push(program);
    return program;
}

test('a plain-text macro registers and resolves to exactly its fixed source', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(macrosModule);
    addProgram(engine, { macroName: 'greeting', kind: 'text', source: 'The old oak door' });
    await engine.enable('macros');

    assert.equal(registeredMacros.get('greeting')(), 'The old oak door');
});

test('a code macro computes fresh on every resolution, reading another module\'s bus value', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(trackerModule);
    engine.register(macrosModule);
    const settings = engine.moduleSettings('tracker', {});
    settings.blocks = [{
        id: 'b1', title: 'Vitals', collapsed: false, enabled: true,
        fields: [{ name: 'health', instruction: '' }, { name: 'shield', instruction: '' }],
        sidecarProfile: 'default', systemPromptTemplate: 'x', promptTemplate: 'y', displayTemplate: '',
    }];
    addProgram(engine, {
        macroName: 'total_hp', kind: 'code',
        source: 'set h to get "tracker:field:b1:health"\nset s to get "tracker:field:b1:shield"\nreturn h + s',
    });
    await engine.enable('tracker');
    await engine.enable('macros');

    engine.bus.set('tracker', 'field:b1:health', '30');
    engine.bus.set('tracker', 'field:b1:shield', '20');
    assert.equal(registeredMacros.get('total_hp')(), '50');

    // Fresh on every call — not a snapshot from registration time.
    engine.bus.set('tracker', 'field:b1:health', '40');
    assert.equal(registeredMacros.get('total_hp')(), '60');
});

test('a code macro with a bug resolves to a visible placeholder, and does not affect a healthy macro registered alongside it', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(macrosModule);
    addProgram(engine, { name: 'Broken', macroName: 'broken', kind: 'code', source: 'return 1 / 0' });
    addProgram(engine, { name: 'Healthy', macroName: 'healthy', kind: 'code', source: 'return "fine"' });
    await engine.enable('macros');

    assert.match(registeredMacros.get('broken')(), /^\[macro error: Broken\]$/);
    assert.equal(registeredMacros.get('healthy')(), 'fine');
});

test('a macro that saves a value can read it back on a later resolution — own state, not shared with other programs', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(macrosModule);
    addProgram(engine, {
        macroName: 'counter', kind: 'code',
        source: 'set n to get "count"\nif n is "" then\nset n to 0\nend\nset n to n + 1\nsave n as "count"\nreturn n',
    });
    await engine.enable('macros');

    assert.equal(registeredMacros.get('counter')(), '1');
    assert.equal(registeredMacros.get('counter')(), '2');
    assert.equal(registeredMacros.get('counter')(), '3');
});

test('two programs with the same macro name: the first keeps it, the second is refused (existing bus collision rule)', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(macrosModule);
    addProgram(engine, { name: 'First', macroName: 'dup', kind: 'text', source: 'first' });
    addProgram(engine, { name: 'Second', macroName: 'dup', kind: 'text', source: 'second' });
    await engine.enable('macros');

    assert.equal(registeredMacros.size, 1);
    assert.equal(registeredMacros.get('dup')(), 'first');
});

test('disabling the module releases every macro it registered', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(macrosModule);
    addProgram(engine, { macroName: 'one', kind: 'text', source: 'a' });
    addProgram(engine, { macroName: 'two', kind: 'text', source: 'b' });
    await engine.enable('macros');
    assert.equal(registeredMacros.size, 2);

    await engine.disable('macros');
    assert.equal(registeredMacros.size, 0);
});

test('removing a program from settings and re-syncing retires just that one macro', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(macrosModule);
    const keep = addProgram(engine, { macroName: 'keep', kind: 'text', source: 'a' });
    addProgram(engine, { macroName: 'drop', kind: 'text', source: 'b' });
    await engine.enable('macros');
    assert.equal(registeredMacros.size, 2);

    const settings = engine.moduleSettings('macros', {});
    settings.programs = settings.programs.filter(program => program.id === keep.id);
    engine.bus.get('macros', 'sync')();

    assert.equal(registeredMacros.size, 1);
    assert.equal(registeredMacros.get('keep')(), 'a');
});

test('a disabled program (enabled: false) is not registered, and re-enabling it registers it', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(macrosModule);
    const program = addProgram(engine, { macroName: 'toggle', kind: 'text', source: 'x', enabled: false });
    await engine.enable('macros');
    assert.equal(registeredMacros.size, 0);

    program.enabled = true;
    engine.bus.get('macros', 'sync')();
    assert.equal(registeredMacros.get('toggle')(), 'x');
});

test('sanitizeMacroName strips whitespace/invalid characters the same way Tracker normalizes field names', () => {
    assert.equal(sanitizeMacroName('  my macro!! '), 'my_macro');
    assert.equal(sanitizeMacroName(''), '');
});
