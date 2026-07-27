# Phase 0 — 実機調査結果

調査日: 2026-07-28 JST
調査機: macOS 26.5.2 (Build 25F84) / Apple Silicon (arm64)
調査者: Claude Code

このドキュメントは指示書 §0 の必須事項に対する回答である。
**「実測」= この機体で実際に確認した値。「docs」= 公式ドキュメント由来。「未確認」= 検証できなかった項目。**

---

## 0. サマリ（結論だけ読む人向け）

| 項目 | 結果 |
|---|---|
| `claude --version` | **2.1.220** — `rate_limits` 提供条件（v2.1.80 以降）を満たす |
| `rate_limits` のキー名 | **`five_hour` / `seven_day`** で確定（docs） |
| `used_percentage` の型 | **number（0〜100、小数あり）** — 例 `23.5` |
| `resets_at` の形式 | **Unix epoch 秒（number）** — ISO8601 ではない |
| 認証方式 | **OAuth サブスク認証**（`ANTHROPIC_API_KEY` 未設定、Keychain に資格情報あり）→ `rate_limits` が出る前提を満たす |
| JSONL の `message.usage` キー | 指示書の想定 **＋4個** 追加フィールドあり（後述） |
| モデル ID の日付サフィックス | **現行モデルには存在しない**（`claude-opus-5` 等）→ 指示書 §3-B の前提が古い |
| 重複排除の必要性 | **必須。実測で 89.4% の過大計上**が発生する |
| statusLine 実 JSON ダンプ | **未取得**（後述・要ユーザー操作） |
| Windows 側確認 | **未確認**（ユーザー判断により Mac 優先、後回し） |

---

## 1. バージョン・環境（実測）

```
claude --version   → 2.1.220 (Claude Code)
node --version     → v25.6.1
npm --version      → 11.9.0
sw_vers            → macOS 26.5.2 (Build 25F84)
uname -m           → arm64
```

指示書は「`rate_limits` は v2.1.80 以降で提供される、という記述があるため要確認」としていた。
**2.1.220 はこれを大きく上回るため、バージョン要件は満たす。**

### 設定ファイルの現状（実測）

`~/.claude/settings.json`:

```json
{
  "permissions": { "allow": ["Bash(uv run:*)", "Read(//private/tmp/**)"] },
  "model": "opus[1m]",
  "effortLevel": "xhigh",
  "tui": "fullscreen"
}
```

- **`statusLine` キーは現在存在しない。**
  → ブリッジ有効化時は「元コマンドなし」の分岐（指示書 §3-A-3、既定行を出力）に入る。
  ただし将来ユーザーが設定する可能性があるため、パススルー実装は必須のまま。
- `$CLAUDE_CONFIG_DIR` は **未設定**（空）。
- `~/.config/claude/projects` は **存在しない**。
- → 探索ルートは実質 `~/.claude/projects` のみ。ただし指示書どおり3段のフォールバックは実装する。

---

## 2. statusLine 入力 JSON（docs 由来・実 JSON は未取得）

出典: <https://code.claude.com/docs/en/statusline>（2026-07-28 取得）

### 2-1. `rate_limits`（本アプリの主データソース）

