import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackerStore } from '../modules/tracker/store.js';

function makeStore() {
    const state = { chatMetadata: {}, saves: 0 };
    return { state, store: createTrackerStore(() => ({ chatMetadata: state.chatMetadata, saveMetadataDebounced: () => state.saves++ })) };
}

test('Tracker store keeps each block\'s state independent', () => {
    const { store, state } = makeStore();
    store.set('health-block', { health: 'Injured' }, ['health']);
    store.set('mood-block', { mood: 'Anxious' }, ['mood']);
    assert.deepEqual(store.get('health-block'), { health: 'Injured' });
    assert.deepEqual(store.get('mood-block'), { mood: 'Anxious' });
    assert.equal(state.saves, 2);
});

test('Tracker store only writes whitelisted fields and skips no-op saves', () => {
    const { store, state } = makeStore();
    store.set('block-1', { health: 'Healthy', secret: 'nope' }, ['health']);
    assert.deepEqual(store.get('block-1'), { health: 'Healthy' });
    assert.equal(state.saves, 1);
    store.set('block-1', { health: 'Healthy' }, ['health']);
    assert.equal(state.saves, 1);
});

test('Tracker store reset clears only the targeted block', () => {
    const { store } = makeStore();
    store.set('block-1', { health: 'Healthy' }, ['health']);
    store.set('block-2', { mood: 'Calm' }, ['mood']);
    store.reset('block-1');
    assert.deepEqual(store.get('block-1'), {});
    assert.deepEqual(store.get('block-2'), { mood: 'Calm' });
});
