import spawn from "cross-spawn";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { availableCredits, resetCreditSchema, resetsSchema, resetOutcomeSchema, type Resets } from "./contract.ts";

export class ResetError extends Error {}

/** One short-lived CLI connection; credentials never leave Codex. */
export class CodexSession {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private buffer = "";
  private stopped = false;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 1024 * 1024) return this.fail(new ResetError("Ответ Codex слишком большой."));
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.fail(new ResetError("Не удалось прочитать ответ Codex.")); return; }
        if (!message || typeof message !== "object") continue;
        if (message.method && message.id !== undefined) {
          this.send({ id: message.id, error: { code: -32601, message: "Unsupported request" } });
          continue;
        }
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new ResetError(message.error.code === -32601
          ? "Обновите Codex CLI: эта версия не поддерживает сохранённые сбросы."
          : "Codex не выполнил запрос. Проверьте вход в аккаунт и обновите данные."));
        else request.resolve(message.result);
      }
    });
    // Do not forward CLI diagnostics: they may contain account details.
    child.stderr.resume();
    child.stdin.on("error", () => this.fail(new ResetError("Соединение с Codex закрыто.")));
    child.once("error", () => this.fail(new ResetError("Не удалось запустить Codex CLI на выбранном компьютере.")));
    child.once("close", () => this.fail(new ResetError("Codex CLI завершился до ответа.")));
  }
  private send(message: unknown) { this.child.stdin.write(JSON.stringify(message) + "\n"); }
  async initialize() {
    await this.call("initialize", { clientInfo: { name: "bb_usage_rings", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
  }
  call(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new ResetError("Соединение с Codex закрыто."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ResetError("Ответ Codex не получен. Обновите данные; при повторе будет использован тот же сброс.")), 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.close();
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new ResetError("Запрос отменён.")); }
    this.pending.clear();
    this.child.stdin.end();
    if (!this.child.pid || this.child.exitCode !== null) return;
    if (process.platform === "win32") {
      // cross-spawn can launch a .cmd shim; terminate its app-server child too.
      execFile("taskkill", ["/pid", String(this.child.pid), "/t", "/f"], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-this.child.pid, "SIGTERM"); } catch { this.child.kill(); }
      const kill = setTimeout(() => { try { process.kill(-this.child.pid!, "SIGKILL"); } catch {} }, 1000);
      kill.unref(); this.child.once("close", () => clearTimeout(kill));
    }
  }
}

export async function withCodex<T>(signal: AbortSignal, run: (client: CodexSession) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const child = spawn("codex", ["app-server"], { stdio: "pipe", windowsHide: true, detached: process.platform !== "win32" }) as ChildProcessWithoutNullStreams;
  const client = new CodexSession(child);
  const abort = () => client.close();
  signal.addEventListener("abort", abort, { once: true });
  try { await client.initialize(); return await run(client); }
  catch (error) { throw error instanceof ResetError ? error : new ResetError("Не удалось прочитать сохранённые сбросы Codex. Обновите CLI и проверьте вход."); }
  finally { signal.removeEventListener("abort", abort); client.close(); }
}

const windowSchema = z.object({ usedPercent: z.number().finite(), windowDurationMins: z.number().nullable(), resetsAt: z.number().nullable() });
const limitsSchema = z.object({ primary: windowSchema.nullish(), secondary: windowSchema.nullish() });
const responseSchema = z.object({
  accountId: z.string().min(1), rateLimits: limitsSchema,
  rateLimitsByLimitId: z.record(z.string(), limitsSchema).nullish(),
  rateLimitResetCredits: z.object({ availableCount: z.number().int().nonnegative(), credits: z.array(resetCreditSchema).max(1000).nullable() }).nullish(),
});
const accountSchema = z.object({ account: z.object({ type: z.literal("chatgpt"), email: z.string().min(1) }) });

export async function readResets(client: Pick<CodexSession, "call">, expectedEmail: string): Promise<Resets> {
  const account = accountSchema.safeParse(await client.call("account/read", { refreshToken: false }));
  if (!account.success || account.data.account.email.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new ResetError("Аккаунт Codex CLI отличается от аккаунта в карточке. Проверьте вход на выбранном компьютере.");
  }
  const response = responseSchema.safeParse(await client.call("account/rateLimits/read", { excludeResetCreditDetails: false }));
  if (!response.success || !response.data.rateLimitResetCredits) throw new ResetError("Данные о сбросах недоступны. Обновите Codex CLI или откройте страницу использования Codex.");
  const { rateLimitResetCredits: summary, accountId } = response.data;
  const limits = response.data.rateLimitsByLimitId?.codex ?? response.data.rateLimits;
  return resetsSchema.parse({ accountId, email: account.data.account.email, ...summary,
    windows: [limits.primary, limits.secondary].filter(w => w != null).map(w => ({
      label: w.windowDurationMins === 300 ? "5 часов" : w.windowDurationMins === 10080 ? "Неделя" : "Основной лимит",
      remaining: Math.max(0, Math.min(100, 100 - w.usedPercent)), resetsAt: w.resetsAt,
    })),
  });
}

export async function consumeReset(client: Pick<CodexSession, "call">, input: {
  expectedEmail: string; expectedAccountId: string; creditId: string; idempotencyKey: string;
}) {
  const current = await readResets(client, input.expectedEmail);
  if (current.accountId !== input.expectedAccountId) throw new ResetError("Аккаунт или рабочее пространство изменилось. Откройте список сбросов заново.");
  if (!availableCredits(current).some(c => c.id === input.creditId && c.resetType === "codexRateLimits")) {
    throw new ResetError("Выбранный сброс больше недоступен. Обновите список; другой сброс не использован.");
  }
  return resetOutcomeSchema.parse((await client.call("account/rateLimitResetCredit/consume", {
    creditId: input.creditId, idempotencyKey: input.idempotencyKey,
  }) as { outcome: unknown }).outcome);
}
