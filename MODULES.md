# Руководство по модулям ST Module Engine

Этот документ описывает, как устроены модули, как их добавлять и как использовать общие сервисы движка. Модуль — это JavaScript-объект внутри одного расширения SillyTavern. Он не является отдельным ST extension: движок управляет его lifecycle, UI, подписками, SideCar-профилем и обменом данными.

## Чем это лучше обычного ST-расширения

Движок берёт на себя весь повторяющийся bootstrap: вставку в `#extensions_settings`, слияние дефолтов настроек, enable/disable с изоляцией ошибок и кнопкой **Retry module**, авто-отписку от `eventSource` с перехватом ошибок в колбэках, drag-reorder карточек и, главное, один общий SideCar — модулю не нужно писать свой fetch/auth/config UI для похода к LLM. Это реально убирает boilerplate, который в обычном самостоятельном extension почти никто не делает аккуратно (упавший `init()` там обычно ломает весь скрипт без возможности retry).

С этой ревизии движок **также включает небольшой UI-фреймворк** (`core/reactive.js` + `core/dom.js` + `core/widgets.js`) — сигналы, `h()`-билдер элементов и готовые компоненты (`Field`, `TextInput`, `Toggle`, `Select`, `SliderField`, `Chip`, `DraggableList`, ...). `render()` теперь вызывается **один раз** за включение модуля (см. ниже), а не при каждом refresh — точечно обновляется только то, что реально изменилось, DOM других модулей и несохранённый ввод пользователя больше не уничтожаются по любому чужому поводу. Писать модуль через `innerHTML` + `querySelector` по-прежнему можно (`container` — обычный DOM-элемент), но так вы теряете и реактивность, и весь смысл единоразового `render()` — свежие модули должны использовать `core/widgets.js`.

## Быстрая модель работы

1. `index.js` создаёт `ModuleEngine`.
2. Встроенные или новые модули регистрируются через `engine.register(module)` до `engine.start()`.
3. При запуске движок включает модули, разрешённые в настройках.
4. У каждого модуля есть своя collapsible карточка в разделе **Modules**. Её можно включить, выключить и перетащить.
5. Общие настройки находятся в **Base settings**; сейчас там находится SideCar.

## Контракт модуля

Минимальный модуль должен содержать следующие поля:

```js
export const exampleModule = {
  id: 'example',                 // уникальный: a-z, 0-9 и дефис
  title: 'Example module',
  description: 'Краткое описание для UI.',
  defaultEnabled: false,         // true, если модуль должен запускаться сразу

  async activate(host) {
    // Подписки, tool registration, фоновые клиенты.
    // Верните cleanup-функцию.
    return () => {};
  },

  render(container, host) {
    // Создайте UI только внутри container.
  },
};
```

Регистрация выполняется в `index.js`:

```js
engine.register(exampleModule);
```

`id` является namespace для настроек и data bus. Не меняйте его после публикации: пользователи могут уже иметь сохранённые настройки.

## Lifecycle

### `activate(host)`

Вызывается после включения модуля. Используйте его для регистрации ST function tools, prompt injection, SideCar lease и подписок на события.

Возвращаемая cleanup-функция вызывается при отключении модуля. В ней обязательно:

- снимите подписки;
- вызовите `lease.release()` для SideCar lease;
- удалите зарегистрированные tools;
- очистите injected prompts, если это требуется.

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

Вызывается **один раз** — когда модуль включается (и заново, если включить его после отключения, или после `host.refresh()`/Retry). Движок **не** перевызывает `render()` из-за того, что изменился порядок карточек, свернулась/развернулась чужая карточка, или включился/выключился другой модуль — DOM вашей карточки, однажды построенный, живёт нетронутым, пока модуль включён.

