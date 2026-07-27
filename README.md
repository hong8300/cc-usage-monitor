# Claude 使用量モニタ

Claude の使用量（サブスクリプション枠の消費率）を、ブラウザで claude.ai を開かずに
メニューバーから常時確認するための Electron アプリ。

**完全ローカル動作。外部サーバへ送信する機能は一切持たない。**

---

## 現在の進捗

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 実機調査 | ✅ 完了 — [`docs/findings.md`](docs/findings.md) |
| 1 | Electron 雛形 + Tray + statusLine ブリッジ | ✅ 完了 |
| 2 | ローカル JSONL 集計（トークン・推定コスト） | 未着手 |
| 3 | 通知・設定・履歴グラフ | 未着手 |
| 4 | パッケージング（+ Windows 対応） | 未着手 |
| 5 | （任意）OAuth モード | 未着手・既定 OFF 予定 |

Windows 対応はユーザー判断により後回し。現在は macOS のみを対象とする。

---

## セットアップ（macOS）

```sh
npm install
npm run dev     # 開発起動
```

初回はメニューバーに灰色のリングが出る（データ未取得）。
パネルを開いて **「ブリッジを有効化」** を押すと使用量が流れ始める。

その他のコマンド:

```sh
npm run typecheck   # 型検査 (main / renderer)
npm test            # 正規化ロジックとブリッジの回帰テスト
npm run build       # 本番ビルド
npm run dist:mac    # dmg 生成（⚠️ Phase 4 で検証予定・現時点では未検証）
```

---

## 仕組み

Claude Code の statusLine 機能は、ターン毎に JSON を stdin でスクリプトに渡す。
本アプリはこれを横取りしてファイルに落とし、監視して UI を更新する。

```
Claude Code ──stdin JSON──▶ ~/.cc-usage-monitor/bridge.js
                                   │
                                   ├──▶ ~/.cc-usage-monitor/latest.json  （原子的書き込み）
                                   │            │
                                   │            └──▶ アプリが chokidar で監視 → Tray / パネル
                                   │
                                   └──▶ 元の statusLine コマンドがあれば実行し stdout をパススルー
```

### `~/.claude/settings.json` の扱い

ブリッジ有効化時に **`statusLine` キーだけ**を書き換える。安全側の設計:

- 書き換え前に全文バックアップを取る（`claude-settings.backup.json` + `backups/` に世代別）
- 既に別ツールの statusLine がある場合は「元コマンドを包む」形にし、その stdout をパススルーする
- **無効化すると元の statusLine 設定（`padding` などの付随設定含む）に戻す**
- 有効化中にユーザーが `model` や `permissions` など他の設定を変更していても、
  無効化でそれを巻き戻さない（`statusLine` キー以外には触れないため）
- 他ツールの statusLine を勝手に削除しない

これらは `tests/bridge.test.ts` で実際にファイルを作って検証している。

### ブリッジは statusLine を壊さない

`bridge.js` は全処理を try/catch で包み、何が起きても必ず 1 行を stdout に出して正常終了する。
元コマンドが失敗・ハング（5秒でタイムアウト）しても既定行にフォールバックし、
エラーは `~/.cc-usage-monitor/bridge.log` に隔離して statusLine の出力は汚さない。

---

## 制約（UI にも明示している）

statusLine 由来のデータには構造的な制約がある。詳細は `docs/findings.md` §2。

- **Claude Code のセッションが動いている間しか更新されない**
- **セッション開始直後（初回 API 応答前）は `rate_limits` が出ない**
- **Pro / Max のサブスクリプション認証時のみ**（API キー認証では出ない）
- **モデル別の週次枠は含まれない**
- 5時間枠と週次枠は互いに独立して欠損しうる

取得できない項目は **`0%` ではなく `—`** と表示し、理由をツールチップで示す。
5分以上古い値はグレーアウトする。

---

## ファイル配置

アプリが作るファイルはすべて `~/.cc-usage-monitor/` 配下に閉じている。

| パス | 内容 |
|---|---|
| `bridge.js` | 生成される statusLine ブリッジ |
| `bridge-config.json` | 元の statusLine コマンドなど、ブリッジが実行時に読む設定 |
| `latest.json` | 直近の statusLine payload |
| `bridge.log` | ブリッジ内部のエラーログ |
| `app-settings.json` | アプリ自身の設定（Tray 表示形式など） |
| `claude-settings.backup.json` | 有効化直前の `~/.claude/settings.json` 全文 |
| `backups/` | 有効化ごとの世代バックアップ |

**Claude Code の JSONL ログは読み取り専用**として扱い、書き換え・削除は一切行わない。

---

## ライセンス

UNLICENSED（個人利用）。
