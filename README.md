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

The **RP Time** module uses the shared SideCar **Max tokens** sampler setting (it does not impose its former 48-token limit), which gives reasoning models enough room to finish and return a label. The **RP Time** module has a form for **Starting time** and **Time format**. Starting time initializes a new chat's time state; each accepted SideCar result becomes that chat's next current time. The format is included in the SideCar instruction, so use an explicit setting convention such as `Day {day}, HH:MM`, `YYYY-MM-DD HH:MM`, or `Morning of {date}`.

### SideCar sampler

SideCar sampler controls are sliders for temperature, Top P, Top K, Min P, Typical P, repetition/frequency/presence penalties, max tokens, and seed. Standard OpenAI parameters are sent to OpenAI-compatible endpoints; extended parameters are sent when changed for compatible local/proxy endpoints. Unsupported sampler fields may be ignored or rejected by the provider.


### SideCar reasoning

For OpenRouter endpoints, the **Reasoning** section exposes provider default/enabled/disabled mode, low/medium/high effort, a reasoning-token budget, and an option to hide reasoning text from the reply. These fields are included only when the endpoint contains `openrouter.ai`; other providers keep their native behaviour.


### SideCar Manager

The SideCar Manager can create multiple independently configured workers. A request from a module enters the manager queue; the manager dispatches it to a free worker and, when all workers are busy, keeps the queue ordered for the worker that becomes free first. Endpoint, API key and model belong to each worker; sampler/reasoning profiles are stored with that worker.
