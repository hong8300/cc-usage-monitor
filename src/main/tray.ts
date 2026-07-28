/**
 * メニューバー常駐表示。
 *
 * 指示書 §4:
 *   - テキスト `5h 42% · 7d 18%`
 *   - 表示形式は「アイコンのみ / % のみ / 両方」を切替可能
 *   - 〜50% 緑 / 〜80% 橙 / 80%〜 赤
 *   - クリックでポップオーバー
 *   - データが取れない項目は 0% ではなく `—`
 */

import { Menu, Tray, nativeImage } from "electron";
import {
  formatAge,
  formatCountdown,
  formatPercent,
  parseResetsAt,
  worstSeverity,
} from "../shared/normalize.ts";
import { STALE_AFTER_MS, type AppSettings, type UsageSnapshot } from "../shared/types.ts";
import { renderTrayIconPng } from "./tray-icon.ts";

export interface TrayCallbacks {
  onToggleWindow: () => void;
  onOpenSettings: () => void;
  onSetTrayMode: (mode: AppSettings["tray"]["mode"]) => void;
  onToggleMini: () => void;
  isMiniEnabled: () => boolean;
  onQuit: () => void;
}

export class TrayController {
  private tray: Tray | null = null;
  private snapshot: UsageSnapshot | null = null;
  private settings: AppSettings;
  private readonly callbacks: TrayCallbacks;

  constructor(settings: AppSettings, callbacks: TrayCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;
  }

  create(): void {
    const initial = renderTrayIconPng({ percent: null, severity: null });
    this.tray = new Tray(nativeImage.createFromBuffer(initial, { scaleFactor: 2 }));
    this.tray.on("click", () => this.callbacks.onToggleWindow());
    this.render();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  update(snapshot: UsageSnapshot | null): void {
    this.snapshot = snapshot;
    this.render();
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    this.render();
  }

  private fivePercent(): number | null {
    return this.snapshot?.fiveHour?.value.used_percentage ?? null;
  }

  private sevenPercent(): number | null {
    return this.snapshot?.sevenDay?.value.used_percentage ?? null;
  }

  /** `5h 42% · 7d 18%`。欠損は `—`(指示書 §4)。 */
  private titleText(): string {
    const five = formatPercent(this.fivePercent()) ?? "—";
    const seven = formatPercent(this.sevenPercent()) ?? "—";
    return `5h ${five} · 7d ${seven}`;
  }

  private render(): void {
    if (!this.tray) return;

    const five = this.fivePercent();
    const seven = this.sevenPercent();

    // アイコンのリングは 5時間枠、色は 2つの枠のうち厳しい方を採る。
    const png = renderTrayIconPng({
      percent: five,
      severity: worstSeverity(five, seven),
    });
    const image = nativeImage.createFromBuffer(png, { scaleFactor: 2 });

    const mode = this.settings.tray.mode;
    this.tray.setImage(mode === "percent" ? nativeImage.createEmpty() : image);
    this.tray.setTitle(mode === "icon" ? "" : this.titleText());
    this.tray.setToolTip(this.tooltip());
    this.tray.setContextMenu(this.menu());
  }

  private tooltip(): string {
    const now = Date.now();
    const lines: string[] = ["Claude 使用量モニタ"];

    if (!this.snapshot || this.snapshot.lastPayloadAt === null) {
      lines.push("データ未取得 — Claude Code セッションが動き出すと更新されます");
      return lines.join("\n");
    }

    const describe = (label: string, window: UsageSnapshot["fiveHour"]) => {
      if (!window) {
        lines.push(`${label}: — (未取得)`);
        return;
      }
      const pct = formatPercent(window.value.used_percentage) ?? "—";
      const reset = formatCountdown(parseResetsAt(window.value.resets_at), now);
      lines.push(`${label}: ${pct}${reset ? ` (${reset}にリセット)` : ""}`);
    };

    describe("5時間枠", this.snapshot.fiveHour);
    describe("週次枠", this.snapshot.sevenDay);

    const age = formatAge(this.snapshot.lastPayloadAt, now);
    const stale = now - this.snapshot.lastPayloadAt > STALE_AFTER_MS;
    lines.push(`更新: ${age}${stale ? "（古い可能性あり）" : ""}`);
    return lines.join("\n");
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: "パネルを開く", click: () => this.callbacks.onToggleWindow() },
      {
        label: "ミニウィンドウを表示",
        type: "checkbox",
        checked: this.callbacks.isMiniEnabled(),
        click: () => this.callbacks.onToggleMini(),
      },
      { label: "設定…", click: () => this.callbacks.onOpenSettings() },
      { type: "separator" },
      {
        label: "表示形式",
        submenu: (["both", "percent", "icon"] as const).map((mode) => ({
          label: { both: "アイコン + %", percent: "% のみ", icon: "アイコンのみ" }[mode],
          type: "radio" as const,
          checked: this.settings.tray.mode === mode,
          click: () => this.callbacks.onSetTrayMode(mode),
        })),
      },
      { type: "separator" },
      { label: "終了", click: () => this.callbacks.onQuit() },
    ]);
  }
}
