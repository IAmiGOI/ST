import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitizePasses, buildPassRequest, cleanPassOutput, runPipeline, applyPipelineResult, diffWords, postprocessModule,
} from '../modules/postprocess/index.js';

// renderBadge() (called from activate()'s MESSAGE_RECEIVED handler and from
// onChatChanged) touches `document` — a trivial stub is enough for it to take its
// "no chat DOM target, do nothing" path, same convention time-reroll.test.js uses.
const originalDocument = globalThis.document;
globalThis.document = { querySelector: () => null };
test.after(() => { globalThis.document = originalDocument; });

test('sanitizePasses normalizes fields, generates a missing id, bounds lengths, and dedupes by id', () => {
    const passes = sanitizePasses([
        { id: 'a', name: '  Polish  ', prompt: '  Fix grammar.  ', profileId: 'fast', enabled: false, includeContext: true, contextDepth: 3 },
        { name: '', prompt: '', profileId: '' }, // no id at all — one must be generated
        { id: 'a', name: 'Duplicate id, dropped' },
    ]);
    assert.equal(passes.length, 2, 'the duplicate "a" id must be dropped, and a real id generated for the id-less entry');
    assert.deepEqual(passes[0], { id: 'a', name: 'Polish', prompt: 'Fix grammar.', profileId: 'fast', enabled: false, includeContext: true, contextDepth: 3 });
    assert.equal(passes[1].name, 'Untitled pass', 'a blank name falls back to a readable default');
    assert.equal(passes[1].profileId, 'default');
    assert.equal(passes[1].enabled, true);
    assert.equal(passes[1].includeContext, false, 'chat context is opt-in, off by default');
    assert.equal(passes[1].contextDepth, 6, 'a default context depth is filled in even when unset');
    assert.ok(passes[1].id, 'a missing id must be generated, never left empty');
});

test('sanitizePasses treats a non-array input as empty', () => {
    assert.deepEqual(sanitizePasses(null), []);
    assert.deepEqual(sanitizePasses(undefined), []);
});

test('sanitizePasses clamps an out-of-range contextDepth into [1, 20]', () => {
    assert.equal(sanitizePasses([{ contextDepth: 0 }])[0].contextDepth, 1);
    assert.equal(sanitizePasses([{ contextDepth: -5 }])[0].contextDepth, 1);
    assert.equal(sanitizePasses([{ contextDepth: 999 }])[0].contextDepth, 20);
    assert.equal(sanitizePasses([{ contextDepth: 'not a number' }])[0].contextDepth, 6);
});

test('buildPassRequest sends only the pass\'s own instruction and the running text by default — no chat context, no other pass', () => {
    const request = buildPassRequest({ prompt: 'Tighten the prose.' }, 'The wolf bites your arm.');
    assert.match(request.systemPrompt, /^Tighten the prose\./);
    assert.match(request.systemPrompt, /Return ONLY the rewritten text/);
    assert.equal(request.prompt, 'The wolf bites your arm.');
});

test('buildPassRequest folds in recent chat context only when the pass opts in, via includeContext — never a macro in the instruction', () => {
    const chat = [
        { is_user: true, mes: 'We enter the tavern.' },
        { is_user: false, mes: 'The bard starts playing.' },
    ];
    const withoutContext = buildPassRequest({ prompt: 'Polish it.', includeContext: false }, 'Running text.', chat);
    assert.equal(withoutContext.prompt, 'Running text.');

    const withContext = buildPassRequest({ prompt: 'Polish it.', includeContext: true, contextDepth: 5 }, 'Running text.', chat);
    assert.match(withContext.prompt, /Player: We enter the tavern/);
    assert.match(withContext.prompt, /Character: The bard starts playing/);
    assert.match(withContext.prompt, /TEXT TO REWRITE:\nRunning text\./);
    assert.doesNotMatch(withContext.systemPrompt, /We enter the tavern/, 'the instruction itself must stay untouched by context');
});

test('cleanPassOutput strips a code fence the model added despite being told not to, and trims', () => {
    assert.equal(cleanPassOutput('```\nRewritten text.\n```'), 'Rewritten text.');
    assert.equal(cleanPassOutput('```markdown\nRewritten text.\n```'), 'Rewritten text.');
    assert.equal(cleanPassOutput('  Plain text.  '), 'Plain text.');
    assert.equal(cleanPassOutput(null), '');
});

