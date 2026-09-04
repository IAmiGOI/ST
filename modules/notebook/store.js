const METADATA_KEY = 'stme_notebook_notes';
const SETTINGS_KEY = 'stme_notebook_settings';
const defaults = Object.freeze({ maxNotes: 12, cleanupBatch: 4, injectionDepth: 4 });

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

// One "token" the model plausibly writes as part of a date/time — used to build a
// whole-line grammar below, never matched loosely mid-sentence.
const TIME_TOKEN = '\\(?\\s*(?:day\\s*\\d+|year\\s*\\d+|\\d{1,4}[:.]\\d{2}\\s*(?:am|pm)?|\\d{1,4}|' +
    '(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)\\w*day|' +
    'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|' +
    'morning|afternoon|evening|night|noon|midnight|dawn|dusk)\\s*\\)?';
// Anchored to the WHOLE first line, not a prefix — a line only matches if it is
// nothing BUT time-shaped tokens and light punctuation, start to end. This is
// deliberately narrow: missing a real duplicate timestamp just leaves one redundant
// line behind (harmless, user can delete it); a loose match risks eating real note
// text that merely opens with a weekday or month name ("Monday's plan is..."). The
// separator between tokens is OPTIONAL (not required) because a preset like
// "09:20 AM(Morning)" butts a token directly against the next with no space at all.
const TIME_LINE_RE = new RegExp(`^\\s*(?:${TIME_TOKEN})(?:[\\s,.:]*(?:${TIME_TOKEN}))*\\s*[:\\-—]?\\s*$`, 'i');

/**
 * Removes a leading line that is ENTIRELY a date/time (e.g. a model imitating the
 * "Day 2, 14:00 (Afternoon)" style it sees in RP Time's own chat badges) so it isn't
 * shown twice next to the note's own system-applied timestamp. Only called when a
 * timestamp is actually about to be applied to this note (see the `timestamp`
 * parameter on add()/update() below) — with nothing to duplicate, stripping would
 * just be destructive for no reason.
 */
export function stripLeadingTimeLine(content) {
    const text = String(content ?? '');
    const newline = text.indexOf('\n');
    if (newline < 0) return text; // a single-line note has nothing to strip a line FROM
    const firstLine = text.slice(0, newline);
    if (!TIME_LINE_RE.test(firstLine)) return text;
    return text.slice(newline + 1).replace(/^\s+/, '');
}

export function createNotebookStore(context) {
    const metadata = () => context().chatMetadata;
    const notes = () => (metadata()[METADATA_KEY] ??= []);
    const save = () => context().saveMetadataDebounced?.();
    // Only ever writes chatMetadata when a value is actually out of range — a
    // mere read (e.g. inject() on every CHAT_CHANGED) must not mutate chat state.
    // Previously this clamped and wrote all three fields unconditionally on every
    // call, so simply switching chats — no note ever touched — silently wrote to
    // chatMetadata each time. See MODULES.md's note on store `settings()`/`get()`
    // helpers for why that's the wrong default: a read that behaves like a write
    // is exactly the kind of thing an engine-level chat-changed storm guard exists
    // to catch, but it should never be needed for something this avoidable.
    const settings = () => {
        const value = metadata()[SETTINGS_KEY] ??= {};
        const nextMaxNotes = clamp(value.maxNotes, 1, 500, defaults.maxNotes);
        if (value.maxNotes !== nextMaxNotes) value.maxNotes = nextMaxNotes;
        const nextCleanupBatch = clamp(value.cleanupBatch, 1, value.maxNotes, defaults.cleanupBatch);
        if (value.cleanupBatch !== nextCleanupBatch) value.cleanupBatch = nextCleanupBatch;
        const nextInjectionDepth = clamp(value.injectionDepth, 0, 100, defaults.injectionDepth);
        if (value.injectionDepth !== nextInjectionDepth) value.injectionDepth = nextInjectionDepth;
        return value;
    };

    return {
        defaults,
        notes: () => notes().map(note => ({ ...note })),
        settings: () => ({ ...settings() }),
        setSettings(values) {
            const current = settings();
            if ('maxNotes' in values) current.maxNotes = clamp(values.maxNotes, 1, 500, defaults.maxNotes);
            if ('cleanupBatch' in values) current.cleanupBatch = clamp(values.cleanupBatch, 1, current.maxNotes, defaults.cleanupBatch);
            if ('injectionDepth' in values) current.injectionDepth = clamp(values.injectionDepth, 0, 100, defaults.injectionDepth);
            current.cleanupBatch = clamp(current.cleanupBatch, 1, current.maxNotes, defaults.cleanupBatch);
            save();
            return { ...current };
        },
        /**
         * `timestamp`, if given, is a plain string already resolved by the caller —
         * this store never talks to RP Time itself (see MODULES.md's host.services
         * section: index.js gets it via `host.services.request('time').getCurrent()`
         * and passes the result in here). Stored once and never overwritten by a
         * later update() — a note's timestamp means "when it was written," not
         * "when it was last touched."
         */
        add(title, content, timestamp) {
            title = String(title ?? '').trim();
            content = String(content ?? '').trim();
            if (timestamp) content = stripLeadingTimeLine(content);
            if (!title || !content) throw new Error('Title and content are required.');
            const current = settings();
            let removed = 0;
            if (notes().length >= current.maxNotes) {
                removed = Math.min(notes().length, Math.max(current.cleanupBatch, notes().length + 1 - current.maxNotes));
                notes().splice(0, removed);
            }
            const note = { id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, title, content, updated: Date.now(), timestamp: timestamp || null };
            notes().push(note);
            save();
            return { ...note, removed };
        },
        /** Removes one note by id. Returns true if a note was actually found and removed, false for an unknown id (never throws — a delete button clicked twice, or on an already-gone note, is a no-op). */
        remove(id) {
            const list = notes();
            const index = list.findIndex(item => item.id === id);
            if (index < 0) return false;
            list.splice(index, 1);
            save();
            return true;
        },
        update(id, title, content, timestamp) {
            const note = notes().find(item => item.id === id);
            if (!note) throw new Error(`Note ${id} was not found.`);
            const nextTitle = title === undefined ? note.title : String(title ?? '').trim();
            let nextContent = content === undefined ? note.content : String(content ?? '').trim();
            if (timestamp && content !== undefined) nextContent = stripLeadingTimeLine(nextContent);
            if (!nextTitle || !nextContent) throw new Error('Title and content cannot be empty.');
            Object.assign(note, { title: nextTitle, content: nextContent, updated: Date.now() });
            // Backfill only — a note created before RP Time was enabled gets one the
            // first time it's touched afterward; a note that already has one keeps it.
            if (timestamp && !note.timestamp) note.timestamp = timestamp;
            save();
            return { ...note };
        },
        prompt() {
            const currentNotes = notes();
            if (!currentNotes.length) return '';
            return ['[Private Notebook — notes written by the assistant for its working memory.]', ...currentNotes.map(note => `- [${note.id}]${note.timestamp ? ` (${note.timestamp})` : ''} ${note.title}: ${note.content}`)].join('\n');
        },
    };
}
