# Плагины BB от deicer

Публичная подборка плагинов BB, которые я поддерживаю или существенно доработал.

## Что здесь есть

### `session-history`

Единый список сессий разных агентов:

- Claude Code, Codex, Qwen, Pi и Command Code;
- сессии с подключённых компьютеров;
- группировка по папкам, в которых работал агент;
- быстрый показ ранее найденных сессий из кеша;
- фоновый поиск новых сессий;
- удаление отдельной сессии или всех сессий папки с подтверждением;
- открытие сессии для продолжения работы.

[Подробная документация session-history](plugins/session-history/README.md)

### `file-manager-multi-host`

Файловый менеджер для работы с файлами на разных подключённых компьютерах BB. Позволяет просматривать каталоги, открывать и скачивать файлы, загружать файлы на выбранный компьютер и выполнять основные операции с архивами.

[Подробная документация file-manager-multi-host](plugins/file-manager-multi-host/README.md)

### `kanban-board`

Доска для организации потоков BB по этапам работы. Потоки можно раскладывать по колонкам и перемещать между ними, чтобы видеть текущие задачи и их состояние.

[Подробная документация kanban-board](plugins/kanban-board/README.md)

### `ru`

Русская локализация интерфейса BB и связанные с ней переводы. Плагин нужен, если вы хотите пользоваться основными экранами BB на русском языке.

[Подробная документация ru](plugins/ru/README.md)

## Установка

Для установки одного плагина выполните команду в терминале:

```powershell
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --plugin session-history
```

Вместо `session-history` можно указать другой идентификатор:

```text
file-manager-multi-host
kanban-board
ru
```

Например, установить файловый менеджер:

```powershell
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --plugin file-manager-multi-host
```

Также можно установить плагин напрямую из его каталога:

```powershell
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --subdirectory plugins/session-history
```

После установки BB сам соберёт плагин и подключит его. Обновить установленный плагин можно командой:

```powershell
bb plugin update session-history
```

## Важно

В репозитории хранятся исходники и документация. Кеши сессий, базы данных, `node_modules`, каталоги сборки и личные данные в него не входят.

## Репозиторий

[github.com/deicer/bb-plugins](https://github.com/deicer/bb-plugins)