test('runPipeline chains passes in order — each pass\'s output becomes the next pass\'s input', () => {
    const passes = [
        { id: 'p1', name: 'Upper', prompt: 'Uppercase it.', enabled: true },
        { id: 'p2', name: 'Exclaim', prompt: 'Add an exclamation mark.', enabled: true },
    ];
    const seenInputs = [];
    const requestFn = async (pass, built) => {
        seenInputs.push(built.prompt);
        if (pass.id === 'p1') return built.prompt.toUpperCase();
        return `${built.prompt}!`;
    };
    return runPipeline(passes, 'hello', requestFn).then(({ text, trace }) => {
        assert.equal(text, 'HELLO!');
        assert.deepEqual(seenInputs, ['hello', 'HELLO'], 'pass 2 must see pass 1\'s output, not the original text');
        assert.equal(trace.length, 2);
        assert.deepEqual(trace[0], { passId: 'p1', name: 'Upper', before: 'hello', after: 'HELLO' });
        assert.deepEqual(trace[1], { passId: 'p2', name: 'Exclaim', before: 'HELLO', after: 'HELLO!' });
    });
});

test('runPipeline passes the real chat through to a pass that opted into context', async () => {
    const chat = [{ is_user: true, mes: 'Hello there.' }];
    const passes = [{ id: 'p1', name: 'Ctx', prompt: 'Rewrite.', enabled: true, includeContext: true, contextDepth: 6 }];
    let seenPrompt = null;
    await runPipeline(passes, 'original', async (pass, built) => { seenPrompt = built.prompt; return 'final'; }, chat);
    assert.match(seenPrompt, /Player: Hello there\./);
});

test('runPipeline skips a disabled pass entirely — never calls requestFn for it', async () => {
    const passes = [{ id: 'p1', name: 'Off', prompt: 'x', enabled: false }];
    let called = false;
    const { text } = await runPipeline(passes, 'original', async () => { called = true; return 'changed'; });
    assert.equal(text, 'original');
    assert.equal(called, false);
});

test('runPipeline skips a pass with no instruction — the running text passes through unchanged', async () => {
    const passes = [{ id: 'p1', name: 'Empty', prompt: '', enabled: true }];
    const { text, trace } = await runPipeline(passes, 'original', async () => 'changed');
    assert.equal(text, 'original');
    assert.deepEqual(trace, [{ passId: 'p1', name: 'Empty', skipped: true, reason: 'no-prompt' }]);
});

test('runPipeline skips a pass whose result comes back empty, and continues to the next pass', async () => {
    const passes = [
        { id: 'p1', name: 'Blank', prompt: 'x', enabled: true },
        { id: 'p2', name: 'Real', prompt: 'y', enabled: true },
    ];
    const { text, trace } = await runPipeline(passes, 'original', async pass => (pass.id === 'p1' ? '   ' : 'final'));
    assert.equal(text, 'final');
    assert.equal(trace[0].skipped, true);
    assert.equal(trace[0].reason, 'empty-output');
    assert.deepEqual(trace[1], { passId: 'p2', name: 'Real', before: 'original', after: 'final' });
});

test('runPipeline skips a pass whose request throws, and continues to the next pass with the text unchanged', async () => {
    const passes = [
        { id: 'p1', name: 'Broken', prompt: 'x', enabled: true },
        { id: 'p2', name: 'Real', prompt: 'y', enabled: true },
    ];
    const { text, trace } = await runPipeline(passes, 'original', async pass => {
        if (pass.id === 'p1') throw new Error('network down');
        return 'final';
    });
    assert.equal(text, 'final');
    assert.equal(trace[0].skipped, true);
    assert.equal(trace[0].reason, 'network down');
});

test('diffWords marks unchanged words equal and highlights only what actually changed', () => {
    const segments = diffWords('The quick fox jumps', 'The quick red fox leaps');
    assert.deepEqual(segments.map(s => s.type), ['equal', 'add', 'equal', 'remove', 'add']);
    // Reconstructing the "after" side (equal + add segments) must equal the real new text.
    const after = segments.filter(s => s.type !== 'remove').map(s => s.text).join('');
    assert.equal(after, 'The quick red fox leaps');
    // Reconstructing the "before" side (equal + remove segments) must equal the real old text.
    const before = segments.filter(s => s.type !== 'add').map(s => s.text).join('');
    assert.equal(before, 'The quick fox jumps');
});

