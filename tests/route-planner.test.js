import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutePlanner, MILESTONE } from '../core/route-planner.js';
import { ModuleDataBus } from '../core/data-bus.js';

function makeFakeSidecar(states = []) {
    return { workerStates: () => states };
}

function publishMain(bus, { phase, toolCallsInCycle = 0, lastOutcome = null }) {
    bus.set('state-track', 'main', { phase, lastOutcome, toolCallsInCycle });
}

test('with no state-track:main published yet, activity is not counted at all — nothing to correlate against', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    bus.set('music', 'nowPlaying', 'track');
    assert.deepEqual(planner.passCounts('music'), { duringGeneration: 0, afterGeneration: 0 });
});

test('activity during phase:generating is counted as "duringGeneration", whether or not a tool call happened yet', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'generating' });
    bus.set('tracker', 'blocks', []);
    publishMain(bus, { phase: 'generating', toolCallsInCycle: 1 });
    bus.set('tracker', 'blocks', []);
    assert.deepEqual(planner.passCounts('tracker'), { duringGeneration: 2, afterGeneration: 0 });
});

test('activity while phase:idle with lastOutcome:success is counted as "afterGeneration"', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    bus.set('notebook', 'notes', []);
    assert.deepEqual(planner.passCounts('notebook'), { duringGeneration: 0, afterGeneration: 1 });
});

test('activity while phase:idle with no completed cycle (lastOutcome null/failed/stopped) is not counted either way — ambiguous', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: null });
    bus.set('a', 'x', 1);
    publishMain(bus, { phase: 'idle', lastOutcome: 'failed' });
    bus.set('a', 'x', 2);
    publishMain(bus, { phase: 'stopped', lastOutcome: 'stopped' });
    bus.set('a', 'x', 3);
    assert.deepEqual(planner.passCounts('a'), { duringGeneration: 0, afterGeneration: 0 });
});

test('State-Track publishing its own snapshot is never counted as module activity — would be circular and is not a module doing work', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'generating' });
    bus.set('state-track', 'sidecars', []);
    assert.deepEqual(planner.passCounts('state-track'), { duringGeneration: 0, afterGeneration: 0 });
});

test('dispose() stops observing — no further writes get counted', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    bus.set('notebook', 'notes', []);
    planner.dispose();
    bus.set('notebook', 'notes', []);
    assert.deepEqual(planner.passCounts('notebook'), { duringGeneration: 0, afterGeneration: 1 });
});

test('passCounts() returns a copy — mutating the result never affects the real counters', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'generating' });
    bus.set('tracker', 'x', 1);
    const counts = planner.passCounts('tracker');
    counts.duringGeneration = 999;
    assert.equal(planner.passCounts('tracker').duringGeneration, 1);
});

// --- probabilityAfterGeneration() — Laplace-smoothed

test('probabilityAfterGeneration is exactly 0.5 (maximally uncertain) with no evidence at all', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    assert.equal(planner.probabilityAfterGeneration('nothing-ever-observed'), 0.5);
});

test('probabilityAfterGeneration moves toward 1 as more "after generation" passes accumulate, and never reaches exactly 0 or 1', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    for (let i = 0; i < 20; i++) bus.set('notebook', 'notes', i);
    const p = planner.probabilityAfterGeneration('notebook');
    assert.ok(p > 0.9 && p < 1, `expected p close to but below 1, got ${p}`);
});

test('probabilityAfterGeneration moves toward 0 as more "during generation" passes accumulate', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'generating' });
    for (let i = 0; i < 20; i++) bus.set('tracker', 'x', i);
    const p = planner.probabilityAfterGeneration('tracker');
    assert.ok(p < 0.1 && p > 0, `expected p close to but above 0, got ${p}`);
});

// --- decide() — compares EXPECTED cost, not raw probability; see the file's own worked example.

test('decide() proceeds when acting-now has the lower expected cost (low probabilityAfterGeneration)', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'generating' });
    for (let i = 0; i < 20; i++) bus.set('tracker', 'x', i); // almost always "during" -> low p
    const result = planner.decide('tracker');
    assert.equal(result.decision, 'proceed');
});

test('decide() reproduces the user\'s own worked example: p≈0.3 "after needed" still favors NOT acting immediately, because the branches\' costs are asymmetric', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    // Force probabilityAfterGeneration close to 0.3, with enough total passes to
    // clear minEvidence too: after=3, during=7 -> (3+1)/(3+7+2) = 4/12 ≈ 0.333.
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    for (let i = 0; i < 3; i++) bus.set('m', 'x', i); // 3 afterGeneration
    publishMain(bus, { phase: 'generating' });
    for (let i = 0; i < 7; i++) bus.set('m', 'x', i); // 7 duringGeneration
    const result = planner.decide('m', { waitCost: 1.5, severeCost: 20 });
    assert.ok(result.probabilityAfterGeneration > 0.25 && result.probabilityAfterGeneration < 0.4);
    assert.notEqual(result.reason, 'insufficient-evidence');
    assert.notEqual(result.decision, 'proceed', 'a ~30% chance of a severe mistake must not be waved through just because 70% "seems" like acting now is fine');
});

test('decide() picks "wait" when acting now is the costlier expected choice — worker availability is irrelevant to this decision, only timing (see pickIdleWorker() for the separate, worker-choice question)', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar([
        { id: 'primary', configured: true, status: 'requesting' },
        { id: 'second', configured: true, status: 'idle' }, // an idle worker existing must NOT change this decision — see the file's own doc comment on why 'reroute' was removed from decide()
    ]));
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    for (let i = 0; i < 20; i++) bus.set('notebook', 'notes', i); // high p -> waiting favored
    const result = planner.decide('notebook');
    assert.equal(result.decision, 'wait');
    assert.equal(result.for, MILESTONE.GENERATION_ENDED);
});

