import { signal, effect } from './reactive.js';

/**
 * Phase 1 of State-Track: pure observation, no behavior change. It tracks what
 * the main chat LLM and every SideCar worker are CURRENTLY doing and republishes
 * that onto the shared bus (namespace 'state-track') so any module or the dev
 * panel can read "what's happening right now" from one place, without its own
 * event wiring. A later phase builds a dependency-aware director on top of this
 * — see MODULES.md's State-Track section — deliberately not attempted yet: that
 * needs this foundation proven first.
 */

export const GENERATION_PHASE = Object.freeze({
    IDLE: 'idle',
    GENERATING: 'generating',
    STOPPED: 'stopped',
});

// GENERATION_ENDED fires identically on success AND on a failed/errored
// generation — ST does not distinguish them at the event level (confirmed
// against ST's own event source; see the memory/design note this was built
// from). This grace window is a heuristic to fill that gap, not a guarantee:
// wait this long after GENERATION_ENDED for a real message to have shown up: if
// one did, the cycle succeeded; if not, call it failed rather than getting stuck
// reporting "generating" forever.
const OUTCOME_GRACE_MS = 2000;
// A user-initiated stop is unambiguous — nothing to wait for. Settle back to
// idle almost immediately, just long enough for a listener to see 'stopped'.
const STOPPED_SETTLE_MS = 300;

const NAMESPACE = 'state-track';

/**
 * Tracks the main chat LLM's own generation lifecycle (not a SideCar — ST's
 * actual configured chat connection). Built from real ST events:
 * GENERATION_STARTED / GENERATION_STOPPED / GENERATION_ENDED,
 * TOOL_CALLS_PERFORMED, and MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED as the
 * "did a real reply actually land" signal.
 *
 * Two guarantees this class exists specifically to provide (the "must not get
 * lost" requirement):
 *  - A tool call performed mid-generation must never desync `phase` away from
 *    GENERATING. GENERATION_ENDED still follows normally once the model resumes
 *    with the tool's result — #onToolCallsPerformed only records that it
 *    happened, it never itself changes `phase`.
 *  - A failed generation must still cleanly return `phase` to IDLE (with
 *    `lastOutcome: 'failed'` recorded) rather than getting stuck reporting
 *    GENERATING forever just because no message ever arrived.
 *
 * Deliberately does NOT treat MESSAGE_RECEIVED as "the cycle is done, go idle
 * now": a tool-calling cycle can plausibly fire that event for an intermediate
 * tool-result message before the model actually resumes and finishes, and
 * reacting to that early would be exactly the kind of desync this class must
 * avoid. It only ever records "yes, at least one message showed up this cycle"
 * — the actual phase transition always waits for GENERATION_ENDED (or
 * GENERATION_STOPPED) to fire, once, at the true end of the cycle.
 */
export class MainLlmStateTrack {
    phase = signal(GENERATION_PHASE.IDLE);
    lastOutcome = signal(null); // 'success' | 'failed' | 'stopped' | null — sticky until the next cycle starts
    toolCallsInCycle = signal(0);
    #getContext;
    #outcomeGraceMs;
    #stoppedSettleMs;
    #cycleId = 0;
    #messageSeenThisCycle = false;
    #graceTimer = null;
    #settleTimer = null;
    #unsubs = [];

    /** `outcomeGraceMs`/`stoppedSettleMs` are only ever overridden by tests — real callers always get the real constants above. */
    constructor(getContext, { outcomeGraceMs = OUTCOME_GRACE_MS, stoppedSettleMs = STOPPED_SETTLE_MS } = {}) {
        this.#getContext = getContext;
        this.#outcomeGraceMs = outcomeGraceMs;
        this.#stoppedSettleMs = stoppedSettleMs;
    }

    start() {
        const context = this.#getContext();
        const types = context?.eventTypes;
        const source = context?.eventSource;
        if (!types || !source?.on) {
            console.warn('[ST Module Engine][state-track] SillyTavern event API is unavailable — main-LLM generation state will stay idle.');
            return;
        }
        this.#on(source, types.GENERATION_STARTED, () => this.#onGenerationStarted());
        this.#on(source, types.GENERATION_STOPPED, () => this.#onGenerationStopped());
        this.#on(source, types.GENERATION_ENDED, () => this.#onGenerationEnded());
        this.#on(source, types.TOOL_CALLS_PERFORMED, () => this.#onToolCallsPerformed());
        this.#on(source, types.MESSAGE_RECEIVED, () => this.#onMessageSeen());
        this.#on(source, types.CHARACTER_MESSAGE_RENDERED, () => this.#onMessageSeen());
    }

