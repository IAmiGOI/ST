import test from 'node:test';
import assert from 'node:assert/strict';
import { signal, effect, computed, isSignal, unwrap } from '../core/reactive.js';

test('signal reads its value and set() updates it', () => {
    const count = signal(1);
    assert.equal(count(), 1);
    count.set(2);
    assert.equal(count(), 2);
    count.set(current => current + 1);
    assert.equal(count(), 3);
});

test('signal.set is a no-op for an equal value and does not notify subscribers', () => {
    const count = signal(1);
    let runs = 0;
    effect(() => { count(); runs++; });
    assert.equal(runs, 1);
    count.set(1);
    assert.equal(runs, 1);
    count.set(2);
    assert.equal(runs, 2);
});

test('effect reruns only when a signal it actually read changes', () => {
    const a = signal(1);
    const b = signal(10);
    let seen = null;
    let runs = 0;
    effect(() => { seen = a(); runs++; });
    assert.equal(runs, 1);
    assert.equal(seen, 1);
    b.set(20);
    assert.equal(runs, 1, 'unrelated signal must not retrigger the effect');
    a.set(2);
    assert.equal(runs, 2);
    assert.equal(seen, 2);
});

test('effect dependencies are re-tracked on every run (conditional reads)', () => {
    const useA = signal(true);
    const a = signal('a1');
    const b = signal('b1');
    let seen = null;
    effect(() => { seen = useA() ? a() : b(); });
    assert.equal(seen, 'a1');
    useA.set(false);
    assert.equal(seen, 'b1');
    a.set('a2'); // no longer read — must not affect `seen` via a stale subscription
    assert.equal(seen, 'b1');
    b.set('b2');
    assert.equal(seen, 'b2');
});

test('disposing an effect stops further reruns', () => {
    const count = signal(0);
    let runs = 0;
    const dispose = effect(() => { count(); runs++; });
    assert.equal(runs, 1);
    dispose();
    count.set(1);
    assert.equal(runs, 1);
});

test('computed derives a value and updates when its dependencies change', () => {
    const price = signal(10);
    const qty = signal(2);
    const total = computed(() => price() * qty());
    assert.equal(total(), 20);
    qty.set(3);
    assert.equal(total(), 30);
});

test('isSignal / unwrap tell signals and computed values apart from plain values', () => {
    const count = signal(1);
    const doubled = computed(() => count() * 2);
    assert.equal(isSignal(count), true);
    assert.equal(isSignal(doubled), true);
    assert.equal(isSignal(42), false);
    assert.equal(isSignal(() => {}), false);
    assert.equal(unwrap(count), 1);
    assert.equal(unwrap(doubled), 2);
    assert.equal(unwrap('plain'), 'plain');
});
