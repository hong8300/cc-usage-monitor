import { useEffect, useState } from "react";
import {
  describeWindow,
  formatResetHint,
  severityFor,
  windowReason,
} from "../../shared/normalize.ts";
import {
  FIVE_HOUR_WINDOW_MS,
  SEVEN_DAY_WINDOW_MS,
  type BridgeState,
  type UsageSnapshot,
} from "../../shared/types.ts";
import { Meter } from "./components/Meter.tsx";

/**
 * デスクトップ常駐の小窓。
 *
 * 出すのは 5時間枠と週次枠のメーターだけ。ローカル集計やグラフは載せない。
 * 作業中ずっと視界の端に置いておくものなので、情報を足すほど邪魔になる。
 *
 * ウィンドウ全体がドラッグ領域。フレームレスなのでここでしか動かせない。
 */
export function MiniPanel() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void window.monitor.getSnapshot().then(setSnapshot);
    void window.monitor.getBridgeState().then(setBridge);
    const offSnapshot = window.monitor.onSnapshot(setSnapshot);
    const offBridge = window.monitor.onBridgeState(setBridge);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offSnapshot();
      offBridge();
      clearInterval(timer);
    };
  }, []);

  const lastAt = snapshot?.lastPayloadAt ?? null;
  // 鮮度はウィンドウごとに見る (App.tsx と同じ理由: payload の到着 ≠ 数字の新しさ)。
  const five = describeWindow(snapshot?.fiveHour, now, { maxAgeMs: FIVE_HOUR_WINDOW_MS });
  const seven = describeWindow(snapshot?.sevenDay, now, { maxAgeMs: SEVEN_DAY_WINDOW_MS });

  const unavailableReason =
    bridge?.status !== "enabled"
      ? "ブリッジが無効です"
      : lastAt === null
        ? "Claude Code セッション未起動"
        : "初回 API 応答前、または Pro/Max 契約以外では取得できません";

  return (
    <div
      className="drag-region flex h-full flex-col justify-center gap-3 px-3"
      style={{
        // フレームレス + transparent なので、角丸と背景はここで作る。
        background: "var(--surface-page)",
        border: "1px solid var(--hairline)",
        borderRadius: 12,
      }}
    >
      <Meter
        label="セッション枠（5時間）"
        percent={five.percent}
        severity={severityFor(five.percent)}
        resetHint={formatResetHint(five.resetsAt, now)}
        unavailableReason={windowReason(five, unavailableReason, { short: true })}
        stale={five.stale}
        compact
      />
      <Meter
        label="週次枠"
        percent={seven.percent}
        severity={severityFor(seven.percent)}
        resetHint={formatResetHint(seven.resetsAt, now)}
        unavailableReason={windowReason(seven, unavailableReason, { short: true })}
        stale={seven.stale}
        compact
      />
    </div>
  );
}
