/**
 * The dynamic layer on top of State-Track (core/state-track.js) and Dependency
 * Scanner (core/dependency-scanner.js) — Phase 3 of that work, per MODULES.md's
 * State-Track section. Everything before this was a STATIC graph of what could
 * happen; this is the piece that watches what actually happens, cycle by cycle,
 * and decides what a module wanting to act RIGHT NOW should do about it.
 *
 * Scope of this pass, confirmed explicitly with the user: build the DECISION
 * ENGINE only — observe, count, and decide. Nothing here reorders a real
 * module's real request, reroutes a real SideCar call, or changes any actual
 * behavior. Wiring `decide()`'s output into real execution is a deliberately
 * separate, later step.
 *
 * Three "milestone" nodes, and only these three (confirmed, closed set — not
 * every ST event): generation-started, a tool call performed, and generation-
 * ended. Reuses the exact `st-event:<NAME>` pseudo-node naming
 * core/dependency-scanner.js's Phase 2d already established, rather than
 * inventing a second vocabulary for the same idea. Their "reached/not yet" state
 * needs no new instrumentation at all — core/state-track.js already publishes
 * `phase`/`toolCallsInCycle`/`lastOutcome` reactively on the bus
 * (`state-track:main`); this just reads that.
 *
 * Observation mechanism: `bus.onAnyWrite()` (core/data-bus.js) — a module's own
 * bus writes are treated as evidence of "this module did something," each one
 * tagged with whichever milestone was current at that instant. A simple pass
 * counter per module, nothing ML — same "small and honest, not clever"
 * philosophy as the rest of this project (the macro language, the diagnostic
 * regex parsers). This deliberately does NOT wrap host.services/host.data at
 * their call sites — that was the original "runtime observation" idea Round 1
 * of the Dependency Scanner design explicitly rejected as the source of the
 * STATIC graph; reusing bus writes here keeps this dynamic layer built from the
 * same non-invasive primitive rather than reopening that decision.
 *
 * The decision itself compares EXPECTED cost, not raw probability — the user's
 * own worked example: even at 70% "fine to act now" vs 30% "should wait until
 * generation ends," acting now can still be the WRONG choice, because the two
 * branches' costs are wildly asymmetric. Waiting when you didn't need to costs a
 * small, roughly fixed delay (`waitCost`). Acting when you should have waited
 * risks a Tier-2, not-cleanly-reversible mistake (state written mid-generation,
 * before the real final outcome was known — the same class of problem as the
 * already-documented Tracker/Time SideCar race condition) — `severeCost`, set
 * deliberately much larger. `expectedCost = probability × cost`; the branch with
 * the LOWER expected cost wins, not the more probable one.
 *
 * `decide()` only ever answers `'proceed'` or `'wait'` — a pure TIMING question.
 * A real end-to-end test (SidecarManager + RoutePlanner together, no mocks —
 * see tests/route-planner-sidecar-integration.test.js) caught a real bug in an
 * earlier version that also offered a `'reroute'` outcome here, reasoning that
 * an idle second SideCar worker was a substitute for waiting: it isn't — WHICH
 * worker computes a result never changes WHEN that result becomes correct to
 * use, so a "reroute" that skips a warranted wait is just acting too early
 * with extra steps. Picking a good worker is still worth doing, just strictly
 * AFTER a real wait has already resolved — that's `pickIdleWorker()` below,
 * called by `SidecarManager.request()` only once `waitFor()` has completed.
 */

export const MILESTONE = Object.freeze({
    GENERATION_STARTED: 'st-event:GENERATION_STARTED',
    TOOL_CALL: 'st-event:TOOL_CALLS_PERFORMED',
    GENERATION_ENDED: 'st-event:GENERATION_ENDED',
});

