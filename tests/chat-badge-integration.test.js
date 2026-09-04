import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';
import { ChatBadgeService } from '../core/chat-badge-service.js';
import { timeModule } from '../modules/time/index.js';
import { postprocessModule } from '../modules/postprocess/index.js';

/**
 * The exact bug reported: Post-Turn Processor rewriting a message's text calls
 * context.updateMessageBlock(), which re-renders that message's DOM from its
 * stored .mes/.extra alone — silently erasing RP Time's already-appended time
 * badge, a pure DOM side effect updateMessageBlock() knows nothing about. This
 * proves the fix end to end: both real modules, the real ChatBadgeService, a
 * real ModuleEngine — only the DOM itself and SideCar are faked.
 */
// A more complete fake DOM element than chat-badge-service.test.js needs — this
// test calls the REAL createBadge()/createPostprocessBadge() from both real
// modules (not a trivial test-only renderer), which use innerHTML, textContent,
// and document.createTextNode. Selectors used inside a badge's own template
// (e.g. RP Time's '.stme-rp-time-value') resolve to a throwaway settable
// stand-in rather than real HTML parsing — the real modules only ever assign
// .textContent to it, never read it back, so nothing more is needed.
function makeFakeDom(mesid) {
    function makeNode(tag) {
        const node = {
            tag, children: [], dataset: {}, className: '', textContent: '', _innerHtmlTargets: {},
            classList: { add() {}, toggle() {} },
            append(...nodes) { this.children.push(...nodes); },
            querySelector(selector) {
                const ownerMatch = selector.match(/\[data-stme-badge-owner="([^"]+)"\]/);
                if (ownerMatch) {
                    const found = this.children.find(child => child.dataset?.stmeBadgeOwner === ownerMatch[1]);
                    if (found) found.remove = () => { this.children = this.children.filter(item => item !== found); };
                    return found ?? null;
                }
                return this._innerHtmlTargets[selector] ??= makeNode('#target');
            },
            set innerHTML(html) { this._html = html; },
            get innerHTML() { return this._html ?? ''; },
            // updateMessageBlock() in real ST rebuilds the message's real innerHTML
            // from .mes/.extra — simulated here as "wipe every appended child",
            // since that's the one behavior this whole fix depends on.
            wipe() { this.children = []; },
        };
        return node;
    }
    const row = makeNode('mes_text');
    globalThis.document = {
        querySelector: selector => (selector.includes(`mesid="${mesid}"`) ? row : null),
        createElement: tag => makeNode(tag),
        createTextNode: text => ({ tag: '#text', text }),
    };
    return row;
}

const originalDocument = globalThis.document;
test.after(() => { globalThis.document = originalDocument; });

function makeEngine() {
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: { MESSAGE_RECEIVED: 'MESSAGE_RECEIVED' },
        eventSource: {
            listeners: new Map(),
            on(type, handler) { const set = this.listeners.get(type) ?? new Set(); set.add(handler); this.listeners.set(type, set); },
            off(type, handler) { this.listeners.get(type)?.delete(handler); },
        },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
        updateMessageBlock(index, message) {
            // Real ST behavior this bug depends on: re-render from stored state,
            // wiping any DOM a module appended outside of it.
            const mesid = message.mesid ?? index;
            const root = document.querySelector(`.mes[mesid="${mesid}"] .mes_text`);
            root?.wipe();
        },
        saveChatConditional() {}, saveChat() {},
    };
    // Each handler is awaited AND flushed (its own fire-and-forget badge
    // setTimeout() included) before the NEXT one starts — deterministically
    // reproducing the real bug's actual precondition: RP Time's badge must
    // already be drawn ON THE DOM before Post-Turn Processor's own
    // updateMessageBlock() call has a chance to wipe it. A naive "await every
    // handler, THEN flush once at the end" harness would never exercise this:
    // both modules defer their own badge draw via setTimeout, so without a
    // flush IN BETWEEN, neither badge is drawn yet when the second handler's
    // synchronous updateMessageBlock() runs — masking the bug regardless of
    // whether the fix is present.
    async function fireMessageReceived(id, type) {
        for (const handler of [...(context.eventSource.listeners.get('MESSAGE_RECEIVED') ?? [])]) {
            await handler(id, type);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    const engine = new ModuleEngine(() => context);
    return { engine, context, fireMessageReceived };
}

test('Post-Turn Processor rewriting a message RP Time already time-stamped does not erase the time badge', async () => {
    const { engine, context, fireMessageReceived } = makeEngine();
    const chatBadges = new ChatBadgeService(() => context, engine.bus);

    engine.register(timeModule);
    engine.register(postprocessModule);
    await engine.enable('time');
    const postSettings = engine.moduleSettings('postprocess', {});
    postSettings.autoRun = true;
    postSettings.passes = [{ id: 'p1', name: 'Polish', prompt: 'Polish it.', profileId: 'default', enabled: true }];
    await engine.enable('postprocess');

    // Both modules need a "configured" SideCar to actually run.
    const sidecarSettings = engine.settings();
    sidecarSettings.sidecars = [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://example.test', model: 'm' }];
    let call = 0;
    engine.sidecar.service('primary').request = async () => (call++ === 0 ? '{"year":"1","month":"1","day":"2","time":"09:00","period":"Morning"}' : 'Polished reply.');

    context.chat.push({ is_user: false, is_system: false, mesid: 0, mes: 'Original reply.', extra: {} });
    const row = makeFakeDom(0);

    await fireMessageReceived(0, 'normal');

    // RP Time's badge must be present...
    assert.ok(row.children.some(child => child.dataset.stmeBadgeOwner === 'time'), 'RP Time badge missing after both modules ran');
    // ...AND Post-Turn Processor's own diff badge must also be present — the
    // updateMessageBlock() call inside applyPipelineResult() must not have left
    // the DOM with only its own badge and nobody else's.
    assert.ok(row.children.some(child => child.dataset.stmeBadgeOwner === 'postprocess'), 'Post-Turn Processor badge missing');
    assert.equal(row.children.length, 2, 'exactly one badge per owner — no duplicates from repeated reapply() calls');

    // And the underlying data both badges are actually derived from is real:
    assert.equal(context.chat[0].extra.stme_rp_time, 'Year 1, Month 1, Day 2, 09:00 (Morning)');
    assert.equal(context.chat[0].mes, 'Polished reply.');
});
