import { ModuleEngine } from './core/module-engine.js';
import { createFullScreenPanel } from './core/full-screen-panel.js';
import { createModuleBrowserPanel, renderBrowserTab } from './core/module-browser.js';
import { LorebookService } from './core/lorebook-service.js';
import { checkCoreUpdate, applyCoreUpdate, deriveExtensionName, isGlobalInstall } from './core/self-update.js';
import { diagnoseCoreUpdate } from './core/update-diagnostics.js';
import { effect } from './core/reactive.js';
import { notebookModule } from './modules/notebook/index.js';
import { timeModule } from './modules/time/index.js';
import { trackerModule } from './modules/tracker/index.js';
import { musicModule } from './modules/music/index.js';
import { macrosModule } from './modules/macros/index.js';

// See core/self-update.js — needs this exact script's own URL, which only index.js
// (the real entry point ST imports) can supply via import.meta.url.
const EXTENSION_NAME = deriveExtensionName(import.meta.url);
// This extension's own root — the ONLY thing index.js passes to ModuleEngine's
// constructor beyond getContext. Lets DependencyScanner's scanServiceContracts()
// (via ModuleEngine's #moduleSourceUrl) fetch a BUILT-IN module's own raw source
// (e.g. `${BASE_URL}modules/tracker/index.js`) the same way it already can for an
// externally-loaded module's known sourceUrl — see core/dependency-scanner.js.
const BASE_URL = new URL('.', import.meta.url).href;
// Guards against a reload loop: after an automatic attempt, a fresh one is skipped
// for a short cooldown — long enough to survive one full check+apply+reload cycle
// (network calls, a git pull, the reload itself) so a broken update can't loop
// forever, but short enough that reloading again later (the normal "did my new
// commits land yet" workflow) still gets a genuinely fresh check. Storing a
// timestamp rather than a flat boolean matters: a boolean version of this guard was
// confirmed to silently block every check for the rest of the tab's lifetime after
// the FIRST successful auto-update — sessionStorage survives reloads by design, so
// a plain "have we ever tried" flag never resets on its own. A failed attempt is
// separately communicated via the banner below, with a manual Retry that bypasses
// this cooldown entirely (an explicit click should never be silently ignored).
const UPDATE_SESSION_FLAG = 'stme_update_attempted';
const UPDATE_RETRY_COOLDOWN_MS = 20000;
// This extension's own repo — see update-diagnostics.js. Hardcoded rather than
// parsed from ST's `remoteUrl` response field: that's the ground truth for what
// git is actually tracking, but this is a diagnostic tool checking against the
// repo this codebase is actually meant to ship from, not whatever a broken/
// misconfigured local remote happens to say.
const CORE_REPO_OWNER = 'IAmiGOI';
const CORE_REPO_NAME = 'ST';

function updateRecentlyAttempted() {
    const last = Number(sessionStorage.getItem(UPDATE_SESSION_FLAG) || 0);
    return Date.now() - last < UPDATE_RETRY_COOLDOWN_MS;
}

// The drawer lives in JavaScript so the extension works regardless of its
// installation folder name and never depends on a fetched template file.
const SETTINGS_HTML = `
<div id="st_module_engine" class="stme-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>ST Module Engine</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
            <p class="stme-intro">Independent modules managed from one place.</p>
            <section class="stme-section"><h4>Base settings</h4><div data-stme-base-list class="stme-base-list"></div></section>
            <section class="stme-section"><h4>Modules <small>Drag cards to reorder them.</small></h4><div data-stme-module-list class="stme-module-list"></div></section>
            <section class="stme-section" data-stme-browser-tab></section>
        </div>
    </div>
</div>`;

function getContext() {
    if (!window.SillyTavern?.getContext) throw new Error('SillyTavern context API is unavailable.');
    return window.SillyTavern.getContext();
}

function renderBlockingOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'stme-update-blocking';
    overlay.innerHTML = `
        <div class="stme-update-blocking-box">
            <div class="stme-update-blocking-spinner"></div>
            <strong>ST Module Engine is updating…</strong>
            <p>A newer version was found. The page will reload automatically once it's applied.</p>
        </div>`;
    document.body.append(overlay);
    return overlay;
}

function renderUpdateBanner() {
    if (document.querySelector('.stme-update-banner')) return;
    const banner = document.createElement('div');
    banner.className = 'stme-update-banner';
    banner.innerHTML = `<span>⚠ ST Module Engine couldn't update itself automatically — it's still running the current version.</span>`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'menu_button';
    retry.textContent = 'Retry';
    retry.addEventListener('click', async () => {
        retry.disabled = true;
        try { await attemptCoreUpdate(); }
        finally { retry.disabled = false; }
    });
    banner.append(retry);
    document.body.prepend(banner);
}

function removeUpdateBanner() {
    document.querySelector('.stme-update-banner')?.remove();
}

/**
 * Checks whether a newer core version is available and, if so, blocks the page
 * (a full-viewport overlay, not just the extension's own panel — the ask was to
 * block *access*, not just this one drawer) while applying it and reloading.
 * Silent — no overlay, no banner — for anything short of "a newer version exists
 * and we tried to apply it": a non-git install, a failed network check, or already
 * up to date all fall through here without a trace. Only an actual FAILED apply
 * (update existed, git pull didn't succeed) shows the yellow banner.
 */