```json
"rate_limits": {
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

指示書 §0-3 が確認を求めた3点への回答:

| 質問 | 回答（docs） |
|---|---|
| キー名は `five_hour` / `seven_day` か | **Yes。確定。** |
| `used_percentage` の型 | **number。0〜100。小数を取りうる**（docs の例が `23.5` / `41.2`）。→ 整数前提の実装は不可 |
| `resets_at` は Unix 秒か ISO8601 か | **Unix epoch 秒（number）**。docs の表現: “Unix epoch seconds when the 5-hour or 7-day rate limit window resets” |

**欠損条件（docs 明記・UI に反映必須）:**

> `rate_limits`: appears only for Claude.ai subscribers (Pro/Max) after the first API response in the session. **Each window (`five_hour`, `seven_day`) may be independently absent.**

→ 指示書 §3-A の制約リストは docs と完全に一致した。**全フィールド optional 扱い**で実装する。
→ `five_hour` はあるが `seven_day` はない、という状態が正規に起こりうる。

**モデル別週次枠（`seven_day_*`）は statusLine には含まれない。** docs のフィールド一覧に存在しない。
→ 指示書 §3-A の「モデル別週次枠は含まれない」は正しい。C（OAuth）を有効化しない限りモデル別は取得不能。

### 2-2. 本アプリが使う他のフィールド（docs 由来）

| フィールド | 型・意味 | 備考 |
|---|---|---|
| `model.id`, `model.display_name` | string | |
| `session_id` | string | |
| `transcript_path` | string | 現セッションの JSONL 絶対パス。**B の集計と A を突き合わせる鍵になる** |
| `version` | string | Claude Code バージョン |
| `workspace.current_dir` / `.project_dir` | string | |
| `cost.total_cost_usd` | number | **クライアント側推定**。docs 明記: “computed client-side. May differ from your actual bill” |
| `cost.total_duration_ms` / `total_api_duration_ms` | number | |
| `cost.total_lines_added` / `total_lines_removed` | number | |
| `context_window.used_percentage` / `.remaining_percentage` | number \| **null** | docs: “may be `null` early in the session” |
| `context_window.context_window_size` | number | 200000 または 1000000 |
| `context_window.current_usage` | object \| **null** | 初回 API 応答前と `/compact` 直後は null |
| `exceeds_200k_tokens` | boolean | |
| `effort.level` | string | `low`〜`max`。モデル非対応時は **キーごと欠損** |
| `fast_mode` | boolean | **料金が変わる**（後述 §4-3） |
| `thinking.enabled` | boolean | |

**`context_window.used_percentage` の定義（docs）:** 入力トークンのみから算出
（`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`）。**`output_tokens` を含まない。**
→ B 側で独自にコンテキスト率を出す場合は同じ式に揃える。

### 2-3. 実 JSON ダンプ — **未取得**

指示書 §0-3 は実機ダンプを必須としているが、`~/.claude/settings.json` への書き込みが
Claude Code の権限クラシファイアによりブロックされたため、**このセッションでは取得できていない。**

取得用スクリプトは同梱済み（ユーザーが1コマンドで実行可能）:

```
node scripts/phase0/enable-dump.js   # バックアップ → statusLine を差し替え
（Claude Code でプロンプトを1回投げる）
node scripts/phase0/restore.js       # 復元（バイト一致を検証）
```

出力先: `~/.cc-usage-monitor/phase0/statusline-dump.json`
毎ターンの履歴: `~/.cc-usage-monitor/phase0/statusline-dump.log.jsonl`

**未確認である以上の前提での実装方針（指示書 §0 末尾の要求どおり）:**

1. `rate_limits`・各ウィンドウ・各フィールドを**すべて optional** として型定義する。
2. 欠損時は `0%` ではなく **`—`** を表示し、理由をツールチップで示す（指示書 §4 表示規則）。
3. `used_percentage` は `number` として受け、`0〜100` にクランプ。整数化しない。
4. `resets_at` は `number`（Unix 秒）として受ける。**万一 ISO8601 文字列が来た場合も
   パースできるよう両対応のパーサを噛ませる**（未確認項目に対するフォールバック）。
5. 未知のキーは破棄せず保持し、デバッグ画面で raw JSON を確認できるようにする。

---

## 3. ローカル JSONL（実測）

対象: `~/.claude/projects/**/*.jsonl` — **9 ファイル / 全 5,871 行 / JSON パース失敗 0 行**

### 3-1. `type: "assistant"` 行の `message.usage` キー（実測）

指示書 §0-4 が確認を求めた4キーは**すべて存在**した。加えて**4つの未記載フィールド**があった。

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 10035,
  "cache_read_input_tokens": 20576,
  "output_tokens": 108,
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 10035,
    "ephemeral_5m_input_tokens": 0
  },
  "inference_geo": "not_available",
  "iterations": [ { "...": "per-attempt breakdown" } ],
  "speed": "standard"
}
```

| キー | 指示書の想定 | 実測 | コストへの影響 |
|---|---|---|---|
| `input_tokens` | ○ | ✅ あり | 通常単価 |
| `output_tokens` | ○ | ✅ あり | 出力単価 |
| `cache_creation_input_tokens` | ○ | ✅ あり | **1.25x か 2x か は下の `cache_creation` 次第** |
| `cache_read_input_tokens` | ○ | ✅ あり | 0.1x |
| `cache_creation.ephemeral_1h_input_tokens` | 記載なし | ✅ **あり（2,408/2,410 行）** | **2.0x**（1時間 TTL） |
| `cache_creation.ephemeral_5m_input_tokens` | 記載なし | ✅ あり（この機体では常に 0） | **1.25x**（5分 TTL） |
| `speed` | 記載なし | ✅ `"standard"` | `"fast"` なら **Opus 5 は $10/$50** に跳ね上がる |
| `service_tier` | 記載なし | ✅ `"standard"` | batch なら 50% 引き |
| `server_tool_use` | 記載なし | ✅ あり | web検索は別課金（本アプリでは非対象） |

