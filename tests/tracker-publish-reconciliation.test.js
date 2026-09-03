import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';
import { trackerModule } from '../modules/tracker/index.js';
import { createTrackerStore } from '../modules/tracker/store.js';

/**
 * Covers the bus-reconciliation bug: a field or block removed from Tracker's config used to
 * leave its bus channel (and {{macro}}) reserved forever, still resolving to its last known
 * value with nothing to show it's gone. publish() now unreserve()s anything no longer current,
 * and publishes an explicit disabled notice instead of stale data for a disabled block.
 */
function makeEngine() {
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    const engine = new ModuleEngine(() => context);
    // Same context function the engine's own store instance reads — writing through this
    // reaches the exact chatMetadata the module's internal store.get() will read back.
    return { engine, store: createTrackerStore(() => context) };
}

test('publish() unreserves a field removed from a block, leaving other fields untouched', async () => {
    const { engine } = makeEngine();
    engine.register(trackerModule);
    const settings = engine.moduleSettings('tracker', {});
    settings.blocks = [{
        id: 'b1', title: 'Vitals', collapsed: false, enabled: true,
        fields: [{ name: 'health', instruction: '' }, { name: 'gold', instruction: '' }],
        sidecarProfile: 'default', systemPromptTemplate: 'x', promptTemplate: 'y', displayTemplate: '',
    }];
    await engine.enable('tracker');

    assert.notEqual(engine.bus.describe('tracker', 'field:b1:health'), null);
    assert.notEqual(engine.bus.describe('tracker', 'field:b1:gold'), null);

    settings.blocks[0].fields = [{ name: 'health', instruction: '' }];
    engine.bus.get('tracker', 'publish')();

    assert.notEqual(engine.bus.describe('tracker', 'field:b1:health'), null, 'the field that is still configured must stay reserved');
    assert.equal(engine.bus.describe('tracker', 'field:b1:gold'), null, 'the removed field must be unreserved');
    assert.equal(engine.bus.get('tracker', 'field:b1:gold'), undefined, 'and its stale value must be gone too, not just the reservation');
});

test('publish() replaces a disabled block\'s field values with an explicit notice instead of stale data', async () => {
    const { engine, store } = makeEngine();
    engine.register(trackerModule);
    const settings = engine.moduleSettings('tracker', {});
    settings.blocks = [{
        id: 'b1', title: 'Vitals', collapsed: false, enabled: true,
        fields: [{ name: 'health', instruction: '' }],
        sidecarProfile: 'default', systemPromptTemplate: 'x', promptTemplate: 'y', displayTemplate: '',
    }];
    await engine.enable('tracker');
    store.set('b1', { health: '100' }, ['health']);
    engine.bus.get('tracker', 'publish')(); // re-publish so the bus picks up the real state we just wrote
    assert.equal(engine.bus.get('tracker', 'field:b1:health'), '100', 'sanity check — the enabled block really is serving the real value first');

    settings.blocks[0].enabled = false;
    engine.bus.get('tracker', 'publish')();

    const fieldValue = engine.bus.get('tracker', 'field:b1:health');
    assert.notEqual(fieldValue, '100', 'a disabled block must not keep serving its last real value');
    assert.match(String(fieldValue), /disabled/i, 'a disabled block should say so explicitly, not just go blank');
    assert.match(String(engine.bus.get('tracker', 'block:b1').state.health), /disabled/i);
});

test('publish() fully retires a removed block: its block channel and every field channel are gone', async () => {
    const { engine } = makeEngine();
    engine.register(trackerModule);
    const settings = engine.moduleSettings('tracker', {});
    settings.blocks = [{
        id: 'b1', title: 'Vitals', collapsed: false, enabled: true,
        fields: [{ name: 'health', instruction: '' }],
        sidecarProfile: 'default', systemPromptTemplate: 'x', promptTemplate: 'y', displayTemplate: '',
    }];
    await engine.enable('tracker');
    assert.notEqual(engine.bus.describe('tracker', 'block:b1'), null);

    settings.blocks = [];
    engine.bus.get('tracker', 'publish')();

    assert.equal(engine.bus.describe('tracker', 'block:b1'), null);
    assert.equal(engine.bus.describe('tracker', 'field:b1:health'), null);
    assert.equal(engine.bus.get('tracker', 'block:b1'), undefined);
});

test('re-publishing an unchanged block keeps serving its real, current value on the still-reserved channel', async () => {
    const { engine, store } = makeEngine();
    engine.register(trackerModule);
    const settings = engine.moduleSettings('tracker', {});
    settings.blocks = [{
        id: 'b1', title: 'Vitals', collapsed: false, enabled: true,
        fields: [{ name: 'health', instruction: '' }],
        sidecarProfile: 'default', systemPromptTemplate: 'x', promptTemplate: 'y', displayTemplate: '',
    }];
    await engine.enable('tracker');
    store.set('b1', { health: '75' }, ['health']);

    engine.bus.get('tracker', 'publish')();

    assert.notEqual(engine.bus.describe('tracker', 'field:b1:health'), null);
    assert.equal(engine.bus.get('tracker', 'field:b1:health'), '75');
});
