/**
 * A "worker" that isn't a real SideCar at all — it routes a request through ST's own
 * main LLM connection via `context.generateRaw({ systemPrompt, prompt })`. Confirmed
 * against ST's own extension docs: generateRaw runs with no chat-context injection
 * (a module already builds its own context excerpt into `prompt`, same as any real
 * SideCar call — auto-injecting the whole chat history again would double it) and
 * never renders anything in the chat UI, so this is genuinely invisible/"quiet" the
 * same way a real SideCar call is.
 *
 * SidecarManager treats this as priority-0 — it is NEVER part of the normal
 * round-robin worker pool (`available()`/`request()`/`#pick()`). A module only ever
 * reaches it by explicitly calling `requestFallback()` after hitting a specific
 * failure it has decided warrants falling back — never automatically, never as part
 * of ordinary load balancing. Enabled by default at the SidecarManager level (a
 * silent "no fallback exists" defeats the point), but still only used per-call, at
 * the call site's own discretion.
 *
 * Deliberately does NOT reuse SidecarService — there is no endpoint/apiKey/model/
 * format to configure here at all; it rides whatever connection the user already
 * has active as their main chat model, whatever that happens to be.
 */
export class MainLlmService {
    #getContext;

    constructor(getContext) {
        this.#getContext = getContext;
    }

    /** True only if this ST build actually exposes generateRaw — older/unusual builds may not. */
    isConfigured() {
        const context = this.#getContext();
        return typeof context?.generateRaw === 'function';
    }

    /** Same request/return shape as SidecarService.request() (a plain trimmed string) so callers never need to branch on which one answered. */
    async request({ prompt, systemPrompt = '', moduleId = 'unknown' } = {}) {
        const context = this.#getContext();
        if (typeof context?.generateRaw !== 'function') throw new Error('The main LLM fallback is not available in this SillyTavern build (generateRaw is missing).');
        if (!String(prompt ?? '').trim()) throw new Error('Main LLM fallback request requires a prompt.');
        console.debug(`[ST Module Engine] Main-LLM fallback request from ${moduleId}.`);
        const result = await context.generateRaw({ systemPrompt: String(systemPrompt ?? ''), prompt: String(prompt) });
        return String(result ?? '').trim();
    }
}
