import { ModuleEngine } from './core/module-engine.js';
import { createFullScreenPanel } from './core/full-screen-panel.js';
import { LorebookService } from './core/lorebook-service.js';
import { effect } from './core/reactive.js';
import { notebookModule } from './modules/notebook/index.js';
import { timeModule } from './modules/time/index.js';
import { trackerModule } from './modules/tracker/index.js';
import { musicModule } from './modules/music/index.js';

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
        </div>
    </div>
</div>`;

function getContext() {
    if (!window.SillyTavern?.getContext) throw new Error('SillyTavern context API is unavailable.');
    return window.SillyTavern.getContext();
}

async function init() {
    const engine = new ModuleEngine(getContext);
    engine.register(notebookModule);
    engine.register(timeModule);
    engine.register(trackerModule);
    engine.register(musicModule);
    await engine.start();

    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('SillyTavern extensions settings container was not found.');
    if (!document.getElementById('st_module_engine')) target.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    engine.mount(document.getElementById('st_module_engine'));

    const fullScreenPanel = createFullScreenPanel(engine);
    addTopBarLauncher(fullScreenPanel);

    // Independent of ModuleEngine on purpose — see MODULES.md's "Independent core
    // services" section. Talks to the rest of the system only through the shared bus
    // (engine.bus); other code reaches it via host.data.read('lorebook', 'api').
    const lorebook = new LorebookService(getContext, engine.bus);
    await lorebook.start();

    window.STModuleEngine = engine;
    window.STModuleEngineLorebook = lorebook;
    console.info('[ST Module Engine] Started with Notebook, RP Time, Tracker and Music modules, plus the independent Lorebook service.');
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
    try { await init(); }
    catch (error) { console.error('[ST Module Engine] Failed to start:', error); }
});
