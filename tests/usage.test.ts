/**
 * ローカル JSONL 集計とコスト計算のテスト。
 *
 * 金額の計算は間違っても例外が出ないので、実測に基づく期待値で固定しておく。
 * 単価は src/pricing.json (出典: platform.claude.com の pricing ページ) 由来。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

let home: string;
let projects: string;
let agg: typeof import("../src/main/jsonl/aggregator.ts");
let pricing: typeof import("../src/main/jsonl/pricing.ts");

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-usage-agg-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  projects = path.join(home, ".claude", "projects", "proj-a");
  fs.mkdirSync(projects, { recursive: true });
  agg = await import("../src/main/jsonl/aggregator.ts");
  pricing = await import("../src/main/jsonl/pricing.ts");
});

// 集計は projects 配下を全部舐めるので、テスト間でログを持ち越さないよう毎回空にする。
beforeEach(() => {
  fs.rmSync(projects, { recursive: true, force: true });
  fs.mkdirSync(projects, { recursive: true });
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** assistant 行を 1 本作る。 */
function assistantLine(options: {
  id: string;
  requestId: string;
  model: string;
  timestamp: string;
  input?: number;
  output?: number;
  write5m?: number;
  write1h?: number;
  read?: number;
  /** cache_creation を付けない (内訳不明のケース) */
  noSplit?: boolean;
  serviceTier?: string;
  inferenceGeo?: string;
  speed?: string;
  extra?: Record<string, unknown>;
}): string {
  const write5m = options.write5m ?? 0;
  const write1h = options.write1h ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: options.input ?? 0,
    output_tokens: options.output ?? 0,
    cache_creation_input_tokens: write5m + write1h,
    cache_read_input_tokens: options.read ?? 0,
  };
  if (!options.noSplit) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: write5m,
      ephemeral_1h_input_tokens: write1h,
    };
  }
  if (options.serviceTier) usage.service_tier = options.serviceTier;
  if (options.inferenceGeo) usage.inference_geo = options.inferenceGeo;
  if (options.speed) usage.speed = options.speed;

  return JSON.stringify({
    type: "assistant",
    uuid: `${options.id}-uuid`,
    requestId: options.requestId,
    timestamp: options.timestamp,
    ...options.extra,
    message: { id: options.id, model: options.model, role: "assistant", usage },
  });
}

function writeTranscript(name: string, lines: string[]): string {
  const file = path.join(projects, name);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function freshAggregator() {
  const a = new agg.TranscriptAggregator();
  a.scan();
  return a;
}

test("findings §3-1: キャッシュ書込は 5m/1h で単価が違う", () => {
  // Opus 5: input $5 → 5m write $6.25 / 1h write $10 / read $0.50 / output $25
  writeTranscript("cache.jsonl", [
    assistantLine({
      id: "m1",
      requestId: "r1",
      model: "claude-opus-5",
      timestamp: "2026-07-28T01:00:00.000Z",
      input: 1_000_000,
      output: 1_000_000,
      write5m: 1_000_000,
      write1h: 1_000_000,
      read: 1_000_000,
    }),
  ]);

  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));
  const day = report.daily.find((d) => d.date === "2026-07-28");
  assert.ok(day, "日次バケットが無い");
  // 5 + 25 + 6.25 + 10 + 0.5 = 46.75
  assert.equal(Number(day.costUsd.toFixed(4)), 46.75);
});

test("5m/1h を分離せず一律 1.25x にすると過小評価になる（分離の必要性）", () => {
  // 1h 書き込みだけのケース。分離しないと 10 ではなく 6.25 で計算してしまう。
  writeTranscript("cache1h.jsonl", [
    assistantLine({
      id: "m2",
      requestId: "r2",
      model: "claude-opus-5",
      timestamp: "2026-07-28T02:00:00.000Z",
      write1h: 1_000_000,
    }),
  ]);
  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));
  const day = report.daily.find((d) => d.date === "2026-07-28");
  assert.equal(Number(day!.costUsd.toFixed(4)), 10.0, "1h 書込は 2.0x 単価であるべき");
});

test("cache_creation の内訳が無い行は 5m 相当で見積もり、別枠で数える", () => {
  writeTranscript("nosplit.jsonl", [
    assistantLine({
      id: "m3",
      requestId: "r3",
      model: "claude-opus-5",
      timestamp: "2026-07-28T03:00:00.000Z",
      write5m: 1_000_000,
      noSplit: true,
    }),
  ]);
  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));
  const day = report.daily.find((d) => d.date === "2026-07-28")!;
  assert.equal(day.totals.cacheWriteUnsplitTokens, 1_000_000);
  assert.equal(day.totals.cacheWrite5mTokens, 0);
  assert.equal(Number(day.costUsd.toFixed(4)), 6.25);
});

