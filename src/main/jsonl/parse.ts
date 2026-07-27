/**
 * JSONL の 1 行を集計対象レコードに変換する。
 *
 * 何を採り、何を捨てるかはすべて docs/findings.md §3 の実測が根拠。
 * Claude Code のログは**読むだけ**で、書き換え・削除は一切しない (指示書 §6)。
 */

import { emptyTotals, type TokenTotals } from "../../shared/usage-types.ts";

export interface UsageRecord {
  /** 重複排除キー。findings.md §3-2 で `message.id` + `requestId` の妥当性を実証済み。 */
  key: string;
  timestamp: Date;
  /** 生のモデル ID。正規化は価格解決側で行う。 */
  model: string;
  totals: TokenTotals;
  /** Batch API 経由 (50% 引き)。Claude Code では通常出ない。 */
  batch: boolean;
  /** inference_geo: "us" は 1.1x。"global"/"not_available" は等倍。 */
  inferenceGeoUs: boolean;
  /** fast mode は単価が別 (Opus 5 / 4.8 で $10/$50)。 */
  fast: boolean;
}

export interface ParseOutcome {
  record: UsageRecord | null;
  /** 集計対象外だった理由。null なら対象。 */
  skipped: "not-assistant" | "no-usage" | "no-request-id" | "synthetic" | "api-error" | "bad-json" | "bad-timestamp" | null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseLine(line: string): ParseOutcome {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { record: null, skipped: "bad-json" };
  }

  if (row.type !== "assistant") return { record: null, skipped: "not-assistant" };

  const message = row.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return { record: null, skipped: "no-usage" };

  // findings.md §3-3: 除外すべき 3 条件。実測ではいずれも同じ 2 行を指していたが、
  // 独立した条件として全部見る。
  if (row.isApiErrorMessage === true) return { record: null, skipped: "api-error" };
  if (message?.model === "<synthetic>") return { record: null, skipped: "synthetic" };

  const requestId = typeof row.requestId === "string" ? row.requestId : null;
  if (!requestId) return { record: null, skipped: "no-request-id" };

  const timestamp = typeof row.timestamp === "string" ? new Date(row.timestamp) : null;
  if (!timestamp || Number.isNaN(timestamp.getTime())) {
    return { record: null, skipped: "bad-timestamp" };
  }

  const model = typeof message?.model === "string" ? message.model : "";
  const messageId = typeof message?.id === "string" ? message.id : "";

  // findings.md §3-1: cache_creation の 5m/1h 内訳が存在する。
  // 内訳を無視して cache_creation_input_tokens を単価 1.25x で計算すると、
  // 全量 1h キャッシュのこの機体では書き込みコストを 37.5% 過小評価する。
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
  const write5m = num(cacheCreation?.ephemeral_5m_input_tokens);
  const write1h = num(cacheCreation?.ephemeral_1h_input_tokens);
  const writeTotal = num(usage.cache_creation_input_tokens);
  // 内訳の合計が総量に満たない分は「切り分け不能」として別に数える。
  const unsplit = Math.max(0, writeTotal - write5m - write1h);

  const totals: TokenTotals = {
    ...emptyTotals(),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    cacheWriteUnsplitTokens: unsplit,
    cacheReadTokens: num(usage.cache_read_input_tokens),
    messages: 1,
  };

  return {
    record: {
      key: `${messageId}|${requestId}`,
      timestamp,
      model,
      totals,
      batch: usage.service_tier === "batch",
      inferenceGeoUs: usage.inference_geo === "us",
      fast: usage.speed === "fast",
    },
    skipped: null,
  };
}