> **これは指示書の前提を1つ覆す重要な発見。**
> `cache_creation_input_tokens` を単一単価で計算すると、この機体では**キャッシュ書き込みコストを 37.5% 過小評価する**
> （実際は全量 1h キャッシュ＝2.0x なのに 1.25x で計算してしまうため）。
> → `pricing.json` は **cacheWrite5m / cacheWrite1h を分離**し、`cache_creation` があればそちらを優先して按分する。

### 3-2. 重複排除（実測）— 指示書の想定どおり、かつ影響は想定以上

| 指標 | 実測値 |
|---|---|
| `type:"assistant"` かつ `message.usage` を持つ行 | **2,410** |
| ユニークな `message.id` + `requestId` | **1,209** |
| 重複キー数 | 771（1キー最大 **7 コピー**） |
| 重複行の usage 値 | **771/771 が完全一致**（差異 0 件） |
| 重複排除なしの総トークン | 574,375,674 |
| 重複排除ありの総トークン | 303,251,587 |
| **過大計上率** | **+89.4%** |

**結論:**
- 重複行は**累積値ではなく同一値の再掲**である。→ **最初の1件を採用**して以降を捨てるのが正しい。
  （指示書は「ストリーミングチャンクは累積値のため」と書いていたが、**実測では累積ではなく同値の重複**だった。
  どちらの理解でも「id+requestId で1件に畳む」実装は同じで正しい。）
- `message.id` + `requestId` の複合キーで**過不足なく畳めた**。

### 3-3. 除外すべき行（実測）

| 条件 | 件数 | 扱い |
|---|---|---|
| `requestId` 欠損 | 2 | **除外** |
| `message.model === "<synthetic>"` | 2 | **除外**（Claude Code がローカル生成した擬似メッセージ。API 課金なし） |
| `isApiErrorMessage: true` | 2 | **除外** |
| `isSidechain: true`（サブエージェント） | 0 | **集計対象に含める**（実トークンを消費するため）。この機体では未出現 |

上記3条件は**同一の2行**を指していた。→ 実装は `requestId` 有無 + `model !== "<synthetic>"` + `!isApiErrorMessage` の AND で足りる。

### 3-4. モデル ID（実測）— **指示書の前提が古い**

```
claude-opus-4-8  : 1,468 行
claude-opus-5    :   940 行
<synthetic>      :     2 行
```

指示書 §3-B は「モデル ID の日付サフィックス（例: `-20250929`）を除去してから価格表に照合」としていたが、
**現行モデルの ID に日付サフィックスは付かない。**（`claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5` …）

→ 実装方針: 日付サフィックス除去は**旧モデル（`claude-3-5-sonnet-20241022` 等）向けの後方互換として残す**が、
まず完全一致を試し、外れた場合のみサフィックス除去 → 再照合、というフォールバック順にする。
未知のモデル ID は**コスト 0 で黙って捨てず、「未知モデル」として件数・トークンを UI に表示**する
（価格表の更新漏れを検知できるようにするため）。

### 3-5. その他（実測）

- `timestamp` は **全行 ISO8601 (`...Z`)**。→ 日次/5時間ブロック集計はこれを使う。
- assistant 行のトップレベルキー: `uuid`, `parentUuid`, `sessionId`, `requestId`, `timestamp`,
  `version`, `cwd`, `gitBranch`, `type`, `message`, `isSidechain`, `effort`, `slug`, `entrypoint` ほか。
- `message` 直下: `id`, `model`, `role`, `type`, `usage`, `content`, `stop_reason`, `stop_details`,
  `container`, `context_management`, `diagnostics`, `stop_sequence`。

---

## 4. 認証・資格情報（実測）

| 項目 | 実測 |
|---|---|
| `ANTHROPIC_API_KEY` | **未設定** |
| `~/.claude/.credentials.json` | **存在しない** |
| macOS Keychain | **存在する** — service `Claude Code-credentials` / account `hong` |

→ この機体は **OAuth サブスクリプション認証**。docs の「`rate_limits` は Claude.ai サブスクライバのみ」条件を満たす。
→ 指示書 §3-C の「macOS: Keychain の `Claude Code-credentials`」という記述は **実測で裏付けられた**。
→ Windows の保存先は **未確認**（§6 参照）。

**本アプリでの扱い（指示書 §6 の禁止事項に従う）:**
トークンは**読まない・保存しない・複製しない**。C（OAuth モード）は既定 OFF、明示オプトイン時のみ参照する。

