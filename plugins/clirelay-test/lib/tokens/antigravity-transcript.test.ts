import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAntigravityUsageLookup,
  isSafeProviderThreadId,
  matchAntigravityUsage,
  parseAntigravityTranscript,
} from "./antigravity-transcript";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("antigravity transcript usage", () => {
  it("отклоняет небезопасные providerThreadId", () => {
    expect(isSafeProviderThreadId("53cb70fa-6bbb-415e-b77b-b23b9d3934d8")).toBe(true);
    expect(isSafeProviderThreadId("../etc/passwd")).toBe(false);
    expect(isSafeProviderThreadId("a/b")).toBe(false);
    expect(isSafeProviderThreadId("")).toBe(false);
  });

  it("парсит PLANNER_RESPONSE и точно сопоставляет по сумме input+cache+output === usedTokens", () => {
    const raw = [
      JSON.stringify({ type: "USER_INPUT", content: "hi" }),
      "not-json-line",
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T17:18:55Z",
        input_tokens: 15_701,
        cache_read_tokens: 0,
        output_tokens: 112,
        model: "gemini-4-neon-medium",
      }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T17:31:30Z",
        input_tokens: 2_787,
        cache_read_tokens: 118_190,
        output_tokens: 1_651,
        model: "gemini-4-neon-medium",
      }),
    ].join("\n");

    const entries = parseAntigravityTranscript(raw);
    expect(entries).toHaveLength(2);

    const matched = matchAntigravityUsage(
      entries,
      122_628,
      Date.parse("2026-11-20T17:32:02Z"),
      1_048_576,
    );
    expect(matched).toEqual({
      last: {
        inputTokens: 120_977,
        cachedInputTokens: 118_190,
        cacheReadInputTokens: 118_190,
        outputTokens: 1_651,
        reasoningOutputTokens: 0,
        totalTokens: 122_628,
      },
      total: {
        inputTokens: 120_977,
        cachedInputTokens: 118_190,
        cacheReadInputTokens: 118_190,
        outputTokens: 1_651,
        reasoningOutputTokens: 0,
        totalTokens: 122_628,
      },
      modelContextWindow: 1_048_576,
    });
    expect(matchAntigravityUsage(entries, 999_999, Date.now(), 1_048_576)).toBeNull();
  });

  it("читает transcript.jsonl с диска и возвращает null при отсутствии файла", async () => {
    const brainDir = await mkdtemp(path.join(os.tmpdir(), "clirelay-ag-"));
    tempDirs.push(brainDir);
    const threadId = "53cb70fa-6bbb-415e-b77b-b23b9d3934d8";
    const logDir = path.join(brainDir, threadId, ".system_generated", "logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      path.join(logDir, "transcript.jsonl"),
      `${JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T17:18:55Z",
        input_tokens: 15_701,
        cache_read_tokens: 0,
        output_tokens: 112,
      })}\n`,
      "utf8",
    );

    const lookup = createAntigravityUsageLookup(brainDir);
    expect(await lookup({
      providerThreadId: threadId,
      usedTokens: 15_813,
      eventCreatedAt: Date.parse("2026-11-20T17:19:00Z"),
      modelContextWindow: 1_048_576,
    })).toMatchObject({
      last: { inputTokens: 15_701, outputTokens: 112, totalTokens: 15_813 },
    });
    expect(await lookup({
      providerThreadId: "missing-thread",
      usedTokens: 15_813,
      eventCreatedAt: Date.now(),
      modelContextWindow: 1_048_576,
    })).toBeNull();
  });
});
