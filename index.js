import { ModuleEngine } from './core/module-engine.js';
import { notebookModule } from './modules/notebook/index.js';
import { timeModule } from './modules/time/index.js';

// Kept in JavaScript deliberately: the extension can be installed under any
// folder name, so the settings UI does not depend on a fetched template path.
const SETTINGS_HTML = `
<div id="st_module_engine" class="stme-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>ST Module Engine</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
            <p class="stme-intro">Independent modules managed from one place.</p>
            <div id="stme-module-list" class="stme-module-list"></div>
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
    await engine.start();

    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('SillyTavern extensions settings container was not found.');
    if (!document.getElementById('st_module_engine')) target.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    engine.mount(document.getElementById('st_module_engine'));
    window.STModuleEngine = engine;
    console.info('[ST Module Engine] Started with Notebook and RP Time modules.');
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Module Engine] Failed to start:', error); }
});