test('diffWords on identical text is a single equal segment', () => {
    const segments = diffWords('Same text here.', 'Same text here.');
    assert.deepEqual(segments, [{ type: 'equal', text: 'Same text here.' }]);
});

test('diffWords on completely different single-word text with nothing in common', () => {
    const segments = diffWords('apple', 'orange');
    assert.deepEqual(segments, [{ type: 'remove', text: 'apple' }, { type: 'add', text: 'orange' }]);
});

test('diffWords falls back to a single remove+add pair for pathologically large input instead of computing a huge LCS table', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');
    const segments = diffWords(huge, `${huge} extra`);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].type, 'remove');
    assert.equal(segments[1].type, 'add');
});

function makeMessage(text) {
    return { is_user: false, is_system: false, mesid: 0, mes: text, extra: {} };
}

test('applyPipelineResult replaces the message and stashes the original text + trace for the change badge', () => {
    const calls = [];
    const context = {
        updateMessageBlock: (...args) => calls.push(['updateMessageBlock', ...args]),
        saveChatConditional: () => calls.push(['saveChatConditional']),
        saveChat: () => calls.push(['saveChat']),
    };
    const message = makeMessage('Original reply.');
    const trace = [{ passId: 'p1', name: 'Polish', before: 'Original reply.', after: 'Polished reply.' }];

    const changed = applyPipelineResult(context, 0, message, { originalText: 'Original reply.', finalText: 'Polished reply.', trace });

    assert.equal(changed, true);
    assert.equal(message.mes, 'Polished reply.');
    assert.equal(message.extra.stme_postprocess.originalText, 'Original reply.');
    assert.deepEqual(message.extra.stme_postprocess.trace, trace);
    assert.equal(typeof message.extra.stme_postprocess.appliedAt, 'number');
    assert.deepEqual(calls[0], ['updateMessageBlock', 0, message]);
    assert.deepEqual(calls[1], ['saveChatConditional']);
    assert.deepEqual(calls[2], ['saveChat']);
});

test('applyPipelineResult is a no-op when the pipeline produced no actual change', () => {
    const calls = [];
    const context = {
        updateMessageBlock: () => calls.push('updateMessageBlock'),
        saveChatConditional: () => calls.push('saveChatConditional'),
        saveChat: () => calls.push('saveChat'),
    };
    const message = makeMessage('Same text.');
    const changed = applyPipelineResult(context, 0, message, { originalText: 'Same text.', finalText: 'Same text.', trace: [] });
    assert.equal(changed, false);
    assert.equal(calls.length, 0);
    assert.equal(message.extra.stme_postprocess, undefined);
});

// --- Full round trip through the real module, a fake host — same shape as
// tests/time-reroll.test.js's own makeHost().
function makeHost(chat, overrides = {}) {
    const settings = { autoRun: true, passes: [{ id: 'p1', name: 'Polish', prompt: 'Polish it.', profileId: 'default', enabled: true }], ...overrides };
    const listeners = {};
    const context = { chat, chatMetadata: {}, updateMessageBlock() {}, saveChatConditional() {}, saveChat() {} };
    const host = {
        context: () => context,
        onEvent: (type, listener) => { listeners[type] = listener; return () => { delete listeners[type]; }; },
        onChatChanged: () => () => {},
        sidecar: { isConfigured: () => true, request: async () => 'Polished reply.' },
        moduleSettings: () => settings,
        saveModuleSettings: () => {},
        toast: () => {},
        // Minimal fake for the chat-badges service (core/chat-badge-service.js) —
        // real enough for activate()'s host.data.read('chat-badges', 'api') not to
        // throw; this file's own tests are about pipeline/reroll logic, not badge
        // rendering, which time-bus-export.test.js-style engine tests would cover.
        data: { read: () => undefined },
    };
    return { host, listeners, context, settings };
}

