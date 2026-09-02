import { createNotebookStore } from './store.js';
import { h, list, signal, computed, onDispose, Field, TextInput, TextArea, Button } from '../../core/widgets.js';

const TOOL_NAME = 'Notebook';
const PROMPT_KEY = 'stme_notebook_context';
const BUS_KEY = 'changed';

export const notebookModule = {
    id: 'notebook',
    title: 'Notebook / Notes',
    description: 'Private per-chat working memory exposed as a native function tool.',
    defaultEnabled: true,

    activate(host) {
        const store = createNotebookStore(host.context);
        const inject = () => {
            const { injectionDepth } = store.settings();
            host.setPrompt(PROMPT_KEY, store.prompt(), 1, injectionDepth, 0);
        };
        const notify = () => host.data.set(BUS_KEY, Date.now());
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
