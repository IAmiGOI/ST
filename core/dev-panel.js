import { h, signal, effectOn, Button, makeDraggable, applyFloatingPosition } from './widgets.js';

/**
 * A floating diagnostic window: registered modules and their state, every
 * reserved bus channel (with its current value), and the engine's recent log.
 * It is NOT a module — it doesn't go through activate()/render()/host, isn't
 * toggled in the module list, and isn't nested in any drawer. It's built
 * directly by the engine and appended to document.body, so it reads as a
 * detached window rather than part of ST Module Engine's own settings UI —
 * the same reasoning as Tracker's HUD, generalized to the whole engine.
 *
 * `engine` needs: listModuleStates(), logs(), bus (the ModuleDataBus
 * instance), devPanelSettings(), saveSettings().
 */
export function createDevPanel(engine) {
    const settings = engine.devPanelSettings();
    const visible = signal(Boolean(settings.visible));
    const collapsed = signal(Boolean(settings.collapsed));
    const refreshTick = signal(0);

    const panel = h('div', { class: 'stme-dev-panel' });
    applyFloatingPosition(panel, settings);

    const head = h('div', { class: 'stme-dev-panel-head' },
        h('span', { class: 'stme-dev-panel-grip' }, '⠿'),
        h('strong', {}, 'ModuleEngine Developer'),
        Button('⟳', () => refreshTick.update(n => n + 1)),
        Button('–', () => collapsed.update(v => !v)),
        Button('×', () => visible.set(false)),
    );
    const body = h('div', { class: 'stme-dev-panel-body' });
    panel.append(head, body);
    document.body.append(panel);

    effectOn(panel, () => { panel.hidden = !visible(); persist(); });
    effectOn(panel, () => { panel.classList.toggle('stme-dev-panel-collapsed', collapsed()); persist(); });
    effectOn(body, () => {
        refreshTick();
        body.replaceChildren(renderModulesSection(engine), renderChannelsSection(engine), renderLogSection(engine));
    });

    function persist() {
        const next = engine.devPanelSettings();
        next.visible = visible.peek();
        next.collapsed = collapsed.peek();
        engine.saveSettings();
    }

    const unmakeDraggable = makeDraggable(panel, head, {
        onDrop: position => { Object.assign(engine.devPanelSettings(), position); engine.saveSettings(); },
    });

    return {
        node: panel,
        toggle: () => visible.update(v => !v),
        show: () => visible.set(true),
        hide: () => visible.set(false),
        dispose: () => { unmakeDraggable(); panel.remove(); },
    };
}

function renderModulesSection(engine) {
    const modules = engine.listModuleStates();
    return h('section', { class: 'stme-dev-section' },
        h('h4', {}, `Modules (${modules.length})`),
        h('div', { class: 'stme-dev-table' }, modules.map(module => h('div', { class: 'stme-dev-row' },
            h('span', { class: 'stme-dev-row-title' }, module.title, h('code', {}, module.id)),
            h('span', { class: `stme-dev-badge stme-dev-badge-${module.error ? 'error' : module.enabled ? 'on' : 'off'}` },
                module.error ? `error: ${module.error}` : module.enabled ? 'enabled' : 'disabled'),
        ))),
    );
}

function renderChannelsSection(engine) {
    const channels = engine.bus.listChannels();
    return h('section', { class: 'stme-dev-section' },
        h('h4', {}, `Bus channels (${channels.length})`),
        channels.length
            ? h('div', { class: 'stme-dev-table' }, channels.map(channel => h('div', { class: 'stme-dev-row stme-dev-channel-row' },
                h('span', { class: 'stme-dev-row-title' }, channel.name || channel.id, h('code', {}, channel.id)),
                h('span', { class: 'stme-dev-channel-flags' }, channelFlags(channel)),
                h('code', { class: 'stme-dev-channel-value' }, previewValue(engine.bus.get(channel.namespace, channel.key))),
            )))
            : h('p', { class: 'stme-dev-empty' }, 'No channels reserved yet.'),
    );
}

function channelFlags(channel) {
    const flags = [];
    if (channel.hasSchema) flags.push(['schema', 'Rejects a write that fails its schema']);
    if (channel.allowExternalWrite) flags.push(['open', 'Any module may write here, not just the owner']);
    if (channel.macro) flags.push([`{{${channel.macro}}}`, 'Registered as an ST macro']);
    if (channel.webhook?.push) flags.push(['push', 'Pushes to an external URL on every write']);
    if (channel.webhook?.pull) flags.push(['pull', 'Pulls from an external URL on an interval']);
    if (channel.persist) flags.push(['persist', 'Mirrored into chatMetadata']);
    return flags.map(([label, title]) => h('span', { class: 'stme-dev-flag', title }, label));
}

function previewValue(value) {
    if (value === undefined) return '(empty)';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function renderLogSection(engine) {
    const logs = engine.logs().slice(0, 20);
    return h('section', { class: 'stme-dev-section' },
        h('h4', {}, 'Recent log'),
        logs.length
            ? h('div', { class: 'stme-dev-log' }, logs.map(entry => h('div', { class: `stme-dev-log-row stme-dev-log-${entry.level}` },
                h('span', { class: 'stme-dev-log-time' }, new Date(entry.time).toLocaleTimeString()),
                h('span', { class: 'stme-dev-log-module' }, entry.moduleId),
                h('span', { class: 'stme-dev-log-message' }, entry.message),
            )))
            : h('p', { class: 'stme-dev-empty' }, 'No log entries yet.'),
    );
}