test("findings §3-2: message.id + requestId で重複排除する", () => {
  const dup = assistantLine({
    id: "same",
    requestId: "same-req",
    model: "claude-opus-5",
    timestamp: "2026-07-28T04:00:00.000Z",
    output: 1_000_000,
  });
  // 同じ行が 3 回、さらに別ファイルにも 1 回。
  writeTranscript("dup1.jsonl", [dup, dup, dup]);
  writeTranscript("dup2.jsonl", [dup]);

  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));
  const day = report.daily.find((d) => d.date === "2026-07-28")!;
  assert.equal(day.totals.messages, 1, "重複が畳まれていない");
  assert.equal(Number(day.costUsd.toFixed(4)), 25.0);
  assert.equal(report.scanned.deduped, 3);
});

test("findings §3-3: synthetic / APIエラー / requestId 欠損は除外する", () => {
  writeTranscript("excluded.jsonl", [
    assistantLine({
      id: "s1",
      requestId: "rs1",
      model: "<synthetic>",
      timestamp: "2026-07-28T05:00:00.000Z",
      output: 1_000_000,
    }),
    assistantLine({
      id: "e1",
      requestId: "re1",
      model: "claude-opus-5",
      timestamp: "2026-07-28T05:00:00.000Z",
      output: 1_000_000,
      extra: { isApiErrorMessage: true },
    }),
    // requestId 欠損
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-28T05:00:00.000Z",
      message: { id: "n1", model: "claude-opus-5", usage: { output_tokens: 1_000_000 } },
    }),
    // user 行は対象外
    JSON.stringify({ type: "user", timestamp: "2026-07-28T05:00:00.000Z" }),
  ]);

  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));
  const day = report.daily.find((d) => d.date === "2026-07-28");
  assert.equal(day, undefined, "除外すべき行が集計された");
});

test("findings §2-3(2)/§3-4: モデル ID の正規化と価格表照合", () => {
  assert.equal(pricing.resolveModelKey("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(pricing.resolveModelKey("claude-opus-4-8"), "claude-opus-4-8");
  // 日付サフィックス付きの旧モデル
  assert.equal(pricing.resolveModelKey("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(pricing.resolveModelKey("claude-3-5-haiku-20241022"), "claude-haiku-3-5");
  // エイリアス
  assert.equal(pricing.resolveModelKey("claude-sonnet-4-20250514"), "claude-sonnet-4-0");
  // 未知
  assert.equal(pricing.resolveModelKey("claude-does-not-exist"), null);
});

test("Sonnet 5 は日付で単価が変わる（2026-09-01 に導入価格が終了）", () => {
  const intro = pricing.rateFor("claude-sonnet-5", {
    at: new Date("2026-08-31T00:00:00Z"),
    fast: false,
  });
  assert.deepEqual(intro, {
    input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2,
  });

  const standard = pricing.rateFor("claude-sonnet-5", {
    at: new Date("2026-09-01T00:00:00Z"),
    fast: false,
  });
  assert.deepEqual(standard, {
    input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3,
  });
});

test("fast mode は単価が別で、キャッシュ倍率はその上に乗る", () => {
  const fast = pricing.rateFor("claude-opus-5", { at: new Date(), fast: true });
  assert.equal(fast?.input, 10);
  assert.equal(fast?.output, 50);
  assert.equal(fast?.cacheWrite5m, 12.5); // 10 * 1.25
  assert.equal(fast?.cacheWrite1h, 20); //  10 * 2.0
  assert.equal(fast?.cacheRead, 1); //     10 * 0.1

  // fast 非対応モデルは標準単価のまま
  const notFast = pricing.rateFor("claude-opus-4-7", { at: new Date(), fast: true });
  assert.equal(notFast?.input, 5);
});

test("batch は 50% 引き、inference_geo:us は 1.1x", () => {
  writeTranscript("modifiers.jsonl", [
    assistantLine({
      id: "b1", requestId: "rb1", model: "claude-opus-5",
      timestamp: "2026-07-28T06:00:00.000Z", output: 1_000_000, serviceTier: "batch",
    }),
    assistantLine({
      id: "g1", requestId: "rg1", model: "claude-opus-5",
      timestamp: "2026-07-28T06:00:00.000Z", output: 1_000_000, inferenceGeo: "us",
    }),
    assistantLine({
      id: "n2", requestId: "rn2", model: "claude-opus-5",
      timestamp: "2026-07-28T06:00:00.000Z", output: 1_000_000, inferenceGeo: "not_available",
    }),
  ]);
  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));
  const day = report.daily.find((d) => d.date === "2026-07-28")!;
  // 12.5 (batch) + 27.5 (us) + 25 (等倍) = 65
  assert.equal(Number(day.costUsd.toFixed(4)), 65.0);
});

test("価格表に無いモデルは 0 円にせず「価格不明」として表に出す", () => {
  writeTranscript("unknown.jsonl", [
    assistantLine({
      id: "u1", requestId: "ru1", model: "claude-future-9",
      timestamp: "2026-07-28T07:00:00.000Z", output: 1_000_000,
    }),
  ]);
  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));

  assert.deepEqual(report.unknownModels, ["claude-future-9"]);
  assert.equal(report.today.hasUnknownPricing, true);
  const entry = report.today.byModel.find((m) => m.model === "claude-future-9");
  assert.ok(entry, "未知モデルが内訳に出ていない");
  assert.equal(entry.costUsd, null);
  // トークン自体は数えている
  assert.equal(entry.totals.outputTokens, 1_000_000);
});

