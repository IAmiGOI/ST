import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutePlanner } from '../core/route-planner.js';
import { SidecarManager } from '../core/sidecar-manager.js';
import { ModuleDataBus } from '../core/data-bus.js';

/**
 * The synthetic demo case: no BUILT-IN module today has genuinely ambiguous
 * timing (confirmed before this phase was built — see MODULES.md's Route
 * Planner section), so this proves the full REAL pipeline end to end —
 * real RoutePlanner accumulating real pass counts from real bus writes, real
 * SidecarManager actually honoring its decision — against a fabricated
 * "demo" module whose historical activity is deliberately skewed toward
 * "after generation ends," the exact shape a genuinely ambiguous module would
 * have. No fakes/mocks of either class here — see
 * tests/route-planner.test.js and tests/sidecar-manager.test.js for the
 * isolated unit-level coverage of each side on its own.
 */

function publishMain(bus, { phase, toolCallsInCycle = 0, lastOutcome = null }) {
    bus.set('state-track', 'main', { phase, lastOutcome, toolCallsInCycle });
}

/** Gives 'demo' enough real, heavily "after generation" history to clear minEvidence and make waiting/rerouting the cheaper choice at the real default costs. */
function teachDemoModuleToWaitForGenerationEnd(bus) {
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    for (let i = 0; i < 10; i++) bus.set('demo', 'result', i); // 10 afterGeneration passes
    publishMain(bus, { phase: 'generating' });
    // no duringGeneration passes at all — this module has, historically, only ever acted after generation ended
}

test('end to end: a demo module with real "always after generation" history gets genuinely delayed by the real SidecarManager, via the real RoutePlanner', async () => {
    const bus = new ModuleDataBus();
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://a.test/v1', model: 'small' }] };
    let routePlanner;
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    routePlanner = new RoutePlanner(bus, manager);
    routePlanner.start();

    teachDemoModuleToWaitForGenerationEnd(bus);
    // Still mid-generation right now — the real, honest ambiguity this whole
    // system exists for: is it safe for 'demo' to act yet?
    publishMain(bus, { phase: 'generating' });

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ choices: [{ message: { content: 'real-answer' } }] }) }; };
    try {
        const pending = manager.request({ prompt: 'hi', moduleId: 'demo' });
        await Promise.resolve(); await Promise.resolve();
        assert.equal(fetchCalled, false, 'the real RoutePlanner must have told SidecarManager to wait — nothing dispatched yet');

        // Generation actually ends now — the real milestone this module's own
        // history said to wait for.
        publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
        assert.equal(await pending, 'real-answer', 'once the real milestone was reached, the real request actually went through');
        assert.equal(fetchCalled, true);
    } finally { globalThis.fetch = originalFetch; }
});

test('end to end: once a real wait resolves, dispatch goes to a real idle worker instead of queueing behind a still-busy one', async () => {
    const bus = new ModuleDataBus();
    const root = {
        sidecars: [
            { id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://busy.test/v1', model: 'small' },
            { id: 'second', name: 'Second', enabled: true, endpoint: 'https://idle.test/v1', model: 'small' },
        ],
    };
    let routePlanner;
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    routePlanner = new RoutePlanner(bus, manager);
    routePlanner.start();

    publishMain(bus, { phase: 'generating' });
    // 'tracker' gets real, heavily "always during generation" history — enough
    // passes that the real formula settles on 'proceed' on its own merits, not
    // just because a lone worker happened to be free (see route-planner.js's
    // own doc comment on the bug this whole file exists to guard against).
    for (let i = 0; i < 20; i++) bus.set('tracker', 'field:x', i);
    // 'demo' gets real, heavily "always after generation" history.
    teachDemoModuleToWaitForGenerationEnd(bus);
    publishMain(bus, { phase: 'generating' });

    const calledUrls = [];
    let releaseBusy;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        calledUrls.push(String(url));
        if (String(url).includes('busy.test')) return new Promise(resolve => { releaseBusy = () => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'busy-answer' } }] }) }); });
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'idle-worker-answer' } }] }) };
    };
    try {
        // Occupy 'primary' with tracker's own real, unambiguous, immediately-dispatched request.
        const busyPending = manager.request({ prompt: 'occupy', moduleId: 'tracker' });
        await Promise.resolve(); await Promise.resolve();
        assert.equal(manager.workerStates().find(w => w.id === 'primary').status, 'requesting', 'primary must genuinely be busy right now, not just assumed to be');

        // demo's own request — still correctly waiting for the real milestone.
        const demoPending = manager.request({ prompt: 'hi', moduleId: 'demo' });
        await Promise.resolve(); await Promise.resolve();
        assert.equal(calledUrls.some(url => url.includes('idle.test')), false, 'must not have dispatched yet — still genuinely waiting');

        publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
        assert.equal(await demoPending, 'idle-worker-answer');
        assert.equal(calledUrls.filter(url => url.includes('idle.test')).length, 1);

        releaseBusy();
        assert.equal(await busyPending, 'busy-answer');
    } finally { globalThis.fetch = originalFetch; }
});

test('end to end: a module with real "always during generation" history is never delayed — the same request from the SAME manager, unaffected', async () => {
    const bus = new ModuleDataBus();
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://a.test/v1', model: 'small' }] };
    let routePlanner;
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    routePlanner = new RoutePlanner(bus, manager);
    routePlanner.start();

    // 'tracker' behaves the way this project's real Tracker module actually
    // does — always fires during generation, never after. Enough passes for
    // the real formula to settle on 'proceed' from the timing math alone.
    publishMain(bus, { phase: 'generating' });
    for (let i = 0; i < 20; i++) bus.set('tracker', 'field:x', i);

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; };
    try {
        await manager.request({ prompt: 'hi', moduleId: 'tracker' });
        assert.equal(fetchCalled, true, 'an unambiguous module\'s own real history must resolve to immediate dispatch, never a needless wait');
    } finally { globalThis.fetch = originalFetch; }
});
