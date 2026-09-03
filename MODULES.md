# ST Module Engine — Module Guide

This document explains how modules are built, how to add one, and how to use the
engine's shared services. A module is a plain JavaScript object living inside one
SillyTavern extension. It is not a standalone ST extension itself: the engine owns its
lifecycle, its UI, its event subscriptions, its SideCar profile, and its data exchange
with everything else.

## Why this beats a plain ST extension

The engine absorbs all the repetitive bootstrap: inserting into `#extensions_settings`,
merging setting defaults, enable/disable with per-module error isolation and a **Retry
module** button, auto-unsubscribing from `eventSource` with errors in callbacks caught
instead of propagating, drag-reorder for cards, and — the big one — a single shared
SideCar, so a module never writes its own fetch/auth/config UI just to reach an LLM.
This removes boilerplate that a plain, hand-rolled extension almost never gets right (a
throwing `init()` there usually takes the whole script down with no retry path at all).

As of this revision the engine **also ships a small UI framework**
(`core/reactive.js` + `core/dom.js` + `core/widgets.js`) — signals, an `h()` element
builder, and ready-made components (`Field`, `TextInput`, `Toggle`, `Select`,
`SliderField`, `Chip`, `DraggableList`, …). `render()` is now called **once** per enable
(see below), not on every refresh — only what actually changed patches the DOM; other
modules' DOM and a user's unsaved input are no longer wiped out by an unrelated event
elsewhere. Building a module through `innerHTML` + `querySelector` still works
(`container` is a plain DOM element), but doing that throws away both reactivity and the
entire point of a once-only `render()` — new modules should use `core/widgets.js`.

## Quick mental model

1. `index.js` creates a `ModuleEngine`.
2. Built-in or new modules register via `engine.register(module)` before `engine.start()`.
3. On startup the engine enables whichever modules are allowed in settings.
4. Each module gets a collapsible card under **Modules**. It can be enabled, disabled,
   and dragged to reorder.
