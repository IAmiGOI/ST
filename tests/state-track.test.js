import test from 'node:test';
import assert from 'node:assert/strict';
import { MainLlmStateTrack, StateTrack, GENERATION_PHASE } from '../core/state-track.js';
import { ModuleDataBus } from '../core/data-bus.js';

const EVENT_TYPES = {
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    TOOL_CALLS_PERFORMED: 'tool_calls_performed',
    MESSAGE_RECEIVED: 'message_received',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
};

function makeFakeEventSource() {
    const handlers = new Map();
    return {
        on(type, handler) { (handlers.get(type) ?? handlers.set(type, new Set()).get(type)).add(handler); },
        off(type, handler) { handlers.get(type)?.delete(handler); },
        emit(type) { for (const handler of [...(handlers.get(type) ?? [])]) handler(); },
        listenerCount(type) { return handlers.get(type)?.size ?? 0; },
    };
}

function makeTrack({ outcomeGraceMs = 15, stoppedSettleMs = 15 } = {}) {
    const eventSource = makeFakeEventSource();
    const context = { eventTypes: EVENT_TYPES, eventSource };
    const track = new MainLlmStateTrack(() => context, { outcomeGraceMs, stoppedSettleMs });
    track.start();
    return { track, eventSource };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('starts idle with no outcome and no tool calls', () => {
    const { track } = makeTrack();
    assert.deepEqual(track.snapshot(), { phase: GENERATION_PHASE.IDLE, lastOutcome: null, toolCallsInCycle: 0 });
});

test('GENERATION_STARTED moves to generating and clears the previous outcome', () => {
    const { track, eventSource } = makeTrack();
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED);
    assert.equal(track.phase(), GENERATION_PHASE.GENERATING);
    assert.equal(track.lastOutcome(), null);
});

test('a tool call performed mid-generation is recorded but never desyncs phase away from generating', () => {
    const { track, eventSource } = makeTrack();
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED);
    eventSource.emit(EVENT_TYPES.TOOL_CALLS_PERFORMED);
    eventSource.emit(EVENT_TYPES.TOOL_CALLS_PERFORMED);
    assert.equal(track.phase(), GENERATION_PHASE.GENERATING, 'a tool call must not end the tracked generation cycle');
    assert.equal(track.toolCallsInCycle(), 2);
});

test('a stray TOOL_CALLS_PERFORMED while idle (no tracked cycle) is ignored', () => {
    const { track, eventSource } = makeTrack();
    eventSource.emit(EVENT_TYPES.TOOL_CALLS_PERFORMED);
    assert.equal(track.toolCallsInCycle(), 0);
});

test('GENERATION_ENDED after a real message arrived resolves to success once the grace window elapses', async () => {
    const { track, eventSource } = makeTrack({ outcomeGraceMs: 10 });
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED);
    eventSource.emit(EVENT_TYPES.MESSAGE_RECEIVED);
    eventSource.emit(EVENT_TYPES.GENERATION_ENDED);
    assert.equal(track.phase(), GENERATION_PHASE.GENERATING, 'stays generating until the grace window resolves it');
    await wait(30);
    assert.equal(track.phase(), GENERATION_PHASE.IDLE);
    assert.equal(track.lastOutcome(), 'success');
});

test('GENERATION_ENDED with no message ever arriving resolves to failed — the tracker returns cleanly to idle instead of getting stuck', async () => {
    const { track, eventSource } = makeTrack({ outcomeGraceMs: 10 });
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED);
    eventSource.emit(EVENT_TYPES.GENERATION_ENDED);
    await wait(30);
    assert.equal(track.phase(), GENERATION_PHASE.IDLE);
    assert.equal(track.lastOutcome(), 'failed');
});

test('an intermediate MESSAGE_RECEIVED (e.g. a tool-call result message) does not itself end the cycle — only GENERATION_ENDED does', async () => {
    const { track, eventSource } = makeTrack({ outcomeGraceMs: 10 });
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED);
    eventSource.emit(EVENT_TYPES.TOOL_CALLS_PERFORMED);
    eventSource.emit(EVENT_TYPES.MESSAGE_RECEIVED); // an intermediate message, generation is NOT actually done yet
    assert.equal(track.phase(), GENERATION_PHASE.GENERATING, 'must still be generating — only GENERATION_ENDED may resolve the cycle');
    eventSource.emit(EVENT_TYPES.GENERATION_ENDED);
    await wait(30);
    assert.equal(track.phase(), GENERATION_PHASE.IDLE);
    assert.equal(track.lastOutcome(), 'success');
});

