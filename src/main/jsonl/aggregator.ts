/**
 * `~/.claude/projects/**\/*.jsonl` を走査してトークン量とコスト推定を出す。
 *
 * 設計方針:
 *   - **読み取り専用。** Claude Code のログには一切書かない (指示書 §6)。
 *   - **増分読み。** 監視アプリなので常駐する。毎回全ファイルを読み直すと
 *     ログが育つほど重くなるため、ファイルごとにバイトオフセットを覚えて
 *     追記分だけ読む。
 *   - **重複排除は横断。** 同じ message.id+requestId が別ファイルに現れても 1 回だけ数える。
 */

import fs from "node:fs";
import path from "node:path";
import {
  addTotals,
  emptyTotals,
  type DailyUsage,
  type LocalUsageReport,
  type ModelUsage,
  type TokenTotals,
  type UsageRollup,
} from "../../shared/usage-types.ts";
import { transcriptRoots } from "../paths.ts";
import { parseLine, type UsageRecord } from "./parse.ts";
import {
  displayNameFor,
  modifiersFor,
  pricingMeta,
  rateFor,
  resolveModelKey,
  unsplitCacheWriteRate,
} from "./pricing.ts";

/** ローカル日付 (YYYY-MM-DD)。UTC ではなく利用者のローカル日で区切る。 */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface Bucket {
  totals: TokenTotals;
  costUsd: number;
  unknownPricing: boolean;
}

function newBucket(): Bucket {
  return { totals: emptyTotals(), costUsd: 0, unknownPricing: false };
}

interface FileCursor {
  offset: number;
  /** 末尾が改行で終わっていない場合の書きかけ行。次回の先頭に繋ぐ。 */
  remainder: string;
}

export class TranscriptAggregator {
  /** date -> model -> Bucket */
  private readonly buckets = new Map<string, Map<string, Bucket>>();
  private readonly seen = new Set<string>();
  private readonly cursors = new Map<string, FileCursor>();
  private readonly unknownModels = new Set<string>();
  private readonly warnings: string[] = [];
  private stats = { files: 0, lines: 0, skipped: 0, deduped: 0 };

  /** 走査してバケットを更新する。増分のみ読む。 */
  scan(): void {
    const roots = this.existingRoots();
    const files = roots.flatMap((root) => this.findJsonl(root));
    this.stats.files = files.length;

    for (const file of files) {
      try {
        this.ingestFile(file);
      } catch (err) {
        this.warnings.push(`${path.basename(file)}: ${(err as Error).message}`);
      }
    }
  }

