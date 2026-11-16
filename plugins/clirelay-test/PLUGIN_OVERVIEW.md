Pi models and relay accounts in one panel, with model badges for pi threads.

«Api модели» is the BB panel for the pi agent: API addresses and their models
in `~/.pi/agent/models.json`, relay account quotas, and the marks that label
the current model of a pi thread.

Connect an address once — its id, base URL, API type and key — and the panel
shows the models the endpoint serves next to the ones pi already has. One
click connects a model, and its accordion holds the settings pi reads on the
next `/model`: reasoning, context window, max output, input kinds. Several
providers behind one address collapse into a single address group. A model can
be switched off instead of deleted: its settings move to the plugin's storage,
pi stops seeing it, and switching it back restores the same entry. Both
columns group models by family, and the «Все / Вкл / Выкл» filter counts what
is on and off. "Тест" sends a minimal real request to a connected model and
reports latency and a short reply.

The «Аккаунты» tab reads relay quotas through the relay's management API.
Cards show the account's email (or its hash), plan, provider, success rate and
a bar per quota with a countdown to reset, with Russian quota labels. Accounts
with quota and without are separate accordions, and a toggle enables or
disables your own accounts. Relay credentials are entered per address — or
once for every address in the plugin settings — and stay on the server.

The «Значки моделей» tab manages marks for model families. Families come from
the models you connected and from the models pi threads actually ran, matched
by name: GPT, Claude, DeepSeek, Grok, Gemini, Qwen, Kimi, Llama, Mistral, and
«х5» for x5/copilot names. Each family gets a mark: a built-in BB icon picked
from a grid, a short text such as «х5», or your own inline SVG (pasted or
uploaded). SVG markup is checked on the server and in the browser: script,
foreignObject, external links and event handlers are refused. Marks are shown
on pi thread rows as a small badge whose tooltip is the full model id, and in
the open thread's context row as the mark plus the model name. The row badge
appears once BB's `threadRowMetadata` experiment is on and Organize → Rows →
Metadata is enabled in the sidebar; the context row needs neither.

The plugin only labels pi threads. The thread's model is learned from every
message dispatch and resolved lazily through the BB SDK for threads seen
before the plugin loaded, so a model change appears from the next message on.
No account, key, or external service is required beyond the ones the panel
already manages.
