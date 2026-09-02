import { ModuleEngine } from './core/module-engine.js';
import { notebookModule } from './modules/notebook/index.js';
import { timeModule } from './modules/time/index.js';

const TEMPLATE_PATH = 'third-party/STModuleEngine';

function getContext() {
    if (!window.SillyTavern?.getContext) throw new Error('SillyTavern context API is unavailable.');
    return window.SillyTavern.getContext();
}

async function init() {
    const engine = new ModuleEngine(getContext);
    engine.register(notebookModule);
    engine.register(timeModule);
    await engine.start();

    const context = getContext();
    const html = await context.renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('SillyTavern extensions settings container was not found.');
    target.insertAdjacentHTML('beforeend', html);
    engine.mount(document.getElementById('st_module_engine'));
    window.STModuleEngine = engine;
    console.info('[ST Module Engine] Started with Notebook module.');
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Module Engine] Failed to start:', error); }
});
