import {
    h, list, show, signal, computed,
    Field, TextInput, TextArea, Select, Toggle, Button, SliderField, DraggableList,
} from '../../core/widgets.js';

const MODULE_ID = 'postprocess';
const POSTPROCESS_EXTRA_KEY = 'stme_postprocess';
const MAX_NAME_LENGTH = 60;
const MAX_PROMPT_LENGTH = 4000;
const MIN_CONTEXT_DEPTH = 1;
const MAX_CONTEXT_DEPTH = 20;
const DEFAULT_CONTEXT_DEPTH = 6;
// A word-level diff over more than this many tokens on either side gets
// expensive fast (the LCS table is O(a.length * b.length)) for a badge nobody
// may ever open — see diffWords()'s own guard below.
const MAX_DIFF_TOKENS = 4000;

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
    return { id: createPassId(), name: 'New pass', prompt: '', profileId: 'default', enabled: true, includeContext: false, contextDepth: DEFAULT_CONTEXT_DEPTH };
}

function clampContextDepth(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(MAX_CONTEXT_DEPTH, Math.max(MIN_CONTEXT_DEPTH, number)) : DEFAULT_CONTEXT_DEPTH;
}

/** Normalizes a raw pass list to `{ id, name, prompt, profileId, enabled, includeContext, contextDepth }`, deduped by id. */
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
            includeContext: Boolean(raw?.includeContext),
            contextDepth: clampContextDepth(raw?.contextDepth ?? DEFAULT_CONTEXT_DEPTH),
        });
    }
    return result;
}

