import test from 'node:test';
import assert from 'node:assert/strict';
import { timeModule } from '../modules/time/index.js';

/**
 * Regression coverage for: a reroll (regenerate, or swiping to a new response) used
 * to never update the RP time — 'regenerate'/'swipe' were excluded message types, AND
 * even once un-excluded, the reused message object's stale .extra would still block
 * recomputation without the explicit clear added alongside this. Also covers the
 * related "stuck pending" bug: dropping an excluded message type used to leave the
 * pending SideCar request in place, silently blocking the NEXT real generation too.
 *
 * timeModule.activate() only touches `document` lazily, inside renderBadge() — once a
 * message is actually processed — never during setup, so a trivial stub (just enough
 * for renderBadge()'s "no chat DOM target, do nothing" path) is enough to drive a full
 * GENERATION_STARTED -> MESSAGE_RECEIVED round trip without a real DOM/jsdom.
 */
const originalDocument = globalThis.document;
globalThis.document = { querySelector: () => null };
test.after(() => { globalThis.document = originalDocument; });

function makeHost(chat) {
    const settings = {
        startTime: 'Year 1, Month 1, Day 1, 08:00 (Morning)',
        fields: [{ name: 'day', instruction: '' }, { name: 'time', instruction: '' }, { name: 'period', instruction: '' }],
        displayTemplate: 'Day {day}, {time} ({period})',
        sidecarProfile: 'default',
    };
    const listeners = {};
    const context = {
        chat, chatMetadata: {},
        saveMetadataDebounced() {}, updateMessageBlock() {}, saveChatConditional() {}, saveChat() {},
    };
    const host = {
        context: () => context,
        onEvent: (type, listener) => { listeners[type] = listener; return () => { delete listeners[type]; }; },
        onChatChanged: () => () => {},
        sidecar: {
            isConfigured: () => true,
            request: async () => JSON.stringify({ day: '2', time: '09:00', period: 'Morning' }),
            diagnostics: () => ({}),
        },
        moduleSettings: () => settings,
        saveModuleSettings: () => {},
        toast: () => {},
        services: { register() {}, unregister() {}, isAvailable: () => false, get: () => undefined, request: () => ({}), ask: async () => undefined },
    };
    return { host, listeners };
}

async function roundTrip(listeners, messageId, type) {
    listeners.GENERATION_STARTED();
    await new Promise(resolve => setTimeout(resolve, 10));
    await listeners.MESSAGE_RECEIVED(messageId, type);
    await new Promise(resolve => setTimeout(resolve, 10));
}

test('a reroll (type "regenerate") replaces the stale time label from before the reroll', async () => {
    const chat = [{
        is_user: false, is_system: false, mesid: 0, mes: 'Old reply.',
        extra: { stme_rp_time: 'Day 1, 08:00 (Morning)', stme_rp_time_data: { day: 'Day 1', time: '08:00', period: 'Morning' } },
    }];
    const { host, listeners } = makeHost(chat);
    await timeModule.activate(host);

    await roundTrip(listeners, 0, 'regenerate');

    assert.equal(chat[0].extra.stme_rp_time, 'Day 2, 09:00 (Morning)');
});

test('a swipe to a new response (type "swipe") also updates the time label', async () => {
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'Old reply.', extra: { stme_rp_time: 'Day 1, 08:00 (Morning)' } }];
    const { host, listeners } = makeHost(chat);
    await timeModule.activate(host);

    await roundTrip(listeners, 0, 'swipe');

    assert.equal(chat[0].extra.stme_rp_time, 'Day 2, 09:00 (Morning)');
});

test('a plain "normal" message still works exactly as before', async () => {
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'Old reply.', extra: {} }];
    const { host, listeners } = makeHost(chat);
    await timeModule.activate(host);

    await roundTrip(listeners, 0, 'normal');

    assert.equal(chat[0].extra.stme_rp_time, 'Day 2, 09:00 (Morning)');
});

test('an excluded type ("continue") still does not apply a label to that message', async () => {
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'Old reply.', extra: {} }];
    const { host, listeners } = makeHost(chat);
    await timeModule.activate(host);

    await roundTrip(listeners, 0, 'continue');

    assert.equal(chat[0].extra.stme_rp_time, undefined);
});

test('an excluded type does not leave the pending request stuck — the NEXT real generation still works', async () => {
    const chat = [
        { is_user: false, is_system: false, mesid: 0, mes: 'Continued reply.', extra: {} },
        { is_user: false, is_system: false, mesid: 1, mes: 'A brand new reply.', extra: {} },
    ];
    const { host, listeners } = makeHost(chat);
    await timeModule.activate(host);

    // First: an excluded type fires and must be dropped cleanly, not left pending.
    await roundTrip(listeners, 0, 'continue');
    assert.equal(chat[0].extra.stme_rp_time, undefined);

    // Second: a completely unrelated, real generation for a DIFFERENT message —
    // this must still send its own request and apply its own result, not be skipped
    // because a stale pending request from the "continue" above was left in place.
    await roundTrip(listeners, 1, 'normal');
    assert.equal(chat[1].extra.stme_rp_time, 'Day 2, 09:00 (Morning)', 'tracking must not be silently broken by an earlier excluded-type message');
});
