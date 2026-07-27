/**
 * Tray アイコンをその場で生成する。
 *
 * バイナリのアイコンをリポジトリに置く代わりに PNG を実行時に組み立てる。
 * 色は指示書 §4 の閾値 (〜50% 緑 / 〜80% 橙 / 80%〜 赤) に従い、
 * リングの塗り分けで 5時間枠の消費率を表す。
 *
 * 依存は node:zlib のみ。canvas も画像ライブラリも使わない。
 */

import zlib from "node:zlib";
import type { Severity } from "../shared/normalize.ts";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** RGBA バッファを PNG にエンコードする。 */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 各スキャンラインの先頭にフィルタバイト 0 を付ける。
  const stride = width * 4;
  const rawWithFilter = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawWithFilter[y * (stride + 1)] = 0;
    rgba.copy(rawWithFilter, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rawWithFilter, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Rgb = [number, number, number];

/**
 * パネル側 (`index.css`) と**同一のステータス色**を使う。
 * 同じ severity が Tray とパネルで違う色に見えると状態の同一性が壊れるため。
 *
 * 値は dataviz の status palette。3色の組で検証済み:
 *   CVD 分離 worst adjacent ΔE 11.3 (protan, 目標 ≥8) / 通常視 27.6 (床 ≥15)。
 */
const SEVERITY_COLOR: Record<Severity, Rgb> = {
  ok: [0x0c, 0xa3, 0x0c], // #0ca30c
  warn: [0xfa, 0xb2, 0x19], // #fab219
  critical: [0xd0, 0x3b, 0x3b], // #d03b3b
};

/** データが無いときの色。0% の緑と紛らわしくならないよう彩度を持たせない。 */
const UNKNOWN_COLOR: Rgb = [0x89, 0x87, 0x81]; // #898781 (muted ink)

export interface TrayIconOptions {
  /** 5時間枠の消費率 (0〜100)。null なら「不明」表示。 */
  percent: number | null;
  severity: Severity | null;
  /** @2x 前提の物理ピクセルサイズ。 */
  size?: number;
}

/**
 * リングゲージを描く。
 *
 * 12時方向を起点に時計回りへ percent 分だけ塗る。
 * 3x3 のスーパーサンプリングで縁を滑らかにする。
 */
export function renderTrayIconPng(options: TrayIconOptions): Buffer {
  const size = options.size ?? 36;
  const color: Rgb = options.severity ? SEVERITY_COLOR[options.severity] : UNKNOWN_COLOR;
  const ratio =
    options.percent === null ? 0 : Math.min(1, Math.max(0, options.percent / 100));

  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const outer = size * 0.46;
  const inner = size * 0.30;
  const samples = 3;
  const twoPi = Math.PI * 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let filled = 0;
      let track = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples - center;
          const py = y + (sy + 0.5) / samples - center;
          const dist = Math.hypot(px, py);
          if (dist < inner || dist > outer) continue;

          // 12時起点・時計回りに 0→2π
          let angle = Math.atan2(px, -py);
          if (angle < 0) angle += twoPi;

          if (options.percent !== null && angle <= twoPi * ratio) filled++;
          else track++;
        }
      }

      const total = samples * samples;
      const offset = (y * size + x) * 4;
      if (filled === 0 && track === 0) continue;

      // 塗り済み部分は濃く、残りは同色を薄く敷いてリング形状を保つ
      // (dataviz: 未消費トラックは中立グレーではなく「同じ色の薄いステップ」)。
      //
      // データ未取得のときは全周がトラックになるため、そのままだと薄すぎて
      // メニューバー上でアイコンの存在が分からない。未取得時だけ濃度を上げる。
      const trackWeight = options.percent === null ? 135 : 60;
      const filledAlpha = (filled / total) * 255;
      const trackAlpha = (track / total) * trackWeight;
      const alpha = Math.round(Math.min(255, filledAlpha + trackAlpha));

      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = alpha;
    }
  }

  return encodePng(size, size, rgba);
}