// Arbitrary but consistent units (both costs use the same scale, only their
// RATIO matters to the decision) — chosen so the user's own worked example
// (waiting costs ~1-2s, acting wrongly risks "a possible severe screwup") comes
// out the same way: severeCost an order of magnitude past waitCost, not just
// somewhat bigger. Both injectable per call — these are only the real default.
const DEFAULT_WAIT_COST = 1.5;
const DEFAULT_SEVERE_COST = 20;
// A brand-new/never-observed module starts at probabilityAfterGeneration = 0.5
// (maximally uncertain) — and at the cost ratio above, even 50/50 uncertainty
// already favors NOT proceeding (0.5*waitCost=0.75 < 0.5*severeCost=10). Wired
// in unconditionally, that would mean every module — including one with no
// real timing ambiguity at all, like this project's own built-in Tracker/Time/
// Music — gets needlessly delayed/rerouted on its first few requests, purely
// from cold-start uncertainty, not from any real signal. This is the guard
// against that: below `minEvidence` total observed passes, decide() always
// returns 'proceed' (today's unchanged default behavior) regardless of what
// the raw formula would say — an unambiguous module's own real evidence
// reliably pushes its probability toward 0 well before this many passes
// accumulate, so the guard only ever suppresses noise, not a real signal.
const DEFAULT_MIN_EVIDENCE = 6;
// Bounds how long waitFor() will actually wait for a milestone that never
// arrives (a wrong probability estimate, a stopped/failed generation, a
// module that's simply mistaken about needing to wait at all) — never wait
// forever just because the model said to.
const DEFAULT_WAIT_TIMEOUT_MS = 15000;

export class RoutePlanner {
    #bus;
    #sidecarManager;
    // moduleId -> { duringGeneration, afterGeneration } — raw pass counts, never
    // reset. Deliberately unbounded/simple: this is a diagnostic learning signal
    // for the life of the page, not something that needs decay or a rolling
    // window for a v1 that doesn't even act on its own output yet.
    #passCounts = new Map();
    #unsubscribeWrite = null;

    constructor(bus, sidecarManager) {
        this.#bus = bus;
        this.#sidecarManager = sidecarManager;
    }

    /** Starts observing bus activity. Idempotent-ish in practice (ModuleEngine calls this once), but safe to call again — a stray double-subscribe would just double-count, not break anything structurally. */
    start() {
        this.#unsubscribeWrite = this.#bus.onAnyWrite(({ writerNamespace }) => this.#recordActivity(writerNamespace));
    }

    dispose() {
        this.#unsubscribeWrite?.();
        this.#unsubscribeWrite = null;
    }

