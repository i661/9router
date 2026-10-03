// Contract: /api/usage/stream pushes the FULL getUsageStats payload for the
// requested ?period= (not just activeRequests/recentRequests) and recalculates
// it as usage is saved — no client refetch anywhere in the path. Also proves
// the invalid-period fallback to "all" (streaming must not 400: EventSource
// treats non-2xx as a connection error and retry-loops).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let route;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-stream-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  // Same module registry as the repo layer → shared statsEmitter and DB.
  route = await import("../../src/app/api/usage/stream/route.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Reads the next SSE data message: accumulate decoded chunks, split on "\n\n",
// skip keepalive comment frames (": ping"), JSON.parse the "data: <json>" line.
async function readNextData(reader) {
  const decoder = new TextDecoder();
  const start = Date.now();
  let buf = "";
  for (;;) {
    const sep = buf.indexOf("\n\n");
    if (sep !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue; // keepalive comment frame
      return JSON.parse(dataLine.slice("data:".length).trim());
    }
    const remaining = 10000 - (Date.now() - start);
    if (remaining <= 0) throw new Error("timed out waiting for an SSE data message");
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("SSE read timeout")), remaining)),
    ]);
    if (done) throw new Error("stream ended before a data message arrived");
    buf += decoder.decode(value, { stream: true });
  }
}

describe("usage stream live, period-filtered stats", () => {
  it("emits period-filtered totals that update as usage is saved", async () => {
    await db.saveRequestUsage({
      provider: "openai", model: "m-today-1", connectionId: "c1",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      endpoint: "/v1/chat/completions", status: "ok",
    });

    const res = await route.GET(new Request("http://localhost/api/usage/stream?period=today"));
    const reader = res.body.getReader();
    try {
      // First message is the initial full recalc (quick pushes require a prior
      // cachedStats, so the initial send emits full stats only).
      const first = await readNextData(reader);
      expect(first.totalRequests).toBe(1);
      expect(first.totalPromptTokens).toBe(100);
      expect(first.totalCompletionTokens).toBe(50);
      expect(first.recentRequests.length).toBe(1);

      // A three-days-old row (shows in recentRequests — period-independent —
      // but excluded from "today" totals) and a second today row, back-to-back.
      // Broken period filtering would make the totals 3 / 1104 / 1056.
      await db.saveRequestUsage({
        provider: "openai", model: "m-old", connectionId: "c1",
        timestamp: new Date(Date.now() - 3 * 86400000).toISOString(),
        tokens: { prompt_tokens: 999, completion_tokens: 999 },
        endpoint: "/v1/chat/completions", status: "ok",
      });
      await db.saveRequestUsage({
        provider: "openai", model: "m-today-2", connectionId: "c1",
        tokens: { prompt_tokens: 5, completion_tokens: 7 },
        endpoint: "/v1/chat/completions", status: "ok",
      });

      // Back-to-back saves may coalesce into one debounced "update" emit (quick
      // + full message) or split into two — tolerate both, never accept totals
      // above the row count actually visible to the period.
      let last = first;
      let read = 0;
      while (last.totalRequests !== 2 && read < 6) {
        last = await readNextData(reader);
        read++;
        expect(last.totalRequests).toBeLessThanOrEqual(2);
      }
      expect(last.totalRequests).toBe(2);
      expect(last.totalPromptTokens).toBe(105);
      expect(last.totalCompletionTokens).toBe(57);
      expect(last.recentRequests.length).toBe(3);
    } finally {
      // Runs the route's cancel(): drops emitter listeners, clears the 25s
      // keepalive interval. Required per opened stream or vitest hangs.
      await reader.cancel();
    }
  }, 10000);

  it("invalid period falls back to all", async () => {
    const res = await route.GET(new Request("http://localhost/api/usage/stream?period=nope"));
    const reader = res.body.getReader();
    try {
      const first = await readNextData(reader);
      // Dynamic comparison keeps this order-independent of test A's rows.
      const allStats = await db.getUsageStats("all");
      expect(first.totalRequests).toBe(allStats.totalRequests);
    } finally {
      await reader.cancel();
    }
  }, 10000);
});