async function attemptCoreUpdate() {
    if (!EXTENSION_NAME) return;
    const context = getContext();
    // Asked fresh each call (never cached) — this runs at most twice a session (boot,
    // plus a possible manual Retry), so a real /discover round trip here is cheap and
    // avoids ever acting on a stale global/local classification. See isGlobalInstall's
    // own doc comment for why this can no longer be derived from the URL alone.
    const global = await isGlobalInstall(EXTENSION_NAME, context);
    const status = await checkCoreUpdate(context, EXTENSION_NAME, { global });
    if (!status.checked) return;
    logUpdateDiagnostic(status); // fire-and-forget — see below; never blocks or affects the real flow
    if (status.upToDate) { removeUpdateBanner(); return; }

    sessionStorage.setItem(UPDATE_SESSION_FLAG, String(Date.now()));
    const overlay = renderBlockingOverlay();
    const result = await applyCoreUpdate(context, EXTENSION_NAME, { global });
    if (result.applied) { window.location.reload(); return; }
    overlay.remove();
    renderUpdateBanner();
}

/**
 * Cross-checks ST's isUpToDate answer against GitHub's real branch HEAD (see
 * update-diagnostics.js) and logs the result to the console — never a toast/banner,
 * same "silent unless something's actually wrong" rule as attemptCoreUpdate itself.
 * Purely observational: fire-and-forget, its own failures are swallowed, and it
 * never influences whether an update gets applied. Exists so a future "reports up
 * to date but is visibly stale" report has a real trail instead of a guess.
 */
function logUpdateDiagnostic(status) {
    diagnoseCoreUpdate({ currentCommitHash: status.currentCommitHash, currentBranchName: status.currentBranchName, owner: CORE_REPO_OWNER, repo: CORE_REPO_NAME })
        .then(diagnosis => {
            if (!diagnosis.applicable) return;
            const localShort = diagnosis.localSha.slice(0, 7);
            const remoteShort = diagnosis.remoteSha.slice(0, 7);
            if (diagnosis.matches) {
                console.info(`[ST Module Engine] Core update check: local commit ${localShort} matches GitHub's latest on "${diagnosis.branch}".`);
            } else if (status.upToDate) {
                console.warn(`[ST Module Engine] Core update MISMATCH: ST reported up to date at commit ${localShort}, but GitHub's latest commit on "${diagnosis.branch}" is ${remoteShort}. The local git checkout is stuck behind origin despite the update endpoint saying otherwise.`);
            } else {
                console.info(`[ST Module Engine] Core update check: local commit ${localShort} is behind GitHub's latest ${remoteShort} on "${diagnosis.branch}" — an update is about to be applied.`);
            }
        })
        .catch(() => {}); // diagnoseCoreUpdate() itself never throws; defensive only
}

async function init() {
    const engine = new ModuleEngine(getContext, BASE_URL);
    engine.register(notebookModule);
    engine.register(timeModule);
    engine.register(trackerModule);
    engine.register(musicModule);
    engine.register(macrosModule);
    await engine.start();

    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('SillyTavern extensions settings container was not found.');
    if (!document.getElementById('st_module_engine')) target.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    engine.mount(document.getElementById('st_module_engine'));

    const fullScreenPanel = createFullScreenPanel(engine);
    addTopBarLauncher(fullScreenPanel);

    // A single overlay instance, opened from the "Browser" tab right after the
    // Modules section (see SETTINGS_HTML above) — reuses the same full-viewport
    // panel mechanism as fullScreenPanel above (core/module-browser.js).
    const browserPanel = createModuleBrowserPanel(engine);
    document.querySelector('[data-stme-browser-tab]')?.append(renderBrowserTab(browserPanel));

    // Independent of ModuleEngine on purpose — see MODULES.md's "Independent core
    // services" section. Talks to the rest of the system only through the shared bus
    // (engine.bus); other code reaches it via host.data.read('lorebook', 'api').
    const lorebook = new LorebookService(getContext, engine.bus);
    await lorebook.start();

    window.STModuleEngine = engine;
    window.STModuleEngineLorebook = lorebook;
    window.STModuleEngineBrowser = browserPanel;
    console.info('[ST Module Engine] Started with Notebook, RP Time, Tracker, Music and Macros modules, plus the independent Lorebook service.');
}

/**
 * SillyTavern has no plugin API for registering a top-level tab — extensions that add
 * one (e.g. Character Library) do it by inserting their own icon into ST's real
 * persistent top-right icon row and building the "tab" themselves as an overlay. This
 * mirrors that exact insertion point + fallback chain and native icon markup so the
 * button is visually indistinguishable from ST's own.
 */
function addTopBarLauncher(panel) {
    const launcher = document.createElement('div');
    launcher.className = 'drawer';
    launcher.innerHTML = `
        <div class="drawer-toggle drawer-header" title="Open ST Module Engine" data-i18n="[title]Open ST Module Engine">
            <div class="drawer-icon fa-solid fa-layer-group fa-fw"></div>
        </div>`;
    const icon = launcher.querySelector('.drawer-icon');
    launcher.addEventListener('click', () => panel.toggle());
    effect(() => icon.classList.toggle('stme-launcher-active', panel.visible()));

    // #rightNavHolder / #top-settings-holder are specific icon elements in ST's own icon
    // row — insert as their next sibling, matching how ST's own icons sit side by side.
    // #top-bar (last resort) is the broader bar container itself, so append INSIDE it.
    const sibling = document.getElementById('rightNavHolder') ?? document.getElementById('top-settings-holder');
    if (sibling) { sibling.after(launcher); return; }
    const bar = document.getElementById('top-bar');
    if (bar) { bar.append(launcher); return; }
    console.warn('[ST Module Engine] Could not find a top-bar container to attach the launcher icon to — the full-screen panel is still reachable via panel.toggle() but has no button.');
}

jQuery(async () => {
    try {
        // Runs before anything else boots — a page reload triggered by a successful
        // update means init() below never has to deal with half-loaded state.
        if (!updateRecentlyAttempted()) await attemptCoreUpdate();
        await init();
    }
    catch (error) { console.error('[ST Module Engine] Failed to start:', error); }
});
