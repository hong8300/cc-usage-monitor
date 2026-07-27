/**
 * ローカル JSONL 集計 (指示書 §3-B) の型。
 *
 * この系統の値は**すべて推定**であり、公式の枠消費率 (statusLine 由来) とは別物。
 * UI では必ず「推定」バッジを付けて A 由来の値と視覚的に区別する。
 */

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  /** cache_creation.ephemeral_5m_input_tokens (単価 = 入力の 1.25x) */
  cacheWrite5mTokens: number;
  /** cache_creation.ephemeral_1h_input_tokens (単価 = 入力の 2.0x) */
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  /**
   * `cache_creation` の内訳が無く 5m/1h を切り分けられなかった書き込み。
   * findings.md §3-1 の実測ではこの機体の全行に内訳があったが、
   * 古いログや将来の形式変更に備えて分けて数える。単価は 5m 相当で見積もる。
   */
  cacheWriteUnsplitTokens: number;
  /** 集計に使った (重複排除後の) アシスタントメッセージ数 */
  messages: number;
}

export interface ModelUsage {
  /** 正規化後のモデル ID */
  model: string;
  displayName: string | null;
  totals: TokenTotals;
  /** 価格表に無いモデルは null。0 円として黙って捨てない。 */
  costUsd: number | null;
  /** 価格表に載っていないモデルか */
  unknownPricing: boolean;
}

export interface DailyUsage {
  /** ローカル日付 YYYY-MM-DD */
  date: string;
  totals: TokenTotals;
  costUsd: number;
  /** 価格不明のモデルが混ざっているか (金額が過小評価になる) */
  hasUnknownPricing: boolean;
}

export interface UsageRollup {
  totals: TokenTotals;
  costUsd: number;
  hasUnknownPricing: boolean;
  byModel: ModelUsage[];
}

export interface LocalUsageReport {
  /** 集計が完了した時刻 (ms) */
  computedAt: number;
  /** 走査したファイル数と行数 (デバッグ・信頼性の目安) */
  scanned: { files: number; lines: number; skipped: number; deduped: number };
  /** 実際に読めた探索ルート */
  roots: string[];
  today: UsageRollup;
  /** 直近 7 日 (ローリング)。seven_day 枠と揃えるため暦週ではなくローリング。 */
  last7Days: UsageRollup;
  /** 履歴グラフ用。古い順。 */
  daily: DailyUsage[];
  /** 価格表に無かったモデル ID (UI に出して価格表の更新漏れを検知できるようにする) */
  unknownModels: string[];
  pricing: { lastUpdated: string; sources: string[]; overridePath: string | null };
  /** 集計中に起きた回復可能なエラー (壊れた行など) */
  warnings: string[];
}

export function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    cacheWriteUnsplitTokens: 0,
    messages: 0,
  };
}

export function addTotals(target: TokenTotals, source: TokenTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheWrite5mTokens += source.cacheWrite5mTokens;
  target.cacheWrite1hTokens += source.cacheWrite1hTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteUnsplitTokens += source.cacheWriteUnsplitTokens;
  target.messages += source.messages;
}

/** 表示用の合計トークン。キャッシュ読み書きも実際に課金対象なので全部足す。 */
export function sumTokens(totals: TokenTotals): number {
  return (
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheWrite5mTokens +
    totals.cacheWrite1hTokens +
    totals.cacheReadTokens +
    totals.cacheWriteUnsplitTokens
  );
}