// A successful apply schedules a fire-and-forget setTimeout() to render the chat
// badge (see activate()'s MESSAGE_RECEIVED handler) — not awaited by the handler
// itself, same as RP Time's own badge scheduling. Awaiting a tick after the
// listener call lets that timer actually flush before the test (and this file's
// `document` stub) goes away, instead of leaking a stray callback into a later test.
async function messageReceived(listeners, id, type) {
    await listeners.MESSAGE_RECEIVED(id, type);
    await new Promise(resolve => setTimeout(resolve, 10));
}

test('a real reply is replaced end to end through activate()\'s MESSAGE_RECEIVED wiring', async () => {
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'Original reply.', extra: {} }];
    const { host, listeners } = makeHost(chat);
    await postprocessModule.activate(host);

    await messageReceived(listeners, 0, 'normal');

    assert.equal(chat[0].mes, 'Polished reply.');
    assert.equal(chat[0].extra.stme_postprocess.originalText, 'Original reply.');
});

test('a pass with includeContext sees the real chat through activate() end to end', async () => {
    // resolveMessage() treats an integer messageId as a direct array index (same
    // convention Tracker/RP Time already use) — the message being reprocessed must
    // sit at chat[messageId], so the prior player line goes at index 0 and the
    // fresh reply (messageId 1) at index 1.
    const chat = [
        { is_user: true, is_system: false, mesid: 0, mes: 'Player line.' },
        { is_user: false, is_system: false, mesid: 1, mes: 'Original reply.', extra: {} },
    ];
    let seenPrompt = null;
    const { host, listeners } = makeHost(chat, { passes: [{ id: 'p1', name: 'Ctx', prompt: 'Rewrite.', profileId: 'default', enabled: true, includeContext: true, contextDepth: 6 }] });
    host.sidecar.request = async built => { seenPrompt = built.prompt; return 'Polished reply.'; };
    await postprocessModule.activate(host);

    await messageReceived(listeners, 1, 'normal');

    assert.match(seenPrompt, /Player: Player line\./);
});

test('an excluded message type ("continue") is left untouched', async () => {
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'Original reply.', extra: {} }];
    const { host, listeners } = makeHost(chat);
    await postprocessModule.activate(host);

    await listeners.MESSAGE_RECEIVED(0, 'continue');

    assert.equal(chat[0].mes, 'Original reply.');
});

test('a message already processed is not reprocessed on a second MESSAGE_RECEIVED for the same id', async () => {
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'Original reply.', extra: {} }];
    let requestCount = 0;
    const { host, listeners } = makeHost(chat);
    host.sidecar.request = async () => { requestCount += 1; return 'Polished reply.'; };
    await postprocessModule.activate(host);

    await messageReceived(listeners, 0, 'normal');
    await messageReceived(listeners, 0, 'normal');

    assert.equal(requestCount, 1);
});

test('a reroll (type "regenerate") clears the stale result and reprocesses the new reply', async () => {
    const chat = [{
        is_user: false, is_system: false, mesid: 0, mes: 'Rerolled reply.',
        extra: { stme_postprocess: { originalText: 'Old reply.', trace: [], appliedAt: 1 } },
    }];
    const { host, listeners } = makeHost(chat);
    host.sidecar.request = async () => 'Polished rerolled reply.';
    await postprocessModule.activate(host);

    await messageReceived(listeners, 0, 'regenerate');

    assert.equal(chat[0].mes, 'Polished rerolled reply.');
    assert.equal(chat[0].extra.stme_postprocess.originalText, 'Rerolled reply.');
});

test('autoRun:false disables the pipeline entirely', async () => {
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'Original reply.', extra: {} }];
    const { host, listeners } = makeHost(chat, { autoRun: false });
    await postprocessModule.activate(host);

    await listeners.MESSAGE_RECEIVED(0, 'normal');

    assert.equal(chat[0].mes, 'Original reply.');
});

test('a user or system message is never processed', async () => {
    const chat = [{ is_user: true, is_system: false, mesid: 0, mes: 'Player text.', extra: {} }];
    const { host, listeners } = makeHost(chat);
    await postprocessModule.activate(host);

    await listeners.MESSAGE_RECEIVED(0, 'normal');

    assert.equal(chat[0].mes, 'Player text.');
});
