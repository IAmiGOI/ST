const TIME_EXTRA_KEY = 'stme_rp_time';
const MAX_TIME_LENGTH = 120;
const TIME_DEFAULTS = Object.freeze({ startTime: 'Day 1, 08:00', format: 'Day {day}, HH:MM', sidecarProfile: 'default' });

export function normalizeTime(value) { return String(value ?? '').replace(/```[\s\S]*?```/g, '').replace(/^(?:time|rp time|время)\s*[:—-]\s*/i, '').replace(/[\r\n]+/g, ' ').replace(/["`]/g, '').replace(/^\[|\]$/g, '').trim().slice(0, MAX_TIME_LENGTH); }
export function buildTimeRequest(chat, settings = TIME_DEFAULTS, currentTime = settings.startTime) {
    const recent = (chat ?? []).filter(item => !item.is_system).slice(-10).map(item => `${item.is_user ? 'Player' : 'Character'}: ${String(item.mes ?? '').slice(0, 900)}`).join('\n\n');
    return { systemPrompt: `You are an RPG time tracker. The configured time format is "${settings.format}". The current known in-world time is "${currentTime}". Infer the next current in-world time from the RP context. Return only one time label in the configured format. Do not explain, quote dialogue, or use brackets.`, prompt: `ROLEPLAY CONTEXT:\n${recent}\n\nThe character is about to respond. Return the current in-world time label only.` };
}
function escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
export function appendTime(message, time) { const label = normalizeTime(time); if (!label || message?.extra?.[TIME_EXTRA_KEY]) return false; message.extra ??= {}; message.extra[TIME_EXTRA_KEY] = label; message.mes = `${String(message.mes ?? '').trimEnd()}\n\n<section class="stme-rp-time" data-stme-rp-time="true"><div class="stme-rp-time-head"><span class="stme-rp-time-icon" aria-hidden="true">◷</span><span class="stme-rp-time-label">Current RP time</span></div><div class="stme-rp-time-value">${escapeHtml(label)}</div></section>`; return true; }
function resolveMessage(chat, id) { if (Number.isInteger(id) && chat[id]) return { message: chat[id], index: id }; const index = chat.findIndex(item => item.mesid === id || item.send_date === id); return index >= 0 ? { message: chat[index], index } : null; }
function updateMessage(context, index, message) { context.updateMessageBlock?.(index, message); context.saveChatConditional?.(); context.saveChat?.(); }
function getCurrentTime(context, settings) { return context.chatMetadata?.stme_rp_time_current || settings.startTime; }
function setCurrentTime(context, time) { context.chatMetadata ??= {}; context.chatMetadata.stme_rp_time_current = time; context.saveMetadataDebounced?.(); }

export const timeModule = {
    id: 'time', title: 'RP Time', description: 'Runs SideCar in parallel with generation and appends the inferred in-world time.', defaultEnabled: false,
    activate(host) {
        let pending = null; let running = false;
        const start = host.onEvent('GENERATION_STARTED', () => { if (pending || !host.sidecar.isConfigured()) return; const context = host.context(); const settings = host.moduleSettings(TIME_DEFAULTS); pending = host.sidecar.request({ ...buildTimeRequest(context.chat, settings, getCurrentTime(context, settings)), profileId: settings.sidecarProfile }).catch(error => ({ error })); });
        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            if (running || ['swipe', 'continue', 'appendFinal', 'first_message', 'command', 'extension', 'regenerate'].includes(type)) return;
            const context = host.context(); const resolved = resolveMessage(context.chat ?? [], messageId); const request = pending; pending = null;
            if (!resolved?.message || resolved.message.is_user || resolved.message.is_system || resolved.message.extra?.[TIME_EXTRA_KEY] || !request) return;
            running = true;
            try { const result = await request; if (result?.error) throw result.error; if (!appendTime(resolved.message, result)) throw new Error('SideCar returned no usable time label.'); setCurrentTime(context, normalizeTime(result)); updateMessage(context, resolved.index, resolved.message); }
            catch (error) { console.error('[ST Module Engine] RP Time SideCar request failed:', error); host.toast('warning', error?.message || 'Could not determine RP time.', 'RP Time'); } finally { running = false; }
        });
        return () => { start(); received(); };
    },
    render(container, host) {
        const settings = host.moduleSettings(TIME_DEFAULTS); const profiles = host.sidecar.profiles();
        container.innerHTML = `<p class="stme-time-help">The SideCar request starts with generation, then a styled time badge is appended beneath the completed response.</p><div class="stme-time-form"><label>Starting time <input class="text_pole" data-field="startTime" maxlength="120"></label><label>Time format <input class="text_pole" data-field="format" maxlength="120" placeholder="Day {day}, HH:MM"></label><label>SideCar profile <select class="text_pole" data-field="sidecarProfile"></select></label><button class="menu_button" data-action="save" type="button">Save time settings</button></div>`;
        container.querySelector('[data-field="startTime"]').value = settings.startTime; container.querySelector('[data-field="format"]').value = settings.format;
        const select = container.querySelector('[data-field="sidecarProfile"]'); for (const profile of profiles) { const option = new Option(profile.name, profile.id); option.selected = profile.id === settings.sidecarProfile; select.add(option); }
        container.querySelector('[data-action="save"]').addEventListener('click', () => { settings.startTime = normalizeTime(container.querySelector('[data-field="startTime"]').value) || TIME_DEFAULTS.startTime; settings.format = String(container.querySelector('[data-field="format"]').value).trim() || TIME_DEFAULTS.format; settings.sidecarProfile = select.value; host.saveModuleSettings(); host.toast('success', 'RP Time settings saved.', 'RP Time'); });
    },
};
