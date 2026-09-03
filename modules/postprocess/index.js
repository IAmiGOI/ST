import {
    h, list, show, signal, computed,
    Field, TextInput, TextArea, Select, Toggle, Button, DraggableList,
} from '../../core/widgets.js';

const MODULE_ID = 'postprocess';
const POSTPROCESS_EXTRA_KEY = 'stme_postprocess';
const MAX_NAME_LENGTH = 60;
const MAX_PROMPT_LENGTH = 4000;

// Same exclusion list Tracker uses, for the same reason: these message types don't
// carry a genuinely new response body worth transforming. 'regenerate'/'swipe' are
// deliberately NOT here — both are real new generations and must still run the
// pipeline (see the stale-.extra clearing step in the MESSAGE_RECEIVED handler below).
const IGNORED_MESSAGE_TYPES = ['continue', 'appendFinal', 'first_message', 'command', 'extension'];

const MODULE_DEFAULTS = Object.freeze({
    autoRun: true,
    passes: [],
});

function createPassId() {
    return `pass_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createPass() {
    return { id: createPassId(), name: 'New pass', prompt: '', profileId: 'default', enabled: true };
}

/** Normalizes a raw pass list to `{ id, name, prompt, profileId, enabled }`, deduped by id. */
export function sanitizePasses(passes) {
    const seen = new Set();
    const result = [];
    for (const raw of Array.isArray(passes) ? passes : []) {
        const id = String(raw?.id ?? '').trim() || createPassId();
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({
            id,
            name: String(raw?.name ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'Untitled pass',
            prompt: String(raw?.prompt ?? '').trim().slice(0, MAX_PROMPT_LENGTH),
            profileId: String(raw?.profileId ?? '').trim() || 'default',
            enabled: raw?.enabled !== false,
        });
    }
    return result;
}

/**
 * A pass's own request — ReCast's core idea kept intact: each pass is fully
 * isolated from the main chat (no character card, no world info, no chat history)
 * and from every other pass (no shared context, no awareness of the pipeline). It
 * sees only its own instruction and the text the PREVIOUS pass produced (or the
 * original reply, for the first pass).
 */
export function buildPassRequest(pass, inputText) {
    return {
        systemPrompt: `${String(pass?.prompt ?? '').trim()}\n\nReturn ONLY the rewritten text — no explanation, no markdown code fences, no commentary before or after it.`,
        prompt: String(inputText ?? ''),
    };
}

/** Strips a stray code fence a model added despite being told not to, and trims. */
export function cleanPassOutput(raw) {
    return String(raw ?? '').replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
}

/**
 * Runs every enabled pass in order, each one's output feeding the next — the
 * chaining half of ReCast's design. `requestFn(pass, built)` is injected so this
 * stays testable without a real SideCar. A pass with no instruction, an empty
 * result, or a failed request is skipped — the running text passes through
 * unchanged — so one bad pass never aborts the rest of the pipeline. Returns the
 * final text plus a `trace` of what each pass actually did: nothing reads it yet
 * (see applyPipelineResult below), but it's exactly what a future diff/review step
 * would need, so it's captured now while it's free.
 */
export async function runPipeline(passes, inputText, requestFn) {
    let text = String(inputText ?? '');
    const trace = [];
    for (const pass of (passes ?? []).filter(item => item.enabled !== false)) {
        if (!pass.prompt) { trace.push({ passId: pass.id, name: pass.name, skipped: true, reason: 'no-prompt' }); continue; }
        try {
            const raw = await requestFn(pass, buildPassRequest(pass, text));
            const cleaned = cleanPassOutput(raw);
            if (!cleaned) { trace.push({ passId: pass.id, name: pass.name, skipped: true, reason: 'empty-output' }); continue; }
            trace.push({ passId: pass.id, name: pass.name, before: text, after: cleaned });
            text = cleaned;
        } catch (error) {
            trace.push({ passId: pass.id, name: pass.name, skipped: true, reason: error?.message || String(error) });
        }
    }
    return { text, trace };
}

function resolveMessage(chat, id) {
    if (Number.isInteger(id) && chat[id]) return { message: chat[id], index: id };
    const index = chat.findIndex(item => item.mesid === id || item.send_date === id);
    return index >= 0 ? { message: chat[index], index } : null;
}

/**
 * The one place a finished pipeline result actually reaches the chat — deliberately
 * isolated in its own function. For now it just replaces the message silently, the
 * same way RP Time/Tracker already do (no diff/review UI — explicitly deferred, not
 * built here); the original text and the full per-pass trace are stashed in `.extra`
 * regardless, so a future review step has everything it needs without touching the
 * pipeline or the event wiring above it at all — only this one function would change.
 */
export function applyPipelineResult(context, index, message, { originalText, finalText, trace }) {
    if (finalText === originalText) return false;
    message.extra ??= {};
    message.extra[POSTPROCESS_EXTRA_KEY] = { originalText, trace, appliedAt: Date.now() };
    message.mes = finalText;
    context.updateMessageBlock?.(index, message);
    context.saveChatConditional?.();
    context.saveChat?.();
    return true;
}

function getPassUi(cache, pass) {
    if (!cache.has(pass.id)) {
        cache.set(pass.id, {
            name: signal(pass.name),
            prompt: signal(pass.prompt),
            profileId: signal(pass.profileId),
            enabled: signal(pass.enabled !== false),
        });
    }
    return cache.get(pass.id);
}

function renderPassHeader(pass, ui, passesSig, persistPasses, profiles, host) {
    const nameInput = TextInput(ui.name, { maxlength: MAX_NAME_LENGTH, placeholder: 'Pass name' });
    nameInput.addEventListener('click', event => event.stopPropagation());
    // Same "don't rely on blur alone" fix RP Time uses for its own text inputs — a
    // save that only ever runs on 'change' can be silently lost if blur never
    // cleanly fires (common on mobile). 'input' persists the raw value on every
    // keystroke; 'change' still does the full trim/normalize once focus leaves.
    nameInput.addEventListener('input', () => {
        pass.name = nameInput.value.slice(0, MAX_NAME_LENGTH) || 'Untitled pass';
        host.saveModuleSettings();
    });
    nameInput.addEventListener('change', () => {
        pass.name = ui.name.peek().trim() || 'Untitled pass';
        ui.name.set(pass.name);
        host.saveModuleSettings();
    });

    const caption = computed(() => {
        const profileName = profiles().find(item => item.id === ui.profileId())?.name ?? ui.profileId();
        return `profile: ${profileName}`;
    });

    return [
        h('div', { class: 'stme-postprocess-title' }, nameInput, h('small', {}, caption)),
        Toggle('Enabled', ui.enabled, {
            onChange: checked => {
                pass.enabled = checked;
                ui.enabled.set(checked);
                host.saveModuleSettings();
            },
        }),
        Button('Remove', event => {
            event.preventDefault(); event.stopPropagation();
            persistPasses(passesSig.peek().filter(item => item.id !== pass.id));
        }, { variant: 'danger' }),
    ];
}

function renderPassContent(pass, ui, profiles, host) {
    const promptArea = TextArea(ui.prompt, { rows: 4, placeholder: 'What should this pass do to the text? e.g. "Fix grammar and tighten prose without changing meaning."' });
    // Same mobile-safe dual save as nameInput above.
    promptArea.addEventListener('input', () => {
        pass.prompt = promptArea.value.slice(0, MAX_PROMPT_LENGTH);
        host.saveModuleSettings();
    });
    promptArea.addEventListener('change', () => {
        pass.prompt = String(ui.prompt.peek()).trim().slice(0, MAX_PROMPT_LENGTH);
        ui.prompt.set(pass.prompt);
        host.saveModuleSettings();
    });

    const profileSelect = Select(ui.profileId, profiles);
    profileSelect.addEventListener('change', () => {
        pass.profileId = profileSelect.value;
        ui.profileId.set(pass.profileId);
        host.saveModuleSettings();
    });

    return h('div', { class: 'stme-postprocess-pass' },
        Field('Instruction', promptArea, { stack: true, hint: 'This pass sees ONLY this instruction and the text so far — no chat history, no other pass.' }),
        Field('SideCar profile', profileSelect),
    );
}

export const postprocessModule = {
    id: MODULE_ID,
    title: 'Post-Turn Processor',
    description: 'Runs each fresh reply through a chain of independent SideCar passes and replaces it with the final result.',
    about: 'Inspired by the ReCast extension\'s pass concept: each pass is a fully independent rewrite step — its own instruction, its own SideCar profile, no shared context with the main chat or with other passes — chained so pass 2 sees pass 1\'s output, and so on. The final pass\'s output replaces the message.',
    defaultEnabled: false,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/postprocess',
    minEngineVersion: '0.1.0',

    activate(host) {
        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            const settings = host.moduleSettings(MODULE_DEFAULTS);
            if (settings.autoRun === false) return;
            if (IGNORED_MESSAGE_TYPES.includes(type)) return;
            if (!host.sidecar.isConfigured()) return;

            const passes = sanitizePasses(settings.passes).filter(pass => pass.enabled !== false && pass.prompt);
            if (!passes.length) return;

            const context = host.context();
            const resolved = resolveMessage(context.chat ?? [], messageId);
            if (!resolved?.message || resolved.message.is_user || resolved.message.is_system) return;

            // A reroll (regenerate, or swiping to a new response) reuses the SAME
            // message object — clear a stale result so this genuinely new reply gets
            // reprocessed instead of being skipped by the "already processed" guard below.
            if ((type === 'regenerate' || type === 'swipe') && resolved.message.extra?.[POSTPROCESS_EXTRA_KEY]) {
                delete resolved.message.extra[POSTPROCESS_EXTRA_KEY];
            }
            if (resolved.message.extra?.[POSTPROCESS_EXTRA_KEY]) return; // already processed

            const originalText = String(resolved.message.mes ?? '');
            if (!originalText) return;

            const { text: finalText, trace } = await runPipeline(passes, originalText, (pass, built) =>
                host.sidecar.request({ ...built, profileId: pass.profileId }));
            applyPipelineResult(context, resolved.index, resolved.message, { originalText, finalText, trace });
        });

        return () => { received(); };
    },

    render(container, host) {
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        const profiles = signal(host.sidecar.profiles());
        const autoRun = signal(settings.autoRun !== false);
        const passes = signal(sanitizePasses(settings.passes));
        const passUiCache = new Map();

        const persistPasses = next => {
            passes.set(next);
            settings.passes = next;
            host.saveModuleSettings();
        };

        const draggableList = DraggableList(passes, pass => pass.id, {
            onReorder: persistPasses,
            renderHeader: pass => renderPassHeader(pass, getPassUi(passUiCache, pass), passes, persistPasses, profiles, host),
            renderContent: pass => renderPassContent(pass, getPassUi(passUiCache, pass), profiles, host),
        });

        container.append(
            h('p', { class: 'stme-postprocess-help' }, 'Each pass below is a fully independent rewrite step — its own instruction, its own SideCar profile. Passes run in order right after each reply; pass 2 sees pass 1\'s output, and so on. Drag a pass by its header to reorder it.'),
            Toggle('Auto-run after each reply', autoRun, {
                onChange: checked => { autoRun.set(checked); settings.autoRun = checked; host.saveModuleSettings(); },
            }),
            show(computed(() => passes().length === 0), empty => empty ? h('p', { class: 'stme-postprocess-empty' }, 'No passes yet — add one to start processing replies.') : null),
            draggableList,
            Button('+ Add pass', () => persistPasses([...passes.peek(), createPass()])),
        );
    },

    css: `
        .stme-settings .stme-postprocess-help { margin: 0 0 10px; line-height: 1.4; opacity: .85; }
        .stme-settings .stme-postprocess-empty { margin: 8px 0; padding: 8px; opacity: .65; font-size: .9em; }
        .stme-settings .stme-postprocess-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
        .stme-settings .stme-postprocess-title-input { border: none; background: transparent; padding: 0; font-weight: 700; font-size: 1em; color: inherit; width: 100%; }
        .stme-settings .stme-postprocess-title small { opacity: .65; }
        .stme-settings .stme-postprocess-pass { display: flex; flex-direction: column; gap: 10px; }
    `,
};
