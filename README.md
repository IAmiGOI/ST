# ST Module Engine

## Installation

In SillyTavern **Extensions → Install extension**, enter the repository clone URL only (not a GitHub `tree/...` page, a Discord/webhook URL, or a link to a subfolder):

```text
https://github.com/IAmiGOI/ST.git
```

Alternatively, copy the contents of this repository into `SillyTavern/public/scripts/extensions/third-party/STModuleEngine/`. In both cases, `manifest.json` must be at the root of the installed folder, next to `index.js`. Reload SillyTavern after installation.

The settings UI is embedded in `index.js`; it does not load a separate `settings.html` file, so the extension also works when SillyTavern chooses a different install-folder name.

It is a single SillyTavern extension that hosts independently implemented modules under one **ST Module Engine** drawer. Each module has its own lifecycle (`activate`/cleanup), UI renderer, and can be enabled or disabled without unloading the host. Shared host APIs cover native function tools, prompt injection, chat-change notifications, toasts, UI refreshes, and a shared SideCar model.

### Modular UI

The extension UI separates **Base settings** (the shared SideCar profile) from **Modules**. Every module card can be collapsed independently. Drag a module card by its grip to change its order; the order and collapsed states are saved in the engine settings.

A **⚙ ModuleEngine Developer** button at the very bottom of the drawer opens a separate floating window — draggable, not nested in the drawer at all — listing every registered module's state, every reserved data-bus channel (with its schema/macro/webhook/persist flags and live current value), and the engine's recent log. It reads like its own detached tool rather than another card in this UI, and needs no setup: reserving a channel anywhere makes it show up here automatically.

### Module loader

