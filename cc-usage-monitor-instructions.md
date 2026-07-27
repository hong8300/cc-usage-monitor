# Claude Code 向け実装指示書 — Claude 使用量モニタ（Mac / Windows 両対応 Electron アプリ）

作成日: 2026-07-28 JST
宛先: Claude Code
発注者: JUN

---

## 0. 最初にやること（必須・実装前）

**推測で実装を始めないこと。** 以下を実機で確認し、結果を `docs/findings.md` に記録してから設計を確定せよ。

1. 公式ドキュメントを取得し、現行の statusLine 入力 JSON のフィールド一覧を確認する
   - https://code.claude.com/docs/en/statusline
   - https://code.claude.com/docs/en/settings
   - https://code.claude.com/docs/en/legal-and-compliance
2. `claude --version` を実行し、バージョンを記録する（`rate_limits` は v2.1.80 以降で提供される、という記述があるため要確認）
3. 実機で statusLine に以下のダンプスクリプトを一時的に設定し、**実際に届く JSON 全体**を保存する。
   ```json
   // ~/.claude/settings.json （一時的）
   { "statusLine": { "type": "command", "command": "node ~/.claude/dump.js" } }
   ```
   ```js
   // ~/.claude/dump.js
   let b=""; process.stdin.on("data",c=>b+=c).on("end",()=>{
     require("fs").writeFileSync(require("os").homedir()+"/statusline-dump.json", b);
     process.stdout.write("dump ok");
   });
   ```
   - Claude Code を起動し、**1回プロンプトを投げてから**（初回 API 応答前は `rate_limits` が出ない）ダンプを確認する。
   - `rate_limits` が存在するか、キー名（`five_hour` / `seven_day`）、`used_percentage` の型、`resets_at` が Unix 秒か ISO8601 かを目視確認する。