Из этого следует главное практическое правило: **весь динамический контент внутри `container` стройте через сигналы (`core/widgets.js`), а не через повторный вызов `render()`.** Прочитайте настройки/metadata один раз в сигналы при построении UI, а дальнейшие изменения проводите через `signal.set(...)` — DOM отреагирует сам, точечно. Если что-то меняется не изнутри этого же `render()` (например, tool action в `activate()`, или сообщение шины от другого модуля), самому `render()` нет способа об этом узнать без явной подписки — используйте `host.data` bus (см. ниже) или `host.onChatChanged()`, вызванные прямо внутри `render()`, и отвяжите их через `onDispose(container, unsubscribe)`, иначе подписка переживёт саму карточку.

```js
render(container, host) {
  const settings = host.moduleSettings({ limit: 10 });
  const limit = signal(settings.limit);           // сигнал — источник правды для DOM
  const items = signal(loadItems(host));           // список, обновляемый вручную при изменениях

  onDispose(container, host.data.subscribe(host.id, 'changed', () => items.set(loadItems(host))));

  container.append(
    Field('Limit', TextInput(limit, { type: 'number' })),
    h('div', {}, list(items, item => item.id, item => h('div', {}, item.title))),
    Button('Save', () => { settings.limit = Number(limit.peek()); host.saveModuleSettings(); }),
  );
}
```

`host.refresh()` остался как аварийный выход: он принудительно пересобирает **только вашу** карточку (не соседние) — полезно, если что-то пошло не по сигнальной модели и проще всё перестроить, чем разбираться. Хорошо написанный модуль почти никогда его не вызывает.

Внутри `render()` не добавляйте UI напрямую в `document.body` или контейнер ST extension settings — работайте только внутри переданного `container`. Это правило про `render()`, а не про модуль целиком: DOM-код за пределами `container`, созданный из `activate()` как побочный эффект — чат-бейджи (RP Time, Tracker) или отдельная плавающая панель (Tracker HUD) — сознательно разрешён, потому что это другая UI-поверхность со своим жизненным циклом (создаётся один раз в `activate()`, удаляется в cleanup), а не часть карточки настроек.

## Защита от ошибок

Движок изолирует три класса ошибок:

- ошибка в `activate()` не запускает только данный модуль;
- ошибка в `render()` заменяет его содержимое карточкой ошибки;
- синхронная или асинхронная ошибка в callback из `host.onEvent()` перехватывается и логируется.

Остальные модули и основной UI продолжают работать. Пользователь увидит кнопку **Retry module**. Всё, что относится к конкретному модулю, всё равно нужно оборачивать в понятные проверки входных данных и возвращать cleanup.

## API `host`

| API | Назначение |
| --- | --- |
| `host.id` | Идентификатор текущего модуля. |
| `host.context()` | Актуальный `SillyTavern.getContext()`. Используйте только там, где нужен ST API. |
| `host.refresh()` | Принудительно пересобрать `render()` только этого модуля (аварийный выход — обычно не нужен, см. `render()` выше). |
| `host.toast(level, message, title?)` | Показать ST toastr-уведомление. |
| `host.moduleSettings(defaults)` | Получить сохраняемые настройки текущего модуля. |
| `host.saveModuleSettings()` | Сохранить настройки текущего модуля. |
| `host.setPrompt(key, prompt, position, depth, role)` | Установить extension prompt. |
| `host.registerTool(definition)` / `host.unregisterTool(name)` | Работа с native function tool. |
| `host.onEvent(eventType, callback)` | Подписка на ST event; возвращает unsubscribe. |
| `host.onChatChanged(callback)` | Упрощённая подписка на смену чата; возвращает unsubscribe. |
| `host.sidecar` | Общий клиент модели и профилей. |
| `host.data` | Независимый от ST in-memory обмен данными между модулями. |

## Сохраняемые module settings

```js
const settings = host.moduleSettings({
  enabledFeature: true,
  limit: 10,
});

settings.limit = 20;
host.saveModuleSettings();
```

