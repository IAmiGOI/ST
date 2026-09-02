const TIME_EXTRA_KEY = 'stme_rp_time';
const MAX_TIME_LENGTH = 120;

export function normalizeTime(value) {
    return String(value ?? '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/^(?:time|rp time|время)\s*[:—-]\s*/i, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/["`]/g, '')
        .replace(/^\[|\]$/g, '')
        .trim()
        .slice(0, MAX_TIME_LENGTH);
}

export function buildTimeRequest(chat, message) {
    const recent = (chat ?? []).filter(item => !item.is_system).slice(-8).map(item => {
        const role = item.is_user ? 'Player' : 'Character';
        return `${role}: ${String(item.mes ?? '').slice(0, 700)}`;
    }).join('\n\n');
    return {
        systemPrompt: 'You are an RPG time tracker. Infer the current in-world time from the roleplay context. Return only a short time label (for example, "Day 3, 18:40" or "The following morning"). Do not explain, do not quote dialogue, and do not use brackets.',
        prompt: `ROLEPLAY CONTEXT:\n${recent}\n\nLATEST CHARACTER RESPONSE:\n${String(message.mes ?? '').slice(0, 1200)}\n\nReturn the current in-world time label only.`,
        maxTokens: 48,
        temperature: 0,
    };
}

export function appendTime(message, time) {
    const label = normalizeTime(time);
    if (!label || message?.extra?.[TIME_EXTRA_KEY]) return false;
    message.extra ??= {};
    message.extra[TIME_EXTRA_KEY] = label;
    message.mes = `${String(message.mes ?? '').trimEnd()}\n\n[RP Time: ${label}]`;
    return true;
}

function resolveMessage(chat, id) {
    if (Number.isInteger(id) && chat[id]) return { message: chat[id], index: id };
    const index = chat.findIndex(item => item.mesid === id || item.send_date === id);
    return index >= 0 ? { message: chat[index], index } : null;
}

function updateMessage(context, index, message) {
    context.updateMessageBlock?.(index, message);
    context.saveChatConditional?.();
    context.saveChat?.();
}

export const timeModule = {
    id: 'time',
    title: 'RP Time',
    description: 'Uses SideCar after a character response and appends the inferred in-world time.',
    defaultEnabled: false,

    activate(host) {
        const sidecar = host.sidecar.acquire('rp-time');
        let running = false;
        const unsubscribe = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            if (running || ['swipe', 'continue', 'appendFinal', 'first_message', 'command', 'extension', 'regenerate'].includes(type)) return;
            if (!sidecar.isConfigured()) return;
            const context = host.context();
            const resolved = resolveMessage(context.chat ?? [], messageId);
            if (!resolved?.message || resolved.message.is_user || resolved.message.is_system || resolved.message.extra?.[TIME_EXTRA_KEY]) return;
            running = true;
            try {
                const time = await sidecar.request(buildTimeRequest(context.chat, resolved.message));
                if (appendTime(resolved.message, time)) {
                    updateMessage(context, resolved.index, resolved.message);
                }
            } catch (error) {
                console.error('[ST Module Engine] RP Time SideCar request failed:', error);
            } finally { running = false; }
        });
        return () => { unsubscribe(); sidecar.release(); };
    },

    render(container, host) {
        const configured = host.sidecar.isConfigured();
        const note = document.createElement('p');
        note.className = 'stme-time-help';
        note.textContent = configured
            ? 'After each normal character response, SideCar infers the in-world time and this module appends [RP Time: …] below the existing text. The response itself is never rewritten by the model.'
            : 'Configure and enable SideCar below, then enable this module. It will append an inferred [RP Time: …] after normal character responses.';
        container.append(note);
    },
};
