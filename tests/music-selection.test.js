import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTracks, pickWeighted, selectTrack } from '../modules/music/selection.js';

const tavernSong = { id: 'a', keys: ['tavern', 'night'], playCount: 0 };
const battleTheme = { id: 'b', keys: ['combat', 'boss'], playCount: 0 };
const nightAmbience = { id: 'c', keys: ['night'], playCount: 0 };
const library = [tavernSong, battleTheme, nightAmbience];

test('matchTracks with no scene keys makes every track eligible', () => {
    assert.deepEqual(matchTracks(library, []), library);
    assert.deepEqual(matchTracks(library, undefined), library);
});

test('matchTracks keeps only the tracks with the highest overlap, ties included', () => {
    assert.deepEqual(matchTracks(library, ['night']), [tavernSong, nightAmbience]);
    assert.deepEqual(matchTracks(library, ['tavern', 'night']), [tavernSong]); // 2 matches beats nightAmbience's 1
});

test('matchTracks returns nothing when no track has any overlap at all', () => {
    assert.deepEqual(matchTracks(library, ['victory']), []);
});

test('pickWeighted returns null for an empty list and the only item for a single-item list', () => {
    assert.equal(pickWeighted([]), null);
    assert.equal(pickWeighted([tavernSong]), tavernSong);
});

test('pickWeighted favors a never-played track over one played many times', () => {
    const fresh = { id: 'fresh', playCount: 0 };
    const stale = { id: 'stale', playCount: 20 };
    // With playCount 0 vs 20, weight(fresh)=1, weight(stale)=1/21 — fresh should win
    // for the vast majority of the roll range. Sample deterministically across the range.
    let freshWins = 0;
    for (let i = 0; i < 100; i++) {
        const roll = i / 100;
        const picked = pickWeighted([fresh, stale], () => roll);
        if (picked === fresh) freshWins++;
    }
    assert.ok(freshWins >= 90, `expected the never-played track to win almost every roll, got ${freshWins}/100`);
});

test('pickWeighted is deterministic given a fixed randomFn, and covers the whole weighted range', () => {
    const a = { id: 'a', playCount: 0 };
    const b = { id: 'b', playCount: 0 };
    // Equal weights (1 each, total 2): roll < 0.5 of total picks a, the rest picks b.
    assert.equal(pickWeighted([a, b], () => 0), a);
    assert.equal(pickWeighted([a, b], () => 0.99), b);
});

test('selectTrack composes matching and weighted picking end to end', () => {
    const picked = selectTrack(library, ['combat'], () => 0);
    assert.equal(picked, battleTheme, 'the only combat-tagged track is the only eligible one');
    assert.equal(selectTrack([], ['combat']), null, 'an empty library never throws, just returns null');
    assert.equal(selectTrack(library, ['nonexistent-key']), null, 'no eligible tracks also returns null cleanly');
});
