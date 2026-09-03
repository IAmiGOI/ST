const METADATA_KEY = 'stme_tracker_state';

/**
 * Per-chat key/value state for the Tracker module, namespaced by tracker
 * block id so independent blocks never see each other's fields. Only
 * whitelisted field names are ever written, so stale keys from a previous
 * field configuration are simply ignored rather than deleted.
 */
export function createTrackerStore(context) {
    const metadata = () => context().chatMetadata;
    const root = () => (metadata()[METADATA_KEY] ??= {});
    const save = () => context().saveMetadataDebounced?.();

    return {
        get: (blockId) => ({ ...(root()[blockId] ?? {}) }),

        /** Writes only the keys present in `fields`; other keys in `patch` are ignored. */
        set(blockId, patch, fields) {
            const current = root()[blockId] ??= {};
            let changed = false;
            for (const key of fields) {
                if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
                const value = patch[key];
                if (value === undefined) continue;
                if (current[key] !== value) { current[key] = value; changed = true; }
            }
            if (changed) save();
            return { ...current };
        },

        reset(blockId) {
            if (!(blockId in root())) return;
            delete root()[blockId];
            save();
        },
    };
}
