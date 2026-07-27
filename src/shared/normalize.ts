/**
 * statusLine payload の正規化。
 *
 * ここにある処理はすべて docs/findings.md の**実測**が根拠になっている。
 * 「念のため」で足したものは無い。
 */

import type {
  ContextWindow,
  Observed,
  RateLimitWindow,
  StatusLinePayload,
  UsageSnapshot,
} from "./types.ts";

/**
 * 表示用にパーセントを丸める。
 *
 * findings.md §2-3(1): 実測で `used_percentage: 14.000000000000002` が出た。
 * 生値をそのまま描画すると Tray に `5h 14.000000000000002%` と出てしまう。
 * 内部では生値を保持し、描画時にだけこれを通す。
 */
export function formatPercent(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.round(clampPercent(value))}%`;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * `resets_at` を Date に変換する。
 *
 * findings.md §2-3: 実測値 `1785208200` を実時刻と突き合わせ、**Unix 秒**で確定済み。
 * ただし将来 ISO8601 文字列に変わる可能性が残るため、文字列も受け付ける
 * (findings.md §6 の未確認項目に対するフォールバック)。
 */
export function parseResetsAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // 10桁 ≒ 秒、13桁 ≒ ミリ秒。秒として解釈した結果が 1970 年台なら
    // ミリ秒だったと判断する。境界は 2001-09-09 (1e9 秒 / 1e12 ms)。
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * モデル ID を価格表照合用に正規化する。
 *
 * findings.md §2-3(2) / §3-4 の実測:
 *   - statusLine: `claude-opus-5[1m]`  ← 角括弧サフィックスが付く
 *   - JSONL     : `claude-opus-5`      ← 素の ID
 *   - 旧モデル  : `claude-3-5-sonnet-20241022` ← 日付サフィックス付き
 *
 * 呼び出し側は「正規化後の ID で完全一致 → 外れたら stripDateSuffix でもう一度」
 * という順で価格表を引く。ここでは日付除去まではやらない
 * (現行モデルの `-4-8` のような版数を日付と誤認して壊すのを避けるため)。
 */
export function normalizeModelId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // `claude-opus-5[1m]` → `claude-opus-5`
  const withoutBrackets = raw.replace(/\[[^\]]*\]/g, "");
  const trimmed = withoutBrackets.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 末尾の 8 桁日付サフィックスだけを落とす。
 *
 * `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`
 * `claude-opus-4-8`            → 変化なし (版数を日付と誤認しない)
 */
export function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** number 以外 (null/undefined/文字列/NaN) を弾いて number だけ通す。 */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 生 JSON から RateLimitWindow を取り出す。
 * 片方のウィンドウだけ来る状態は正規なので、欠損は null で返して呼び出し側に判断させる。
 */
export function readWindow(v: unknown): RateLimitWindow | null {
  if (!isRecord(v)) return null;
  const used = num(v.used_percentage);
  const resets = v.resets_at;
  if (used === undefined && resets === undefined) return null;
  const out: RateLimitWindow = {};
  if (used !== undefined) out.used_percentage = used;
  if (typeof resets === "number" || typeof resets === "string") {
    out.resets_at = typeof resets === "number" ? resets : Date.parse(resets) / 1000;
  }
  return out;
}

function observe<T>(value: T | null, at: number): Observed<T> | null {
  return value === null ? null : { value, observedAt: at };
}

/**
 * 新しい payload を直前のスナップショットにマージする。
 *
 * **欠損は「消えた」ではなく「今回は載っていない」として扱い、前回値を残す。**
 * findings.md §2-3(3) で `workspace.repo` が 14 サンプル中 4 回しか出ず、
 * 出たり消えたりすることを実測したため。素直に上書きすると UI がチラつく。
 *
 * 鮮度は `observedAt` に残るので、古い値は呼び出し側でグレーアウトできる。
 */
export function mergeSnapshot(
  previous: UsageSnapshot | null,
  payload: StatusLinePayload,
  now: number,
): UsageSnapshot {
  const prev = previous ?? emptySnapshot();
  const limits = isRecord(payload.rate_limits) ? payload.rate_limits : undefined;

  const fiveHour = observe(readWindow(limits?.five_hour), now) ?? prev.fiveHour;
  const sevenDay = observe(readWindow(limits?.seven_day), now) ?? prev.sevenDay;

  const rawModelId = payload.model?.id ?? null;
  const model = payload.model
    ? {
        value: {
          id: payload.model.id,
          displayName: payload.model.display_name,
          normalizedId: normalizeModelId(rawModelId) ?? undefined,
        },
        observedAt: now,
      }
    : prev.model;

  const contextWindow: UsageSnapshot["contextWindow"] = isRecord(payload.context_window)
    ? { value: payload.context_window as ContextWindow, observedAt: now }
    : prev.contextWindow;

  const sessionCost = isRecord(payload.cost)
    ? { value: payload.cost, observedAt: now }
    : prev.sessionCost;

  return {
    lastPayloadAt: now,
    fiveHour,
    sevenDay,
    model,
    contextWindow,
    sessionCost,
    sessionId: payload.session_id ?? prev.sessionId,
    claudeCodeVersion: payload.version ?? prev.claudeCodeVersion,
    raw: payload,
  };
}

export function emptySnapshot(): UsageSnapshot {
  return {
    lastPayloadAt: null,
    fiveHour: null,
    sevenDay: null,
    model: null,
    contextWindow: null,
    sessionCost: null,
    sessionId: null,
    claudeCodeVersion: null,
    raw: null,
  };
}

/** 指示書 §4: 〜50% 緑 / 〜80% 橙 / 80%〜 赤 */
export type Severity = "ok" | "warn" | "critical";

export function severityFor(percent: number | null | undefined): Severity | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const p = clampPercent(percent);
  if (p >= 80) return "critical";
  if (p > 50) return "warn";
  return "ok";
}

/** 2つのウィンドウのうち厳しい方の色を採用する。 */
export function worstSeverity(...values: Array<number | null | undefined>): Severity | null {
  const order: Severity[] = ["ok", "warn", "critical"];
  let worst: Severity | null = null;
  for (const v of values) {
    const s = severityFor(v);
    if (s && (worst === null || order.indexOf(s) > order.indexOf(worst))) worst = s;
  }
  return worst;
}

/** 「3分前」のような相対時刻。指示書 §4 の鮮度表示用。 */
export function formatAge(observedAt: number | null, now: number): string | null {
  if (observedAt === null) return null;
  const seconds = Math.max(0, Math.floor((now - observedAt) / 1000));
  if (seconds < 10) return "たった今";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

/** リセットまでの残り時間。指示書 §4 のカウントダウン用。 */
export function formatCountdown(resetsAt: Date | null, now: number): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt.getTime() - now;
  if (ms <= 0) return "まもなくリセット";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}日${hours}時間後`;
  if (hours > 0) return `${hours}時間${mins}分後`;
  return `${mins}分後`;
}