    #recordActivity(moduleId) {
        // State-Track publishing its own snapshot isn't a module "doing work" —
        // counting it would also be circular, since #currentMilestone() itself
        // reads the very value being written.
        if (!moduleId || moduleId === 'state-track') return;
        const milestone = this.#currentMilestone();
        if (!milestone) return; // no generation cycle to correlate against right now (stopped/failed/never started) — not useful evidence either way
        const counts = this.#passCounts.get(moduleId) ?? { duringGeneration: 0, afterGeneration: 0 };
        if (milestone === MILESTONE.GENERATION_ENDED) counts.afterGeneration++;
        else counts.duringGeneration++; // GENERATION_STARTED or TOOL_CALL both count as "during" — the fork this system tracks is before/after the end, not the finer sub-phase
        this.#passCounts.set(moduleId, counts);
    }

    #currentMilestone() {
        const main = this.#bus.get('state-track', 'main');
        if (!main) return null;
        if (main.phase === 'generating') return main.toolCallsInCycle > 0 ? MILESTONE.TOOL_CALL : MILESTONE.GENERATION_STARTED;
        if (main.phase === 'idle' && main.lastOutcome === 'success') return MILESTONE.GENERATION_ENDED;
        return null; // stopped, failed, or idle with no completed cycle yet — ambiguous, not counted either way
    }

    /** Laplace-smoothed observed frequency that `moduleId`'s activity has historically landed AFTER generation ends, vs. during. Starts at 0.5 (maximally uncertain) before any evidence exists, and moves as real passes accumulate. */
    probabilityAfterGeneration(moduleId) {
        const { duringGeneration, afterGeneration } = this.passCounts(moduleId);
        return (afterGeneration + 1) / (afterGeneration + duringGeneration + 2);
    }

    /** Raw counts for `moduleId`, `{ duringGeneration: 0, afterGeneration: 0 }` if nothing's been observed yet. A copy — callers can't mutate the real counters through it. */
    passCounts(moduleId) {
        const counts = this.#passCounts.get(moduleId);
        return counts ? { ...counts } : { duringGeneration: 0, afterGeneration: 0 };
    }

    /**
     * What `moduleId` should do if it wants to act RIGHT NOW, based purely on
     * what's been observed so far — see the file doc comment for the cost model.
     * Never acts, never reorders anything real — see that same comment for why.
     *
     * Only two outcomes — this answers a TIMING question ("is it safe for this
     * module's data to exist yet"), and nothing about WHICH worker computes it
     * can change that answer. An earlier version of this method also offered a
     * `'reroute'` outcome here, on the theory that an idle second SideCar
     * worker was a substitute for waiting — that was wrong, caught by a real
     * end-to-end test: rerouting to a different worker doesn't make it any
     * more correct to act before generation has actually ended, so it must
     * never be allowed to skip a wait that's actually warranted. Picking a
     * good worker AFTER a real wait has resolved is a real, separate concern
     * — see `pickIdleWorker()` below, which `SidecarManager.request()` calls
     * once its own `waitFor()` has already completed, never instead of it.
     *
     * `{ decision: 'proceed' }` — acting now is the lower-expected-cost choice.
     * `{ decision: 'wait', for: MILESTONE.GENERATION_ENDED }` — waiting is
     *   cheaper in expectation.
     *
     * Every result also carries `probabilityAfterGeneration`/
     * `expectedCostOfWaiting`/`expectedCostOfActingNow` — the numbers the
     * decision was actually made from, for tests and for a human reading a log
     * to see WHY, not just what. Below `minEvidence` total observed passes for
     * `moduleId`, always `{ decision: 'proceed', reason: 'insufficient-evidence' }`
     * — see `DEFAULT_MIN_EVIDENCE`'s own comment for why: without that guard,
     * cold-start uncertainty alone would make this override even a module with
     * no real timing ambiguity at all.
     */
    decide(moduleId, { waitCost = DEFAULT_WAIT_COST, severeCost = DEFAULT_SEVERE_COST, minEvidence = DEFAULT_MIN_EVIDENCE } = {}) {
        const counts = this.passCounts(moduleId);
        const probabilityAfterGeneration = this.probabilityAfterGeneration(moduleId);
        const expectedCostOfWaiting = (1 - probabilityAfterGeneration) * waitCost;
        const expectedCostOfActingNow = probabilityAfterGeneration * severeCost;
        const base = { probabilityAfterGeneration, expectedCostOfWaiting, expectedCostOfActingNow };

        if (counts.duringGeneration + counts.afterGeneration < minEvidence) {
            return { decision: 'proceed', reason: 'insufficient-evidence', ...base };
        }
        if (expectedCostOfWaiting >= expectedCostOfActingNow) return { decision: 'proceed', ...base };
        return { decision: 'wait', for: MILESTONE.GENERATION_ENDED, ...base };
    }

    /**
     * A configured, currently-idle SideCar worker, or `null` — for
     * `SidecarManager.request()` to use ONLY once a real `wait` has already
     * resolved, to skip the normal queue/round-robin (`#pick()`) and avoid
     * sitting behind a busy worker a moment longer than necessary. Never a
     * substitute for the wait itself — see `decide()`'s own doc comment for
     * why an earlier version of this file got that wrong.
     */
    pickIdleWorker() {
        return this.#sidecarManager?.workerStates?.().find(worker => worker.configured && worker.status === 'idle') ?? null;
    }

    /**
     * Resolves once `milestone` is the current one (checked immediately — if
     * it's already true, resolves right away with no subscription at all),
     * or after `timeoutMs` elapses, whichever comes first — never rejects,
     * never waits forever. The only real caller today is
     * SidecarManager.request() acting on a `{ decision: 'wait' }` result; kept
     * here (not duplicated in SidecarManager) because this is the one place
     * that already knows how to read `state-track:main`.
     */
    waitFor(milestone, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}) {
        if (this.#currentMilestone() === milestone) return Promise.resolve();
        return new Promise(resolve => {
            const cleanup = () => { unsubscribe(); clearTimeout(timer); };
            const unsubscribe = this.#bus.subscribe('state-track', 'main', () => {
                if (this.#currentMilestone() === milestone) { cleanup(); resolve(); }
            });
            const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
        });
    }
}
