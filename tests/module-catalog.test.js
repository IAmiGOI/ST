import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogEntry, fetchCatalog, DEFAULT_CATALOG_URL } from '../core/module-catalog.js';

test('parseCatalogEntry accepts a full entry and normalizes every field to a string (or null)', () => {
    const entry = parseCatalogEntry({
        id: 'dice-roller', title: 'Dice Roller', url: 'https://github.com/x/y/blob/main/index.js',
        description: 'Rolls dice.', author: 'someone', version: '1.2.0',
        repo: 'https://github.com/x/y', tags: ['utility', 'chat'], minEngineVersion: '0.1.0',
        updatedAt: '2026-08-01', extraField: 'ignored',
    });
    assert.deepEqual(entry, {
        id: 'dice-roller', title: 'Dice Roller', url: 'https://github.com/x/y/blob/main/index.js',
        description: 'Rolls dice.', author: 'someone', version: '1.2.0', repo: 'https://github.com/x/y',
        tags: ['utility', 'chat'], minEngineVersion: '0.1.0', updatedAt: '2026-08-01',
    });
    assert.equal('extraField' in entry, false, 'unknown fields are dropped, not passed through');
});

test('parseCatalogEntry defaults optional fields and trims id/title/url', () => {
    const entry = parseCatalogEntry({ id: '  dice  ', title: '  Dice  ', url: '  https://x/y.js  ' });
    assert.deepEqual(entry, {
        id: 'dice', title: 'Dice', url: 'https://x/y.js', description: '', author: null, version: null,
        repo: null, tags: [], minEngineVersion: null, updatedAt: null,
    });
});

test('parseCatalogEntry coerces a non-array "tags" to empty and drops blank tag entries', () => {
    assert.deepEqual(parseCatalogEntry({ id: 'x', title: 'X', url: 'https://x', tags: 'not-an-array' }).tags, []);
    assert.deepEqual(parseCatalogEntry({ id: 'x', title: 'X', url: 'https://x', tags: ['utility', '', '  ', 'chat'] }).tags, ['utility', 'chat']);
});

test('parseCatalogEntry returns null for anything missing id, title, or url', () => {
    assert.equal(parseCatalogEntry({ title: 'X', url: 'https://x' }), null, 'missing id');
    assert.equal(parseCatalogEntry({ id: 'x', url: 'https://x' }), null, 'missing title');
    assert.equal(parseCatalogEntry({ id: 'x', title: 'X' }), null, 'missing url');
    assert.equal(parseCatalogEntry({ id: '  ', title: 'X', url: 'https://x' }), null, 'blank-after-trim id counts as missing');
    assert.equal(parseCatalogEntry(null), null);
    assert.equal(parseCatalogEntry('not an object'), null);
});

function fakeFetch(handler) { return async (...args) => handler(...args); }

test('fetchCatalog defaults to DEFAULT_CATALOG_URL when no URL is given', async () => {
    let requestedUrl;
    await fetchCatalog(undefined, {
        fetchImpl: fakeFetch(url => { requestedUrl = url; return { ok: true, json: async () => ({ modules: [] }) }; }),
    });
    assert.equal(requestedUrl, DEFAULT_CATALOG_URL);
});

test('fetchCatalog returns only the valid entries, skipping malformed ones', async () => {
    const entries = await fetchCatalog('https://example.test/catalog.json', {
        fetchImpl: fakeFetch(() => ({
            ok: true,
            json: async () => ({
                modules: [
                    { id: 'good-one', title: 'Good One', url: 'https://x/good.js' },
                    { title: 'Missing id', url: 'https://x/bad.js' },
                    { id: 'also-good', title: 'Also Good', url: 'https://x/also.js', version: '2.0.0' },
                    null,
                ],
            }),
        })),
    });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(e => e.id), ['good-one', 'also-good']);
});

test('fetchCatalog treats a missing/non-array "modules" field as an empty catalog, not an error', async () => {
    const entries = await fetchCatalog('https://example.test/catalog.json', {
        fetchImpl: fakeFetch(() => ({ ok: true, json: async () => ({}) })),
    });
    assert.deepEqual(entries, []);
});

test('fetchCatalog throws a clear error on a network/HTTP failure', async () => {
    await assert.rejects(
        fetchCatalog('https://example.test/catalog.json', { fetchImpl: fakeFetch(() => ({ ok: false, status: 404 })) }),
        /HTTP 404/,
    );
});