test('decide() never throws when constructed without a sidecarManager at all', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, undefined);
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    for (let i = 0; i < 20; i++) bus.set('notebook', 'notes', i);
    assert.doesNotThrow(() => planner.decide('notebook'));
    assert.equal(planner.decide('notebook').decision, 'wait');
});

// --- pickIdleWorker() — the separate, worker-CHOICE question. Only ever
// consulted by SidecarManager.request() AFTER a real wait has already
// resolved, never as a substitute for one — see decide()'s own doc comment.

test('pickIdleWorker returns a configured, idle worker when one exists', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar([
        { id: 'primary', configured: true, status: 'requesting' },
        { id: 'second', configured: true, status: 'idle' },
    ]));
    assert.equal(planner.pickIdleWorker().id, 'second');
});

test('pickIdleWorker ignores an idle-but-not-configured worker', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar([{ id: 'unconfigured', configured: false, status: 'idle' }]));
    assert.equal(planner.pickIdleWorker(), null);
});

test('pickIdleWorker returns null when nothing is idle, or when constructed without a sidecarManager at all', () => {
    const bus = new ModuleDataBus();
    assert.equal(new RoutePlanner(bus, makeFakeSidecar([{ id: 'primary', configured: true, status: 'requesting' }])).pickIdleWorker(), null);
    assert.doesNotThrow(() => new RoutePlanner(bus, undefined).pickIdleWorker());
    assert.equal(new RoutePlanner(bus, undefined).pickIdleWorker(), null);
});

test('decide() respects custom waitCost/severeCost overrides', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    bus.set('m', 'x', 1); // p ≈ 2/3, moderate
    // minEvidence: 0 isolates this test to the cost formula itself, not the
    // separate evidence-gate behavior (covered by its own tests above).
    // With a tiny severeCost, acting now becomes cheap even at moderate probability.
    assert.equal(planner.decide('m', { waitCost: 100, severeCost: 0.01, minEvidence: 0 }).decision, 'proceed');
});

// --- minEvidence gate — a brand-new module must not get needlessly delayed/
// rerouted purely from cold-start uncertainty (p starts at 0.5, which already
// favors NOT proceeding at the default cost ratio).

test('decide() always proceeds — regardless of what the raw formula would say — until minEvidence total passes have been observed', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    // Zero evidence at all: raw p=0.5 would normally favor NOT proceeding.
    const result = planner.decide('brand-new-module');
    assert.equal(result.decision, 'proceed');
    assert.equal(result.reason, 'insufficient-evidence');
});

test('once minEvidence is reached, decide() uses the real formula again — a module with mixed-but-inconclusive evidence can now be told to wait', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    // 6 total passes, split so p stays near 0.5 (mixed/inconclusive) — enough
    // evidence to stop being suppressed, not enough to settle toward 0 or 1.
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    for (let i = 0; i < 3; i++) bus.set('m', 'x', i);
    publishMain(bus, { phase: 'generating' });
    for (let i = 0; i < 3; i++) bus.set('m', 'x', i);
    const result = planner.decide('m', { minEvidence: 6 });
    assert.notEqual(result.reason, 'insufficient-evidence');
    assert.notEqual(result.decision, 'proceed', 'p≈0.5 at the default cost ratio favors NOT proceeding blindly once there is enough real evidence to trust it');
});

test('minEvidence is overridable per call', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    bus.set('m', 'x', 1); // just 1 pass
    assert.equal(planner.decide('m', { minEvidence: 5 }).reason, 'insufficient-evidence');
    assert.notEqual(planner.decide('m', { minEvidence: 1 }).reason, 'insufficient-evidence');
});

// --- waitFor() — bounded, resolves on the real milestone or on timeout, never rejects.

test('waitFor resolves immediately, with no subscription needed, if the milestone is already current', async () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    const startedAt = Date.now();
    await planner.waitFor(MILESTONE.GENERATION_ENDED, { timeoutMs: 10000 });
    assert.ok(Date.now() - startedAt < 50, 'must not have waited for the (long) timeout — it was already true');
});

test('waitFor resolves as soon as the milestone actually becomes current', async () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    publishMain(bus, { phase: 'generating' });
    const promise = planner.waitFor(MILESTONE.GENERATION_ENDED, { timeoutMs: 10000 });
    let resolved = false;
    promise.then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false, 'must not resolve before the milestone is actually reached');
    publishMain(bus, { phase: 'idle', lastOutcome: 'success' });
    await promise;
    assert.equal(resolved, true);
});

test('waitFor resolves via timeout if the milestone never arrives — never waits forever', async () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    publishMain(bus, { phase: 'generating' });
    const startedAt = Date.now();
    await planner.waitFor(MILESTONE.GENERATION_ENDED, { timeoutMs: 20 });
    assert.ok(Date.now() - startedAt >= 20);
});

test('waitFor never rejects, even on a stopped/failed generation that never reaches the awaited milestone', async () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    publishMain(bus, { phase: 'stopped', lastOutcome: 'stopped' });
    await assert.doesNotReject(() => planner.waitFor(MILESTONE.GENERATION_ENDED, { timeoutMs: 20 }));
});

test('decide() never mutates real state and never acts — purely returns a decision object', () => {
    const bus = new ModuleDataBus();
    const planner = new RoutePlanner(bus, makeFakeSidecar());
    planner.start();
    publishMain(bus, { phase: 'generating' });
    bus.set('tracker', 'x', 1);
    const before = planner.passCounts('tracker');
    planner.decide('tracker');
    planner.decide('tracker');
    assert.deepEqual(planner.passCounts('tracker'), before, 'calling decide() must not itself count as activity');
});
