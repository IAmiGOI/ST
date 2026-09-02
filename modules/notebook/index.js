import { createNotebookStore } from './store.js';

const TOOL_NAME = 'Notebook';
const PROMPT_KEY = 'stme_notebook_context';

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
                        const note = store.add(args.title, args.content); inject(); host.refresh();
                        return `Saved note "${note.title}" (ID: ${note.id}).${note.removed ? ` Removed ${note.removed} oldest note(s) to stay within capacity.` : ''}`;
                    }
                    if (args?.action === 'update') {
                        if (!args.note_id) return 'update requires note_id.';
                        const note = store.update(args.note_id, args.title, args.content); inject(); host.refresh();
                        return `Updated note "${note.title}" (ID: ${note.id}).`;
                    }
                    return 'Unknown action. Use write or update.';
                } catch (error) { return error?.message || String(error); }
            },
            formatMessage: args => args?.action === 'update' ? 'Updating notebook note…' : 'Saving notebook note…',
            stealth: false,
        });
        inject();
        const unsubscribe = host.onChatChanged(inject);
        return () => { unsubscribe(); host.unregisterTool(TOOL_NAME); host.setPrompt(PROMPT_KEY, '', 1, 0, 0); };
    },

    render(container, host) {
        const store = createNotebookStore(host.context);
        const settings = store.settings();
        container.innerHTML = `
            <div class="stme-note-status"></div>
            <div class="stme-note-settings">
              <label>Maximum notes <input class="text_pole" data-field="maxNotes" type="number" min="1" max="500"></label>
              <label>Cleanup batch <input class="text_pole" data-field="cleanupBatch" type="number" min="1" max="500"></label>
              <label>Injection depth (@X) <input class="text_pole" data-field="injectionDepth" type="number" min="0" max="100"></label>
              <button class="menu_button" data-action="save-settings" type="button">Save settings</button>
            </div>
            <div class="stme-note-editor">
              <input class="text_pole" data-field="title" maxlength="160" placeholder="Note title">
              <textarea class="text_pole" data-field="content" rows="3" placeholder="Note content"></textarea>
              <button class="menu_button" data-action="add" type="button"><i class="fa-solid fa-plus"></i> Add note</button>
            </div>
            <div class="stme-note-list"></div>`;
        for (const [key, value] of Object.entries(settings)) container.querySelector(`[data-field="${key}"]`).value = value;
        const status = container.querySelector('.stme-note-status');
        const notes = store.notes();
        status.textContent = `${notes.length} / ${settings.maxNotes} notes · cleanup: ${settings.cleanupBatch} · injection: @${settings.injectionDepth}`;
        const list = container.querySelector('.stme-note-list');
        if (!notes.length) list.textContent = 'No notes yet.';
        for (const note of notes) {
            const item = document.createElement('article'); item.className = 'stme-note';
            const heading = document.createElement('strong'); heading.textContent = note.title;
            const body = document.createElement('div'); body.textContent = note.content;
            item.append(heading, body); list.append(item);
        }
        container.querySelector('[data-action="add"]').addEventListener('click', () => {
            try {
                const note = store.add(container.querySelector('[data-field="title"]').value, container.querySelector('[data-field="content"]').value);
                container.querySelector('[data-field="title"]').value = ''; container.querySelector('[data-field="content"]').value = '';
                host.setPrompt(PROMPT_KEY, store.prompt(), 1, store.settings().injectionDepth, 0); host.toast('success', `Saved "${note.title}".`); host.refresh();
            } catch (error) { host.toast('error', error?.message || String(error)); }
        });
        container.querySelector('[data-action="save-settings"]').addEventListener('click', () => {
            store.setSettings(Object.fromEntries(['maxNotes', 'cleanupBatch', 'injectionDepth'].map(key => [key, container.querySelector(`[data-field="${key}"]`).value])));
            host.setPrompt(PROMPT_KEY, store.prompt(), 1, store.settings().injectionDepth, 0);
            host.refresh(); host.toast('success', 'Notebook settings saved.');
        });
    },
};