5. Shared settings live under **Base settings** — currently just SideCar.
6. The whole thing has **two entry points into the same UI tree**: the drawer inside
   `#extensions_settings2` (always there), and a full-screen overlay toggled from a
   native-styled icon `index.js` inserts into SillyTavern's own top bar (see
   [Full-screen panel and the top-bar launcher](#full-screen-panel-and-the-top-bar-launcher)).
   Both call `engine.mount()` on their own root — a module never needs to know which one
   its card is currently rendered inside.

## Module contract

A minimal module needs these fields:

```js
export const exampleModule = {
  id: 'example',                 // unique: a-z, 0-9, and hyphens
  title: 'Example module',
  description: 'Short description for the UI.',
  defaultEnabled: false,         // true if the module should start enabled

  async activate(host) {
    // Subscriptions, tool registration, background clients.
    // Return a cleanup function.
    return () => {};
  },

  render(container, host) {
    // Build UI only inside container.
  },
};
```

Registration happens in `index.js`:

```js
engine.register(exampleModule);
```

`id` is the namespace for settings and the data bus. Don't change it after shipping —
users may already have settings saved under it.

Three more fields are optional but recommended — see [Versioning and
auto-updates](#versioning-and-auto-updates) for what each one does:

```js
export const exampleModule = {
  // ...the fields above...
  version: '1.0.0',
  repo: 'https://github.com/you/your-repo',   // or a /tree/<branch>/<path> pointing at this module's own folder
  minEngineVersion: '0.1.0',                  // oldest ModuleEngine this module is known to work with
};
```

## Lifecycle

### `activate(host)`

Called after the module is enabled. Use it to register ST function tools, inject
prompts, acquire a SideCar lease, and subscribe to events.

The returned cleanup function runs when the module is disabled. In it you must:

- drop your subscriptions;
- call `lease.release()` for any SideCar lease;
- unregister any tools you registered;
- clear injected prompts, if that's needed.

```js
activate(host) {
  const unsubscribe = host.onEvent('MESSAGE_RECEIVED', onMessage);
  const lease = host.sidecar.acquire('example-worker');

  return () => {
    unsubscribe();
    lease.release();
  };
}
```

### `render(container, host)`

Called **once** — when the module is enabled (and again if it's re-enabled after being
disabled, or after `host.refresh()`/Retry). The engine does **not** re-invoke `render()`
just because card order changed, some other card was collapsed/expanded, or another
module was enabled/disabled — once your card's DOM is built, it stays untouched for as
long as the module stays enabled.

The practical rule that follows: **build every piece of dynamic content inside
`container` with signals (`core/widgets.js`), not by re-running `render()`.** Read
settings/metadata into signals once, while building the UI, then push further changes
through `signal.set(...)` — the DOM reacts on its own, precisely. If something changes
from outside this same `render()` call (a tool action fired from `activate()`, a bus
message from another module), `render()` has no way to find out about it without an
explicit subscription — use the `host.data` bus (below) or `host.onChatChanged()`,
called from inside `render()` itself, and tie the unsubscribe to the container's
lifetime with `onDispose(container, unsubscribe)` — otherwise the subscription outlives
the card itself.

```js
render(container, host) {
  const settings = host.moduleSettings({ limit: 10 });
  const limit = signal(settings.limit);            // signal — the source of truth for the DOM
  const items = signal(loadItems(host));            // list refreshed by hand on external changes

  onDispose(container, host.data.subscribe(host.id, 'changed', () => items.set(loadItems(host))));

  container.append(
    Field('Limit', TextInput(limit, { type: 'number' })),
    h('div', {}, list(items, item => item.id, item => h('div', {}, item.title))),
    Button('Save', () => { settings.limit = Number(limit.peek()); host.saveModuleSettings(); }),
  );
}
```

`host.refresh()` still exists as an emergency exit: it force-rebuilds **only your own**
card (never siblings) — useful when something drifted outside the signal model and
rebuilding is simpler than tracking it down. A well-written module almost never needs
it.

Inside `render()`, don't append UI directly to `document.body` or ST's own extension
settings container — stay inside the `container` you were given. That rule is about
`render()` specifically, not the module as a whole: DOM built from `activate()` as a
side effect and living outside `container` — chat badges (RP Time, Tracker) or a
detached floating panel (Tracker's HUD) — is deliberately allowed, because that's a
different UI surface with its own lifecycle (built once in `activate()`, torn down in
cleanup), not part of the settings card.

## Error protection

The engine isolates three classes of failure:

- a throw inside `activate()` only takes down that module;
- a throw inside `render()` replaces its content with an error card;
- a sync or async error inside an `host.onEvent()` callback is caught and logged.

Every other module and the main UI keep working. The user sees a **Retry module**
button. Anything module-specific still needs its own sane input validation and must
still return a cleanup function.

### Protection against a reentrant/bursty `CHAT_CHANGED`

A separate guard exists for the `host.onChatChanged()` dispatcher, for the case where
something a listener does (say, a write into `chatMetadata`) provokes ST into firing
`CHAT_CHANGED` again:

- **Reentrancy.** If handling `CHAT_CHANGED` provokes a new `CHAT_CHANGED` **before**
  the first dispatch has finished, the nested call is **dropped** — listeners never run
  re-entrantly inside themselves.
- **Burst limit.** More than 8 `CHAT_CHANGED` firings within 2 seconds isn't a normal
  chat switch; the engine logs an error and skips dispatching until the burst quiets
  down on its own (a sliding window — dispatching resumes automatically once no event
  has fired for 2 seconds).
- Every listener, exactly like in `onEvent()`, is wrapped in try/catch with rejected-
  promise handling — one module's broken listener never blocks the others.

This is useful protection in its own right (and `store.settings()` in
`modules/notebook/store.js` still only writes to `chatMetadata` when a value genuinely
needs normalizing, never on every read), but it was **not** the real cause of a genuine
hang bug this project shipped once — see the next section.

### The real cause of that hang: live `Set` iteration + a dependency leak through `show()`/`list()`

Separately from `CHAT_CHANGED`, a far more fundamental bug was found and fixed — a
synchronous infinite loop with no growing call stack (so there was neither a stack
overflow nor a hung `await`; the tab simply stopped responding while memory climbed
until the browser/computer locked up). The mechanism was a combination of two things:

1. **`ModuleDataBus`** (`core/data-bus.js`), when dispatching a value on a channel,
   iterated listeners via `for (const listener of this.#listeners.get(id))` — a **live**
   `Set` traversal. In JS, iterating a `Set`/`Map` with `for...of` is live: an item added
   to the collection **during** the current pass is visited in that same pass, as long
   as the iterator hasn't already passed it.
2. **`show()`/`list()`** (`core/dom.js`) called `renderFn`/`renderItem` (and therefore
   `module.render()`) synchronously **from inside the body of their own effect**. Any
   "bare" signal read inside `render()` (e.g. `signal(store.settings())`, where
   `settings()` is a signal read directly rather than through `computed`/`effect`) was,
   at that moment, wrongly counted as a dependency of `show()`'s own effect rather than
   the module's — because `core/reactive.js` tracks "the current active effect" as one
   shared variable for the whole module, with no awareness of nesting.

Together these formed a self-sustaining loop: a bus write → dispatch to listeners → one
listener changes a signal that leaked into `show()` → `show()`'s effect re-runs → it
calls `module.render()` again → the module re-subscribes to that same bus key
(`host.data.subscribe(...)`) → this adds a **new** entry to the very `Set` the outer
`for...of` from point 1 is iterating right now → the new listener gets visited **in
that same pass** → it changes the signal again → repeat forever. Every turn is an
ordinary function return, not deeper recursion, so the stack never grows or overflows;
the loop just spins forever, allocating fresh DOM/signals/subscriptions on every pass.

Both ends were fixed structurally, for every module at once:

- `#applyWrite()`/`restore()` in `core/data-bus.js` now iterate a **snapshot**
  (`[...(this.#listeners.get(id) ?? [])]`), not a live `Set` — a listener that
  subscribes mid-dispatch is only called on the *next* write, never in the current pass.
- `core/reactive.js` gained `untrack(fn)` — runs `fn` with dependency tracking
  temporarily suspended. `show()`/`list()` in `core/dom.js` now call
  `renderFn`/`renderItem` (and therefore `module.render()`) through `untrack()`, so a
  bare signal read inside a module's `render()` can no longer leak as a dependency of
  `show()`'s/`list()`'s own effect.

**Practical takeaway for module authors**: writing `signal(someOtherSignal())` (a bare
read) directly inside `render()`'s body is now safe with respect to this class of leak —
the engine guarantees the isolation. The "don't write unconditionally on every call"
rule from the previous section still stands on its own, though — that one is about
avoiding needless `chatMetadata` writes, not dependency leaks.

### Idempotent calls into ST on every `CHAT_CHANGED`

A separate category of risk lives not inside the engine but at the boundary with ST
itself. `host.onChatChanged(listener)` calls `listener()` on **every** chat switch; if
`listener` unconditionally calls `context.setExtensionPrompt(...)` (or any other ST API
that might provoke a save/recompute on ST's side), ST could in theory react to that call
with something that fires `CHAT_CHANGED` again — and in that case the engine's
reentrancy/burst guard only limits the damage (it stops the tab from hanging outright),
it doesn't remove the cycle: as long as the listener keeps calling `setExtensionPrompt`
again on EVERY repeated firing, the cycle can keep going indefinitely from ST's point of
view, even after the engine itself has stopped participating past the burst limit.

The right pattern is to make the call into ST itself **idempotent**: remember the last
value you actually set, and skip the call if it hasn't changed. `modules/notebook/index.js`'s
`inject()`/`notify()` are the working example: they compare a computed "signature"
(depth + prompt text) against the last one actually sent, and never touch
`context.setExtensionPrompt` if it matches. This isn't only protection against a
hypothetical loop — it's also just less pointless work: switching chats back and forth
shouldn't rebuild and resend the same prompt every single time.

## The `host` API

| API | Purpose |
| --- | --- |
| `host.id` | The current module's identifier. |
| `host.context()` | The live `SillyTavern.getContext()`. Use it only where you actually need the ST API. |
| `host.refresh()` | Force-rebuild `render()` for this module only (emergency exit — usually not needed, see `render()` above). |
| `host.toast(level, message, title?)` | Show an ST toastr notification. |
| `host.moduleSettings(defaults)` | Get this module's persisted settings. |
| `host.saveModuleSettings()` | Persist this module's settings. |
| `host.setPrompt(key, prompt, position, depth, role)` | Set an extension prompt. |
| `host.registerTool(definition)` / `host.unregisterTool(name)` | Register/unregister a native function tool. |
| `host.onEvent(eventType, callback)` | Subscribe to an ST event; returns an unsubscribe function. |
| `host.onChatChanged(callback)` | Simplified chat-change subscription; returns unsubscribe. The dispatcher is protected against reentrant/bursty repeats — see above. |
| `host.sidecar` | The shared model/profile client. |
| `host.data` | The inter-module data bus — get/set/subscribe plus optional channel reservation (schema, ownership protection, history/restore, ST macro, webhook, `unreserve()`). See the section below. |
| `host.services` | The registry of services modules provide to each other: push (`register`/`get`/`request`/`isAvailable`) and pull, request-response (`ask(name, type, payload)`) — the same request/provider shape as `host.sidecar`, generalized to any module. See the section below. |

## Persisted module settings

```js
const settings = host.moduleSettings({
  enabledFeature: true,
  limit: 10,
});

settings.limit = 20;
host.saveModuleSettings();
```

Values are saved into the engine's own config. They're meant for serializable data —
strings, numbers, booleans, arrays, plain objects. For anything scoped to the current
chat, use `context.chatMetadata` instead.

## The data bus: exchanging data between modules

`host.data` is the shared bus (`core/data-bus.js`), independent of any one module's
logic. The base layer is a plain runtime key/value store with subscriptions, and it
behaves exactly as it sounds:

```js
host.data.set('lastResult', { score: 12 });          // into your own namespace (module id)
const result = host.data.get('lastResult');
host.data.remove('lastResult');

host.data.write('time', 'lastResult', { label: 'Day 2, 13:00' });  // into someone else's namespace — technically allowed
const value = host.data.read('time', 'lastResult', null);

const unsubscribe = host.data.subscribe('time', 'lastResult', value => console.debug('New RP time:', value));
return () => unsubscribe();
```

This is still **convention, not isolation**: nothing stops `write()` into a namespace
that isn't reserved (see below). Write into your own namespace by default; writing into
someone else's is a rare, deliberate exception.

### Reservation: `host.data.reserve(key, options)`

Turns a bare key into a **channel** — a declared, checked contract instead of "someone
put something there." Always reserves in your OWN namespace (the caller's module id);
you cannot reserve someone else's channel — that's the difference between `reserve()`
and `write()`.

```js
const channel = host.data.reserve('health', {
  name: 'Vitals — health',           // human-readable name — look it up via host.data.findByName()
  schema: { type: 'string' },        // or a function (value) => true | 'error text'
  allowExternalWrite: false,         // by default only the owner can write
  macro: 'tracker_vitals_health',    // see "Three kinds of channels" below
  webhook: { pushUrl, pullUrl, pullIntervalMs },
  persist: true,                     // see "Persistence within a chat" below
});
// channel.id === 'my-module:health'; channel.unreserve() retires it by hand —
// though the engine already does this automatically on disable() (see below).
```

`set(key, value)` / `write(namespace, key, value)` against a reserved channel now go
through protection:

- **Schema.** A value that fails `schema` is rejected, logged, and never reaches
  subscribers — the last valid value stays put. A badly written module can't corrupt
  data other modules rely on.
- **Ownership.** A write from anywhere other than the owning module is rejected unless
  `allowExternalWrite: true` was set at reservation time.
- **Rate limit.** More than ~20 writes/sec into one channel trips a temporary breaker
  (protection against an infinite-write-loop bug).

A rejected write is called "contamination" here — logged via `console.warn` and (if the
engine was given `onContaminate`) visible in its log; it never reaches `#values`.

### Retiring a channel: `unreserve()` — for a list of channels that can shrink

`channel.unreserve()` (from the handle `reserve()` returns) or the equivalent
`host.data.unreserve(key)` (addressable by key alone, no handle needed) fully retires a
channel: its protections, its ST macro registration, its value, and its history are all
gone — not just the schema/ownership checks. Use it whenever your module's own set of
channels can **shrink while the module stays enabled** — a user-removable field, a
deletable block, anything with a "remove" button in your own UI.

```js
host.data.reserve(`field:${id}`, { macro: macroSlug(id) });
// ... later, the user removes this field from your own config:
host.data.unreserve(`field:${id}`);
```

Without this, a channel (and its `{{macro}}`, if it had one) reserved for something the
user later removes just keeps resolving to its last known value forever — there's
nothing else telling the bus it's gone. `modules/tracker/index.js`'s `publish()` is the
worked example: on every re-publish it diffs the current set of blocks/fields against
what it published last time, and `unreserve()`s anything that dropped out (a removed
field, or an entire deleted block) — see
[Pattern: reconciling a dynamic set of channels](#pattern-reconciling-a-dynamic-set-of-channels)
below for the full shape of that pattern, including how it also handles a block that's
merely *disabled* (not removed).

`releaseNamespace()` (used automatically on module disable, see below) is really
`unreserve()` applied to every channel a module owns at once, plus a sweep for anything
that was ever `set()` under that namespace without going through `reserve()` at all.

### Backups: `history()` and `restore()`

Every accepted write keeps the last 10 values with timestamps:

```js
host.data.history('health');              // [{ value, at }, ...] newest first
host.data.restore('health', 1);            // roll back one step — no re-validation
```

### Finding channels by id or name

`host.data.listChannels(namespace?)` — lists reserved channels (your own namespace, or
all of them). `host.data.findByName(name)` — finds a channel by its human-readable name,
not just its technical `namespace:key`.

### Three kinds of channels (what you can reserve, and why)

1. **Internal** — between engine modules. This is what already existed: `set`/`get`/
   `subscribe`, now optionally with a schema and ownership protection. Example:
   `host.data.subscribe('tracker', 'blocks', ...)`.
2. **Public, readable anywhere in ST** — via `macro: 'name'`. Reservation registers an
   ST macro (`context.registerMacro`, with the modern `context.macros.register()` used
   first via feature-detection if the user's ST build has it): the channel's value
   becomes available as `{{name}}` in prompts, World Info, the character card, Quick
   Replies — everywhere ST itself resolves macro substitution, not only wherever a
   module inserts text by hand. The handler is synchronous and reads the channel's
   **current** value on every call — nothing needs caching. A macro-name collision with
   one already taken is rejected and logged as contamination; the channel itself keeps
   working, just without a macro. A live example is `modules/tracker/index.js`:
   `{{tracker_<title>_<field>}}` for every tracked field.
3. **External, via an API outside ST** — `webhook: { pushUrl, pullUrl, pullIntervalMs }`.
   The extension is code running in the user's browser and physically cannot accept
   inbound requests (there's no server to stand up); it can only reach out itself:
   `pushUrl` — a fire-and-forget POST on every accepted write (a network error neither
   blocks the write nor throws); `pullUrl` — a periodic GET (no more often than once per
   5s), and the result goes through the exact same validation (schema + external-write
   check) as any other outside write — pulled data is the least trusted kind, so a pull
   channel almost always needs `allowExternalWrite: true` alongside a schema. **The URL
   must always be a setting the user types in** (the same way SideCar's endpoint is) —
   never hardcode someone else's address inside a module.

### Persistence within a chat: `persist: true`

By default the bus is entirely in-memory and doesn't survive a page reload.
`persist: true` at reservation time mirrors every accepted write into `chatMetadata`
(the same mechanism that already stores Notebook's notes and Tracker's state) and
restores the last value right at `reserve()` time — so a subscriber (a HUD panel, say)
never sees emptiness in the first seconds after reload, before the module has had a
chance to re-publish. `remove(key)` on a persisted channel also clears the saved copy.
Turn this on only for what genuinely needs to survive a reload — most bus traffic is
derived and not worth a disk write on every tick.

### Cleanup on module disable

The engine calls the `host.data` equivalent of `releaseNamespace(moduleId)` right after
`cleanup()` runs on disable — it retires every channel the module owns (unregistering
macros, stopping pull timers) and clears their values, even if `cleanup()` forgot
something. A manual `host.data.remove(...)` in `cleanup()` for a reserved channel isn't
needed — only for genuinely temporary data with a narrower lifetime than the module
itself.

### Pattern: a producer publishes, it doesn't just notify

If a producer module only writes to the bus in response to an event (say, "after the
model replies"), a subscriber sees emptiness or stale data until the next event happens
(unless the channel is `persist: true`, see above). So:

- Publish the **full current state** right in `activate()`, not only on changes.
- Keep one `publish()` function, call it from every place the published state changes
  (including `render()`, if the UI can change the structure). It's simpler to republish
  everything than to patch it piecemeal.
- Never publish secrets or internal details (API keys, prompt templates, a SideCar
  profile). Write a small, dedicated `describeXForBus(x)` function that decides
  explicitly what leaves the module, and cover it with a test.

### Pattern: reconciling a dynamic set of channels

`modules/tracker/index.js`'s `publish()` is the reference implementation for a producer
whose set of channels can shrink or change meaning (a field/block removed by the user,
or a block merely disabled) while the module itself stays enabled:

1. Keep a small in-memory map from the last publish (e.g. `blockId -> Set<fieldName>`).
2. On each `publish()`, first diff the *current* configuration against that map and
   `unreserve()` anything that no longer exists (a removed field's channel, or —
   because the block itself was deleted — every channel that block ever owned).
3. For something still configured but **disabled** rather than removed, don't just skip
   publishing it (that would leave its last real value frozen forever) — publish an
   explicit notice value (e.g. `'(tracking disabled)'`) into its channel(s), so a
   `{{macro}}` reader sees a clear, current signal instead of stale data with no
   indication it stopped being tracked.
4. Always call `set()` for a channel, even with an empty value — a value that used to
   be truthy and just got cleared (a user hitting "reset") must actually clear the bus
   too, not silently keep whatever was there because a falsy new value used to skip the
   write.

### Pattern: index + re-subscribe for dynamic collections

`subscribe(namespace, key, listener)` subscribes to one specific key — there's no
wildcard/prefix subscription for "everything in a namespace." The standard idiom for a
dynamic list of entities:

1. Publish an index under a known key (e.g. `blocks` → a list of `{ id, ... }`).
2. Subscribe to that index. In the callback, unsubscribe from every previous per-entry
   subscription and re-subscribe to `entry:<id>` for each item in the new index.
3. This way a subscriber never needs to know the list of ids ahead of time — only the
   one known index key.

The worked producer/consumer pair for this is `modules/tracker/index.js`
(`publish()` reserves and writes `blocks` + `block:<id>` + `field:<id>:<name>`,
`resubscribeBlocks()` reads the index and re-subscribes to the entries for its own
floating panel).

### DOM nodes and functions on the bus — allowed, but it's a private RPC, not a public contract

`host.data` doesn't serialize values — you can put a live DOM element reference or a
function on it (e.g. so `render()` can reach a HUD panel `activate()` built, or call
`publish()` from a different closure in the same module). This is deliberately allowed
and convenient **within a single module**. Don't build a public API for other modules
on top of it, though — such a reference only survives the current page session; publish
only plain, serializable data for cross-module exchange. Reservation (schema, persist,
macro, webhook) only makes sense for serializable values in the first place — don't
reserve a channel that holds a DOM node or a function.

## SideCar

`host.sidecar` gives you a single shared endpoint/API key/model and a set of
sampler/reasoning profiles. A module never gets the API key through the public API.

### One-off request

```js
const answer = await host.sidecar.request({
  profileId: 'default',
  systemPrompt: 'Return JSON only.',
  prompt: '...',
});
```

### A lease tied to the module's lifecycle

```js
const lease = host.sidecar.acquire('example-worker');
const answer = await lease.request({
  profileId: 'default',
  prompt: '...',
});

return () => lease.release();
```

A lease doesn't keep a persistent HTTP connection open. It only marks the module's
long-lived access to the shared SideCar. Every `request()` is still its own separate
HTTP generation request.

### Profiles

A profile stores sampler and reasoning parameters, but never the endpoint, API key, or
model. The user creates a profile in the SideCar card; a module then shows
`host.sidecar.profiles()` and saves the chosen `profileId` in `host.moduleSettings()`.

```js
const profiles = host.sidecar.profiles(); // [{ id, name }, ...]
```

Reasoning fields for OpenRouter only apply when the endpoint contains `openrouter.ai`.

## `host.services`: services modules provide to each other

`host.sidecar` is access to an LLM, built into the engine. `host.services` is the same
request/provider idea, but for a service that a **different module** provides, not the
engine itself. The engine has no built-in knowledge of any particular service's name or
shape — there isn't a single line anywhere in `core/module-engine.js` that knows
anything specifically about Tracker. That's the point: a second, third, tenth provider
module can show up tomorrow without ever touching the engine again — that's where all
the scalability comes from.

### Provider: registers a service in its own `activate()`

```js
activate(host) {
  host.services.register('tracker', {
    track(requesterId, key, options) { /* ... */ return { set(value) {}, remove() {} }; },
  });
  return () => {}; // unregister isn't required — the engine drops the registration on disable() anyway
}
```

### Consumer: requests a service

```js
const tracker = host.services.request('tracker'); // ALWAYS an object, never undefined
const handle = tracker.track(host.id, 'my-value', { name: 'Short label', initial: '...' });
handle.set('new value');
// in cleanup:
return () => handle.remove();
```

`request(name)` is the main way to consume a service: if it's unavailable (the provider
module is disabled, or hasn't started yet), you don't get `undefined` — you get a
"void" object, where touching any property is a function that logs a warning and
returns another void object. So `tracker.track(...).set(...).remove()` **never throws**,
no matter how many methods are chained or what shape the real service actually has —
the engine doesn't need to know what `track()` even returns to guarantee that. If you
need to check availability explicitly (say, to avoid creating a `handle` for nothing),
use `host.services.isAvailable(name)` or `host.services.get(name)` (returns `undefined`
if it's missing — you can build your own logic on that, the same way as
`host.sidecar.isConfigured()`).

### `ask()` — the other half of the protocol: request-response, not just push

`register`/`get`/`request` cover push: the provider puts arbitrary methods on the
service object (`track()` above), and the consumer calls them directly. But a service
can also have the reverse shape — a consumer wants to **ask** the provider something in
a specific request shape, rather than call a ready-made method. That's
`host.services.ask(name, type, payload)`:

```js
// Provider — optionally adds handleRequest(type, payload, askerId) to the same object
// already registered via register(). `type` is a request vocabulary the provider
// defines and documents itself; `payload` is whatever shape that type expects.
host.services.register('tracker', {
  track(requesterId, key, options) { /* push, as above */ },
  async handleRequest(type, payload, askerId) {
    if (type === 'classify') return await runClassification(payload.vocabulary);
    throw new Error(`unknown type ${type}`);
  },
});

// Consumer:
const { keys } = await host.services.ask('tracker', 'classify', { vocabulary: myKeys }) ?? { keys: [] };
```

`ask()` is always a `Promise`, and it **never rejects**: the service is missing, it has
no `handleRequest`, it doesn't recognize the `type`, the handler throws — every one of
those resolves to `undefined` (logged), never a caught exception on the consumer's side.
No try/catch is needed just to ask a question that might not have an answer.

### Worked example: Tracker as a two-way service

Beyond its own hand-configured blocks, Tracker is a provider of the `'tracker'` service
in both directions:

- **Push** — `track(requesterId, key, options)`: any other module can request a value
  be tracked programmatically, without creating a block by hand. The result shows up in
  Tracker itself as a compact **Quick tracked values** section — and deliberately
  **cannot be edited there**: since the value comes from another module's code, there's
  no reason (and no way) for the user to type it in by hand. Whoever requested it
  (`host.id`, passed as the first argument) owns it, and is responsible for calling
  `handle.remove()` in its own `cleanup()`, exactly like a `sidecar` lease. Each such
  value is also a plain reserved bus channel — it has a schema, persistence, and (while
  Tracker is enabled) its own ST macro.
- **Pull** — `handleRequest('classify', { vocabulary, profileId? })`: runs one SideCar
  request asynchronously and returns `{ keys }` — which of the **asker's own** vocabulary
  of keys (up to 50; the vocabulary doesn't belong to Tracker, the asker supplies it
  every time) fit the current scene.

Both live in `modules/tracker/index.js`. A live consumer of both sides is the **Music**
module (`modules/music/index.js`): it asks Tracker for `classify` to get the scene's
keys, then picks a track by them.

## The UI framework: `core/reactive.js` + `core/dom.js` + `core/widgets.js`

Everything `render()` needs is one import from `core/widgets.js` (it re-exports what it
needs from `dom.js`/`reactive.js` — no need to import those separately).

### Signals

```js
import { signal, computed, effect } from '../../core/widgets.js';

const count = signal(0);       // count() reads, count.set(5) / count.update(n => n+1) writes, count.peek() reads without subscribing
const doubled = computed(() => count() * 2);   // recomputes itself when count changes
const dispose = effect(() => console.log(doubled()));  // runs immediately, re-runs on every dependency change
```

Synchronous, no batching: `set()` immediately notifies everyone who read the signal
inside an `effect`/`computed`. Inside `h()` bindings (below), effect disposal happens
automatically when the DOM node is removed — you almost never call `dispose()` by hand,
except for one-off effects that live outside the DOM.

### `h()` — building elements

```js
h('div', { class: 'my-class' }, 'text', childNode, anotherSignal);
```

- `bind:value` / `bind:checked` prop — two-way binding between a signal and an
  `<input>`/`<textarea>`/`<select>` (except `<select>`, see `Select()` below).
- A signal prop (`class`, or any other attribute) stays live on its own.
- `on:click` and friends — a plain `addEventListener`.
- A signal child becomes a live text node.
- `list(itemsSignal, keyFn, renderItem)` — a reactive keyed list: when `itemsSignal`
  changes, it reuses and repositions existing DOM nodes by key instead of rebuilding
  everything — focus/value inside a list item survives a NEIGHBORING item being
  added/removed/reordered.
- `show(valueSignal, renderFn)` — reactively swaps a single node when `valueSignal`
  changes value (for "which section is currently shown"-style conditionals).

### Ready-made components (`core/widgets.js`)

`Field(label, control, { hint, stack })`, `TextInput(sig, opts)`, `TextArea(sig, opts)`,
`Select(valueSig, optionsSig, shape)`, `SliderField(label, sig, { min, max, step })`,
`Toggle(label, checkedSig, { hint, onChange })`, `Button(label, onClick, { variant: 'danger' })`,
`Chip(content, { onRemove, onClick, title })`,
`DraggableList(itemsSig, keyFn, { renderHeader, renderContent, isOpen, onToggleOpen, onReorder, className })`.

`Toggle` is a real switch, not a checkbox — use it for any on/off instead of
`<input type="checkbox">`. It two-way binds to a signal by default; pass
`onChange(nextChecked, inputEl)` if the switch needs to go through something else first
(a persist call, an async action that can fail and needs to roll the visual state back)
— that's exactly what the engine's own **Enabled** toggle does (see
`core/module-engine.js`).

`DraggableList` is the same drag-and-drop card list the engine itself uses for the
module list; `modules/tracker/index.js` uses it for its own trackers too. Don't write
your own drag/drop — reuse this one.

`Select` is deliberately not built on `list()`: `<select>` only recognizes `<option>` as
a direct child, and a wrapper `<div>` (even `display:contents`) silently breaks the
option list.

### Subscriptions from inside `render()`

`render()` doesn't get a cleanup function (unlike `activate()`). If you subscribe to
something external from inside `render()` (`host.data.subscribe`, `host.onChatChanged`),
tie the unsubscribe to the container's lifetime with `onDispose(container, unsubscribe)`
— otherwise the subscription outlives the card itself and piles up on every re-render
(after a Retry or a chat switch).

## ModuleEngine Developer — the floating diagnostic panel

The **⚙ ModuleEngine Developer** button at the bottom of the drawer (below Base
settings and Modules) opens a floating window: every module with its state
(enabled/disabled/error), every reserved bus channel with its flags
(`schema`/`open`/`{{macro}}`/`push`/`pull`/`persist`) and current value, and the
engine's recent log. It isn't a module — it never goes through `activate()`/`render()`/
`host`, it doesn't appear in the Modules list, and it isn't nested in any drawer at all
(`document.body`, exactly like Tracker's HUD). The engine builds it directly, in
`core/dev-panel.js`, off a small public slice of `ModuleEngine` itself:
`listModuleStates()`, `logs()`, `bus` (a getter onto the `ModuleDataBus`),
`devPanelSettings()`.

There's nothing to add to your own module for this — the moment a channel is reserved
via `host.data.reserve()`, it's automatically visible in this panel.

## Full-screen panel and the top-bar launcher

Beyond the drawer, the engine also gives itself a real launcher icon in SillyTavern's
own top bar — the same way third-party extensions like Character Library do (ST has no
plugin API for registering a native tab; every extension that has one builds it as a
self-managed overlay and inserts its own icon by hand). `index.js`'s
`addTopBarLauncher()` inserts a `.drawer > .drawer-toggle.drawer-header > .drawer-icon`
element — the exact markup ST's own icons use — right after `#rightNavHolder` (falling
back to `#top-settings-holder`, then appending inside `#top-bar` as a last resort).
Clicking it toggles `core/full-screen-panel.js`'s overlay, a full-viewport panel with an
optional "hide ST's own top bar while open" setting.

The full-screen panel does **not** reparent the drawer's already-mounted DOM into
itself — `autoDispose()`'s `MutationObserver` (`core/dom.js`) would see that as a
removal from the drawer and tear down every live effect/subscription in it. Instead,
`ModuleEngine.mount()` is called a **second, independent time** on the panel's own
skeleton, lazily, the first time it's opened. Both mounts read/write the same
`engine.settings()`/`moduleSettings()`, so they stay in sync through shared state — the
same way two browser tabs open to the same page would. `mount()` finds its containers
via `[data-stme-base-list]`/`[data-stme-module-list]` attribute selectors, not `#id` —
an `id` that's duplicated elsewhere in the document (as it now is, once for the drawer
and once for the full-screen skeleton) makes `querySelector('#id')` unreliable even
scoped to a subtree, confirmed both in jsdom and worth assuming true for real browsers
too (a duplicate `id` is invalid HTML to begin with). A module never touches any of
this directly — `mount()` running twice only matters if you're modifying the engine
shell itself, not writing a module.

## Function tools

For native function calling, use ST's own definition shape and only register it from
`activate()`:

```js
host.registerTool({
  name: 'Example_Action',
  displayName: 'Example action',
  description: 'Description for the model.',
  parameters: { type: 'object', properties: {} },
  action: async args => 'Done.',
});

return () => host.unregisterTool('Example_Action');
```

Notebook is the reference example: it registers a tool, stores notes in `chatMetadata`,
injects a private prompt, and cleans up the whole integration on disable.

## RP Time as an example of a background module

RP Time fires a SideCar request on `GENERATION_STARTED` and applies the result after
`MESSAGE_RECEIVED`. This lets the request run in parallel with the main generation. The
module stores its result in `message.extra`, so the model's actual reply text is never
rewritten. The time badge is appended by plain DOM code after the message renders.

## Independent core services

Not everything the engine provides is a module, and not everything module-shaped is
owned by `ModuleEngine`. There are two other categories:

**`host.sidecar`** — engine-owned, instantiated inside `ModuleEngine` itself
(`this.sidecar = new SidecarManager(...)`), exposed directly on `host`. Always
available (once the user configures it), no Enabled toggle, no card in the Modules
list — its own card lives under **Base settings**.

**`core/lorebook-service.js`'s `LorebookService`** — one step further: not just
outside the Modules list, but outside `ModuleEngine` entirely. `index.js` constructs
and starts it as a **sibling** to `ModuleEngine`, and the two talk to each other only
through the shared `ModuleDataBus` (`engine.bus`) — `core/module-engine.js` has no
import of, or reference to, `LorebookService` anywhere. A module reaches it purely via
the bus, using the same "publish a callable object" idiom `modules/tracker/index.js`'s
own `publish()` already relies on (see
[DOM nodes and functions on the bus](#dom-nodes-and-functions-on-the-bus--allowed-but-its-a-private-rpc-not-a-public-contract)):

```js
const lorebook = host.data.read('lorebook', 'api');
const results = lorebook.find({ key: 'dragon' });        // metadata-only query
const full = lorebook.get(results[0].uid);                // one entry, content included
const created = await lorebook.createEntry({ comment: 'New Entry', content: '...' });
const unsubscribe = lorebook.on('entryCreated', entry => { /* ... */ });
```

It reads whichever World Info book is bound to the current chat/character
(`context.chatMetadata.world_info` + `character.data.extensions.world`, via ST's own
`context.loadWorldInfo()`/`context.saveWorldInfo()`) and republishes a **metadata-only**
index on the bus — `uid`, `book`, `name`, `keys`, `length`, `disabled`, `constant`,
deliberately never `content` — so the index itself never carries a lorebook's full text
weight; `get(uid)` fetches one entry's full record only when something actually needs
the text.

Beyond reading, it's a real read/write store with events —
`createEntry(patch, { book? })` / `updateEntry(uid, patch)` / `deleteEntry(uid)` each do
a read-modify-write against ST's own file (load the whole book, touch only the one
entry, save the whole object back — so anything else the file contains is left alone)
and, once the resulting re-scan has already updated the index, fire `'entryCreated'` /
`'entryUpdated'` / `'entryDeleted'` (plus `'scan'` on every scan, chat-change-triggered
or not) via a small internal `core/event-emitter.js`. Why go this far for something
that today is "just" a lorebook reader: the plan is for World Info to end up as one
possible storage backend under a bigger system — the actual node/connection graph
owned by the engine side, not by WI's own structure — and neither of those things (the
node graph, or a different backend) can be built later without a rewrite unless this
piece is already decoupled from `ModuleEngine` and shaped like a mutable, observable
store rather than "a WI-specific reader." Nothing graph-shaped exists yet — this is
only about not painting that door shut.

**Practical rule of thumb**: reach for this shape (independent class + `index.js`
constructs/starts it + bus-only) when a capability isn't "a module a user enables" and
isn't a natural extension of `ModuleEngine`'s own job (module lifecycle/UI) — not for
every core-ish idea. `host.sidecar` staying inside `ModuleEngine` and `LorebookService`
living outside it are both deliberate, not inconsistent: SideCar is intrinsic to what
the engine already does for every module (give it a model); Lorebook's future shape is
explicitly meant to grow past what `ModuleEngine` is about.

## Versioning and auto-updates

Three separate mechanisms, covering three separate things that can go stale: the
engine itself, a built-in module, and a module loaded from someone else's repo via
the Module Loader.

### Core self-update

`index.js` calls `attemptCoreUpdate()` once per browser session (guarded by a
`sessionStorage` flag, `stme_update_attempted`, so a failed attempt never turns into a
reload loop), before anything else boots. It uses SillyTavern's own git-based
extension-update endpoints — the same ones behind the "Update" button in ST's own
Extensions manager — wrapped in `core/self-update.js`:

- `checkCoreUpdate(context, extensionName)` → `POST /api/extensions/version`.
- `applyCoreUpdate(context, extensionName)` → `POST /api/extensions/update` (a `git
  pull`).

`extensionName` isn't exposed by `getContext()` — `deriveExtensionName(import.meta.url)`
pulls it from this exact script's own URL (the folder name in
`.../extensions/third-party/<name>/index.js` or `.../extensions/<name>/index.js`).
Both endpoints simply don't exist for a non-git install (manually copied files) —
every function here degrades to "checked: false" / "applied: false" instead of
throwing, so a non-git install boots exactly as if this code weren't here at all: no
overlay, no banner, nothing logged beyond one `console.info`.

If an update is found: a full-viewport blocking overlay (`.stme-update-blocking`, not
scoped to this extension's own panel — the ask was to block *access*, not just one
drawer) appears while the pull runs, then the page reloads on success. On failure the
overlay is removed and a fixed, page-top yellow banner (`.stme-update-banner`) appears
with a manual Retry button — Retry re-runs the same check-and-apply flow directly
(bypassing the session flag on purpose, since that flag only guards the *automatic*
attempt on load).

### Built-in module version/repo metadata

Every built-in module carries `version` and `repo` (see [Module
contract](#module-contract)) purely for display — a small `vX.Y.Z` label plus a "view
source" link next to the module's title in `#renderModuleHeader`
(`core/module-engine.js`). A built-in module's code already updates for free whenever
the core does (same git checkout, same `git pull`) — there's nothing separate to
build for these; `repo` just needs to point at that module's own folder inside this
repo (e.g. `.../tree/main/modules/notebook`), the same URL shape the Module Loader
already understands for a module hosted anywhere else.

### Engine/module compatibility: `ENGINE_VERSION` and `minEngineVersion`

`core/module-engine.js` exports `ENGINE_VERSION` (bumped by hand, kept in sync with
`manifest.json`'s own version by discipline — no build step derives one from the
other) and `compareVersions(a, b)`, a plain dotted-numeric comparison (`"1.10.0" >
"1.2.0"`) — no semver ranges or pre-release tags, since this is an internal
compatibility gate, not a package registry.

A module declares `minEngineVersion` to be checked against `ENGINE_VERSION`. The
check happens in `enable()`, **not** thrown from `register()` — an incompatible
module must not take down every module registered after it in the same `init()` (see
[Error protection](#error-protection)). When incompatible, `activate()` is never
called; the existing error-card UI shows "requires ST Module Engine vX.Y.Z or later"
instead, same as any other start failure.

### External module auto-update (Module Loader-loaded modules only)

Only meaningful for a module loaded via the Module Loader from a *different* repo —
that module isn't part of this extension's own git checkout, so core self-update
never touches it. `#loadRemoteModule(url)` now persists `{ sourceUrl: url }` into that
module's settings entry (the exact string pasted in, not the resolved raw-file URL,
so a bare repo/tree link keeps re-resolving its branch/entry file fresh on every
check).

- `engine.checkModuleUpdateAvailable(id)` re-fetches that same `sourceUrl` and reads
  its declared `version` field via a plain regex — deliberately **without**
  importing/executing the source again, since checking for an update shouldn't run a
  second copy of a module's top-level code next to the one already active. Compares
  against the currently-registered module's own `version` via `compareVersions`.
- `engine.checkAllModuleUpdates()` runs that for every module with a persisted
  `sourceUrl`, in parallel — this is what the Module Loader card's "Check for
  updates" button calls. It's on-demand, not automatic-on-load: core self-update is
  the one place a network check happens unprompted (that was the explicit ask);
  modules opt in via a click instead of firing N GitHub requests on every page load.
- When a check finds a newer version, `#renderModuleHeader` reactively shows an
  "Update available" button next to the Enabled toggle. Clicking it calls
  `engine.applyModuleUpdate(id)`: `unregister(id)` (new — fully removes a module,
  unlike `disable()`, including its injected `<style>`) followed by the exact same
  load sequence `#loadRemoteModule()` already uses, from the same `sourceUrl`. No
  page reload needed: each fetch produces a fresh `Blob`/object URL, so re-`import()`-ing
  genuinely loads fresh code, unlike a normal (cached) ES module URL.

## Community module catalog

A single, hand-curated `catalog.json` lists community modules for discovery —
separate from the [external module auto-update](#external-module-auto-update-module-loader-loaded-modules-only)
mechanism above, which only concerns a module *already installed*. This is the
"where do I find one" half.

**Where it lives**: [`IAmiGOI/SillyTavernME-Modules`](https://github.com/IAmiGOI/SillyTavernME-Modules)
— its own repository, deliberately separate from this engine's own repo and from
any individual module's own repo/fork. `core/module-catalog.js`'s
`DEFAULT_CATALOG_URL` points at its raw `catalog.json` on `main`.

**Format** — a single JSON object with one array:

```json
{
  "modules": [
    {
      "id": "dice-roller",
      "title": "Dice Roller",
      "url": "https://github.com/someone/ST-dice-roller/blob/main/index.js",
      "description": "Rolls dice inline in chat.",
      "author": "someone",
      "version": "1.0.0",
      "repo": "https://github.com/someone/ST-dice-roller"
    }
  ]
}
```

Only `id`/`title`/`url` are required — `url` is whatever `installModule()`
(below) would accept: a direct file link, a bare repo link, or a `/tree/<branch>`
link, same as the Module Loader card's own text field.

**How a module gets listed** (deliberately asymmetric, to keep a contributor's PR
minimal): a contributor's PR touches only *their own module's code*, in their own
repo or fork — never `catalog.json` itself. The maintainer reviews the module, then
by hand adds the one corresponding entry to `catalog.json` when accepting it. This
keeps the bar for contributing a module as low as "write the module, open a PR/link
it somewhere," with all catalog curation staying centralized and reviewed.

**The code here** (`core/module-catalog.js`) is intentionally backend-only, with no
UI wired to it yet:

- `parseCatalogEntry(raw)` — normalizes one entry, or returns `null` if `id`/
  `title`/`url` is missing. Every other field is coerced to a string or `null`;
  unknown extra fields are dropped, not passed through.
- `fetchCatalog(url = DEFAULT_CATALOG_URL, { fetchImpl })` — fetches and parses the
  whole catalog. A malformed individual entry is skipped with a console warning
  (same per-item error isolation as everywhere else in this codebase); a network/
  HTTP failure throws — unlike core self-update, there's no silent-skip case here,
  since a caller asking to browse the catalog needs to know when that failed.
- `ModuleEngine.installModule(url)` — the public entry point a future catalog
  browser will call per entry (`engine.installModule(entry.url)`). It's the exact
  same download-resolve-import-register-enable sequence the Module Loader card's
  "Load module" button already uses (`#loadRemoteModule`, private) — just callable
  without a DOM text field + button click in between.

## Recommendations

- Don't import ST's internal files by relative path from a module.
- Don't wrap imports in try/catch.
- Always return a cleanup function from `activate()` when you hold resources or
  subscriptions.
- Don't use global variables to exchange data between modules — use `host.data`.
- Never store secrets in module settings or on the data bus.
- Check for missing SideCar configuration via `host.sidecar.isConfigured()`.
- Don't try to rewrite the model's main reply for a small addition — persist data and
  add UI/DOM the way RP Time does.
- Build `render()` through `core/widgets.js` (signals + `h()`), not
  `innerHTML`/`querySelector` — `render()` runs once, and only signals give you an
  updated UI after that.
- Always wrap subscriptions made inside `render()` (`host.data.subscribe`,
  `host.onChatChanged`) in `onDispose(container, ...)`.
- If your module's own set of bus channels can shrink while it stays enabled (a
  removable field, a deletable entry), `unreserve()` what's gone — see
  [Pattern: reconciling a dynamic set of channels](#pattern-reconciling-a-dynamic-set-of-channels).

## Module CSS without touching the shared `style.css`

A module can export a string field, `css`. When `engine.register(module)` runs, the
engine automatically creates a dedicated `<style data-stme-module="module-id">` in
`document.head`. So a new module never needs to edit the shared `style.css`:

```js
export const exampleModule = {
  id: 'example',
  title: 'Example',
  css: `
    .stme-example-card { border-radius: 8px; }
  `,
  activate() { return () => {}; },
  render(container) { /* ... */ },
};
```

Prefix your classes with your module's name (`stme-example-*`) so you never collide
with ST's own UI or another module's.
