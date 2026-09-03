/**
 * Minimal synchronous reactive core: signals + effects + computed. No batching,
 * no async scheduling — UI updates here are driven by discrete user events and
 * bus messages, not high-frequency writes, so eager, synchronous propagation
 * keeps this small and easy to reason about.
 */

let activeEffect = null;

export function signal(initialValue) {
    let value = initialValue;
    const subscribers = new Set();

    function read() {
        if (activeEffect) {
            subscribers.add(activeEffect);
            activeEffect.deps.add(subscribers);
        }
        return value;
    }
    read.isSignal = true;
    read.peek = () => value;
    read.set = (next) => {
        const nextValue = typeof next === 'function' ? next(value) : next;
        if (Object.is(nextValue, value)) return;
        value = nextValue;
        for (const runner of [...subscribers]) runner.schedule();
    };
    read.update = (fn) => read.set(fn(value));
    return read;
}

/** Runs `fn` immediately and again whenever any signal it read changes. Returns a dispose function. */
export function effect(fn) {
    const runner = {
        deps: new Set(),
        disposed: false,
        schedule() { if (!runner.disposed) runner.run(); },
        run() {
            for (const dep of runner.deps) dep.delete(runner);
            runner.deps.clear();
            const previous = activeEffect;
            activeEffect = runner;
            try { fn(); } finally { activeEffect = previous; }
        },
    };
    runner.run();
    return () => {
        runner.disposed = true;
        for (const dep of runner.deps) dep.delete(runner);
        runner.deps.clear();
    };
}

/** A read-only signal derived from other signals. Recomputes eagerly when a dependency changes. */
export function computed(fn) {
    const result = signal(undefined);
    let first = true;
    const dispose = effect(() => { const value = fn(); if (first) { result.set(value); first = false; } else result.set(value); });
    const read = () => result();
    read.isSignal = true;
    read.peek = result.peek;
    read.dispose = dispose;
    return read;
}

/**
 * Runs `fn` with dependency tracking suspended, so any signal it reads is NOT
 * attributed to whichever effect is currently running. Needed anywhere a callback
 * invoked from inside an effect's body does its own, unrelated signal reads — e.g.
 * `show()`/`list()` calling a render callback that reads its own local signals.
 * `activeEffect` is a single shared module-level variable, so without this a bare
 * read inside such a callback silently becomes a dependency of the OUTER effect
 * instead of nothing — a leak that can cause the outer effect to re-run itself
 * (and, in `show()`'s case, re-invoke the callback, which re-subscribes the same
 * read again) forever. See MODULES.md's note on `untrack()`.
 */
export function untrack(fn) {
    const previous = activeEffect;
    activeEffect = null;
    try { return fn(); } finally { activeEffect = previous; }
}

export function isSignal(value) {
    return typeof value === 'function' && value.isSignal === true;
}

/** Reads a value that may or may not be a signal. */
export function unwrap(value) {
    return isSignal(value) ? value() : value;
}
