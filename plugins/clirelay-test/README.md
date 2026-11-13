# Api модели (clirelay-test)

BB-плагин для лёгкого подключения моделей с API-адресов в [pi](https://pi.dev).
Источник истины — `~/.pi/agent/models.json`; pi подхватывает изменения при открытии `/model`.

## Раскладка

Иконка «Api модели» в левом рейле → панель:

```
[＋ Добавить API]
▼ my-router         …:8080/v1   3 подкл.   [⟳] [⚙] [✕]
  ┌ Доступные (GET /models) ─┐ ┌ Подключённые (в pi) ─────────┐
  │ model-large        [＋]  │ │ ▶ model-flash                │
  │ model-new          [＋]  │ │ ▼ model-pro            [✕]   │
  │ (подключённые скрыты)    │ │   reasoning      [✓] bool    │
  └──────────────────────────┘ │   contextWindow  [400000] int│
                               │   maxTokens      [64000] int │
                               │   input          [text|image]│
                               │   [Сохранить]                │
                               └──────────────────────────────┘
▶ other-api       …
```

- Аккордеон верхнего уровня — API-адрес (провайдер `models.json`).
  Если несколько провайдеров сидят на одном адресе — они показываются вложенно
  под общей группой адреса (аккордеон адреса → аккордеоны провайдеров).
- Слева — модели с `GET {baseUrl}/models` минус уже подключённые; «＋» подключает.
  Если эндпоинт не отдаёт `/models` — ошибка + ручное добавление по id.
- Справа — подключённые модели; аккордеон модели → форма настроек.
- Форма генерится из схемы полей (`lib/schema.ts`): bool → чекбокс, int → число,
  enum → селект, multiselect → чекбоксы. v1: `name`, `reasoning`, `contextWindow`,
  `maxTokens`, `input`. Compat/Sampling/Cost — следующие итерации.

## Сценарий

1. «Добавить API» → id (slug), имя, baseUrl, тип API, ключ.
2. Раскрыть адрес → список доступных загрузится сам.
3. «＋ Подключить» → модель появилась справа и в `models.json`.
4. Раскрыть модель → настроить → «Сохранить».
5. В pi открыть `/model` — модель доступна.

## Установка

```bash
npm install
bb plugin build
bb plugin install .
```

Тесты: `npm test` (vitest). Типы: `npm run typecheck`.

## Конфигурация

Путь к файлу pi настраивается (дефолт `~/.pi/agent/models.json`):

```bash
bb plugin config clirelay-test set modelsPath /path/to/models.json
bb plugin reload clirelay-test   # настройка читается при загрузке
```

То же поле — в Settings → Installed plugins → Api модели.
`PI_MODELS_PATH` — тестовый шов, имеет приоритет над настройкой.

## Секретность

Ключи и адреса живут только в `~/.pi/agent/models.json` (вне репо).
В коде, тестах и доках — только выдуманные `localhost`. `apiKey` и `headers`
никогда не возвращаются фронтенду; ошибки discovery санитизируются (без URL).
Запись файла атомарная (tmp + rename) с ротацией `.bak`; неизвестные поля сохраняются.

## Ограничения v1

- Таргет — только pi.
- Ключи `!command` не резолвятся для discovery (literal и `$ENV` — да).
- Редкие поля (`thinkingLevelMap`, `inputLimits`, `headers`, `promptCache`,
  `samplingParams*`) не редактируются, но сохраняются в файле как есть.
