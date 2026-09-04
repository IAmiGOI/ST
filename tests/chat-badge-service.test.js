import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleDataBus } from '../core/data-bus.js';
import { ChatBadgeService } from '../core/chat-badge-service.js';

// A trivial fake DOM — just enough to exercise reapply()'s querySelector/append/
// remove usage without a real browser. Each "message row" is a plain object with
// its own tiny stand-in for classList/dataset/querySelector, keyed by mesid.
function makeFakeDom(mesids) {
    function makeNode(tag) {
        return {
            tag,
            children: [],
            dataset: {},
            className: '',
            classList: { add() {}, toggle() {} },
            append(...nodes) { this.children.push(...nodes); },
            querySelector(selector) {
                const match = selector.match(/\[data-stme-badge-owner="([^"]+)"\]/);
                if (!match) return null;
                const found = this.children.find(child => child.dataset?.stmeBadgeOwner === match[1]);
                if (found) found.remove = () => { this.children = this.children.filter(item => item !== found); };
                return found ?? null;
            },
        };
    }
    const rows = new Map(mesids.map(mesid => [String(mesid), makeNode('mes_text')]));
    globalThis.document = {
        querySelector: selector => {
            const match = selector.match(/mesid="([^"]+)"/);
            return match ? (rows.get(match[1]) ?? null) : null;
        },
        createElement: tag => makeNode(tag),
    };
    return rows;
}

const originalDocument = globalThis.document;
test.afterEach(() => { globalThis.document = originalDocument; });

test('register() + reapply(): renders the registered badge under the message, tagged with its owner', () => {
    makeFakeDom([0]);
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => ({ chat: [] }), bus);
    service.register('time', message => (message.label ? { dataset: {}, tag: 'badge-for-' + message.label } : null));

    service.reapply(0, { label: 'Day 2' });

    const root = document.querySelector('.mes[mesid="0"] .mes_text');
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].dataset.stmeBadgeOwner, 'time');
});

test('reapply() re-renders EVERY registered owner\'s badge, not just one — the actual fix for the reported bug', () => {
    makeFakeDom([0]);
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => ({ chat: [] }), bus);
    service.register('time', message => (message.time ? { dataset: {} } : null));
    service.register('postprocess', message => (message.processed ? { dataset: {} } : null));

    service.reapply(0, { time: 'Day 2', processed: true });

    const root = document.querySelector('.mes[mesid="0"] .mes_text');
    const owners = root.children.map(child => child.dataset.stmeBadgeOwner).sort();
    assert.deepEqual(owners, ['postprocess', 'time']);
});

test('reapply() only replaces ITS OWN previously-tagged badge for an owner, never a different owner\'s node', () => {
    makeFakeDom([0]);
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => ({ chat: [] }), bus);
    let timeCalls = 0;
    service.register('time', () => { timeCalls++; return { dataset: {} }; });
    service.register('postprocess', () => ({ dataset: {} }));

    service.reapply(0, {});
    service.reapply(0, {}); // simulates a SECOND content update on the same message

    const root = document.querySelector('.mes[mesid="0"] .mes_text');
    assert.equal(root.children.length, 2, 'exactly one badge per owner survives repeated reapply() calls, not an accumulating pile');
    assert.equal(timeCalls, 2);
});

test('a badge renderer that throws is skipped (logged), never blocks a DIFFERENT owner\'s badge from rendering', () => {
    makeFakeDom([0]);
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => ({ chat: [] }), bus);
    service.register('broken', () => { throw new Error('boom'); });
    service.register('time', () => ({ dataset: {} }));

    assert.doesNotThrow(() => service.reapply(0, {}));
    const root = document.querySelector('.mes[mesid="0"] .mes_text');
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].dataset.stmeBadgeOwner, 'time');
});

test('reapply() is a no-op (never throws) when the message is not currently in the DOM at all', () => {
    makeFakeDom([]); // no rows at all
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => ({ chat: [] }), bus);
    service.register('time', () => ({ dataset: {} }));
    assert.doesNotThrow(() => service.reapply(0, {}));
});

test('refreshAll() reapplies badges across every message in the real chat, keyed by mesid falling back to array index', () => {
    makeFakeDom([5, 1]);
    const context = { chat: [{ mesid: 5, label: 'a' }, { label: 'b' }] }; // second entry has no mesid — falls back to its array index (1)
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => context, bus);
    service.register('time', message => (message.label ? { dataset: {} } : null));

    service.refreshAll();

    assert.equal(document.querySelector('.mes[mesid="5"] .mes_text').children.length, 1);
    assert.equal(document.querySelector('.mes[mesid="1"] .mes_text').children.length, 1);
});

test('register() returns an unregister function that stops that owner\'s badge from being (re)rendered', () => {
    makeFakeDom([0]);
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => ({ chat: [{ mesid: 0 }] }), bus);
    const unregister = service.register('time', () => ({ dataset: {} }));
    service.reapply(0, {});
    assert.equal(document.querySelector('.mes[mesid="0"] .mes_text').children.length, 1);

    unregister();
    service.reapply(0, {});
    assert.equal(document.querySelector('.mes[mesid="0"] .mes_text').children.length, 0, 'the unregistered owner\'s stale badge must also be cleared, not left behind');
});

test('the constructor publishes { register, reapply, refreshAll } onto the bus at "chat-badges":"api" — the real, documented access path', () => {
    makeFakeDom([0]);
    const bus = new ModuleDataBus();
    // eslint-disable-next-line no-new
    new ChatBadgeService(() => ({ chat: [] }), bus);
    const api = bus.get('chat-badges', 'api');
    assert.equal(typeof api.register, 'function');
    assert.equal(typeof api.reapply, 'function');
    assert.equal(typeof api.refreshAll, 'function');
});

test('start(): CHAT_CHANGED triggers refreshAll(), and a reentrant fire during that refresh is dropped rather than recursing', () => {
    makeFakeDom([0]);
    let chatChangedHandler = null;
    const context = {
        chat: [{ mesid: 0, label: 'x' }],
        eventTypes: { CHAT_CHANGED: 'CHAT_CHANGED' },
        eventSource: {
            on(type, handler) { if (type === 'CHAT_CHANGED') chatChangedHandler = handler; },
            off(type, handler) { if (type === 'CHAT_CHANGED' && chatChangedHandler === handler) chatChangedHandler = null; },
        },
    };
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => context, bus);
    let calls = 0;
    service.register('time', message => {
        calls++;
        if (calls === 1) chatChangedHandler?.(); // nested fire while still handling the first
        return message.label ? { dataset: {} } : null;
    });

    service.start();
    chatChangedHandler();

    assert.equal(calls, 1, 'the nested CHAT_CHANGED fired synchronously from inside the refresh must be dropped, not recursed into');
});

test('stop() unsubscribes — a later CHAT_CHANGED no longer triggers refreshAll()', () => {
    makeFakeDom([0]);
    let chatChangedHandler = null;
    const context = {
        chat: [{ mesid: 0, label: 'x' }],
        eventTypes: { CHAT_CHANGED: 'CHAT_CHANGED' },
        eventSource: {
            on(type, handler) { chatChangedHandler = handler; },
            off(type, handler) { if (chatChangedHandler === handler) chatChangedHandler = null; },
        },
    };
    const bus = new ModuleDataBus();
    const service = new ChatBadgeService(() => context, bus);
    let calls = 0;
    service.register('time', () => { calls++; return null; });

    service.start();
    service.stop();
    chatChangedHandler?.();

    assert.equal(calls, 0);
});
