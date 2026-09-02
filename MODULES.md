# Руководство по модулям ST Module Engine

Этот документ описывает, как устроены модули, как их добавлять и как использовать общие сервисы движка. Модуль — это JavaScript-объект внутри одного расширения SillyTavern. Он не является отдельным ST extension: движок управляет его lifecycle, UI, подписками, SideCar-профилем и обменом данными.

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

Вызывается для отрисовки включённой карточки. Движок пересоздаёт UI при refresh, поэтому храните состояние в настройках, metadata чата или своём модуле, а не в DOM. Не добавляйте UI напрямую в `document.body` или контейнер ST extension settings.

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
| `host.refresh()` | Перерисовать общий UI движка. |
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
