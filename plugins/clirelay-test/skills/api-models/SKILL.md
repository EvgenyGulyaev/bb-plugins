---
name: api-models
description: Use when the user asks to connect, list, or configure pi models from API addresses through the «Api модели» BB plugin panel.
---

# Api модели (clirelay-test)

Панель bb «Api модели» управляет кастомными провайдерами pi в `~/.pi/agent/models.json`.

- Раскладка: аккордеон на API-адрес → слева доступные модели (`GET {baseUrl}/models`, минус подключённые), справа подключённые; аккордеон модели → форма настроек. Несколько провайдеров на одном адресе → вложенная группа адреса.
- Конфиг: `bb plugin config clirelay-test set modelsPath <путь>` (+ `bb plugin reload clirelay-test`); дефолт `~/.pi/agent/models.json`.
- RPC: `providers_list`, `provider_save`, `provider_delete`, `models_discover`, `model_connect`, `model_disconnect`, `model_update`, `model_test` (минимальный chat-запрос, латентность + ответ; только `openai-completions`, таймаут 30с).
- v1 поля модели: `name`, `reasoning`, `contextWindow`, `maxTokens`, `input`. Остальные поля файла сохраняются нетронутыми.
- pi подхватывает изменения при открытии `/model`.
- Секретность: ключи и адреса живут только в `models.json` вне репо; не коммитить и не логировать их. `apiKey` фронтенду не возвращается.
- Ограничения: ключи `!command` не резолвятся для discovery; таргет только pi.
- Тестовый шов: `PI_MODELS_PATH` переопределяет путь к файлу (используется в тестах).
