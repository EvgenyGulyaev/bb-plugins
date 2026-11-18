# Логотипы провайдеров

Вендоренные SVG-логотипы для колец квот relay (kimi, claude, grok, gpt/OpenAI).

- Источник: [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons), лицензия MIT.
- Файлы скопированы как есть: `kimi.svg`, `claude.svg`, `grok.svg`, `gpt.svg`.
- Каждый — чистый SVG бренд-иконки: `viewBox="0 0 24 24"`, `fill="currentColor"`,
  только `<path>`, без `<script>`, обработчиков `on*`, `href`, `<foreignObject>`
  и внешних ссылок. Проверяется тестом `lib/provider-logos.test.ts`.
- `lib/provider-logos.ts` держит их строковыми константами: фронтенд-бандл не
  читает файлы с диска. HTML вставляется в дерево только из этих констант.

Обновление: замените файл в этой папке и перегенерируйте `lib/provider-logos.ts`
(константы — точное содержимое файлов, кроме хвостового перевода строки).
