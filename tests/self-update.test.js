import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCoreUpdate, applyCoreUpdate, deriveExtensionName } from '../core/self-update.js';

test('deriveExtensionName pulls the folder name from a real extension script URL, third-party or first-party', () => {
    assert.equal(deriveExtensionName('https://host/scripts/extensions/third-party/ST/index.js'), 'ST');
    assert.equal(deriveExtensionName('https://host/scripts/extensions/ST/index.js'), 'ST');
    assert.equal(deriveExtensionName('https://host/scripts/extensions/My%20Extension/index.js'), 'My Extension');
});

test('deriveExtensionName is null (never throws) for anything that does not match the expected shape', () => {
    assert.equal(deriveExtensionName('https://host/some/other/path.js'), null);
    assert.equal(deriveExtensionName(undefined), null);
    assert.equal(deriveExtensionName(''), null);
});

function makeContext(fetchImpl) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    return { context: { getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) }, restore: () => { globalThis.fetch = originalFetch; } };
}

test('checkCoreUpdate: no extensionName means nothing to check, never calls fetch', async () => {
    let called = false;
    const { context, restore } = makeContext(async () => { called = true; return { ok: true, json: async () => ({}) }; });
    try {
        const result = await checkCoreUpdate(context, null);
        assert.deepEqual(result, { checked: false });
        assert.equal(called, false);
    } finally { restore(); }
});

test('checkCoreUpdate reports checked:true and the real isUpToDate value on a successful call', async () => {
    let requestBody;
    const { context, restore } = makeContext(async (url, options) => {
        requestBody = JSON.parse(options.body);
        assert.equal(url, '/api/extensions/version');
        return { ok: true, json: async () => ({ isUpToDate: false, currentBranchName: 'main' }) };
    });
    try {
        const result = await checkCoreUpdate(context, 'ST');
        assert.deepEqual(result, { checked: true, upToDate: false });
        assert.deepEqual(requestBody, { extensionName: 'ST' });
    } finally { restore(); }
});

test('checkCoreUpdate degrades to checked:false — never throws — on a non-git install (404) or a network error', async () => {
    const { context: context404, restore: restore404 } = makeContext(async () => ({ ok: false, status: 404 }));
    try { assert.deepEqual(await checkCoreUpdate(context404, 'ST'), { checked: false }); } finally { restore404(); }

    const { context: contextThrow, restore: restoreThrow } = makeContext(async () => { throw new Error('network down'); });
    try { assert.deepEqual(await checkCoreUpdate(contextThrow, 'ST'), { checked: false }); } finally { restoreThrow(); }
});

test('applyCoreUpdate reports applied:true on a successful git pull', async () => {
    const { context, restore } = makeContext(async () => ({ ok: true, json: async () => ({ isUpToDate: true, shortCommitHash: 'abc123' }) }));
    try {
        const result = await applyCoreUpdate(context, 'ST');
        assert.deepEqual(result, { applied: true, isUpToDate: true });
    } finally { restore(); }
});

test('applyCoreUpdate reports applied:false with an error message — never throws — when the pull fails', async () => {
    const { context, restore } = makeContext(async () => ({ ok: false, status: 500 }));
    try {
        const result = await applyCoreUpdate(context, 'ST');
        assert.equal(result.applied, false);
        assert.match(result.error, /500/);
    } finally { restore(); }
});

test('applyCoreUpdate refuses cleanly (no fetch) without an extensionName', async () => {
    let called = false;
    const { context, restore } = makeContext(async () => { called = true; return { ok: true, json: async () => ({}) }; });
    try {
        const result = await applyCoreUpdate(context, null);
        assert.equal(result.applied, false);
        assert.equal(called, false);
    } finally { restore(); }
});