4. `~/.claude/projects/` 配下の JSONL を 1 ファイル開き、`type: "assistant"` 行の `message.usage` の実際のキー（`input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`）とモデル ID の実値を確認する。
5. Windows 側（RTX5090 機）でも同じ確認を行い、パス（`%USERPROFILE%\.claude\`）と statusLine コマンドの起動方法の差異を記録する。

**確認できなかった項目は「未確認」と findings.md に明記し、その前提でフォールバックを実装すること。**

---

## 1. 目的

Claude の使用量（サブスクリプション枠の消費率）を、ブラウザで claude.ai の設定 → 使用量ページを開かずに、デスクトップから常時確認できるようにする。

- 現在のセッション枠（5時間ローリングウィンドウ）
- 週次枠（全モデル合計）
- モデル別の週次枠（Sonnet / Opus / Fable など、取得できる範囲で）
- リセットまでの残り時間
- ローカルログから算出したトークン消費・コスト推定・モデル別内訳

対象 OS: macOS（Apple Silicon）/ Windows 11 x64

---

## 2. 技術スタック

| 項目 | 指定 |
|---|---|
| フレームワーク | Electron（最新安定版） |
| 言語 | TypeScript |
| ビルド | Vite + electron-vite |
| UI | React + Tailwind CSS |
| パッケージング | electron-builder（mac: dmg/arm64、win: nsis/x64） |
| ファイル監視 | chokidar |
| 常駐 | Tray（メニューバー / タスクトレイ） |

Electron を指定するが、実装開始前に「Tauri の方が明確に有利」と判断する理由があれば **提案のみ** せよ。勝手に切り替えないこと。

---

## 3. アーキテクチャ — データソースは 3 系統

**重要: 優先度 A と B のみを標準実装とする。C は既定 OFF のオプトイン機能とする。**

### A. statusLine ブリッジ（主データソース・公式仕様のみを使用）

Claude Code の statusLine 機能は、ターン毎に JSON を stdin でスクリプトに渡す。これを横取りしてファイルに落とす。

- アプリが `~/.cc-usage-monitor/bridge.js`（Windows も同じ相対パス）を生成する
- bridge.js は
  1. stdin の JSON 全体を `~/.cc-usage-monitor/latest.json` に原子的書き込み（tmp → rename）
  2. ユーザーが元々使っていた statusLine コマンドがあれば、同じ JSON を渡してそのまま実行し、stdout をパススルー
  3. 元コマンドが無ければ、簡潔なデフォルト行を出力
- アプリは `latest.json` を chokidar で監視して UI 更新
- 設定画面から「ブリッジを有効化 / 無効化」できること。有効化時は `~/.claude/settings.json` の `statusLine` を**バックアップしてから**書き換え、無効化時に完全復元する

取得できる想定（要 findings.md での確認）:
`rate_limits.five_hour.used_percentage` / `.resets_at`、`rate_limits.seven_day.*`、`model`、`context_window`、`cost`、`session_id`、`workspace`

**制約（UI に明示すること）:**
- Claude Code のセッションが動いている間しか更新されない
- セッション開始直後（初回 API 応答前）は `rate_limits` が存在しない
- Pro / Max のサブスクリプション認証時のみ（API キー認証では出ない）
- モデル別週次枠は**含まれない**
- 各ウィンドウは独立に欠損しうる → 全フィールド optional として扱い、欠損時は "—" 表示

### B. ローカル JSONL 集計（補助データソース・完全ローカル）

`~/.claude/projects/**/*.jsonl` を解析して、トークン量・推定コスト・モデル別内訳・5時間ブロック別履歴を出す。ccusage と同じ考え方。

- 探索ルート: `$CLAUDE_CONFIG_DIR`（カンマ区切り、あれば）→ `~/.claude/projects` → `~/.config/claude/projects`
- `type: "assistant"` かつ `message.usage` を持つ行のみ集計
- `message.id` + `requestId` で重複排除（ストリーミングチャンクは累積値のため）
- モデル ID の日付サフィックス（例: `-20250929`）を除去してから価格表に照合
- 価格表はハードコードせず `src/pricing.json` に分離し、「最終更新日」と出典 URL をファイル内に持たせる。UI 上でも推定値である旨を明示する
- **これはあくまで概算であり、公式の枠消費率とは一致しない。** UI 上で A 由来の値と B 由来の値を視覚的に区別すること（例: B は「推定」バッジ付き）

### C. OAuth usage エンドポイント（既定 OFF・オプトイン・要警告）

`GET https://api.anthropic.com/api/oauth/usage` に OAuth アクセストークンを付けて叩くと、5時間枠・週次枠・モデル別週次枠・追加利用枠がセッション非依存で取得できる、とコミュニティで報告されている。

**ただし以下の理由から、既定 OFF・明示的オプトインとし、初回有効化時に警告ダイアログを出すこと。**

1. Anthropic の公式ドキュメントに記載のない非公開エンドポイントであり、予告なく変更・停止されうる
2. `anthropic-beta: oauth-2025-04-20` というバージョン付きヘッダを要する
3. Anthropic の法務・コンプライアンス文書に「Free / Pro / Max プランの OAuth 認証は Claude Code と Claude.ai 専用であり、他の製品・ツール・サービスでの OAuth トークン利用は消費者利用規約違反」という趣旨の記述がある（https://code.claude.com/docs/en/legal-and-compliance）。この記述が「自分の使用量を読むだけの参照用エンドポイント」まで含むかは**本指示書の作成時点で未確認**である
4. 429（レート制限）が頻発するという報告が複数ある

実装する場合の要件:
- 設定画面に「これは非公式エンドポイントであり、利用規約上のリスクを自己判断で受け入れる場合のみ有効化してください」という趣旨の説明と、上記法務ドキュメントへのリンクを置く
- ポーリング間隔は最短でも 5 分、既定 10 分。429 を受けたら指数バックオフし、直前の成功値を stale 表示にフォールバック
- トークンは **アプリ側で保存・複製しない**。参照のみ（macOS: Keychain の `Claude Code-credentials`、Windows/Linux: `~/.claude/.credentials.json`。※ Windows での実際の保存先は findings.md で確認すること）
- レスポンスのキーは固定で決め打ちせず、`five_hour` / `seven_day` / `seven_day_*`（モデル別）/ `extra_usage` を**汎用的にループ処理**して表示する。Fable 専用キーの有無は未確認なので、未知の `seven_day_*` キーもラベル整形して表示できる設計にすること

