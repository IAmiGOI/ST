import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCoreUpdate, applyCoreUpdate, deriveExtensionName, isGlobalInstall } from '../core/self-update.js';

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

test('isGlobalInstall asks the server via /api/extensions/discover and matches this extension by name (bare, or "third-party/<name>")', async () => {
    const { context, restore } = makeContext(async url => {
        assert.equal(url, '/api/extensions/discover');
        return { ok: true, json: async () => ([{ type: 'system', name: 'quick-reply' }, { type: 'global', name: 'third-party/ST' }]) };
    });
    try { assert.equal(await isGlobalInstall('ST', context), true); } finally { restore(); }
});

test('isGlobalInstall is false for a "local" (per-user) entry — the exact case a URL heuristic used to get wrong', async () => {
    // Both 'local' and 'global' installs share the identical "third-party/<name>" URL
    // prefix server-side — this is precisely why the old import.meta.url-based check
    // could never tell them apart and had to be replaced with a real server lookup.
    const { context, restore } = makeContext(async () => ({ ok: true, json: async () => ([{ type: 'local', name: 'third-party/ST' }]) }));
    try { assert.equal(await isGlobalInstall('ST', context), false); } finally { restore(); }
});

test('isGlobalInstall is false — never throws — with no extensionName, a discover() failure, a non-array body, or no matching entry', async () => {
    const { context: noName } = makeContext(async () => { throw new Error('must not be called'); });
    assert.equal(await isGlobalInstall(null, noName), false);

    const { context: notOk, restore: restoreNotOk } = makeContext(async () => ({ ok: false, status: 500 }));
    try { assert.equal(await isGlobalInstall('ST', notOk), false); } finally { restoreNotOk(); }

    const { context: throws, restore: restoreThrows } = makeContext(async () => { throw new Error('network down'); });
    try { assert.equal(await isGlobalInstall('ST', throws), false); } finally { restoreThrows(); }

    const { context: malformed, restore: restoreMalformed } = makeContext(async () => ({ ok: true, json: async () => ({ not: 'an array' }) }));
    try { assert.equal(await isGlobalInstall('ST', malformed), false); } finally { restoreMalformed(); }

    const { context: noMatch, restore: restoreNoMatch } = makeContext(async () => ({ ok: true, json: async () => ([{ type: 'global', name: 'third-party/SomeOtherExtension' }]) }));
    try { assert.equal(await isGlobalInstall('ST', noMatch), false); } finally { restoreNoMatch(); }
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
        assert.deepEqual(result, { checked: true, upToDate: false, currentCommitHash: null, currentBranchName: 'main', remoteUrl: null });
        assert.deepEqual(requestBody, { extensionName: 'ST' });
    } finally { restore(); }
});

test('checkCoreUpdate passes through currentCommitHash/currentBranchName/remoteUrl — update-diagnostics.js needs the real local commit to cross-check against GitHub', async () => {
    const { context, restore } = makeContext(async () => ({
        ok: true,
        json: async () => ({ isUpToDate: true, currentCommitHash: 'deadbeef'.repeat(5), currentBranchName: 'main', remoteUrl: 'https://github.com/IAmiGOI/ST.git' }),
    }));
    try {
        const result = await checkCoreUpdate(context, 'ST');
        assert.equal(result.currentCommitHash, 'deadbeef'.repeat(5));
        assert.equal(result.currentBranchName, 'main');
        assert.equal(result.remoteUrl, 'https://github.com/IAmiGOI/ST.git');
    } finally { restore(); }
});

test('checkCoreUpdate omits "global" by default, and includes global:true only when asked — a global install found the server looking in the wrong directory otherwise', async () => {
    let requestBody;
    const { context, restore } = makeContext(async (_url, options) => { requestBody = JSON.parse(options.body); return { ok: true, json: async () => ({ isUpToDate: true }) }; });
    try {
        await checkCoreUpdate(context, 'ST');
        assert.deepEqual(requestBody, { extensionName: 'ST' }, 'no "global" key at all by default, not global:false');
        await checkCoreUpdate(context, 'ST', { global: true });
        assert.deepEqual(requestBody, { extensionName: 'ST', global: true });
    } finally { restore(); }
});

test('applyCoreUpdate also threads global:true through to the update request', async () => {
    let requestBody;
    const { context, restore } = makeContext(async (_url, options) => { requestBody = JSON.parse(options.body); return { ok: true, json: async () => ({ isUpToDate: true }) }; });
    try {
        await applyCoreUpdate(context, 'ST', { global: true });
        assert.deepEqual(requestBody, { extensionName: 'ST', global: true });
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
