---
name: token-meter
description: Объяснить бейджи токенов/ток/с и сводку token-meter, отсутствие usage у провайдера или ограничения истории.
---

# token-meter

Плагин показывает только фактический `thread/tokenUsage/updated`, полученный от BB:

- бейдж последнего realized assistant-сообщения хода: `↑вход ↓выход · cache N · M ток/с`;
- сводку контекста треда: `Σ N токенов · ~M ток/с`.

Не предлагай «исправить» отсутствие бейджа оценкой токенов. Сначала проверь провайдера: pi/codex отдают usage, command-code/gemini-web — нет. BB заменяет предыдущее usage-событие последним, поэтому история доступна только из записей, которые plugin успел накопить после установки.

Скорость — wall-clock `outputTokens / (turn/completed − turn/started)`, только при длительности ≥1 с и output >0. Это не provider-native tokens/sec. Reasoning и cache read/write доступны в tooltip бейджа.

Retention: 500 ходов на тред и 30 дней. Нет сохранённой записи → UI должен возвращать `null`, без плейсхолдеров и выдуманных значений.

Проверки после изменений: `npm run typecheck`, `bb plugin build`, `npx vitest run` в `plugins/token-meter`.
