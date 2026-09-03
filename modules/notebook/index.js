import { createNotebookStore } from './store.js';
import { h, list, signal, computed, onDispose, Field, TextInput, TextArea, Button } from '../../core/widgets.js';

const TOOL_NAME = 'Notebook';
const PROMPT_KEY = 'stme_notebook_context';
const BUS_KEY = 'changed';

export const notebookModule = {
    id: 'notebook',
    title: 'Notebook / Notes',
    description: 'Private per-chat working memory exposed as a native function tool.',
    about: 'A private notebook the AI can write in and read back during the story — like sticky notes only it can see, used to remember things (plans, secrets, character goals) that shouldn\'t appear in the actual conversation text.',
    defaultEnabled: true,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/notebook',
    minEngineVersion: '0.1.0',

    activate(host) {
        const store = createNotebookStore(host.context);
        // inject()/notify() run on every CHAT_CHANGED (see onChatChanged below), so calling
        // an ST API unconditionally here means every single chat switch re-issues a
        // setExtensionPrompt call even when nothing about the notebook actually changed.
        // If ST's own prompt manager reacts to that call (e.g. by saving/re-rendering
        // something that can itself provoke another CHAT_CHANGED), that turns "notebook is
        // enabled while a chat opens" into a self-sustaining external loop that no amount of
        // fixing OUR OWN reactive framework can stop, since ST's side keeps calling us right
        // back. Tracking the last value we actually set and skipping a no-op call closes that
        // loop at the source instead of just bounding how much work happens once it starts.
        let lastInjected = null;
        const inject = () => {
            const { injectionDepth } = store.settings();
            const prompt = store.prompt();
            const signature = `${injectionDepth}::${prompt}`;
            if (signature === lastInjected) return;
            lastInjected = signature;
            host.setPrompt(PROMPT_KEY, prompt, 1, injectionDepth, 0);
        };
        let lastNotified = null;
        const notify = () => {
            const signature = JSON.stringify(store.notes()) + JSON.stringify(store.settings());
            if (signature === lastNotified) return;
            lastNotified = signature;
            host.data.set(BUS_KEY, Date.now());
        };
        host.registerTool({
            name: TOOL_NAME,
            displayName: 'Notebook',
            description: 'Private working-memory notebook. Use write to save a title and content, or update with note_id and new title and/or content.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#', type: 'object',
                properties: {
                    action: { type: 'string', enum: ['write', 'update'] },
                    title: { type: 'string' }, content: { type: 'string' }, note_id: { type: 'string' },
                }, required: ['action'],
            },
            action: async (args) => {
                try {
                    if (args?.action === 'write') {
                        const note = store.add(args.title, args.content); inject(); notify();
                        return `Saved note "${note.title}" (ID: ${note.id}).${note.removed ? ` Removed ${note.removed} oldest note(s) to stay within capacity.` : ''}`;
                    }
                    if (args?.action === 'update') {
                        if (!args.note_id) return 'update requires note_id.';
                        const note = store.update(args.note_id, args.title, args.content); inject(); notify();
                        return `Updated note "${note.title}" (ID: ${note.id}).`;
                    }
                    return 'Unknown action. Use write or update.';
                } catch (error) { return error?.message || String(error); }
            },
            formatMessage: args => args?.action === 'update' ? 'Updating notebook note…' : 'Saving notebook note…',
            stealth: false,
        });
        inject(); notify();
        const unsubscribe = host.onChatChanged(() => { inject(); notify(); });
        return () => { unsubscribe(); host.unregisterTool(TOOL_NAME); host.setPrompt(PROMPT_KEY, '', 1, 0, 0); };
    },

    render(container, host) {
        const store = createNotebookStore(host.context);
        const notes = signal(store.notes());
        const settings = signal(store.settings());
        const sync = () => { notes.set(store.notes()); settings.set(store.settings()); };
        onDispose(container, host.data.subscribe('notebook', BUS_KEY, sync));

        const status = h('div', { class: 'stme-note-status' },
            computed(() => `${notes().length} / ${settings().maxNotes} notes · cleanup: ${settings().cleanupBatch} · injection: @${settings().injectionDepth}`));

        // These three only ever change through this very Save button — nothing else
        // writes them — so they must NOT resync on the 'changed' bus event (a note
        // added by the AI mid-typing would otherwise silently wipe an unsaved edit here).
        const maxNotes = signal(settings().maxNotes);
        const cleanupBatch = signal(settings().cleanupBatch);
        const injectionDepth = signal(settings().injectionDepth);

        const settingsForm = h('div', { class: 'stme-note-settings' },
            Field('Maximum notes', TextInput(maxNotes, { type: 'number' })),
            Field('Cleanup batch', TextInput(cleanupBatch, { type: 'number' })),
            Field('Injection depth (@X)', TextInput(injectionDepth, { type: 'number' })),
            Button('Save settings', () => {
                const next = store.setSettings({ maxNotes: maxNotes.peek(), cleanupBatch: cleanupBatch.peek(), injectionDepth: injectionDepth.peek() });
                maxNotes.set(next.maxNotes); cleanupBatch.set(next.cleanupBatch); injectionDepth.set(next.injectionDepth);
                host.setPrompt(PROMPT_KEY, store.prompt(), 1, next.injectionDepth, 0);
                host.toast('success', 'Notebook settings saved.');
            }),
        );

        const titleInput = signal('');
        const contentInput = signal('');
        const editor = h('div', { class: 'stme-note-editor' },
            TextInput(titleInput, { maxlength: 160, placeholder: 'Note title' }),
            TextArea(contentInput, { rows: 3, placeholder: 'Note content' }),
            Button('+ Add note', () => {
                try {
                    const note = store.add(titleInput.peek(), contentInput.peek());
                    titleInput.set(''); contentInput.set('');
                    sync();
                    host.setPrompt(PROMPT_KEY, store.prompt(), 1, store.settings().injectionDepth, 0);
                    host.toast('success', `Saved "${note.title}".`);
                } catch (error) { host.toast('error', error?.message || String(error)); }
            }),
        );

        const noteList = h('div', { class: 'stme-note-list' },
            list(notes, note => note.id, note => h('article', { class: 'stme-note' },
                h('strong', {}, note.title),
                h('div', {}, note.content),
            )),
        );

        container.append(status, settingsForm, editor, noteList);
    },
};
