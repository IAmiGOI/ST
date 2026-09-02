const TIME_EXTRA_KEY = 'stme_rp_time';
const MAX_TIME_LENGTH = 120;
const TIME_DEFAULTS = Object.freeze({ startTime: 'Day 1, 08:00', format: 'Day {day}, HH:MM' });

export function normalizeTime(value) {
    return String(value ?? '').replace(/```[\s\S]*?```/g, '').replace(/^(?:time|rp time|время)\s*[:—-]\s*/i, '').replace(/[\r\n]+/g, ' ').replace(/["`]/g, '').replace(/^\[|\]$/g, '').trim().slice(0, MAX_TIME_LENGTH);
}

export function buildTimeRequest(chat, message, settings = TIME_DEFAULTS, currentTime = settings.startTime) {
    const recent = (chat ?? []).filter(item => !item.is_system).slice(-8).map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 700)}`).join('\n\n');
    return {
        systemPrompt: `You are an RPG time tracker. The configured time format is "${settings.format}". The current known in-world time is "${currentTime}". Infer the next current in-world time from the RP context. Return only one time label in the configured format. Do not explain, quote dialogue, or use brackets.`,
        prompt: `ROLEPLAY CONTEXT:\n${recent}\n\nLATEST CHARACTER RESPONSE:\n${String(message.mes ?? '').slice(0, 1200)}\n\nReturn the current in-world time label only.`, maxTokens: 48, temperature: 0,
    };
}

export function appendTime(message, time) {
    const label = normalizeTime(time);
    if (!label || message?.extra?.[TIME_EXTRA_KEY]) return false;
    message.extra ??= {}; message.extra[TIME_EXTRA_KEY] = label;
    message.mes = `${String(message.mes ?? '').trimEnd()}\n\n[RP Time: ${label}]`;
    return true;
}

function resolveMessage(chat, id) { if (Number.isInteger(id) && chat[id]) return { message: chat[id], index: id }; const index = chat.findIndex(item => item.mesid === id || item.send_date === id); return index >= 0 ? { message: chat[index], index } : null; }
function updateMessage(context, index, message) { context.updateMessageBlock?.(index, message); context.saveChatConditional?.(); context.saveChat?.(); }
function getCurrentTime(context, settings) { return context.chatMetadata?.stme_rp_time_current || settings.startTime; }
function setCurrentTime(context, time) { context.chatMetadata ??= {}; context.chatMetadata.stme_rp_time_current = time; context.saveMetadataDebounced?.(); }

export const timeModule = {
    id: 'time', title: 'RP Time', description: 'Uses SideCar after a character response and appends the inferred in-world time.', defaultEnabled: false,
    activate(host) {
        const sidecar = host.sidecar.acquire('rp-time'); let running = false;
        const unsubscribe = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            if (running || ['swipe', 'continue', 'appendFinal', 'first_message', 'command', 'extension', 'regenerate'].includes(type) || !sidecar.isConfigured()) return;
            const context = host.context(); const resolved = resolveMessage(context.chat ?? [], messageId); const settings = host.moduleSettings(TIME_DEFAULTS);
            if (!resolved?.message || resolved.message.is_user || resolved.message.is_system || resolved.message.extra?.[TIME_EXTRA_KEY]) return;
            running = true;
            try { const time = await sidecar.request(buildTimeRequest(context.chat, resolved.message, settings, getCurrentTime(context, settings))); if (appendTime(resolved.message, time)) { setCurrentTime(context, normalizeTime(time)); updateMessage(context, resolved.index, resolved.message); } }
            catch (error) { console.error('[ST Module Engine] RP Time SideCar request failed:', error); } finally { running = false; }
        });
        return () => { unsubscribe(); sidecar.release(); };
    },
    render(container, host) {
        const settings = host.moduleSettings(TIME_DEFAULTS); const configured = host.sidecar.isConfigured();
        container.innerHTML = `<p class="stme-time-help">${configured ? 'SideCar appends a time label below each normal character response; the response text is never rewritten.' : 'Configure and enable SideCar below, then enable this module.'}</p><div class="stme-time-form"><label>Starting time <input class="text_pole" data-field="startTime" maxlength="120"></label><label>Time format <input class="text_pole" data-field="format" maxlength="120" placeholder="Day {day}, HH:MM"></label><button class="menu_button" data-action="save" type="button">Save time settings</button></div>`;
        container.querySelector('[data-field="startTime"]').value = settings.startTime; container.querySelector('[data-field="format"]').value = settings.format;
        container.querySelector('[data-action="save"]').addEventListener('click', () => { settings.startTime = normalizeTime(container.querySelector('[data-field="startTime"]').value) || TIME_DEFAULTS.startTime; settings.format = String(container.querySelector('[data-field="format"]').value).trim() || TIME_DEFAULTS.format; host.saveModuleSettings(); host.toast('success', 'RP Time settings saved. The starting time is used for new chats.', 'RP Time'); });
    },
};
