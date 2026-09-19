/**
 * statusLine payload の正規化。
 *
 * ここにある処理はすべて docs/findings.md の**実測**が根拠になっている。
 * 「念のため」で足したものは無い。
 */

import {
  STALE_AFTER_MS,
  type ContextWindow,
  type Observed,
  type RateLimitWindow,
  type StatusLinePayload,
  type UsageSnapshot,
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

/**
 * レート制限ウィンドウを 1 つ取り込む。**後退する値は採らない。**
 *
 * statusLine は `statusLine.refreshInterval` の秒数ごとに**起動中の全セッションで**走る。
 * その tick では API 応答が無いので、Claude Code はそのセッションが最後に受け取った
 * `rate_limits` をそのまま出し続ける。つまり放置されたセッションは、何時間前の読み値でも
 * 30秒ごとに書き続ける。`latest.json` は最後に書いたセッションが勝つ一枚なので、
 * 2つ以上のセッションが動いていると値が行き来する。
 *
 * 実測 (2026-09-20): セッション A が 30%、別ウィンドウに放置されたセッション B が
 * 当時の 17% を交互に上書きし、メニューバーが 30% → 17% → 30% と往復していた。
 * B の payload は書かれた瞬間なので mtime は新しく、`resets_at` も同じ枠を指す。
 * 鮮度判定 (STALE_AFTER_MS) も期限切れ判定 (describeWindow) もこれを弾けない。
 *
 * 弾けるのは中身の側だけ。`rate_limits` はセッション単位ではなく**アカウント単位**で、
 * 同じ枠 (= 同じ `resets_at`) の中では消費率は減らない。したがって:
 *   - 新しい枠 (resets_at が先) → 採用。枠が変われば消費率は当然下がる。
 *   - 古い枠 (resets_at が前)   → 破棄。放置セッションが前の枠の値を再送している。
 *   - 同じ枠で消費率が下がった  → 破棄。アカウント全体では起きえないので古い読み値。
 *
 * 破棄したときは `observedAt` も据え置く。値を保持したこと自体は正しいが、
 * 「その数字をいつ確認したか」は書き換わっていないため。
 */
function adoptWindow(
  previous: Observed<RateLimitWindow> | null,
  incoming: RateLimitWindow | null,
  now: number,
): Observed<RateLimitWindow> | null {
  // 今回の payload に載っていない = 「消えた」ではなく「今回は載っていない」。
  if (incoming === null) return previous;
  if (previous === null) return { value: incoming, observedAt: now };

  const previousReset = parseResetsAt(previous.value.resets_at)?.getTime() ?? null;
  const incomingReset = parseResetsAt(incoming.resets_at)?.getTime() ?? null;

  // 片方でも `resets_at` が欠けていると枠を突き合わせられない (findings.md §2: 各
  // フィールドは独立して欠損しうる)。判断材料が無い以上、最新の payload を信じる。
  if (previousReset === null || incomingReset === null) {
    return { value: incoming, observedAt: now };
  }

  if (incomingReset > previousReset) return { value: incoming, observedAt: now };
  if (incomingReset < previousReset) return previous;

  // ここから先は同じ枠。消費率の大小がそのまま新旧になる。
  const incomingPercent = incoming.used_percentage;
  if (typeof incomingPercent !== "number") return previous;
  const previousPercent = previous.value.used_percentage;
  if (typeof previousPercent === "number" && incomingPercent < previousPercent) return previous;

  return { value: incoming, observedAt: now };
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

  const fiveHour = adoptWindow(prev.fiveHour, readWindow(limits?.five_hour), now);
  const sevenDay = adoptWindow(prev.sevenDay, readWindow(limits?.seven_day), now);

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

/**
 * 数値を出せないときに代わりに出す説明文。
 *
 * 「—」だけを出すと壊れているように見える。とくに期限切れは
 * 「取得できない」ではなく「前の枠の値だったので捨てた」なので、そう書き分ける。
 *
 * @param fallback 期限切れ以外 (ブリッジ未有効・セッション未起動など) の理由。
 * @param options.short ミニウィンドウ用。幅が無いので前の枠の値と説明を落とす。
 */
export function windowReason(
  view: WindowView,
  fallback: string,
  options: { short?: boolean } = {},
): string {
  if (!view.expired) return fallback;
  if (options.short) return "リセット済み — 次の更新待ち";
  const previous = formatPercent(view.lastKnownPercent);
  const suffix = "Claude Code が次に更新するまで待っています";
  return previous ? `リセット済み（前の枠は ${previous}）— ${suffix}` : `リセット済み — ${suffix}`;
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

/**
 * `resets_at` を過ぎた直後の猶予。
 *
 * リセット時刻を跨いだ瞬間は「まもなくリセット」で正しいが、
 * 何時間も前に過ぎた値をそう出し続けるのは嘘になる。境界をここに一本化する。
 */
export const RESET_GRACE_MS = 60_000;

/** リセットまでの残り時間。指示書 §4 のカウントダウン用。 */
export function formatCountdown(resetsAt: Date | null, now: number): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt.getTime() - now;
  // 過ぎた時刻に対して残り時間は存在しない。「まもなく」は跨いだ直後だけ。
  if (ms <= -RESET_GRACE_MS) return "リセット済み";
  if (ms <= 0) return "まもなくリセット";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}日${hours}時間後`;
  if (hours > 0) return `${hours}時間${mins}分後`;
  return `${mins}分後`;
}

/**
 * リセット予定の**完成した表示文**。呼び出し側で「にリセット」を足さないこと。
 *
 * 以前は各画面が `${formatCountdown(...)}にリセット` と自前で連結していたため、
 * 過去時刻で「まもなくリセットにリセット」という文字列が出ていた。
 * 助詞まで含めてここで組み立て、その手の二重表現を構造的に不可能にする。
 */
export function formatResetHint(
  resetsAt: Date | null,
  now: number,
  options: { withDate?: boolean } = {},
): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt.getTime() - now;
  if (ms <= -RESET_GRACE_MS) return "リセット済み";
  if (ms <= 0) return "まもなくリセット";

  const countdown = formatCountdown(resetsAt, now);
  if (!options.withDate) return `${countdown}にリセット`;
  // 週次枠は数日先なので、残り時間だけでは何日か分からない。日付も添える。
  const label = resetsAt.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${label} にリセット（${countdown}）`;
}

/**
 * 1つのウィンドウについて「今この瞬間、何を表示してよいか」を確定させた形。
 *
 * Tray / パネル / ミニウィンドウ / 通知が個別に鮮度判定を書くと必ずズレるので、
 * 判定はここ 1 箇所に集約する。
 */
export interface WindowView {
  /** **現在の枠の値として表示してよい**消費率。期限切れ・未取得なら null。 */
  percent: number | null;
  /** 期限切れでも保持する生の観測値。「前の枠では 23% でした」の表示用。 */
  lastKnownPercent: number | null;
  resetsAt: Date | null;
  /**
   * `resets_at` を過ぎている = この数字はもう「今の枠」のものではない。
   *
   * マシンを一晩落としてから起動すると、`latest.json` には前日の 5時間枠が残っている。
   * それを現在値として出すのが最も紛らわしいので、期限切れは数値ごと落とす。
   */
  expired: boolean;
  /** STALE_AFTER_MS 以上更新が無い。期限内ではあるが古い。 */
  stale: boolean;
  /** 観測時刻 (ms)。null = 一度も観測していない。 */
  observedAt: number | null;
}

const EMPTY_VIEW: WindowView = {
  percent: null,
  lastKnownPercent: null,
  resetsAt: null,
  expired: false,
  stale: false,
  observedAt: null,
};

/**
 * 観測済みウィンドウを表示用に評価する。
 *
 * `maxAgeMs` は `resets_at` が欠落していたときのフォールバック
 * (findings.md §2: 各フィールドは独立して欠損しうる)。ウィンドウ長を渡しておけば、
 * リセット時刻が分からなくても「もう別の枠の話」と判定できる。
 */
export function describeWindow(
  observed: Observed<RateLimitWindow> | null | undefined,
  now: number,
  options: { maxAgeMs?: number } = {},
): WindowView {
  if (!observed) return EMPTY_VIEW;

  const resetsAt = parseResetsAt(observed.value.resets_at);
  const age = now - observed.observedAt;
  const expired =
    resetsAt !== null
      ? resetsAt.getTime() <= now
      : options.maxAgeMs !== undefined && age > options.maxAgeMs;

  const raw = observed.value.used_percentage;
  const known = typeof raw === "number" && Number.isFinite(raw) ? raw : null;

  return {
    percent: expired ? null : known,
    lastKnownPercent: known,
    resetsAt,
    expired,
    stale: age > STALE_AFTER_MS,
    observedAt: observed.observedAt,
  };
}
