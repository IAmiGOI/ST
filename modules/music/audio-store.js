const DB_NAME = 'stme-music';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

/**
 * Where imported audio files actually live: IndexedDB, in this browser only.
 * ST Module Engine's own settings (`extensionSettings`/`chatMetadata`) are plain
 * JSON that SillyTavern reads and writes whole — audio bytes have no business
 * there. This store only ever holds Blob/File values keyed by track id; the
 * track's metadata (name, keys, playCount) lives in `host.moduleSettings()` as
 * usual and is the only part that's portable/exportable. Losing this store
 * (a different browser, cleared site data) loses the audio, not the library
 * structure — re-importing the same files under the same ids would restore it,
 * though nothing here does that automatically.
 */
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore(mode, run) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode);
            const store = tx.objectStore(STORE_NAME);
            const request = run(store);
            // request.result only settles once the request itself succeeds, but that
            // always happens before tx.oncomplete — reading it there is safe.
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
        });
    } finally {
        db.close();
    }
}

export function saveTrackBlob(id, blob) {
    return withStore('readwrite', store => store.put(blob, id));
}

export async function loadTrackBlob(id) {
    return withStore('readonly', store => store.get(id));
}

export function deleteTrackBlob(id) {
    return withStore('readwrite', store => store.delete(id));
}