test("追記分だけ読み、再スキャンで二重計上しない", () => {
  const file = writeTranscript("incremental.jsonl", [
    assistantLine({
      id: "i1", requestId: "ri1", model: "claude-opus-5",
      timestamp: "2026-07-28T08:00:00.000Z", output: 1_000_000,
    }),
  ]);

  const a = new agg.TranscriptAggregator();
  a.scan();
  const first = a.report(new Date("2026-07-28T12:00:00+09:00"));
  const firstLines = first.scanned.lines;
  const firstCost = first.daily.find((d) => d.date === "2026-07-28")!.costUsd;

  // 何も変えずに再スキャン
  a.scan();
  const same = a.report(new Date("2026-07-28T12:00:00+09:00"));
  assert.equal(same.scanned.lines, firstLines, "変更が無いのに読み直している");
  assert.equal(same.daily.find((d) => d.date === "2026-07-28")!.costUsd, firstCost);

  // 1 行追記 → 差分だけ読む
  fs.appendFileSync(
    file,
    `${assistantLine({
      id: "i2", requestId: "ri2", model: "claude-opus-5",
      timestamp: "2026-07-28T08:30:00.000Z", output: 1_000_000,
    })}\n`,
  );
  a.scan();
  const grown = a.report(new Date("2026-07-28T12:00:00+09:00"));
  assert.equal(grown.scanned.lines, firstLines + 1, "追記 1 行だけを読んでいない");
  assert.equal(
    Number(grown.daily.find((d) => d.date === "2026-07-28")!.costUsd.toFixed(4)),
    Number((firstCost + 25).toFixed(4)),
  );
});

test("改行の途中で読んでも行が壊れない（書きかけ行の持ち越し）", () => {
  const file = path.join(projects, "partial.jsonl");
  const line = assistantLine({
    id: "p1", requestId: "rp1", model: "claude-opus-5",
    timestamp: "2026-07-28T09:00:00.000Z", output: 1_000_000,
  });
  // 行の途中まで書いた状態
  fs.writeFileSync(file, line.slice(0, 40));

  const a = new agg.TranscriptAggregator();
  a.scan();
  const partial = a.report(new Date("2026-07-28T12:00:00+09:00"));
  const before = partial.daily.find((d) => d.date === "2026-07-28")?.costUsd ?? 0;

  // 残りを書き足す
  fs.appendFileSync(file, `${line.slice(40)}\n`);
  a.scan();
  const complete = a.report(new Date("2026-07-28T12:00:00+09:00"));
  const after = complete.daily.find((d) => d.date === "2026-07-28")!.costUsd;

  assert.equal(Number((after - before).toFixed(4)), 25.0, "分割して届いた行が集計できていない");
});

test("直近7日はローリング窓（seven_day 枠に合わせる）", () => {
  writeTranscript("window.jsonl", [
    // 窓内 (2 日前)
    assistantLine({
      id: "w1", requestId: "rw1", model: "claude-opus-5",
      timestamp: "2026-07-26T03:00:00.000Z", output: 1_000_000,
    }),
    // 窓外 (10 日前)
    assistantLine({
      id: "w2", requestId: "rw2", model: "claude-opus-5",
      timestamp: "2026-07-18T03:00:00.000Z", output: 1_000_000,
    }),
  ]);

  const report = freshAggregator().report(new Date("2026-07-28T12:00:00+09:00"));
  assert.equal(Number(report.last7Days.costUsd.toFixed(4)), 25.0, "窓外の日が混ざっている");
  assert.equal(report.daily.length, 2, "日次履歴には窓外も残るべき");
});

test("価格表のメタ情報（最終更新日・出典）が読める", () => {
  const meta = pricing.pricingMeta();
  assert.match(meta.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(meta.sources.length > 0, "出典 URL が無い");
  assert.ok(meta.sources.every((s) => s.startsWith("https://")));
});
