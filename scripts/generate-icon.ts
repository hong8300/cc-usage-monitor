#!/usr/bin/env node
/**
 * アプリアイコン (build/icon.png) を生成する。
 *
 * バイナリを手で置く代わりにスクリプトで作る。デザインを変えたくなったら
 * ここを直して再実行すればよく、差分もレビューできる。
 *
 *   node scripts/generate-icon.ts
 *
 * 図案は Tray アイコンと同じリングゲージ。ただし塗りは指示書 §4 の閾値
 * (〜50% 緑 / 〜80% 橙 / 80%〜 赤) をそのまま色分けするので、
 * アイコン自体がアプリの読み方を説明している。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../src/main/tray-icon.ts";

const SIZE = 1024;
/** macOS Big Sur 以降のアイコングリッド: 1024 のうち実体は 824 角・角丸 185。 */
const CONTENT = 824;
const RADIUS = 185;

type Rgb = [number, number, number];

const BACKGROUND: Rgb = [0x1e, 0x1e, 0x1c];
const TRACK: Rgb = [0xff, 0xff, 0xff];
const GOOD: Rgb = [0x0c, 0xa3, 0x0c];
const WARN: Rgb = [0xfa, 0xb2, 0x19];
const CRITICAL: Rgb = [0xd0, 0x3b, 0x3b];

/**
 * リングは全周を塗る。
 *
 * 途中で止めると「常に N% 使っている」ように読めてしまうので、
 * 特定の値を示さない「ゲージ盤」として 3 つの閾値ゾーンだけを見せる。
 */
const FILL_RATIO = 1;

const rgba = Buffer.alloc(SIZE * SIZE * 4);
const center = SIZE / 2;
const half = CONTENT / 2;
const outer = SIZE * 0.30;
const inner = SIZE * 0.205;
const SAMPLES = 4;
const TWO_PI = Math.PI * 2;

/** 角丸矩形の内側か。角の部分だけ円で判定する。 */
function insideRoundedRect(x: number, y: number): boolean {
  const dx = Math.abs(x - center);
  const dy = Math.abs(y - center);
  if (dx > half || dy > half) return false;
  const cornerX = half - RADIUS;
  const cornerY = half - RADIUS;
  if (dx <= cornerX || dy <= cornerY) return true;
  return Math.hypot(dx - cornerX, dy - cornerY) <= RADIUS;
}

/** 12時起点・時計回りの角度から、その位置の閾値色を返す。 */
function zoneColor(ratio: number): Rgb {
  if (ratio >= 0.8) return CRITICAL;
  if (ratio > 0.5) return WARN;
  return GOOD;
}

function blend(dst: Rgb, src: Rgb, alpha: number): Rgb {
  return [
    Math.round(dst[0] * (1 - alpha) + src[0] * alpha),
    Math.round(dst[1] * (1 - alpha) + src[1] * alpha),
    Math.round(dst[2] * (1 - alpha) + src[2] * alpha),
  ];
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let bgHits = 0;
    let trackHits = 0;
    // 塗り部分は位置によって色が変わる。
    // ここで色ごとの**サンプル数**を数えておき、後で 1 色につき 1 回だけブレンドする。
    // 1 サンプルずつ 1/16 の不透明度で重ねると 16 回重ねても不透明にならず、色が濁る。
    const fillCounts = new Map<Rgb, number>();

    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        if (!insideRoundedRect(px, py)) continue;
        bgHits++;

        const dx = px - center;
        const dy = py - center;
        const dist = Math.hypot(dx, dy);
        if (dist < inner || dist > outer) continue;

        let angle = Math.atan2(dx, -dy);
        if (angle < 0) angle += TWO_PI;
        const ratio = angle / TWO_PI;

        if (ratio <= FILL_RATIO) {
          const color = zoneColor(ratio);
          fillCounts.set(color, (fillCounts.get(color) ?? 0) + 1);
        } else {
          trackHits++;
        }
      }
    }

    const total = SAMPLES * SAMPLES;
    const offset = (y * SIZE + x) * 4;
    if (bgHits === 0) continue; // 角丸の外は完全に透明

    let color: Rgb = BACKGROUND;
    // 未消費トラックは白の薄敷き (FILL_RATIO が 1 未満のときだけ現れる)
    if (trackHits > 0) color = blend(color, TRACK, (trackHits / total) * 0.14);
    for (const [zone, count] of fillCounts) {
      color = blend(color, zone, count / total);
    }

    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = Math.round((bgHits / total) * 255);
  }
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dirname, "..", "build", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(SIZE, SIZE, rgba));
console.log(`✓ ${out} (${SIZE}x${SIZE})`);