Значения сохраняются в конфигурации движка. Они предназначены для сериализуемых данных: строк, чисел, boolean, массивов и plain object. Для данных текущего чата используйте `context.chatMetadata`.

## Data bus: обмен переменными между модулями

`host.data` не использует SillyTavern и не сохраняется на диск. Это runtime Map, поэтому можно передавать любые JavaScript-объекты, функции, Promise или ссылки на объекты. После перезагрузки страницы bus очищается.

### Свой namespace

```js
host.data.set('lastResult', { score: 12 });
const result = host.data.get('lastResult');
host.data.remove('lastResult');
```

### Данные другого модуля

```js
host.data.write('time', 'lastResult', { label: 'Day 2, 13:00' });
const value = host.data.read('time', 'lastResult', null);
```

### Подписка

```js
const unsubscribe = host.data.subscribe('time', 'lastResult', value => {
  console.debug('New RP time:', value);
});

return () => unsubscribe();
```

Используйте явные namespace и ключи. Не передавайте API key, chat metadata или большой постоянно растущий лог через bus.

### Шина — это не изоляция, а конвенция

`host.data.write(namespace, key, value)` технически позволяет писать в **чужой** namespace — это не баг, а сознательно открытый примитив (см. пример выше), но это значит, что **ничего не мешает одному модулю затереть данные другого**. Ничего похожего на права доступа нет. Правило по умолчанию: пишите только в свой namespace (`host.data.set`); используйте `host.data.write` в чужой namespace лишь в редких, осознанных случаях, и никогда не полагайтесь на то, что чужой namespace не может измениться у вас из-под ног.

### Паттерн: продюсер публикует, а не просто уведомляет

Шина — **только in-memory** и не переживает перезагрузку страницы. Если модуль-продюсер пишет в bus только по событию (например, «после ответа модели»), то после reload потребитель до следующего события видит пустоту или устаревшие данные. Поэтому:

- Публикуйте **полное текущее состояние** сразу в `activate()`, а не только при изменениях. Не полагайтесь на то, что кто-то раньше уже что-то туда положил.
- Держите одну функцию `publish()`, вызывайте её из каждого места, где меняется опубликованное состояние (включая `render()`, если UI меняет структуру — например, добавление/удаление сущности). Проще перепубликовать всё целиком, чем точечно патчить — как и с `host.refresh()`, микрооптимизация здесь не стоит сложности.
- Никогда не публикуйте секреты или внутренние детали (API-ключи, промпт-шаблоны, SideCar-профиль). Заведите отдельную чистую функцию вида `describeXForBus(x)`, которая явно решает, что именно уходит наружу, и покройте её тестом — так контракт шины виден и не расползается вслед за внутренней моделью данных модуля.

### Паттерн: индекс + переподписка для динамических коллекций

`subscribe(namespace, key, listener)` подписывается на один конкретный ключ — нет wildcard/prefix-подписки на «всё в namespace». Если у модуля динамический список сущностей (блоки, воркеры, что угодно), стандартная идиома:

1. Публикуйте индекс под известным ключом (например, `blocks` → список `{ id, ... }`).
2. Подпишитесь на этот индекс. В колбэке — отпишитесь от всех предыдущих подписок на элементы и подпишитесь заново на `entry:<id>` для каждого элемента из нового индекса.
3. Так подписчик не должен заранее знать список id — только один известный ключ-индекс, через который он их узнаёт.

Пример такой пары продюсер/потребитель внутри одного модуля — `modules/tracker/index.js` (`publish()` пишет `blocks` + `block:<id>`, `resubscribeBlocks()` читает индекс и переподписывается на элементы для отдельной плавающей панели).

### DOM-узлы и функции на шине — можно, но это приватный RPC, а не публичный контракт