/** Same recent-context shape Tracker/RP Time already build: last N non-system messages, "Player"/"Character" prefixed, each capped so one huge message can't blow out the request. */
function buildContextBlock(chat, depth) {
    return (chat ?? [])
        .filter(item => !item.is_system)
        .slice(-depth)
        .map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`)
        .join('\n\n');
}

/**
 * A pass's own request: each pass is fully isolated from every other pass (no
 * shared context, no awareness of the pipeline) and, by default, from the main
 * chat too — it sees only its own instruction and the text the PREVIOUS pass
 * produced (or the original reply, for the first pass). A pass can opt into
 * seeing recent chat history as well, via its own `includeContext`/`contextDepth`
 * settings (configured through the UI — see renderPassContent below), not by the
 * author typing a macro/placeholder into the instruction text: the instruction
 * stays plain natural language either way.
 */
export function buildPassRequest(pass, inputText, chat = []) {
    const systemPrompt = `${String(pass?.prompt ?? '').trim()}\n\nReturn ONLY the rewritten text — no explanation, no markdown code fences, no commentary before or after it.`;
    if (!pass?.includeContext) {
        return { systemPrompt, prompt: String(inputText ?? '') };
    }
    const context = buildContextBlock(chat, clampContextDepth(pass.contextDepth ?? DEFAULT_CONTEXT_DEPTH));
    return {
        systemPrompt,
        prompt: `RECENT CONTEXT:\n${context}\n\nTEXT TO REWRITE:\n${String(inputText ?? '')}`,
    };
}

/** Strips a stray code fence a model added despite being told not to, and trims. */
export function cleanPassOutput(raw) {
    return String(raw ?? '').replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
}

/**
 * Runs every enabled pass in order, each one's output feeding the next.
 * `requestFn(pass, built)` is injected so this stays testable without a real
 * SideCar. A pass with no instruction, an empty result, or a failed request is
 * skipped — the running text passes through unchanged — so one bad pass never
 * aborts the rest of the pipeline. Returns the final text plus a `trace` of what
 * each pass actually did (before/after, or skipped + why) — read by the message
 * badge below to show exactly what changed, pass by pass.
 */
export async function runPipeline(passes, inputText, requestFn, chat = []) {
    let text = String(inputText ?? '');
    const trace = [];
    for (const pass of (passes ?? []).filter(item => item.enabled !== false)) {
        if (!pass.prompt) { trace.push({ passId: pass.id, name: pass.name, skipped: true, reason: 'no-prompt' }); continue; }
        try {
            const raw = await requestFn(pass, buildPassRequest(pass, text, chat));
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
 * isolated in its own function. Replaces the message the same way RP Time/Tracker
 * already do; the original text and the full per-pass trace are stashed in `.extra`
 * either way, which is what powers the per-message change badge (see
 * createPostprocessBadge below) — a viewer never re-derives what changed, it just
 * reads what actually happened.
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

/** Splits on whitespace while keeping the whitespace as its own tokens, so the diff below can rejoin segments without losing original spacing. */
function tokenize(text) {
    return String(text ?? '').match(/\S+|\s+/g) ?? [];
}

function longestCommonSubsequenceTable(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    return dp;
}

/**
 * Word-level diff between two texts: an array of `{ type: 'equal'|'add'|'remove', text }`
 * segments (adjacent same-type tokens merged into one segment each), built from a
 * standard LCS table + backtrack over whitespace-preserving word tokens — no
 * external diff library, this project ships with no build step. Above
 * MAX_DIFF_TOKENS on either side (a genuinely enormous message), the LCS table
 * itself would be the expensive part for a badge that may never even be opened, so
 * this falls back to a single remove+add pair instead of computing it.
 */
export function diffWords(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) {
        const segments = [];
        if (a.length) segments.push({ type: 'remove', text: a.join('') });
        if (b.length) segments.push({ type: 'add', text: b.join('') });
        return segments;
    }

    const dp = longestCommonSubsequenceTable(a, b);
    const segments = [];
    const push = (type, text) => {
        const last = segments[segments.length - 1];
        if (last && last.type === type) last.text += text;
        else segments.push({ type, text });
    };
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { push('equal', a[i]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { push('remove', a[i]); i++; }
        else { push('add', b[j]); j++; }
    }
    while (i < a.length) { push('remove', a[i]); i++; }
    while (j < b.length) { push('add', b[j]); j++; }
    return segments;
}

/** Renders one pass's diff (or its skip reason) as a plain DOM row — built with the DOM API directly, matching RP Time's own chat-badge convention (a side effect of activate(), never inside a module's render()). */
function createPassDiffRow(step) {
    const row = document.createElement('div');
    row.className = 'stme-postprocess-step';
    const heading = document.createElement('strong');
    heading.textContent = step.name;
    row.append(heading);

    if (step.skipped) {
        row.classList.add('stme-postprocess-step-skipped');
        const reason = document.createElement('span');
        reason.className = 'stme-postprocess-skip-reason';
        reason.textContent = ` — skipped (${step.reason})`;
        row.append(reason);
        return row;
    }

    const text = document.createElement('div');
    text.className = 'stme-postprocess-diff-text';
    for (const segment of diffWords(step.before, step.after)) {
        if (segment.type === 'equal') { text.append(document.createTextNode(segment.text)); continue; }
        const el = document.createElement(segment.type === 'add' ? 'ins' : 'del');
        el.className = segment.type === 'add' ? 'stme-postprocess-add' : 'stme-postprocess-remove';
        el.textContent = segment.text;
        text.append(el);
    }
    row.append(text);
    return row;
}

/** A collapsible `<details>` badge — the toggle itself — appended under a processed message, listing what every pass in its trace actually did, with word-level highlighting per pass. */
function createPostprocessBadge(entry) {
    const passCount = entry.trace.filter(step => !step.skipped).length;
    const details = document.createElement('details');
    details.className = 'stme-postprocess-badge';
    const summary = document.createElement('summary');
    summary.textContent = `✎ Post-processed (${passCount} pass${passCount === 1 ? '' : 'es'})`;
    const body = document.createElement('div');
    body.className = 'stme-postprocess-diff';
    for (const step of entry.trace) body.append(createPassDiffRow(step));
    details.append(summary, body);
    return details;
}

/** This module's own chat-badges renderer (see core/chat-badge-service.js) — pure, derived fresh from the message's own `.extra` every time, never a cached trace. */
function renderPostprocessBadge(message) {
    const entry = message?.extra?.[POSTPROCESS_EXTRA_KEY];
    return entry ? createPostprocessBadge(entry) : null;
}

function getPassUi(cache, pass) {
    if (!cache.has(pass.id)) {
        cache.set(pass.id, {
            name: signal(pass.name),
            prompt: signal(pass.prompt),
            profileId: signal(pass.profileId),
            enabled: signal(pass.enabled !== false),
            includeContext: signal(Boolean(pass.includeContext)),
            contextDepth: signal(clampContextDepth(pass.contextDepth ?? DEFAULT_CONTEXT_DEPTH)),
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
        return ui.includeContext() ? `profile: ${profileName} · +${ui.contextDepth()} msg context` : `profile: ${profileName}`;
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
        Field('Instruction', promptArea, { stack: true, hint: 'This pass always sees this instruction and the text so far — no other pass\'s identity, no macros needed.' }),
        Field('SideCar profile', profileSelect),
        Toggle('Include recent chat context', ui.includeContext, {
            hint: 'Off by default — a pass sees only the text being rewritten. Turn on to also give it the last few chat messages, picked with the slider below.',
            onChange: checked => {
                pass.includeContext = checked;
                ui.includeContext.set(checked);
                host.saveModuleSettings();
            },
        }),
        // Built fresh every time it becomes visible, not hoisted — show() permanently
        // disposes its rendered node's effects when it hides (see core/dom.js's
        // disposeTree()), so a slider built once outside this callback and reused
        // across show/hide cycles would come back non-reactive the second time.
        show(ui.includeContext, on => {
            if (!on) return null;
            const slider = SliderField('Messages of context', ui.contextDepth, { min: MIN_CONTEXT_DEPTH, max: MAX_CONTEXT_DEPTH, step: 1 });
            slider.querySelector('input').addEventListener('change', () => {
                pass.contextDepth = clampContextDepth(ui.contextDepth.peek());
                ui.contextDepth.set(pass.contextDepth);
                host.saveModuleSettings();
            });
            return slider;
        }),
    );
}

export const postprocessModule = {
    id: MODULE_ID,
    title: 'Post-Turn Processor',
    description: 'Runs each fresh reply through a chain of independent SideCar passes and replaces it with the final result.',
    about: 'Each pass is an independent rewrite step — its own instruction, its own SideCar profile, and optionally its own slice of recent chat context — chained so pass 2 sees pass 1\'s output, and so on. The final pass\'s output replaces the message, and a small toggle under the message lets you see exactly what every pass changed.',
    defaultEnabled: false,
    version: '1.0.0',
    repo: 'https://github.com/IAmiGOI/ST/tree/main/modules/postprocess',
    minEngineVersion: '0.1.0',

    activate(host) {
        // Independent core service, not host.services — same shape RP Time already
        // uses. Registering here means THIS module's applyPipelineResult() below,
        // which calls context.updateMessageBlock() and therefore wipes out any
        // badge a SIBLING module (RP Time) had already drawn on this same message,
        // can restore it correctly via reapply() — without needing to know RP Time
        // exists at all. See core/chat-badge-service.js's own doc comment; this is
        // the actual bug the service was built to fix.
        const chatBadges = host.data.read('chat-badges', 'api');
        const unregisterBadge = chatBadges?.register?.('postprocess', renderPostprocessBadge);

        // Lets Tracker (or anything else) know a given MESSAGE_RECEIVED cycle's
        // pipeline work is done — success, "nothing to do", or any other early
        // return — so an 'after-turn' poll can wait for THIS module's rewrite to
        // land before reading the message instead of racing it. Always fires
        // exactly once per real MESSAGE_RECEIVED call, via the try/finally below.
        const messageHandledListeners = new Set();
        host.services.register('postprocess', {
            onMessageHandled(listener) {
                messageHandledListeners.add(listener);
                return () => messageHandledListeners.delete(listener);
            },
        });
        const notifyMessageHandled = messageId => {
            for (const listener of [...messageHandledListeners]) {
                try { listener(messageId); } catch (error) { console.error('[ST Module Engine] Post-Turn Processor onMessageHandled listener threw:', error); }
            }
        };

        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            try {
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
                    host.sidecar.request({ ...built, profileId: pass.profileId }), context.chat);
                const changed = applyPipelineResult(context, resolved.index, resolved.message, { originalText, finalText, trace });
                if (changed) {
                    const mesid = resolved.message.mesid ?? resolved.index;
                    // reapply(), not a renderer just for this module's own badge — the
                    // updateMessageBlock() call inside applyPipelineResult() just wiped
                    // the ENTIRE .mes_text DOM, so any badge RP Time (or anything else)
                    // had already drawn on this same message needs redrawing too, not
                    // just this module's own.
                    setTimeout(() => chatBadges?.reapply?.(mesid, resolved.message));
                }
            } finally {
                notifyMessageHandled(messageId);
            }
        });

        return () => { received(); unregisterBadge?.(); messageHandledListeners.clear(); };
    },

    render(container, host) {
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        // Sanitized IN PLACE, then the signal is built from that SAME array/objects
        // — not signal(sanitizePasses(settings.passes)), which would hand every
        // rendered pass row a freshly-copied object no longer identical to what
        // `settings.passes` points at. Every per-pass field handler below mutates
        // `pass` directly and just calls host.saveModuleSettings() (no
        // persistPasses() round trip) — with a detached copy, that mutates an
        // object nobody actually persists, so an edited instruction (or name,
        // profile, context toggle, depth — every per-pass field) silently reverts
        // on reload until SOME add/remove/reorder happens to resync the two
        // arrays via persistPasses() below. Same pattern RP Time/Tracker's own
        // render() already use for their own field/block lists.
        settings.passes = sanitizePasses(settings.passes);
        const profiles = signal(host.sidecar.profiles());
        const autoRun = signal(settings.autoRun !== false);
        const passes = signal(settings.passes);
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
            h('p', { class: 'stme-postprocess-help' }, 'Each pass below is an independent rewrite step — its own instruction, its own SideCar profile. Passes run in order right after each reply; pass 2 sees pass 1\'s output, and so on. Drag a pass by its header to reorder it. A ✎ toggle appears under every processed message showing exactly what changed.'),
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

        /* Chat-message badge — appended into .mes_text, outside the settings drawer. */
        .stme-postprocess-badge { margin-top: 8px; padding: 6px 8px; border-radius: var(--stme-radius-sm, 6px); background: rgba(0, 0, 0, .07); font-size: .85em; }
        .stme-postprocess-badge summary { cursor: pointer; opacity: .8; user-select: none; }
        .stme-postprocess-badge summary:hover { opacity: 1; }
        .stme-postprocess-diff { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
        .stme-postprocess-step strong { display: block; margin-bottom: 2px; font-size: .9em; opacity: .85; }
        .stme-postprocess-step-skipped { opacity: .6; }
        .stme-postprocess-skip-reason { font-style: italic; }
        .stme-postprocess-diff-text { line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
        .stme-postprocess-add { background: color-mix(in srgb, #4caf50 35%, transparent); text-decoration: none; border-radius: 2px; }
        .stme-postprocess-remove { background: color-mix(in srgb, #f44336 30%, transparent); text-decoration: line-through; border-radius: 2px; opacity: .8; }
    `,
};
