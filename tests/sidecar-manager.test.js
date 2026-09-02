import test from 'node:test';
import assert from 'node:assert/strict';
import { SidecarManager } from '../core/sidecar-manager.js';

test('SideCar Manager migrates a legacy SideCar configuration into a worker', () => {
    const root = { sidecar: { enabled: true, endpoint: 'https://example.test/v1', model: 'small' } };
    const manager = new SidecarManager(() => root, () => {});
    assert.equal(manager.configs().length, 1);
    assert.equal(root.sidecar, undefined);
    assert.equal(manager.configs()[0].id, 'primary');
});

test('SideCar Manager adds independent workers', () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: false }] };
    const manager = new SidecarManager(() => root, () => {});
    const id = manager.add();
    assert.equal(manager.configs().length, 2);
    assert.notEqual(id, 'primary');
    assert.notEqual(manager.configs()[0], manager.configs()[1]);
});