`host.data` не сериализует значения — можно положить туда живую ссылку на DOM-элемент или функцию (например, чтобы `render()` мог достать HUD-панель, созданную в `activate()`, или вызвать `publish()` из другого замыкания того же модуля). Это осознанно разрешено и удобно **внутри одного модуля**, когда `activate()` и `render()` не имеют общего closure. Но не стройте на этом публичный API для других модулей — такая ссылка переживает только текущую сессию страницы и не имеет версии/контракта; для межмодульного обмена публикуйте только простые сериализуемые данные (как в примере с Tracker выше).

## SideCar

`host.sidecar` предоставляет единый endpoint/API key/model и набор sampler/reasoning профилей. Модуль не получает API key через публичный API.

### Разовый запрос

```js
const answer = await host.sidecar.request({
  profileId: 'default',
  systemPrompt: 'Return JSON only.',
  prompt: '...',
});
```

### Lease на lifecycle модуля

```js
const lease = host.sidecar.acquire('example-worker');
const answer = await lease.request({
  profileId: 'default',
  prompt: '...',
});

return () => lease.release();
```

Lease не держит постоянное HTTP-соединение. Он лишь обозначает долгоживущий доступ модуля к общему SideCar. Каждый `request()` остаётся отдельным HTTP generation request.

### Профили

Профиль хранит sampler и reasoning параметры, но не endpoint, API key или модель. Пользователь создаёт профиль в карточке SideCar, затем модуль показывает `host.sidecar.profiles()` и сохраняет выбранный `profileId` в `host.moduleSettings()`.

```js
const profiles = host.sidecar.profiles(); // [{ id, name }, ...]
```

Для OpenRouter reasoning-поля применяются только к endpoint, содержащему `openrouter.ai`.

## UI-фреймворк: `core/reactive.js` + `core/dom.js` + `core/widgets.js`

Всё, что нужно для `render()`, — импорт из `core/widgets.js` (он же реэкспортирует нужное из `dom.js`/`reactive.js`, отдельно их подключать не нужно).

### Сигналы

```js
import { signal, computed, effect } from '../../core/widgets.js';

const count = signal(0);       // count() — читать, count.set(5) / count.update(n => n+1) — писать, count.peek() — читать без подписки
const doubled = computed(() => count() * 2);   // пересчитывается сам при изменении count
const dispose = effect(() => console.log(doubled()));  // сразу выполняется и перезапускается на каждое изменение зависимостей
```

Синхронно, без батчинга: `set()` немедленно уведомляет всех, кто читал сигнал внутри `effect`/`computed`. Внутри `h()`-биндингов (ниже) диспоз эффектов происходит автоматически при удалении DOM-узла — вручную `dispose()` вызывать почти никогда не нужно, кроме одноразовых эффектов вне DOM.

### `h()` — построение элементов

```js
h('div', { class: 'my-class' }, 'text', childNode, anotherSignal);
```

- Проп `bind:value` / `bind:checked` — двусторонняя привязка сигнала к `<input>`/`<textarea>`/`<select>` (кроме `<select>`, см. `Select()` ниже).
- Проп-сигнал (`class`, любой другой атрибут) — держится в актуальном состоянии сам.
- Проп `on:click` и т.п. — обычный `addEventListener`.
- Ребёнок-сигнал становится живым текстовым узлом.
- `list(itemsSignal, keyFn, renderItem)` — реактивный keyed-список: при изменении `itemsSignal` переиспользует и переставляет существующие DOM-узлы по ключу, а не пересоздаёт всё — фокус/значение инпутов внутри элемента списка переживают добавление/удаление/реордер СОСЕДНИХ элементов.
- `show(valueSignal, renderFn)` — реактивно подменяет один узел, когда `valueSignal` меняет значение (для условного «какая секция сейчас показана»).

### Готовые компоненты (`core/widgets.js`)

