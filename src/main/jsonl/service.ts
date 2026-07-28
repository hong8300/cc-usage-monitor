/**
 * JSONL 集計をバックグラウンドで回すサービス。
 *
 * ログは Claude Code が動いている間ターン毎に追記されるので、
 * ファイル監視 + デバウンスで再集計する。集計自体は増分読みなので安い。
 */

import chokidar, { type FSWatcher } from "chokidar";
import type { LocalUsageReport } from "../../shared/usage-types.ts";
import { transcriptRoots } from "../paths.ts";
import { TranscriptAggregator } from "./aggregator.ts";

export type ReportListener = (report: LocalUsageReport) => void;

export class LocalUsageService {
  private readonly aggregator = new TranscriptAggregator();
  private readonly listeners = new Set<ReportListener>();
  private watcher: FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;
  private report: LocalUsageReport | null = null;

  start(): void {
    if (this.watcher) return;

    // 起動時に一度フル集計 (このとき全ファイルを頭から読む)。
    this.recompute();

    this.watcher = chokidar.watch(transcriptRoots(), {
      ignoreInitial: true,
      // 存在しないルートを渡しても落ちないようにする。
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      // `.jsonl` 以外は監視しない。
      // ~/.claude/projects 配下には memory/*.md など集計に無関係なファイルもあり、
      // ディレクトリごと監視すると読む必要のないユーザーファイルにまでハンドルを持つ。
      // 触る範囲は必要最小限に留める (指示書 §6)。
      ignored: (targetPath, stats) => {
        if (stats?.isDirectory()) return false;
        if (stats?.isFile()) return !targetPath.endsWith(".jsonl");
        // stats がまだ無い段階ではディレクトリの可能性があるので通す。
        return false;
      },
    });

    const onChange = (file: string) => {
      if (!file.endsWith(".jsonl")) return;
      this.schedule();
    };
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
  }

  stop(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    void this.watcher?.close();
    this.watcher = null;
  }

  current(): LocalUsageReport | null {
    return this.report;
  }

  onReport(listener: ReportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 手動で再集計する (設定画面の「再スキャン」など)。 */
  refresh(): LocalUsageReport {
    this.recompute();
    return this.report!;
  }

  /** 書き込みが連続しても再集計は 1 回にまとめる。 */
  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.recompute();
    }, 1200);
  }

  private recompute(): void {
    this.aggregator.scan();
    this.report = this.aggregator.report();
    for (const listener of this.listeners) listener(this.report);
  }
}