---

## 4. UI 要件

### Tray（常駐表示）
- テキスト: `5h 42% · 7d 18%`（表示形式は設定で「アイコンのみ / % のみ / 両方」を切替可能）
- 色: 〜50% 緑 / 〜80% 橙 / 80%〜 赤
- クリックでポップオーバー表示

### メインパネル
| セクション | 内容 |
|---|---|
| ヘッダ | データソース表示（`statusLine` / `推定` / `OAuth`）と最終更新時刻 |
| セッション枠 | 5時間枠のバー + % + リセットまでのカウントダウン |
| 週次枠 | 全モデル週次のバー + % + リセット日時 |
| モデル別 | 取得できた `seven_day_*` を全部並べる（C 有効時のみ） |
| ローカル集計 | 今日 / 今週のトークン数・推定コスト・モデル別内訳（「推定」バッジ付き） |
| 履歴 | 直近 7 日の日次消費バーチャート |

### 設定
- 更新間隔、起動時自動起動、閾値通知（既定 80% / 95%）、ブリッジ有効化、OAuth モード有効化、テーマ

### 表示規則（厳守）
- データが取得できない項目は 0% と表示せず `—` と表示し、理由をツールチップで示す（例: 「Claude Code セッション未起動」）
- 古いデータは「◯分前」を明示し、5分以上古い場合はグレーアウト

---

## 5. 実装フェーズ

| Phase | 内容 | 完了条件 |
|---|---|---|
| 0 | 実機調査（§0） | `docs/findings.md` に実測 JSON と未確認事項を記載 |
| 1 | Electron 雛形 + Tray + ブリッジ方式（A） | Mac で 5h/7d が Tray に出る |
| 2 | JSONL 集計（B） | 日次・モデル別内訳が出る |
| 3 | 通知・設定・履歴グラフ | 閾値通知が動作 |
| 4 | Windows 対応 + パッケージング | dmg / nsis が生成でき、両 OS で起動確認 |
| 5 | （任意）OAuth モード（C） | 既定 OFF、警告 UI 付き |

**各 Phase 完了ごとにコミットし、次に進む前に動作確認結果を報告すること。一気に全部作らないこと。**

---

## 6. 制約・禁止事項

- `~/.claude/settings.json` を書き換える際は必ずバックアップを取り、無効化で完全復元できること
- Claude Code の JSONL ログを**書き換え・削除しない**（読み取り専用）
- OAuth トークンをアプリのストレージ・ログ・テレメトリに**複製しない**
- 外部サーバへの送信機能を一切作らない（完全ローカル動作）
- `~/.claude/projects` 配下に自前のセッション成果物を残さない
- 価格表・レート上限値をコード中にハードコードしない（データファイルに分離し、出典と更新日を持たせる）
- 未確認の仕様を「動くはず」で実装しない。不明な点は実装を止めて質問すること

---

## 7. 既存の類似実装（参考。コピーではなく設計の参照用）

| 名前 | 形態 | 参考になる点 |
|---|---|---|
| ccusage | CLI（npm, MIT） | JSONL 集計ロジック、重複排除、5時間ブロックの考え方 |
| CodexBar | macOS ネイティブ | 複数データソースのフォールバック順序設計 |
| Claude-Code-Usage-Monitor 系 | 各種 | 閾値通知・バーンレート表示の UI |

ライセンスを確認せずにコードを流用しないこと。

---

## 8. 成果物

- リポジトリ一式（TypeScript / Electron）
- `docs/findings.md`（実機調査結果と未確認事項）
- `README.md`（Mac / Windows それぞれのセットアップ手順、制約の明示）
- ビルド済み: `.dmg`（arm64）/ `.exe`（NSIS, x64）
