import { saveTrackBlob, loadTrackBlob, deleteTrackBlob } from './audio-store.js';
import { selectTrack } from './selection.js';
import {
    h, list, show, signal, computed, onDispose, effectOn,
    Field, TextInput, Select, Toggle, Button, Chip,
    makeDraggable, applyFloatingPosition,
} from '../../core/widgets.js';

const MODULE_ID = 'music';
const MAX_VOCABULARY = 50;
const MAX_KEY_LENGTH = 40;
const IGNORED_MESSAGE_TYPES = ['swipe', 'continue', 'appendFinal', 'first_message', 'command', 'extension', 'regenerate'];

const MODULE_DEFAULTS = Object.freeze({
    vocabulary: [],
    tracks: [],
    sidecarProfile: 'default',
    autoClassify: true,
    // Reassigned wholesale on every change, never mutated in place — see the
    // note on Tracker's MODULE_DEFAULTS for why (shared frozen default aliasing).
    player: { visible: false, collapsed: false, x: null, y: null, volume: 0.7 },
});

function clamp01(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0.7;
}

function createTrackId() {
    return `track_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Trims, dedupes, drops blanks, caps at MAX_VOCABULARY — same shape as Tracker's own vocabulary sanitizer, kept local since modules don't import from one another. */
export function sanitizeVocabulary(vocabulary) {
    const seen = new Set();
    const result = [];
    for (const raw of Array.isArray(vocabulary) ? vocabulary : []) {
        const key = String(raw ?? '').trim().slice(0, MAX_KEY_LENGTH);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(key);
        if (result.length >= MAX_VOCABULARY) break;
    }
    return result;
}

function renderTrackKeyToggle(track, key, keyCount, host) {
    const active = signal(track.keys.includes(key));
    return h('button', {
        type: 'button',
        class: computed(() => active() ? 'stme-music-key-toggle stme-music-key-toggle-active' : 'stme-music-key-toggle'),
        'on:click': () => {
            const next = active.peek() ? track.keys.filter(k => k !== key) : [...track.keys, key];
            track.keys = next;
            active.set(!active.peek());
            keyCount.set(next.length);
            host.saveModuleSettings();
        },
    }, key);
}

function renderTrackKeysDetails(track, vocabulary, host) {
    const keyCount = signal(track.keys.length);
    return h('details', { class: 'stme-music-track-keys' },
        h('summary', {}, computed(() => `Keys (${keyCount()})`)),
        h('div', { class: 'stme-music-track-key-picker' },
            show(computed(() => vocabulary().length === 0), empty => empty ? h('p', { class: 'stme-music-empty' }, 'Add scene keys above first.') : null),
            list(vocabulary, key => key, key => renderTrackKeyToggle(track, key, keyCount, host)),
        ),
    );
}

function renderTrackRow(track, tracks, vocabulary, persistTracks, host) {
    const name = signal(track.name);
    const nameInput = TextInput(name, { maxlength: 120 });
    nameInput.addEventListener('change', () => {
        track.name = name.peek().trim() || track.name;
        name.set(track.name);
        host.saveModuleSettings();
    });

    return h('div', { class: 'stme-music-track-row' },
        h('div', { class: 'stme-music-track-main' },
            nameInput,
            h('span', { class: 'stme-music-track-plays' }, `${track.playCount ?? 0} plays`),
            Button('×', () => {
                deleteTrackBlob(track.id).catch(() => {});
                persistTracks(tracks.peek().filter(item => item.id !== track.id));
            }, { variant: 'danger' }),
        ),
        renderTrackKeysDetails(track, vocabulary, host),
    );
}

function renderVocabularySection(vocabulary, persistVocabulary, host) {
    const nameInput = signal('');
    const addKey = () => {
        const key = String(nameInput.peek()).trim().slice(0, MAX_KEY_LENGTH);
        if (!key) { host.toast('warning', 'Enter a key first.', 'Music'); return; }
        const current = vocabulary.peek();
        if (current.includes(key)) { host.toast('warning', `Key "${key}" already exists.`, 'Music'); return; }
        if (current.length >= MAX_VOCABULARY) { host.toast('warning', `Maximum ${MAX_VOCABULARY} keys — remove one first.`, 'Music'); return; }
        persistVocabulary([...current, key]);
        nameInput.set('');
    };
    const input = TextInput(nameInput, { placeholder: 'Key (e.g. combat, tavern, night)', maxlength: MAX_KEY_LENGTH });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addKey(); } });

    return h('div', { class: 'stme-music-section' },
        h('div', { class: 'stme-music-section-head' },
            h('strong', {}, 'Scene keys'),
            h('small', {}, computed(() => `${vocabulary().length} / ${MAX_VOCABULARY} — SideCar picks matching keys for the scene; tracks are tagged with the same keys.`)),
        ),
        show(computed(() => vocabulary().length === 0), empty => empty ? h('p', { class: 'stme-music-empty' }, 'No keys yet — add some below.') : null),
        h('div', { class: 'stme-music-vocab-list' },
            list(vocabulary, key => key, key => Chip(key, { onRemove: () => persistVocabulary(vocabulary.peek().filter(item => item !== key)) })),
        ),
        h('div', { class: 'stme-music-vocab-add' }, input, Button('+ Add key', addKey)),
    );
}

function renderTracksSection(tracks, vocabulary, persistTracks, host) {
    const fileInput = h('input', { type: 'file', accept: 'audio/*', multiple: true });
    fileInput.addEventListener('change', async () => {
        const files = [...fileInput.files];
        fileInput.value = '';
        for (const file of files) {
            const id = createTrackId();
            try {
                await saveTrackBlob(id, file);
                const name = file.name.replace(/\.[^./\\]+$/, '') || file.name;
                persistTracks([...tracks.peek(), { id, name, keys: [], playCount: 0, addedAt: Date.now() }]);
            } catch (error) {
                host.toast('error', `Could not import "${file.name}": ${error?.message || String(error)}`, 'Music');
            }
        }
    });

    return h('div', { class: 'stme-music-section' },
        h('div', { class: 'stme-music-section-head' }, h('strong', {}, 'Tracks'), h('small', {}, computed(() => `${tracks().length} imported`))),
        show(computed(() => tracks().length === 0), empty => empty ? h('p', { class: 'stme-music-empty' }, 'No tracks yet — import audio files below.') : null),
        h('div', { class: 'stme-music-track-list' }, list(tracks, track => track.id, track => renderTrackRow(track, tracks, vocabulary, persistTracks, host))),
        h('div', { class: 'stme-music-track-add' }, Field('Import audio', fileInput, { hint: 'Stored locally in this browser (IndexedDB) — not part of ST\'s own settings export.' })),
    );
}

function createPlayerPanel() {
    const panel = h('div', { class: 'stme-music-player' });
    document.body.append(panel);
    return panel;
}

export const musicModule = {
    id: MODULE_ID,
    title: 'Music',
    description: 'Classifies the scene into keys, picks a matching track, and plays it in the background.',
    about: 'Picks and plays background music that matches the current scene on its own, based on mood/location words it recognizes — like a soundtrack that changes itself as the story moves.',
    defaultEnabled: false,

    activate(host) {
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        const audio = new Audio();
        audio.volume = clamp01(settings.player.volume);

        let currentUrl = null;
        let userPaused = true;
        let lastSceneKeys = [];
        let pendingClassify = null;

        const nowPlaying = signal({ trackId: null, name: null, playing: false, blocked: false });
        const volume = signal(audio.volume);

        const publishNowPlaying = () => host.data.set('nowPlaying', nowPlaying.peek());
        const updateNowPlaying = patch => { nowPlaying.update(prev => ({ ...prev, ...patch })); publishNowPlaying(); };

        async function playTrack(track) {
            if (!track) return;
            if (nowPlaying.peek().trackId !== track.id) {
                let blob = null;
                try { blob = await loadTrackBlob(track.id); } catch { /* handled by the null check below */ }
                if (!blob) { host.toast('error', `Audio for "${track.name}" is missing from this browser's storage — re-import it.`, 'Music'); return; }
                if (currentUrl) URL.revokeObjectURL(currentUrl);
                currentUrl = URL.createObjectURL(blob);
                audio.src = currentUrl;
                track.playCount = (track.playCount ?? 0) + 1;
                host.saveModuleSettings();
            }
            userPaused = false;
            try {
                await audio.play();
                updateNowPlaying({ trackId: track.id, name: track.name, playing: true, blocked: false });
            } catch {
                // Browser autoplay policy blocked an unattended play() call — needs a user gesture (the ▶ button).
                updateNowPlaying({ trackId: track.id, name: track.name, playing: false, blocked: true });
            }
        }

        function pause() {
            userPaused = true;
            audio.pause();
            updateNowPlaying({ playing: false, blocked: false });
        }

        function chooseAndPlay(sceneKeys) {
            const track = selectTrack(settings.tracks, sceneKeys);
            if (track) return playTrack(track);
            updateNowPlaying({ trackId: null, name: null, playing: false, blocked: false });
            return undefined;
        }

        audio.addEventListener('ended', () => { if (!userPaused) chooseAndPlay(lastSceneKeys); });

        const start = host.onEvent('GENERATION_STARTED', () => {
            if (pendingClassify || !settings.autoClassify || !settings.vocabulary.length) return;
            pendingClassify = host.services
                .ask('tracker', 'classify', { vocabulary: settings.vocabulary, profileId: settings.sidecarProfile })
                .catch(() => null);
        });

        const received = host.onEvent('MESSAGE_RECEIVED', async (messageId, type) => {
            if (!pendingClassify || IGNORED_MESSAGE_TYPES.includes(type)) return;
            const request = pendingClassify;
            pendingClassify = null;
            const result = await request;
            lastSceneKeys = result?.keys ?? [];
            host.data.set('sceneKeys', lastSceneKeys);
            await chooseAndPlay(lastSceneKeys);
        });

        // Cross-closure RPC for render()'s mini "now playing" strip and toggles —
        // same "functions on the bus, private to this module" pattern as Tracker's HUD.
        host.data.set('playTrack', playTrack);
        host.data.set('pause', pause);
        host.data.set('resume', () => chooseAndPlay(lastSceneKeys));
        host.data.set('skip', () => chooseAndPlay(lastSceneKeys));
        host.data.set('setVolume', value => {
            audio.volume = clamp01(value);
            volume.set(audio.volume);
            settings.player = { ...settings.player, volume: audio.volume };
            host.saveModuleSettings();
        });
        host.data.set('setPlayerVisible', visible => {
            settings.player = { ...settings.player, visible };
            host.saveModuleSettings();
            playerVisible.set(visible);
        });
        publishNowPlaying();
        host.data.set('sceneKeys', lastSceneKeys);

        // --- Floating player: built once here, appended to document.body — a
        // separate window, not nested in ST Module Engine's own drawer, exactly
        // like Tracker's HUD and the engine's own Developer panel.
        const playerVisible = signal(Boolean(settings.player.visible));
        const playerCollapsed = signal(Boolean(settings.player.collapsed));
        const player = createPlayerPanel();
        applyFloatingPosition(player, settings.player);

        const trackLabel = computed(() => {
            const state = nowPlaying();
            if (!state.trackId) return 'No track selected';
            return state.blocked ? `${state.name} — press ▶ to start` : state.name;
        });
        const playPauseLabel = computed(() => (nowPlaying().playing ? '⏸' : '▶'));
        const playPauseButton = Button(playPauseLabel, () => {
            const state = nowPlaying.peek();
            if (state.playing) pause();
            else if (state.trackId) playTrack(settings.tracks.find(item => item.id === state.trackId));
            else chooseAndPlay(lastSceneKeys);
        });

        const head = h('div', { class: 'stme-music-player-head' },
            h('span', { class: 'stme-music-player-grip' }, '⠿'),
            h('strong', {}, 'Music'),
            Button('–', () => playerCollapsed.update(v => !v)),
            Button('×', () => { playerVisible.set(false); settings.player = { ...settings.player, visible: false }; host.saveModuleSettings(); }),
        );
        const volumeInput = h('input', { type: 'range', min: 0, max: 1, step: 0.05, 'bind:value': volume });
        volumeInput.addEventListener('change', () => {
            settings.player = { ...settings.player, volume: volume.peek() };
            host.saveModuleSettings();
        });
        const body = h('div', { class: 'stme-music-player-body' },
            h('div', { class: 'stme-music-player-track' }, trackLabel),
            h('div', { class: 'stme-music-player-controls' },
                playPauseButton,
                Button('⏭', () => chooseAndPlay(lastSceneKeys)),
            ),
            h('label', { class: 'stme-music-player-volume' }, 'Vol', volumeInput),
        );
        player.append(head, body);

        effectOn(player, () => { audio.volume = volume(); });
        effectOn(player, () => { player.hidden = !playerVisible(); });
        effectOn(player, () => { player.classList.toggle('stme-music-player-collapsed', playerCollapsed()); });

        const unmakeDraggable = makeDraggable(player, head, {
            onDrop: position => { settings.player = { ...settings.player, ...position }; host.saveModuleSettings(); },
        });

        return () => {
            start(); received();
            audio.pause();
            if (currentUrl) URL.revokeObjectURL(currentUrl);
            unmakeDraggable();
            player.remove();
        };
    },

    render(container, host) {
        const settings = host.moduleSettings(MODULE_DEFAULTS);
        const profiles = signal(host.sidecar.profiles());
        const vocabulary = signal(settings.vocabulary);
        const tracks = signal(settings.tracks);
        const sidecarProfile = signal(settings.sidecarProfile);
        const autoClassify = signal(Boolean(settings.autoClassify));
        const playerVisible = signal(Boolean(settings.player.visible));

        const nowPlaying = signal(host.data.get('nowPlaying', { trackId: null, name: null, playing: false, blocked: false }));
        onDispose(container, host.data.subscribe(MODULE_ID, 'nowPlaying', next => nowPlaying.set(next ?? nowPlaying.peek())));

        const persistTracks = next => { tracks.set(next); settings.tracks = next; host.saveModuleSettings(); };
        const persistVocabulary = next => { vocabulary.set(next); settings.vocabulary = next; host.saveModuleSettings(); };

        const profileSelect = Select(sidecarProfile, profiles);
        profileSelect.addEventListener('change', () => { settings.sidecarProfile = profileSelect.value; host.saveModuleSettings(); });

        const nowPlayingLine = computed(() => {
            const state = nowPlaying();
            if (!state.trackId) return 'Nothing playing.';
            return `${state.playing ? 'Playing' : state.blocked ? 'Paused (blocked by browser)' : 'Paused'}: ${state.name}`;
        });

        container.append(
            h('p', { class: 'stme-music-help' }, 'Tracker classifies the scene into your keys, Music picks the best-matching track (favoring ones played least) and loops it in the background until the scene changes.'),
            h('p', { class: 'stme-music-now-playing' }, nowPlayingLine),
            Field('SideCar profile', profileSelect, { hint: 'Used for scene classification, via Tracker.' }),
            Toggle('Auto-classify on each message', autoClassify, {
                onChange: checked => { autoClassify.set(checked); settings.autoClassify = checked; host.saveModuleSettings(); },
                hint: 'Requires the Tracker module to be enabled — Music asks it to classify the scene.',
            }),
            Toggle('Show floating player', playerVisible, {
                onChange: checked => {
                    playerVisible.set(checked);
                    host.data.get('setPlayerVisible')?.(checked);
                },
            }),
            renderVocabularySection(vocabulary, persistVocabulary, host),
            renderTracksSection(tracks, vocabulary, persistTracks, host),
        );
    },

    css: `
        .stme-settings .stme-music-help { margin: 0 0 10px; line-height: 1.4; opacity: .85; }
        .stme-settings .stme-music-now-playing { margin: 0 0 12px; padding: 8px 10px; border-radius: var(--stme-radius); background: rgba(0, 0, 0, .08); font-size: .9em; opacity: .9; }
        .stme-settings .stme-music-section { margin-top: 14px; padding-top: 12px; border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor) 70%, transparent); }
        .stme-settings .stme-music-section-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
        .stme-settings .stme-music-section-head small { opacity: .65; }
        .stme-settings .stme-music-empty { margin: 0 0 8px; padding: 8px; opacity: .65; font-size: .9em; }
        .stme-settings .stme-music-vocab-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        .stme-settings .stme-music-vocab-add { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
        .stme-settings .stme-music-track-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
        .stme-settings .stme-music-track-row { padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: var(--stme-radius-sm); background: var(--SmartThemeBlurTintColor); }
        .stme-settings .stme-music-track-main { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; }
        .stme-settings .stme-music-track-plays { opacity: .6; font-size: .82em; white-space: nowrap; }
        .stme-settings .stme-music-track-keys { margin-top: 6px; }
        .stme-settings .stme-music-track-keys summary { cursor: pointer; font-size: .85em; opacity: .8; }
        .stme-settings .stme-music-track-key-picker { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
        .stme-settings .stme-music-key-toggle { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--SmartThemeBorderColor); background: transparent; color: inherit; font-size: .8em; cursor: pointer; opacity: .6; }
        .stme-settings .stme-music-key-toggle:hover { opacity: .85; }
        .stme-settings .stme-music-key-toggle-active { opacity: 1; border-color: var(--stme-accent, var(--SmartThemeQuoteColor, #8da8ff)); background: color-mix(in srgb, var(--stme-accent, var(--SmartThemeQuoteColor, #8da8ff)) 25%, transparent); }

        /* Floating player: appended to document.body, not the settings drawer. */
        .stme-music-player { position: fixed; z-index: 5000; width: 240px; display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #8da8ff) 70%, var(--SmartThemeBorderColor)); background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 90%, var(--SmartThemeQuoteColor, #8da8ff)); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); backdrop-filter: blur(6px); font-family: var(--mainFontFamily, inherit); color: var(--SmartThemeBodyColor); font-size: .9em; }
        .stme-music-player[hidden] { display: none; }
        .stme-music-player-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px; cursor: grab; background: linear-gradient(105deg, transparent, rgba(0, 0, 0, .14)); user-select: none; touch-action: none; }
        .stme-music-player-head:active { cursor: grabbing; }
        .stme-music-player-grip { opacity: .6; }
        .stme-music-player-head strong { flex: 1; font-size: .85em; letter-spacing: .03em; }
        .stme-music-player-head .menu_button { width: 22px; height: 22px; padding: 0; line-height: 1; font-size: 1em; }
        .stme-music-player-body { padding: 10px 11px 12px; display: flex; flex-direction: column; gap: 9px; }
        .stme-music-player.stme-music-player-collapsed .stme-music-player-body { display: none; }
        .stme-music-player-track { overflow-wrap: anywhere; opacity: .9; }
        .stme-music-player-controls { display: flex; gap: 8px; }
        .stme-music-player-volume { display: flex; align-items: center; gap: 8px; font-size: .85em; opacity: .8; }
        .stme-music-player-volume input { flex: 1; }
    `,
};
