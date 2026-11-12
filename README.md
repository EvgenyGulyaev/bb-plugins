# deicer BB plugins

Плагины BB, которые я поддерживаю или существенно доработал.

## Установка

Установить один плагин из этого репозитория:

```sh
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --plugin session-history
```

Вместо `session-history` можно указать `file-manager-multi-host`, `kanban-board` или `ru`.

Установка через путь к каталогу плагина:

```sh
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --subdirectory plugins/session-history
```

Плагины собираются BB при установке. Кеши, базы данных, `node_modules` и личные данные в этот репозиторий не входят.
