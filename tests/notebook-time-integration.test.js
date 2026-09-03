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
 *
 * RP Time's own "current time" is derived by scanning `context.chat` for the latest
 * labeled character message (see modules/time/index.js's getCurrentTime() — there is
 * no more separate chatMetadata scalar to set directly), so these tests populate a
 * labeled message in `context.chat` instead of writing a chatMetadata key by hand.
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

/** The one real way RP Time's "current time" becomes non-default — a labeled character message already in the chat. */
function seedCurrentTime(context, label) {
    context.chat.push({ is_user: false, is_system: false, mes: 'Earlier reply.', extra: { stme_rp_time: label } });
}

test('a note written while RP Time is enabled gets stamped, through host.services — not by Notebook reading chatMetadata itself', async () => {
    const { engine, context, getTool } = makeEngine();
    engine.register(timeModule);
    engine.register(notebookModule);
    await engine.enable('time');
    await engine.enable('notebook');

    // RP Time's own source of truth is the chat itself — Notebook never reads this
    // directly; it only ever goes through host.services.request('time').
    seedCurrentTime(context, 'Day 2, 14:00 (Afternoon)');

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

    seedCurrentTime(context, 'Day 2, 14:00 (Afternoon)'); // present in chat but must be ignored — Time isn't active

    const tool = getTool();
    await tool.action({ action: 'write', title: 'Plan', content: 'Visit the observatory.' });

    const notes = context.chatMetadata.stme_notebook_notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].timestamp, null, 'host.services.isAvailable("time") must be false while Time is disabled, regardless of a labeled message already in chat');
});

test('a model-written duplicate leading time-line is stripped, and the real timestamp is stored separately', async () => {
    const { engine, context, getTool } = makeEngine();
    engine.register(timeModule);
    engine.register(notebookModule);
    await engine.enable('time');
    await engine.enable('notebook');
    seedCurrentTime(context, 'Day 2, 14:00 (Afternoon)');

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
    seedCurrentTime(context, 'Day 2, 14:00 (Afternoon)');

    const tool = getTool();
    await tool.action({ action: 'write', title: 'Before', content: 'stamped one' });
    await engine.disable('time'); // releases the 'time' service registration automatically
    await tool.action({ action: 'write', title: 'After', content: 'unstamped one' });

    const notes = context.chatMetadata.stme_notebook_notes;
    assert.equal(notes.find(note => note.title === 'Before').timestamp, 'Day 2, 14:00 (Afternoon)');
    assert.equal(notes.find(note => note.title === 'After').timestamp, null);
});