---

## 5. 法務・コンプライアンス（docs 由来）

出典: <https://code.claude.com/docs/en/legal-and-compliance>（2026-07-28 取得）

該当箇所の**逐語引用**:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
> Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native
> Anthropic applications.
>
> **Developers** building products or services that interact with Claude's capabilities, including those
> using the Agent SDK, should use API key authentication through Claude Console or a supported cloud
> provider. **Anthropic does not permit third-party developers to offer Claude.ai login or to route
> requests through Free, Pro, or Max plan credentials on behalf of their users.**
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

**読み取り（指示書 §3-C-3 の「未確認」に対する回答）:**

- 明示的に禁止されているのは
  ① 第三者開発者が **Claude.ai ログインを提供**すること、
  ② **ユーザーの代わりに** Free/Pro/Max の資格情報でリクエストを**中継**すること。
- 本アプリは「ユーザー自身のマシンで、ユーザー自身のトークンで、自分の使用量を読むだけ」であり、
  上記①②の字義には**該当しない可能性が高い**。
- ただし OAuth は “ordinary use of Claude Code and **other native Anthropic applications**” に限定されると
  書かれており、**本アプリはネイティブ Anthropic アプリではない。**
- さらに `GET /api/oauth/usage` は**公式ドキュメントに一切記載がない非公開エンドポイント**である
  （docs 内に該当記述なし）。

→ **結論: グレー。「明確に許可されている」とは言えない。**
→ 指示書の判断（**C は既定 OFF・明示オプトイン・警告ダイアログ必須**）は妥当であり、**そのまま踏襲する。**
→ 警告ダイアログには上記引用と法務ドキュメントへのリンクを載せる。
→ **A（statusLine）と B（ローカル JSONL）だけで指示書 §1 の目的の大半は満たせる**ため、C なしを既定とする。

---

## 6. 未確認事項（指示書 §0 末尾の要求により明記）

| # | 未確認項目 | 理由 | 実装側のフォールバック |
|---|---|---|---|
| 1 | statusLine の**実 JSON** | `~/.claude/settings.json` への書き込みが権限ブロック。ユーザー実行用スクリプトを同梱済み | 全フィールド optional。`resets_at` は Unix秒/ISO8601 両対応パーサ。未知キーは保持して raw 表示 |
| 2 | `rate_limits` が**この機体で実際に出るか** | 同上 | 欠損時は `—` + 理由ツールチップ（「Claude Code セッション未起動」/「初回 API 応答前」/「API キー認証では非提供」） |
| 3 | **Windows** のパス・statusLine 起動方法 | ユーザー判断により後回し（Mac 優先） | パスは `os.homedir()` ベースで解決。Windows 固有分岐は Phase 4 で対応 |
| 4 | Windows の**資格情報保存先** | 同上 | C 自体が既定 OFF のため現時点で影響なし |
| 5 | `GET /api/oauth/usage` の**実レスポンス形状** | 非公開 API・C は既定 OFF のため未検証 | `seven_day_*` を含む未知キーを**汎用ループで表示**する設計（指示書 §3-C 準拠） |
| 6 | `speed: "fast"` 時の JSONL 表現 | この機体では `"standard"` のみ出現 | `speed` を読み、`fast` なら fast 単価を適用。単価不明時は標準単価＋警告バッジ |
| 7 | `service_tier: "batch"` の出現 | 未出現 | 同上（batch は 50% 引きだが Claude Code では通常出ない） |

---

## 7. この調査から確定した設計判断

1. **`pricing.json` は cacheWrite を 5m / 1h で分離する。** §3-1 の実測により必須。
2. **重複排除は `message.id` + `requestId`、最初の1件採用。** §3-2 で妥当性を実証（過大計上 +89.4%）。
3. **モデル ID は完全一致 → 日付サフィックス除去の順で照合。** §3-4。未知モデルは UI に可視化。
4. **`rate_limits` は全階層 optional。`five_hour` だけ来る状態を正規に扱う。** §2-1（docs 明記）。
5. **`resets_at` は Unix 秒。** ミリ秒と誤解して 1970 年を表示しないこと。§2-1。
6. **A 由来（公式）と B 由来（推定）は UI で明確に分離。** B には「推定」バッジ。指示書 §3-B 準拠。
7. **ブリッジは元コマンドのパススルーを実装する。** 現在は未設定だが将来設定されうる。§1。
8. **Windows 対応は Phase 4 に先送り。Phase 1〜3 は macOS で完結させる。**（ユーザー判断）