`Field(label, control, { hint, stack })`, `TextInput(sig, opts)`, `TextArea(sig, opts)`, `Select(valueSig, optionsSig, shape)`, `SliderField(label, sig, { min, max, step })`, `Toggle(label, checkedSig, { hint, onChange })`, `Button(label, onClick, { variant: 'danger' })`, `Chip(content, { onRemove, onClick, title })`, `DraggableList(itemsSig, keyFn, { renderHeader, renderContent, isOpen, onToggleOpen, onReorder, className })`.

`Toggle` — не чекбокс, а настоящий слайдер-переключатель; используйте его для любого on/off вместо `<input type="checkbox">`. По умолчанию двусторонне привязан к сигналу; передайте `onChange(nextChecked, inputEl)`, если переключение должно сначала пройти через что-то ещё (персист, асинхронный вызов, который может упасть и должен откатить визуальное состояние) — так делает переключатель **Enabled** у самого движка (см. `core/module-engine.js`).

`DraggableList` — тот же drag-and-drop-список карточек, что использует сам движок для списка модулей; `modules/tracker/index.js` использует его же для своих трекеров. Не пишите свой drag/drop — переиспользуйте этот.

`Select` специально не построен на `list()`: `<select>` признаёт `<option>` только как своего прямого потомка, обёрточный `<div>` (даже `display:contents`) ломает список опций молча.

### Кросс-замыканий подписки внутри `render()`

`render()` не получает cleanup-функцию (в отличие от `activate()`). Если внутри `render()` вы подписываетесь на что-то внешнее (`host.data.subscribe`, `host.onChatChanged`), привяжите отписку к жизни контейнера через `onDispose(container, unsubscribe)` — иначе подписка переживёт саму карточку и будет копиться при каждом повторном `render()` (после Retry/переключения).

## Function tools

Для native function calling используйте определение ST и регистрируйте его только в `activate()`:

```js
host.registerTool({
  name: 'Example_Action',
  displayName: 'Example action',
  description: 'Описание для модели.',
  parameters: { type: 'object', properties: {} },
  action: async args => 'Done.',
});

return () => host.unregisterTool('Example_Action');
```

Notebook — эталонный пример: он регистрирует tool, хранит заметки в `chatMetadata`, инъецирует private prompt и очищает integration при отключении.

## RP Time как пример фонового модуля

RP Time запускает SideCar-запрос на `GENERATION_STARTED`, а результат применяет после `MESSAGE_RECEIVED`. Это позволяет запросу выполняться параллельно с основной генерацией. Модуль хранит результат в `message.extra`, поэтому сам текст ответа модели не переписывается. Бейдж времени добавляется DOM-кодом после рендера сообщения.

## Рекомендации

- Не импортируйте внутренние ST-файлы по относительным путям из модуля.
- Не оборачивайте imports в `try/catch`.
- Всегда возвращайте cleanup из `activate()` при наличии ресурсов или подписок.
- Не используйте глобальные переменные для обмена между модулями: используйте `host.data`.
- Не сохраняйте секреты в module settings или data bus.
- Проверяйте отсутствие SideCar-конфигурации через `host.sidecar.isConfigured()`.
- Не пытайтесь переписывать основной ответ нейросетью для небольших дополнений: сохраняйте данные и добавляйте UI/DOM-кодом, как RP Time.
- Стройте `render()` через `core/widgets.js` (сигналы + `h()`), а не через `innerHTML`/`querySelector` — `render()` вызывается один раз, и только сигналы дают вам обновление UI после этого.
- Подписки внутри `render()` (`host.data.subscribe`, `host.onChatChanged`) всегда оборачивайте в `onDispose(container, ...)`.

## CSS модуля без изменения общего `style.css`

Модуль может экспортировать строковое поле `css`. При `engine.register(module)` движок автоматически создаёт отдельный `<style data-stme-module="module-id">` в `document.head`. Поэтому для нового модуля не нужно редактировать общий `style.css`:

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

Используйте префикс класса модуля (`stme-example-*`), чтобы не затронуть интерфейс ST и другие модули.
