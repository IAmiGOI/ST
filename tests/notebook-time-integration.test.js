import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';
import { notebookModule } from '../modules/notebook/index.js';
import { timeModule } from '../modules/time/index.js';

/**
 * End-to-end coverage for the RP Time <-> Notebook integration, going through the
 * REAL ModuleEngine and REAL host.services registry — not a hand-built fake host —
 * to prove the "services only, never chatMetadata directly" wiring actually works
 * when both modules are live at once (this is what module-engine-compat.test.js's
 * own services suite already covers for the mechanism in general; this file is
 * specific to Notebook writing a note through the LLM function tool).
 */
function makeEngine() {
    let capturedTool = null;
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
        setExtensionPrompt() {},
        registerFunctionTool: definition => { capturedTool = definition; },
        unregisterFunctionTool() {},
    };
    const engine = new ModuleEngine(() => context);
    return { engine, context, getTool: () => capturedTool };
}

test('a note written while RP Time is enabled gets stamped, through host.services — not by Notebook reading chatMetadata itself', async () => {
    const { engine, context, getTool } = makeEngine();
    engine.register(timeModule);
    engine.register(notebookModule);
    await engine.enable('time');
    await engine.enable('notebook');

    // This is RP Time's OWN chatMetadata key (context.chatMetadata.stme_rp_time_current) —
    // Notebook never reads it; it only ever goes through host.services.request('time').
    context.chatMetadata.stme_rp_time_current = 'Day 2, 14:00 (Afternoon)';

    const tool = getTool();
    const result = await tool.action({ action: 'write', title: 'Plan', content: 'Visit the observatory.' });
    assert.match(result, /^Saved note "Plan"/);

    const notes = context.chatMetadata.stme_notebook_notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].timestamp, 'Day 2, 14:00 (Afternoon)');
    assert.equal(notes[0].content, 'Visit the observatory.');
});

test('a note written while RP Time is disabled gets no timestamp at all', async () => {
    const { engine, context, getTool } = makeEngine();
    engine.register(timeModule);
    engine.register(notebookModule);
    await engine.enable('notebook'); // Time deliberately never enabled

    context.chatMetadata.stme_rp_time_current = 'Day 2, 14:00 (Afternoon)'; // present but must be ignored — Time isn't active

    const tool = getTool();
    await tool.action({ action: 'write', title: 'Plan', content: 'Visit the observatory.' });

    const notes = context.chatMetadata.stme_notebook_notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].timestamp, null, 'host.services.isAvailable("time") must be false while Time is disabled, regardless of stale chatMetadata');
});

test('a model-written duplicate leading time-line is stripped, and the real timestamp is stored separately', async () => {
    const { engine, context, getTool } = makeEngine();
    engine.register(timeModule);
    engine.register(notebookModule);
    await engine.enable('time');
    await engine.enable('notebook');
    context.chatMetadata.stme_rp_time_current = 'Day 2, 14:00 (Afternoon)';

    const tool = getTool();
    await tool.action({ action: 'write', title: 'Plan', content: 'Day 2, 14:00 (Afternoon)\nVisit the observatory.' });

    const notes = context.chatMetadata.stme_notebook_notes;
    assert.equal(notes[0].timestamp, 'Day 2, 14:00 (Afternoon)');
    assert.equal(notes[0].content, 'Visit the observatory.');
});

test('disabling RP Time mid-session (service released) makes isAvailable false for any note written afterward', async () => {
    const { engine, context, getTool } = makeEngine();
    engine.register(timeModule);
    engine.register(notebookModule);
    await engine.enable('time');
    await engine.enable('notebook');
    context.chatMetadata.stme_rp_time_current = 'Day 2, 14:00 (Afternoon)';

    const tool = getTool();
    await tool.action({ action: 'write', title: 'Before', content: 'stamped one' });
    await engine.disable('time'); // releases the 'time' service registration automatically
    await tool.action({ action: 'write', title: 'After', content: 'unstamped one' });

    const notes = context.chatMetadata.stme_notebook_notes;
    assert.equal(notes.find(note => note.title === 'Before').timestamp, 'Day 2, 14:00 (Afternoon)');
    assert.equal(notes.find(note => note.title === 'After').timestamp, null);
});
