/**
 * ミニウィンドウ — デスクトップに常駐する小窓。
 *
 * メニューバー表示とは独立した機能で、5時間枠と週次枠のメーターだけを出す。
 * 同じレンダラを `#mini` ハッシュ付きで読み込み、App 側がミニ表示に切り替える。
 */

import { BrowserWindow, screen } from "electron";
import type { AppSettings } from "../shared/types.ts";

const WIDTH = 260;
const HEIGHT = 148;
/** 画面端からの余白。初回表示位置に使う。 */
const MARGIN = 16;

export interface MiniWindowDeps {
  preloadPath: string;
  rendererUrl: string | undefined;
  rendererFile: string;
  /** 位置が変わったときに設定へ書き戻す。 */
  onMoved: (x: number, y: number) => void;
}

export class MiniWindow {
  private window: BrowserWindow | null = null;
  private readonly deps: MiniWindowDeps;

  constructor(deps: MiniWindowDeps) {
    this.deps = deps;
  }

  /** 設定に合わせて表示/非表示と各種フラグを揃える。 */
  sync(settings: AppSettings): void {
    if (!settings.mini.enabled) {
      this.destroy();
      return;
    }
    const window = this.ensure(settings);
    window.setAlwaysOnTop(settings.mini.alwaysOnTop, "floating");
    window.setVisibleOnAllWorkspaces(settings.mini.visibleOnAllWorkspaces, {
      visibleOnFullScreen: settings.mini.visibleOnAllWorkspaces,
    });
    if (!window.isVisible()) window.showInactive();
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }

  private ensure(settings: AppSettings): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      ...this.initialPosition(settings),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      // Dock やアプリスイッチャーからフォーカスを奪わない。
      focusable: true,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    if (this.deps.rendererUrl) {
      void window.loadURL(`${this.deps.rendererUrl}#mini`);
    } else {
      void window.loadFile(this.deps.rendererFile, { hash: "mini" });
    }

    // ドラッグで動かしたら位置を覚える。
    window.on("moved", () => {
      const [x, y] = window.getPosition();
      this.deps.onMoved(x, y);
    });

    this.window = window;
    return window;
  }

  /** 保存位置があればそれを、無ければ画面右上に寄せる。 */
  private initialPosition(settings: AppSettings): { x?: number; y?: number } {
    const { x, y } = settings.mini;
    if (typeof x === "number" && typeof y === "number") {
      // 保存時と画面構成が変わっていても画面外に飛ばないようにする。
      const area = screen.getDisplayNearestPoint({ x, y }).workArea;
      return {
        x: Math.min(Math.max(x, area.x), area.x + area.width - WIDTH),
        y: Math.min(Math.max(y, area.y), area.y + area.height - HEIGHT),
      };
    }
    const area = screen.getPrimaryDisplay().workArea;
    return {
      x: area.x + area.width - WIDTH - MARGIN,
      y: area.y + MARGIN,
    };
  }
}