test('GENERATION_STOPPED (user abort) resolves immediately to stopped, then settles to idle shortly after', async () => {
    const { track, eventSource } = makeTrack({ stoppedSettleMs: 10 });
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED);
    eventSource.emit(EVENT_TYPES.GENERATION_STOPPED);
    assert.equal(track.phase(), GENERATION_PHASE.STOPPED);
    assert.equal(track.lastOutcome(), 'stopped');
    await wait(30);
    assert.equal(track.phase(), GENERATION_PHASE.IDLE);
    assert.equal(track.lastOutcome(), 'stopped', 'the outcome stays "stopped" — settling to idle only affects phase');
});

test('a new cycle starting before a stale GENERATION_ENDED grace timer fires is not overwritten by it', async () => {
    const { track, eventSource } = makeTrack({ outcomeGraceMs: 20 });
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED); // cycle 1
    eventSource.emit(EVENT_TYPES.GENERATION_ENDED); // cycle 1 ends with no message — would resolve 'failed' in 20ms
    await wait(5);
    eventSource.emit(EVENT_TYPES.GENERATION_STARTED); // cycle 2 starts before that timer fires
    eventSource.emit(EVENT_TYPES.MESSAGE_RECEIVED);
    await wait(30); // past cycle 1's original grace window
    assert.equal(track.phase(), GENERATION_PHASE.GENERATING, 'cycle 2 is still running — the stale cycle-1 timer must not have touched it');
    assert.equal(track.lastOutcome(), null);
});

test('dispose() removes every event listener', () => {
    const { track, eventSource } = makeTrack();
    for (const type of Object.values(EVENT_TYPES)) assert.equal(eventSource.listenerCount(type), 1);
    track.dispose();
    for (const type of Object.values(EVENT_TYPES)) assert.equal(eventSource.listenerCount(type), 0);
});

test('start() degrades quietly (stays idle forever, never throws) when the ST event API is unavailable', () => {
    const track = new MainLlmStateTrack(() => ({}));
    assert.doesNotThrow(() => track.start());
    assert.equal(track.phase(), GENERATION_PHASE.IDLE);
});

// --- StateTrack orchestrator: republishes mainLlm + a SidecarManager-shaped
// object's workerStates() onto the bus under namespace 'state-track'. A fake
// sidecar stands in here — the real one is covered by sidecar-manager.test.js's
// own workerStates() tests; this only needs to prove the wiring/republishing.

function makeFakeSidecar(initialStates) {
    let states = initialStates;
    return { workerStates: () => states, setStates: next => { states = next; } };
}

test('StateTrack publishes both main-LLM and sidecar snapshots onto the bus as soon as it starts', () => {
    const bus = new ModuleDataBus({ getContext: () => ({}) });
    const eventSource = makeFakeEventSource();
    const context = { eventTypes: EVENT_TYPES, eventSource };
    const sidecar = makeFakeSidecar([{ id: 'primary', name: 'Primary', status: 'idle' }]);
    const stateTrack = new StateTrack(() => context, bus, sidecar);
    stateTrack.start();

    assert.deepEqual(bus.get('state-track', 'main'), { phase: GENERATION_PHASE.IDLE, lastOutcome: null, toolCallsInCycle: 0 });
    assert.deepEqual(bus.get('state-track', 'sidecars'), [{ id: 'primary', name: 'Primary', status: 'idle' }]);
});

test('StateTrack keeps the bus in sync as the main-LLM phase changes', () => {
    const bus = new ModuleDataBus({ getContext: () => ({}) });
    const eventSource = makeFakeEventSource();
    const context = { eventTypes: EVENT_TYPES, eventSource };
    const stateTrack = new StateTrack(() => context, bus, makeFakeSidecar([]));
    stateTrack.start();

    eventSource.emit(EVENT_TYPES.GENERATION_STARTED);
    assert.equal(bus.get('state-track', 'main').phase, GENERATION_PHASE.GENERATING);
});

test('StateTrack.dispose() stops the main-LLM tracker\'s own listeners', () => {
    const bus = new ModuleDataBus({ getContext: () => ({}) });
    const eventSource = makeFakeEventSource();
    const context = { eventTypes: EVENT_TYPES, eventSource };
    const stateTrack = new StateTrack(() => context, bus, makeFakeSidecar([]));
    stateTrack.start();
    stateTrack.dispose();
    for (const type of Object.values(EVENT_TYPES)) assert.equal(eventSource.listenerCount(type), 0);
});
