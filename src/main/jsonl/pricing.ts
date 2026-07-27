/**
 * 価格表の読み込みと単価解決。
 *
 * 指示書 §3-B: 価格表はハードコードせず `src/pricing.json` に分離し、
 * 最終更新日と出典 URL をファイル内に持たせる。
 *
 * さらに `~/.cc-usage-monitor/pricing.json` を置けばそちらが優先される。
 * Anthropic が価格を変えたときに再ビルドせず直せるようにするため。
 */

import fs from "node:fs";
import path from "node:path";
import builtinPricing from "../../pricing.json" with { type: "json" };
import { normalizeModelId, stripDateSuffix } from "../../shared/normalize.ts";
import { APP_DIR } from "../paths.ts";

export interface Rate {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

interface ModelEntry extends Partial<Rate> {
  displayName?: string;
  fast?: { input: number; output: number };
  periods?: Array<Partial<Rate> & { until?: string; note?: string }>;
}

interface PricingTable {
  lastUpdated: string;
  sources: string[];
  modifiers: {
    batch: { multiplier: number };
    inferenceGeoUs: { multiplier: number };
  };
  cacheMultipliers: { write5m: number; write1h: number; read: number };
  aliases: Record<string, string>;
  models: Record<string, ModelEntry>;
}

const OVERRIDE_PATH = path.join(APP_DIR, "pricing.json");

let cached: { table: PricingTable; overridePath: string | null } | null = null;

/** ユーザー上書きがあればそれを、無ければ内蔵表を使う。 */
export function loadPricing(): { table: PricingTable; overridePath: string | null } {
  if (cached) return cached;

  let table = builtinPricing as unknown as PricingTable;
  let overridePath: string | null = null;

  try {
    if (fs.existsSync(OVERRIDE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf8")) as PricingTable;
      // 最低限の妥当性検査。壊れた上書きで全モデルが「価格不明」になるのを防ぐ。
      if (parsed && typeof parsed === "object" && parsed.models && parsed.modifiers) {
        table = parsed;
        overridePath = OVERRIDE_PATH;
      }
    }
  } catch {
    // 壊れていたら内蔵表にフォールバックする。
  }

  cached = { table, overridePath };
  return cached;
}

/** テスト用。 */
export function resetPricingCache(): void {
  cached = null;
}

/**
 * モデル ID を価格表のキーに解決する。
 *
 * findings.md §2-3(2) / §3-4 の実測に基づく順序:
 *   1. 角括弧サフィックス除去 (`claude-opus-5[1m]` → `claude-opus-5`)
 *   2. 完全一致
 *   3. エイリアス
 *   4. 日付サフィックス除去 (`claude-3-5-haiku-20241022` → `claude-3-5-haiku`) → 再度 2/3
 *
 * 現行モデルの版数 (`-4-8`) を日付と誤認しないよう、日付除去は最後に置く。
 */
export function resolveModelKey(rawModelId: string): string | null {
  const { table } = loadPricing();
  const normalized = normalizeModelId(rawModelId);
  if (!normalized) return null;

  const tryKey = (key: string): string | null => {
    if (Object.hasOwn(table.models, key)) return key;
    const aliased = table.aliases[key];
    if (aliased && Object.hasOwn(table.models, aliased)) return aliased;
    return null;
  };

  return tryKey(normalized) ?? tryKey(stripDateSuffix(normalized));
}

export function displayNameFor(rawModelId: string): string | null {
  const key = resolveModelKey(rawModelId);
  if (!key) return null;
  const { table } = loadPricing();
  return table.models[key]?.displayName ?? key;
}

function pickPeriod(entry: ModelEntry, at: Date): Partial<Rate> {
  if (!entry.periods || entry.periods.length === 0) return entry;
  // `until` は排他的上限。最初にマッチした期間を採る。
  for (const period of entry.periods) {
    if (!period.until) return period;
    if (at.getTime() < Date.parse(period.until)) return period;
  }
  return entry.periods[entry.periods.length - 1] ?? entry;
}

function isCompleteRate(rate: Partial<Rate>): rate is Rate {
  return (
    typeof rate.input === "number" &&
    typeof rate.output === "number" &&
    typeof rate.cacheWrite5m === "number" &&
    typeof rate.cacheWrite1h === "number" &&
    typeof rate.cacheRead === "number"
  );
}

export interface RateContext {
  /** レコードのタイムスタンプ。期間制の価格 (Sonnet 5 の導入価格など) の解決に使う。 */
  at: Date;
  /** `message.usage.speed === "fast"` */
  fast: boolean;
}

/**
 * そのレコードに適用すべき単価を返す。価格表に無ければ null。
 *
 * 未知のモデルを 0 円として黙って捨てないこと。呼び出し側で「価格不明」として
 * UI に出し、価格表の更新漏れを検知できるようにする。
 */
export function rateFor(rawModelId: string, context: RateContext): Rate | null {
  const key = resolveModelKey(rawModelId);
  if (!key) return null;

  const { table } = loadPricing();
  const entry = table.models[key];
  if (!entry) return null;

  const picked = pickPeriod(entry, context.at);
  if (!isCompleteRate(picked)) return null;

  // periods の要素には `until` や `note` も入っているので、そのまま返さず
  // 単価だけの素の Rate に詰め直す。
  const base: Rate = {
    input: picked.input,
    output: picked.output,
    cacheWrite5m: picked.cacheWrite5m,
    cacheWrite1h: picked.cacheWrite1h,
    cacheRead: picked.cacheRead,
  };

  if (!context.fast || !entry.fast) return base;

  // fast mode は入出力の単価が置き換わり、キャッシュ倍率はその上に乗る。
  // (pricing docs: "Prompt caching multipliers apply on top of fast mode pricing")
  const m = table.cacheMultipliers;
  return {
    input: entry.fast.input,
    output: entry.fast.output,
    cacheWrite5m: entry.fast.input * m.write5m,
    cacheWrite1h: entry.fast.input * m.write1h,
    cacheRead: entry.fast.input * m.read,
  };
}

export function modifiersFor(options: { batch: boolean; inferenceGeoUs: boolean }): number {
  const { table } = loadPricing();
  let multiplier = 1;
  if (options.batch) multiplier *= table.modifiers.batch.multiplier;
  if (options.inferenceGeoUs) multiplier *= table.modifiers.inferenceGeoUs.multiplier;
  return multiplier;
}

export function pricingMeta(): { lastUpdated: string; sources: string[]; overridePath: string | null } {
  const { table, overridePath } = loadPricing();
  return { lastUpdated: table.lastUpdated, sources: table.sources, overridePath };
}

/** `cache_creation` の内訳が無い行のフォールバック倍率 (5m 相当で見積もる)。 */
export function unsplitCacheWriteRate(rate: Rate): number {
  return rate.cacheWrite5m;
}