    #on(source, eventName, handler) {
        if (!eventName) return;
        source.on(eventName, handler);
        this.#unsubs.push(() => source.off?.(eventName, handler));
    }

    dispose() {
        for (const unsub of this.#unsubs) unsub();
        this.#unsubs = [];
        clearTimeout(this.#graceTimer);
        clearTimeout(this.#settleTimer);
    }

    #onGenerationStarted() {
        this.#cycleId += 1;
        this.#messageSeenThisCycle = false;
        clearTimeout(this.#graceTimer);
        clearTimeout(this.#settleTimer);
        this.phase.set(GENERATION_PHASE.GENERATING);
        this.lastOutcome.set(null);
        this.toolCallsInCycle.set(0);
    }

    #onToolCallsPerformed() {
        if (this.phase.peek() !== GENERATION_PHASE.GENERATING) return;
        this.toolCallsInCycle.update(n => n + 1);
    }

    #onGenerationStopped() {
        clearTimeout(this.#graceTimer);
        this.phase.set(GENERATION_PHASE.STOPPED);
        this.lastOutcome.set('stopped');
        this.#settleTimer = setTimeout(() => {
            if (this.phase.peek() === GENERATION_PHASE.STOPPED) this.phase.set(GENERATION_PHASE.IDLE);
        }, this.#stoppedSettleMs);
    }

    #onGenerationEnded() {
        if (this.phase.peek() !== GENERATION_PHASE.GENERATING) return; // already stopped/settled elsewhere — nothing to resolve
        const cycleId = this.#cycleId;
        clearTimeout(this.#graceTimer);
        this.#graceTimer = setTimeout(() => {
            // A newer cycle already started while this timer was pending — it would
            // be wrong to resolve THIS outcome onto that different, still-running
            // cycle. Same "stale timer, cancel instead of misattribute" shape as the
            // Tracker/Time SideCar race this codebase already knows about elsewhere.
            if (this.#cycleId !== cycleId) return;
            this.lastOutcome.set(this.#messageSeenThisCycle ? 'success' : 'failed');
            this.phase.set(GENERATION_PHASE.IDLE);
        }, this.#outcomeGraceMs);
    }

    #onMessageSeen() {
        if (this.phase.peek() !== GENERATION_PHASE.GENERATING) return;
        this.#messageSeenThisCycle = true;
    }

    snapshot() {
        return { phase: this.phase(), lastOutcome: this.lastOutcome(), toolCallsInCycle: this.toolCallsInCycle() };
    }
}

/**
 * Top-level orchestrator: owns the main-LLM tracker above, and republishes both
 * it AND SidecarManager's own per-worker states (see sidecar-manager.js's
 * workerStates()) onto the shared bus under one namespace. Purely observational
 * — reserve()d with a schema like any other bus data, never `persist` (this is
 * live/in-memory operational state; nothing about "what's happening right now"
 * is meaningful to restore after a reload).
 */
export class StateTrack {
    mainLlm;
    #bus;
    #sidecar;
    #stopEffect = null;

    constructor(getContext, bus, sidecarManager) {
        this.mainLlm = new MainLlmStateTrack(getContext);
        this.#bus = bus;
        this.#sidecar = sidecarManager;
        this.#bus.reserve(NAMESPACE, 'main', { name: 'State-Track: main LLM generation state', schema: { type: 'object' } });
        this.#bus.reserve(NAMESPACE, 'sidecars', { name: 'State-Track: SideCar worker states', schema: { type: 'array' } });
    }

    start() {
        this.mainLlm.start();
        this.#stopEffect = effect(() => {
            this.#bus.set(NAMESPACE, 'main', this.mainLlm.snapshot());
            this.#bus.set(NAMESPACE, 'sidecars', this.#sidecar.workerStates());
        });
    }

    dispose() {
        this.#stopEffect?.();
        this.mainLlm.dispose();
    }
}
