/**
 * `latest.json` を監視して UsageSnapshot を更新する。
 *
 * ブリッジは tmp → rename で書くので、監視対象のファイルは
 * 「消えて作り直される」形で更新される。個別ファイルではなくディレクトリを監視し、
 * ファイル未作成の状態から始めても取りこぼさないようにする。
 */

import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { mergeSnapshot } from "../shared/normalize.ts";
import type { StatusLinePayload, UsageSnapshot } from "../shared/types.ts";
import { APP_DIR, LATEST_JSON } from "./paths.ts";

export type SnapshotListener = (snapshot: UsageSnapshot) => void;

export class UsageWatcher {
  private watcher: FSWatcher | null = null;
  private snapshot: UsageSnapshot | null = null;
  private readonly listeners = new Set<SnapshotListener>();
  private pending: NodeJS.Timeout | null = null;

  start(): void {
    if (this.watcher) return;
    fs.mkdirSync(APP_DIR, { recursive: true });

    // 起動時点で既にファイルがあれば即座に反映する。
    this.read();

    this.watcher = chokidar.watch(APP_DIR, {
      depth: 0,
      ignoreInitial: true,
      // rename 直後に読むと稀に空を掴むので、書き込み完了を待つ。
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    });

    const onEvent = (file: string) => {
      if (path.resolve(file) !== path.resolve(LATEST_JSON)) return;
      this.schedule();
    };

    this.watcher.on("add", onEvent);
    this.watcher.on("change", onEvent);
  }

  stop(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    void this.watcher?.close();
    this.watcher = null;
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  current(): UsageSnapshot | null {
    return this.snapshot;
  }

  /** 立て続けの書き込みを 1 回にまとめる。 */
  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.read();
    }, 40);
  }

  private read(): void {
    let text: string;
    try {
      text = fs.readFileSync(LATEST_JSON, "utf8");
    } catch {
      // まだ書かれていない / 読めない。前回のスナップショットを保持したままにする。
      return;
    }
    if (text.trim().length === 0) return;

    let payload: StatusLinePayload;
    try {
      payload = JSON.parse(text) as StatusLinePayload;
    } catch {
      // rename の隙間で半端に読んだ場合。次の更新で取り直せるので黙って捨てる。
      return;
    }

    this.snapshot = mergeSnapshot(this.snapshot, payload, Date.now());
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