The **Module loader** card under Base settings accepts either a direct link to a module's `.js` file, or a bare GitHub repository link — `https://github.com/user/repo`, with or without `.git`, and optionally pinned to a branch (`.../tree/branch`). For a repo link it looks for `manifest.json`'s `"js"` field first (the same convention this repository's own manifest.json uses), then `module.js`, then `index.js` at the repo root, and loads whichever it finds. Anything it can't resolve that way — an already-raw `raw.githubusercontent.com` link, or a non-GitHub URL — is fetched as-is, unchanged.

## Included module: Notebook

Notebook is enabled by default. It registers the native `Notebook` function tool with `write` and `update` actions, stores notes per chat, and injects them as private working memory. Its settings and notes are managed in the common engine UI. Disabling the module unregisters its tool and clears its prompt injection.

## Add a module

Create a module object and pass it to `engine.register()` before `engine.start()`:

```js
{
  id: 'my-module',
  title: 'My Module',
  description: 'What it does',
  defaultEnabled: true,
  activate(host) { /* setup; return cleanup function */ },
  render(container, host) { /* render only this module UI */ },
}
```

Module enablement is stored in `extensionSettings.st_module_engine.modules`; per-chat Notebook data is stored in `chatMetadata` under `stme_notebook_*` keys.

## Shared SideCar API

The **SideCar** card in the engine UI owns the one model profile (endpoint, format, key, model, sampler settings). Secrets remain in SillyTavern extension settings and are never returned through the module API. Every module receives `host.sidecar`:

```js
// A one-off request; use it when the module does not need a lifecycle client.
const answer = await host.sidecar.request({
  systemPrompt: 'You classify scenes.',
  prompt: 'Classify this message: ...',
  maxTokens: 100,
});

// A lifecycle lease; acquire in activate(), release in the returned cleanup.
const sidecar = host.sidecar.acquire('scene-indexer');
const answer = await sidecar.request({ prompt: '...' });
return () => sidecar.release();
```

A lease is intentionally lightweight: it does **not** hold an HTTP connection or run a model continuously. It represents long-lived access to the centrally configured SideCar profile; each `request()` is still an independent generation. This keeps one model configuration under user control while allowing modules to use it on demand or through their full active lifetime.

## Built-in RP Time module

**RP Time** is disabled by default to avoid unexpected SideCar requests. Enable and configure SideCar first, then enable **RP Time**. After each normal character response, it sends only the recent RP context to SideCar, asks it for a short in-world time label, and changes the stored message with ordinary JavaScript by appending `\n\n[RP Time: …]`. The SideCar is never asked to rewrite the character response. The marker in message metadata prevents a duplicate suffix on the same message.

### RP Time settings

The **RP Time** module uses the shared SideCar **Max tokens** sampler setting (it does not impose its former 48-token limit), which gives reasoning models enough room to finish and return a label. The **RP Time** module has a form for **Starting time** and **Time format**. Starting time initializes a new chat's time state; each accepted SideCar result becomes that chat's next current time. The format is included in the SideCar instruction, so use an explicit setting convention such as `Day {day}, HH:MM`, `YYYY-MM-DD HH:MM`, or `Morning of {date}`. Two **presets** fill in a working starting time, format, JSON fields, and display template in one click: a full calendar date (year/month/day/time/period) and a simple day counter (day/time/period). Switching the **SideCar profile** dropdown saves immediately, so a refresh triggered elsewhere (e.g. a chat change) never reverts an unsaved pick.

### SideCar sampler

SideCar sampler controls are sliders for temperature, Top P, Top K, Min P, Typical P, repetition/frequency/presence penalties, max tokens, and seed. Standard OpenAI parameters are sent to OpenAI-compatible endpoints; extended parameters are sent when changed for compatible local/proxy endpoints. Unsupported sampler fields may be ignored or rejected by the provider.


### SideCar reasoning

For OpenRouter endpoints, the **Reasoning** section exposes provider default/enabled/disabled mode, low/medium/high effort, a reasoning-token budget, and an option to hide reasoning text from the reply. These fields are included only when the endpoint contains `openrouter.ai`; other providers keep their native behaviour.


### SideCar Manager

The SideCar Manager can create multiple independently configured workers. A request from a module enters the manager queue; the manager dispatches it to a free worker and, when all workers are busy, keeps the queue ordered for the worker that becomes free first. Endpoint, API key and model belong to each worker; sampler/reasoning profiles are stored with that worker.

## Built-in Tracker module

**Tracker** is disabled by default. Unlike Notebook and RP Time, it hosts any number of independent **tracker blocks** inside its own card — each block is a self-contained tracker with its own SideCar profile, its own prompt templates, and its own field list. Add a block with **+ Add tracker**, drag it by its grip to reorder it, and collapse it like any module card. Each block can be enabled or removed independently.

### Tracker fields

A block's fields are edited as a list, not a comma-separated string: add a field name and an optional instruction (e.g. field `health`, instruction "One of: healthy, injured, critical"). That instruction is sent to SideCar as the reason for that JSON key, so the model knows exactly how to fill it in — the generated system prompt lists every field as `- name: instruction`.

### Tracker requests

On `GENERATION_STARTED`, every enabled block with at least one field sends its own SideCar request (using its own profile) in parallel with generation. After the response completes, each block's reply is parsed for just its whitelisted fields, saved to that block's own slice of chat metadata, and appended as a styled badge under the message — one badge per block that updated.

### Tracker data bus, macros, and floating panel

Tracker publishes every block's fields and current values onto the shared `host.data` bus under namespace `tracker`: a `blocks` index and one `block:<id>` entry per block, each reserved with a schema so a malformed value can never reach a subscriber. Any other module can `host.data.read('tracker', 'blocks', [])` or `host.data.subscribe('tracker', 'block:<id>', ...)` to react to tracked state. This is the *only* path tracked fields leave the module — they are never written into `message.mes` or anything sent to the character LLM, so they cannot end up in its context.

Each individual field is also reserved as its own channel and registered as a live SillyTavern macro, `{{tracker_<block title>_<field name>}}` — e.g. a block titled "Vitals" with a `health` field exposes `{{tracker_vitals_health}}`. Because it's a real ST macro, it resolves anywhere SillyTavern itself does macro substitution — prompt templates, World Info entries, character card fields, Quick Replies — not only where this extension explicitly injects text. These field channels also persist into chat metadata, so their macro value survives a page reload before the module gets a chance to re-publish. Disabling Tracker unregisters every macro it owns automatically.

### Tracker as a service: quick tracked values

Tracker isn't only a hand-configured block editor — it also provides a `'tracker'` service (via `host.services`, the same request/provider mechanism as SideCar, generalized to any module) that any other module can call to have a value tracked without a block. The requesting module owns and pushes the value; Tracker only stores and displays it, in a compact **Quick tracked values** section with no editor — since the value comes from another module's code, there's nothing for the user to type there. Each quick value is also a reserved bus channel with its own schema, chat-metadata persistence, and ST macro, exactly like a regular block's fields.

To view that bus data, enable **Show floating panel** in the Tracker card. It opens a separate, draggable tab (appended to the page, not the chat transcript) that lists every enabled block's fields and current values, live-updated from the bus. Drag it by its header to reposition it, collapse it with **–**, or hide it with **×** — position and open state persist. It stays off by default; showing it is opt-in.

Tracker also *answers* a request, not just accepts pushed values: `host.services.ask('tracker', 'classify', { vocabulary, profileId? })` runs one SideCar call and returns `{ keys }` — whichever of the caller's own keys (up to 50) genuinely fit the current scene. Tracker doesn't own the vocabulary; the asker supplies it, so this is reusable by any module that needs "which of my keys apply right now" — the Music module below is the first one that does.

## Built-in Music module

**Music** is disabled by default. Define up to 50 **scene keys** (combat, tavern, night, victory, ...), import audio files, and tag each one with whichever keys fit it. On every character message, Music asks Tracker (`host.services.ask('tracker', 'classify', ...)`) which of those keys match the current scene, then picks a track: the ones whose keys overlap the scene the *most* are eligible, and among those, a weighted random pick favors whichever has played least (`weight = 1 / (playCount + 1)`) — so the rotation self-corrects instead of repeating favorites. Auto-classification needs Tracker enabled; without it (or with no scene keys yet), the whole library stays eligible so something still plays.

Imported audio is stored in this browser's IndexedDB, not in SillyTavern's own settings — that JSON is read and written whole by ST, and audio bytes have no business in it. That also means the library doesn't travel with an ST settings export/import and is local to this browser; only the track list's *metadata* (name, keys, play count) lives in the regular engine settings.

A floating **Music** player (same draggable-window pattern as Tracker's HUD) shows the current track with play/pause, skip, and volume — toggled from **Show floating player** in the card, off by default. Browsers block unattended audio without a user gesture, so the very first play after a page load may need one click on ▶ in the player before it actually starts.
