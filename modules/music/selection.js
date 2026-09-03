/** How many of `sceneKeys` a track's own keys contain. */
function overlapCount(trackKeys, sceneKeys) {
    const scene = new Set(sceneKeys);
    let count = 0;
    for (const key of trackKeys) if (scene.has(key)) count++;
    return count;
}

/**
 * Tracks eligible to play for the current scene: the ones whose key set overlaps
 * `sceneKeys` the MOST (ties are all kept — the weighted pick below decides among
 * them). An empty `sceneKeys` (no classification yet, or Tracker unavailable) makes
 * every track eligible — better to play something than nothing.
 */
export function matchTracks(tracks, sceneKeys) {
    if (!sceneKeys?.length) return [...tracks];
    const scored = tracks
        .map(track => ({ track, score: overlapCount(track.keys ?? [], sceneKeys) }))
        .filter(entry => entry.score > 0);
    if (!scored.length) return [];
    const best = Math.max(...scored.map(entry => entry.score));
    return scored.filter(entry => entry.score === best).map(entry => entry.track);
}

/**
 * Weighted random pick where a track's weight is `1 / (playCount + 1)` — a
 * never-played track (playCount 0) is twice as likely as one played once, and
 * so on, so the rotation self-corrects toward whatever has played least without
 * ever fully excluding a track that's merely been played a lot. `randomFn`
 * defaults to Math.random but is injectable for deterministic tests.
 */
export function pickWeighted(tracks, randomFn = Math.random) {
    if (!tracks.length) return null;
    if (tracks.length === 1) return tracks[0];
    const weights = tracks.map(track => 1 / ((track.playCount ?? 0) + 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = randomFn() * total;
    for (let i = 0; i < tracks.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return tracks[i];
    }
    return tracks[tracks.length - 1];
}

/** The whole pipeline: narrow to the best-matching tracks, then weighted-pick among them. `null` if nothing is eligible (empty library, or scene keys match nothing). */
export function selectTrack(tracks, sceneKeys, randomFn = Math.random) {
    return pickWeighted(matchTracks(tracks, sceneKeys), randomFn);
}