  private existingRoots(): string[] {
    return transcriptRoots().filter((root) => {
      try {
        return fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private findJsonl(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return; // プロジェクトディレクトリ配下しか無いので十分
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
      }
    };
    walk(root, 0);
    return out;
  }

  /** 追記分だけ読む。ファイルが縮んでいたら作り直されたとみなして頭から読む。 */
  private ingestFile(file: string): void {
    const cursor = this.cursors.get(file) ?? { offset: 0, remainder: "" };
    const size = fs.statSync(file).size;

    if (size < cursor.offset) {
      cursor.offset = 0;
      cursor.remainder = "";
    }
    if (size === cursor.offset) return;

    const length = size - cursor.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, cursor.offset);
    } finally {
      fs.closeSync(fd);
    }

    const text = cursor.remainder + buffer.toString("utf8");
    const lines = text.split("\n");
    // 末尾が改行で終わっていなければ最後の要素は書きかけ。次回に持ち越す。
    cursor.remainder = text.endsWith("\n") ? "" : (lines.pop() ?? "");
    cursor.offset = size;
    this.cursors.set(file, cursor);

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      this.stats.lines++;
      const { record, skipped } = parseLine(line);
      if (skipped !== null || !record) {
        // 集計対象外の行は大半が user/system 行なので、警告は出さず数だけ持つ。
        this.stats.skipped++;
        continue;
      }
      this.ingestRecord(record);
    }
  }

  private ingestRecord(record: UsageRecord): void {
    // findings.md §3-2: 重複行は累積ではなく同値の再掲。最初の 1 件だけ採る。
    if (this.seen.has(record.key)) {
      this.stats.deduped++;
      return;
    }
    this.seen.add(record.key);

    const dateKey = localDateKey(record.timestamp);
    let byModel = this.buckets.get(dateKey);
    if (!byModel) {
      byModel = new Map();
      this.buckets.set(dateKey, byModel);
    }

    const modelKey = resolveModelKey(record.model) ?? record.model ?? "(unknown)";
    let bucket = byModel.get(modelKey);
    if (!bucket) {
      bucket = newBucket();
      byModel.set(modelKey, bucket);
    }

    addTotals(bucket.totals, record.totals);

    const rate = rateFor(record.model, { at: record.timestamp, fast: record.fast });
    if (!rate) {
      // 価格不明。0 円として黙って捨てず、UI に出せるよう記録する。
      bucket.unknownPricing = true;
      if (record.model) this.unknownModels.add(record.model);
      return;
    }

    const modifier = modifiersFor({
      batch: record.batch,
      inferenceGeoUs: record.inferenceGeoUs,
    });
    const t = record.totals;
    const usd =
      (t.inputTokens * rate.input +
        t.outputTokens * rate.output +
        t.cacheWrite5mTokens * rate.cacheWrite5m +
        t.cacheWrite1hTokens * rate.cacheWrite1h +
        t.cacheWriteUnsplitTokens * unsplitCacheWriteRate(rate) +
        t.cacheReadTokens * rate.cacheRead) /
      1_000_000;

    bucket.costUsd += usd * modifier;
  }

  /** 現在のバケットからレポートを組み立てる。 */
  report(now = new Date()): LocalUsageReport {
    const todayKey = localDateKey(now);

    // 直近 7 日は seven_day 枠と揃えるためローリング (暦週ではない)。
    const windowKeys = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      windowKeys.add(localDateKey(d));
    }

    const daily: DailyUsage[] = [...this.buckets.entries()]
      .map(([date, byModel]) => {
        const totals = emptyTotals();
        let costUsd = 0;
        let hasUnknownPricing = false;
        for (const bucket of byModel.values()) {
          addTotals(totals, bucket.totals);
          costUsd += bucket.costUsd;
          hasUnknownPricing ||= bucket.unknownPricing;
        }
        return { date, totals, costUsd, hasUnknownPricing };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      computedAt: Date.now(),
      scanned: { ...this.stats },
      roots: this.existingRoots(),
      today: this.rollup((date) => date === todayKey),
      last7Days: this.rollup((date) => windowKeys.has(date)),
      daily,
      unknownModels: [...this.unknownModels].sort(),
      pricing: (() => {
        const meta = pricingMeta();
        return {
          lastUpdated: meta.lastUpdated,
          sources: meta.sources,
          overridePath: meta.overridePath,
        };
      })(),
      warnings: [...this.warnings],
    };
  }

  private rollup(includeDate: (date: string) => boolean): UsageRollup {
    const totals = emptyTotals();
    let costUsd = 0;
    let hasUnknownPricing = false;
    const perModel = new Map<string, Bucket>();

    for (const [date, byModel] of this.buckets) {
      if (!includeDate(date)) continue;
      for (const [model, bucket] of byModel) {
        addTotals(totals, bucket.totals);
        costUsd += bucket.costUsd;
        hasUnknownPricing ||= bucket.unknownPricing;

        let merged = perModel.get(model);
        if (!merged) {
          merged = newBucket();
          perModel.set(model, merged);
        }
        addTotals(merged.totals, bucket.totals);
        merged.costUsd += bucket.costUsd;
        merged.unknownPricing ||= bucket.unknownPricing;
      }
    }

    const byModel: ModelUsage[] = [...perModel.entries()]
      .map(([model, bucket]) => ({
        model,
        displayName: displayNameFor(model),
        totals: bucket.totals,
        costUsd: bucket.unknownPricing && bucket.costUsd === 0 ? null : bucket.costUsd,
        unknownPricing: bucket.unknownPricing,
      }))
      // 金額の大きい順。価格不明は末尾に寄せる。
      .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));

    return { totals, costUsd, hasUnknownPricing, byModel };
  }
}
