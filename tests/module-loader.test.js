import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceUrl, resolveModuleUrl } from '../core/module-loader.js';

test('parseSourceUrl recognizes a bare repo link, with or without .git / trailing slash', () => {
    assert.deepEqual(parseSourceUrl('https://github.com/IAmiGOI/ST'), { kind: 'repo', owner: 'IAmiGOI', repo: 'ST', branch: null });
    assert.deepEqual(parseSourceUrl('https://github.com/IAmiGOI/ST.git'), { kind: 'repo', owner: 'IAmiGOI', repo: 'ST', branch: null });
    assert.deepEqual(parseSourceUrl('https://github.com/IAmiGOI/ST/'), { kind: 'repo', owner: 'IAmiGOI', repo: 'ST', branch: null });
});

test('parseSourceUrl recognizes a repo link pinned to a branch via /tree/', () => {
    assert.deepEqual(parseSourceUrl('https://github.com/IAmiGOI/ST/tree/dev'), { kind: 'repo', owner: 'IAmiGOI', repo: 'ST', branch: 'dev' });
});

test('parseSourceUrl recognizes a direct file link via /blob/', () => {
    assert.deepEqual(
        parseSourceUrl('https://github.com/user/repo/blob/main/modules/example/index.js'),
        { kind: 'file', owner: 'user', repo: 'repo', branch: 'main', path: 'modules/example/index.js' },
    );
});

test('parseSourceUrl treats anything else (already-raw or non-GitHub URLs) as a pass-through', () => {
    const raw = 'https://raw.githubusercontent.com/user/repo/main/module.js';
    assert.deepEqual(parseSourceUrl(raw), { kind: 'raw', url: raw });
    const other = 'https://example.com/module.js';
    assert.deepEqual(parseSourceUrl(other), { kind: 'raw', url: other });
});

function fakeFetch(routes) {
    return async url => {
        for (const [pattern, respond] of routes) {
            if (typeof pattern === 'string' ? url === pattern : pattern.test(url)) return respond(url);
        }
        return { ok: false, status: 404 };
    };
}

test('resolveModuleUrl on a direct /blob/ link builds the raw URL without any network call', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true }; };
    const result = await resolveModuleUrl('https://github.com/user/repo/blob/main/index.js', { fetchImpl });
    assert.equal(result, 'https://raw.githubusercontent.com/user/repo/main/index.js');
    assert.equal(calls, 0, 'a file link is already fully specified — no API calls needed');
});

test('resolveModuleUrl on a bare repo link finds manifest.json and reads its "js" field', async () => {
    const fetchImpl = fakeFetch([
        [/api\.github\.com\/repos\/IAmiGOI\/ST$/, () => ({ ok: true, json: async () => ({ default_branch: 'main' }) })],
        [/api\.github\.com\/repos\/IAmiGOI\/ST\/contents/, () => ({ ok: true, json: async () => ([{ name: 'manifest.json' }, { name: 'index.js' }, { name: 'style.css' }]) })],
        [/raw\.githubusercontent\.com\/IAmiGOI\/ST\/main\/manifest\.json/, () => ({ ok: true, json: async () => ({ js: 'index.js' }) })],
    ]);
    const result = await resolveModuleUrl('https://github.com/IAmiGOI/ST', { fetchImpl });
    assert.equal(result, 'https://raw.githubusercontent.com/IAmiGOI/ST/main/index.js');
});

test('resolveModuleUrl falls back to module.js, then index.js, when there is no manifest.json', async () => {
    const withModuleJs = fakeFetch([
        [/repos\/a\/b$/, () => ({ ok: true, json: async () => ({ default_branch: 'main' }) })],
        [/contents/, () => ({ ok: true, json: async () => ([{ name: 'module.js' }, { name: 'README.md' }]) })],
    ]);
    assert.equal(await resolveModuleUrl('https://github.com/a/b', { fetchImpl: withModuleJs }), 'https://raw.githubusercontent.com/a/b/main/module.js');

    const withIndexJsOnly = fakeFetch([
        [/repos\/a\/b$/, () => ({ ok: true, json: async () => ({ default_branch: 'trunk' }) })],
        [/contents/, () => ({ ok: true, json: async () => ([{ name: 'index.js' }]) })],
    ]);
    assert.equal(await resolveModuleUrl('https://github.com/a/b', { fetchImpl: withIndexJsOnly }), 'https://raw.githubusercontent.com/a/b/trunk/index.js');
});

test('resolveModuleUrl uses the branch already given in a /tree/ link and skips the default-branch lookup', async () => {
    let defaultBranchCalls = 0;
    const fetchImpl = fakeFetch([
        [/repos\/a\/b$/, () => { defaultBranchCalls++; return { ok: true, json: async () => ({ default_branch: 'main' }) }; }],
        [/contents\?ref=dev/, () => ({ ok: true, json: async () => ([{ name: 'index.js' }]) })],
    ]);
    const result = await resolveModuleUrl('https://github.com/a/b/tree/dev', { fetchImpl });
    assert.equal(result, 'https://raw.githubusercontent.com/a/b/dev/index.js');
    assert.equal(defaultBranchCalls, 0, 'the branch was already known from the URL');
});

test('resolveModuleUrl throws a clear error when no entry file can be found', async () => {
    const fetchImpl = fakeFetch([
        [/repos\/a\/b$/, () => ({ ok: true, json: async () => ({ default_branch: 'main' }) })],
        [/contents/, () => ({ ok: true, json: async () => ([{ name: 'README.md' }]) })],
    ]);
    await assert.rejects(resolveModuleUrl('https://github.com/a/b', { fetchImpl }), /Could not find a module entry file/);
});

test('resolveModuleUrl surfaces a clear error when the repository itself cannot be read', async () => {
    const fetchImpl = fakeFetch([[/repos\/a\/b$/, () => ({ ok: false, status: 404 })]]);
    await assert.rejects(resolveModuleUrl('https://github.com/a/b', { fetchImpl }), /Could not read repository/);
});
