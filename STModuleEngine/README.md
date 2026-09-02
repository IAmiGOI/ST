# ST Module Engine

Install the `STModuleEngine` folder in `SillyTavern/public/scripts/extensions/third-party/` and reload SillyTavern.

It is a single SillyTavern extension that hosts independently implemented modules under one **ST Module Engine** drawer. Each module has its own lifecycle (`activate`/cleanup), UI renderer, and can be enabled or disabled without unloading the host. Shared host APIs cover native function tools, prompt injection, chat-change notifications, toasts, and UI refreshes.

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
