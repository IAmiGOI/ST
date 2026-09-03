import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseCoreUpdate } from '../core/update-diagnostics.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('diagnoseCoreUpdate is not applicable without a currentCommitHash/currentBranchName — a non-git install, or a skipped/failed /version check', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, text: async () => SHA_A }; };
    assert.deepEqual(await diagnoseCoreUpdate({ currentCommitHash: null, currentBranchName: 'main', owner: 'o', repo: 'r' }, { fetchImpl }), { applicable: false });
    assert.deepEqual(await diagnoseCoreUpdate({ currentCommitHash: SHA_A, currentBranchName: null, owner: 'o', repo: 'r' }, { fetchImpl }), { applicable: false });
    assert.equal(called, false);
});

test('diagnoseCoreUpdate reports matches:true when the local commit equals GitHub\'s real branch HEAD', async () => {
    let requestedUrl;
    const fetchImpl = async (url, options) => { requestedUrl = url; assert.equal(options.headers.Accept, 'application/vnd.github.sha'); return { ok: true, text: async () => SHA_A }; };
    const result = await diagnoseCoreUpdate({ currentCommitHash: SHA_A, currentBranchName: 'main', owner: 'IAmiGOI', repo: 'ST' }, { fetchImpl });
    assert.deepEqual(result, { applicable: true, matches: true, localSha: SHA_A, remoteSha: SHA_A, branch: 'main' });
    assert.equal(requestedUrl, 'https://api.github.com/repos/IAmiGOI/ST/commits/main');
});

test('diagnoseCoreUpdate reports matches:false — the exact bug #3 signature when combined with ST reporting upToDate:true — when the local commit is behind GitHub\'s real HEAD', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => SHA_B });
    const result = await diagnoseCoreUpdate({ currentCommitHash: SHA_A, currentBranchName: 'main', owner: 'IAmiGOI', repo: 'ST' }, { fetchImpl });
    assert.deepEqual(result, { applicable: true, matches: false, localSha: SHA_A, remoteSha: SHA_B, branch: 'main' });
});

test('diagnoseCoreUpdate compares case-insensitively', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => SHA_A.toUpperCase() });
    const result = await diagnoseCoreUpdate({ currentCommitHash: SHA_A, currentBranchName: 'main', owner: 'IAmiGOI', repo: 'ST' }, { fetchImpl });
    assert.equal(result.matches, true);
});

test('diagnoseCoreUpdate falls back to parsing a JSON commit object if something strips the sha Accept header', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ sha: SHA_A, commit: {} }) });
    const result = await diagnoseCoreUpdate({ currentCommitHash: SHA_A, currentBranchName: 'main', owner: 'IAmiGOI', repo: 'ST' }, { fetchImpl });
    assert.equal(result.matches, true);
    assert.equal(result.remoteSha, SHA_A);
});

test('diagnoseCoreUpdate never throws — degrades to applicable:false with an error on any GitHub API failure', async () => {
    const fetchImpl404 = async () => ({ ok: false, status: 404 });
    const result404 = await diagnoseCoreUpdate({ currentCommitHash: SHA_A, currentBranchName: 'main', owner: 'IAmiGOI', repo: 'ST' }, { fetchImpl: fetchImpl404 });
    assert.equal(result404.applicable, false);
    assert.match(result404.error, /404/);

    const fetchImplThrow = async () => { throw new Error('network down'); };
    const resultThrow = await diagnoseCoreUpdate({ currentCommitHash: SHA_A, currentBranchName: 'main', owner: 'IAmiGOI', repo: 'ST' }, { fetchImpl: fetchImplThrow });
    assert.equal(resultThrow.applicable, false);
    assert.match(resultThrow.error, /network down/);
});
