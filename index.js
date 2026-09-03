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
import { diceModule } from './modules/dice/index.js';

const EXTENSION_NAME = deriveExtensionName(import.meta.url);
const EXTENSION_IS_GLOBAL = isGlobalInstall(import.meta.url);
const UPDATE_SESSION_FLAG = 'stme_update_attempted';
const UPDATE_RETRY_COOLDOWN_MS = 20000;
const CORE_REPO_OWNER = 'IAmiGOI';
const CORE_REPO_NAME = 'ST';

function updateRecentlyAttempted() {
    const last = Number(sessionStorage.getItem(UPDATE_SESSION_FLAG) || 0);
    return Date.now() - last < UPDATE_RETRY_COOLDOWN_MS;
}

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
    overlay.innerHTML = `<div class="stme-update-blocking-box"><div class="stme-update-blocking-spinner"></div><strong>ST Module Engine is updating…</strong><p>A newer version was found. The page will reload automatically once it's applied.</p></div>`;
    document.body.append(overlay);
    return overlay;
}

function renderUpdateBanner() {
    if (document.querySelector('.stme-update-banner')) return;
    const banner = document.createElement('div');
    banner.className = 'stme-update-banner';
    banner.innerHTML = `<span>⚠ ST Module Engine couldn't update itself automatically — it's still running the current version.</span>`;
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'menu_button'; retry.textContent = 'Retry';
    retry.addEventListener('click', async () => { retry.disabled = true; try { await attemptCoreUpdate(); } finally { retry.disabled = false; } });
    banner.append(retry); document.body.prepend(banner);
}
function removeUpdateBanner() { document.querySelector('.stme-update-banner')?.remove(); }

async function attemptCoreUpdate() {
    if (!EXTENSION_NAME) return;
    const context = getContext();
    const status = await checkCoreUpdate(context, EXTENSION_NAME, { global: EXTENSION_IS_GLOBAL });
    if (!status.checked) return;
    logUpdateDiagnostic(status);
    if (status.upToDate) { removeUpdateBanner(); return; }
    sessionStorage.setItem(UPDATE_SESSION_FLAG, String(Date.now()));
    const overlay = renderBlockingOverlay();
    const result = await applyCoreUpdate(context, EXTENSION_NAME, { global: EXTENSION_IS_GLOBAL });
    if (result.applied) { window.location.reload(); return; }
    overlay.remove(); renderUpdateBanner();
}

function logUpdateDiagnostic(status) {
    diagnoseCoreUpdate({ currentCommitHash: status.currentCommitHash, currentBranchName: status.currentBranchName, owner: CORE_REPO_OWNER, repo: CORE_REPO_NAME })
        .then(diagnosis => {
            if (!diagnosis.applicable) return;
            const localShort = diagnosis.localSha.slice(0, 7);
            const remoteShort = diagnosis.remoteSha.slice(0, 7);
            if (diagnosis.matches) console.info(`[ST Module Engine] Core update check: local commit ${localShort} matches GitHub's latest on "${diagnosis.branch}".`);
            else if (status.upToDate) console.warn(`[ST Module Engine] Core update MISMATCH: ST reported up to date at commit ${localShort}, but GitHub's latest commit on "${diagnosis.branch}" is ${remoteShort}.`);
            else console.info(`[ST Module Engine] Core update check: local commit ${localShort} is behind GitHub's latest ${remoteShort} on "${diagnosis.branch}".`);
        }).catch(() => {});
}

async function init() {
    const engine = new ModuleEngine(getContext);
    engine.register(notebookModule);
    engine.register(timeModule);
    engine.register(trackerModule);
    engine.register(musicModule);
    engine.register(macrosModule);
    engine.register(diceModule);
    await engine.start();

    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('SillyTavern extensions settings container was not found.');
    if (!document.getElementById('st_module_engine')) target.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    engine.mount(document.getElementById('st_module_engine'));

    const fullScreenPanel = createFullScreenPanel(engine);
    addTopBarLauncher(fullScreenPanel);
    const browserPanel = createModuleBrowserPanel(engine);
    document.querySelector('[data-stme-browser-tab]')?.append(renderBrowserTab(browserPanel));

    const lorebook = new LorebookService(getContext, engine.bus);
    await lorebook.start();
    window.STModuleEngine = engine;
    window.STModuleEngineLorebook = lorebook;
    window.STModuleEngineBrowser = browserPanel;
    console.info('[ST Module Engine] Started with Notebook, RP Time, Tracker, Music, Macros and Dice modules, plus the independent Lorebook service.');
}

function addTopBarLauncher(panel) {
    const launcher = document.createElement('div');
    launcher.className = 'drawer';
    launcher.innerHTML = `<div class="drawer-toggle drawer-header" title="Open ST Module Engine" data-i18n="[title]Open ST Module Engine"><div class="drawer-icon fa-solid fa-layer-group fa-fw"></div></div>`;
    const icon = launcher.querySelector('.drawer-icon');
    launcher.addEventListener('click', () => panel.toggle());
    effect(() => icon.classList.toggle('stme-launcher-active', panel.visible()));
    const sibling = document.getElementById('rightNavHolder') ?? document.getElementById('top-settings-holder');
    if (sibling) { sibling.after(launcher); return; }
    const bar = document.getElementById('top-bar');
    if (bar) { bar.append(launcher); return; }
    console.warn('[ST Module Engine] Could not find a top-bar container to attach the launcher icon to.');
}

jQuery(async () => {
    try {
        if (!updateRecentlyAttempted()) await attemptCoreUpdate();
        await init();
    } catch (error) { console.error('[ST Module Engine] Failed to start:', error); }
});
