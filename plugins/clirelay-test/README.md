# Api модели (clirelay-test)

BB-плагин для лёгкого подключения моделей с API-адресов в [pi](https://pi.dev).
Источник истины — `~/.pi/agent/models.json`; pi подхватывает изменения при открытии `/model`.

## Раскладка

Иконка «Api модели» в левом рейле → панель с двумя вкладками:

- **«Аккаунты»** (дефолт) — карточки квот аккаунтов relay, как в manage-UI clirelay:
  шапка `auth_index`, бейджи (план, провайдер, Cycle, Success Rate, restriction),
  строки квот с баром остатка (`percent`), countdown до сброса (`reset_at`);
  бар зелёный при остатке >20%, красный ≤20%. Карточки сгруппированы по адресу
  relay, обновление кнопкой ⟳ на группу. Данные: management API clirelay
  `GET {origin}/v0/management/ai-accounts/status` (нужны логин/пароль админки relay, см. ниже).
  Без ключа — карточка-подсказка с командой настройки; при ошибке ключа — понятный текст.
- **«Подключение»** — управление моделями pi:

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
                               │   [Тест] [Сохранить]         │
                               └──────────────────────────────┘
▶ other-api       …
```

- Аккордеон верхнего уровня — API-адрес (провайдер `models.json`).
  Если несколько провайдеров сидят на одном адресе — они показываются вложенно
  под общей группой адреса (аккордеон адреса → аккордеоны провайдеров).
- Слева — модели с `GET {baseUrl}/models` минус уже подключённые; «＋» подключает.
  Если эндпоинт не отдаёт `/models` — ошибка + ручное добавление по id.
- Справа — подключённые модели; аккордеон модели → форма настроек.
  Кнопка «Тест» шлёт минимальный реальный запрос (`POST /chat/completions`,
  `max_tokens: 8`, таймаут 30с) и показывает латентность и кусочек ответа;
  ошибки санитизируются. v1: только `openai-completions`.
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

Логин и пароль админки relay (для вкладки «Аккаунты») задаются **per-URL**: кнопка
«Креды» у каждой группы адреса открывает диалог (логин/пароль, сохранить/очистить).
Креды хранятся в server-side kv плагина по origin (`relay-creds:<origin>`), сессии —
там же (`relay-auth:<origin>`); плагин сам логинится (`POST {origin}/v0/auth/login`)
и продлевает сессию через `/v0/auth/refresh`. Глобальные secret-настройки
`managementUser` / `managementPassword` (файл 0600, не попадают в db/фронтенд/репо) —
fallback для адресов без своих кредов:

```bash
bb plugin config clirelay-test set managementUser <логин админки>
bb plugin config clirelay-test set managementPassword <пароль админки>
bb plugin reload clirelay-test
```

Если у адреса нет management API (например, другой сервис вместо clirelay) —
группа покажет ошибку HTTP, остальные адреса работают независимо.

## Секретность

Ключи и адреса живут только в `~/.pi/agent/models.json` (вне репо), креды админки —
в secret-настройках плагина, сессии — в server-side kv. В коде, тестах и доках —
только выдуманные `localhost`.
`apiKey` и `headers` никогда не возвращаются фронтенду; ошибки discovery и
management API санитизируются (без URL).
Запись файла атомарная (tmp + rename) с ротацией `.bak`; неизвестные поля сохраняются.

## Ограничения v1

- Таргет — только pi.
- Ключи `!command` не резолвятся для discovery (literal и `$ENV` — да).
- Редкие поля (`thinkingLevelMap`, `inputLimits`, `headers`, `promptCache`,
  `samplingParams*`) не редактируются, но сохраняются в файле как есть.
