const METADATA_KEY = 'stme_tracker_state';

/**
 * Per-chat key/value state for the Tracker module. Only whitelisted field
 * names are ever written, so stale keys from a previous field configuration
 * are simply ignored rather than deleted (nothing here assumes the field
 * list is stable across sessions).
 */
export function createTrackerStore(context) {
    const metadata = () => context().chatMetadata;
    const state = () => (metadata()[METADATA_KEY] ??= {});
    const save = () => context().saveMetadataDebounced?.();

    return {
        get: () => ({ ...state() }),

        /** Writes only the keys present in `fields`; other keys in `patch` are ignored. */
        set(patch, fields) {
            const current = state();
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

        reset() {
            for (const key of Object.keys(state())) delete state()[key];
            save();
        },
    };
}
