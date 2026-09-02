import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleDataBus } from '../core/data-bus.js';

test('ModuleDataBus exchanges arbitrary values by namespace without ST state', () => {
    const bus = new ModuleDataBus();
    const object = { nested: ['any', 'value'] };
    let received;
    const unsubscribe = bus.subscribe('time', 'result', value => { received = value; });
    bus.set('time', 'result', object);
    assert.equal(bus.get('time', 'result'), object);
    assert.equal(received, object);
    unsubscribe();
    bus.set('time', 'result', 'next');
    assert.equal(received, object);
    assert.equal(bus.get('missing', 'key', 'fallback'), 'fallback');
});
