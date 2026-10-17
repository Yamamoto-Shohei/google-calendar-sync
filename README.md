# google-calendar-sync

複数の Google アカウントのカレンダーを **双方向** に同期し、予定の「時間枠」だけを設定した文言で埋める CLI ツールです。[Lynx](https://lynxcat.app/) のセルフホスト版にあたります。

元予定のタイトル・詳細・場所・参加者は**一切コピーしません**。同期先に作られるのは、時間だけが同じで中身が伏せられたブロック予定です。

```
┌─────────────┐
│ A カレンダー │  10/20 14:00-15:00「〇〇社と商談」
└──────┬──────┘
       │  時間枠のみ抽出（内容は捨てる）
       ├──────────────▶ B: 10/20 14:00-15:00「秘密の予定」
       └──────────────▶ C: 10/20 14:00-15:00「プライベートの予定」
```

参加カレンダーが3つなら **A→B, A→C, B→A, B→C, C→A, C→B の6方向すべて**を同期します。同期で作られた予定（ミラー）は同期元として扱わないため、ミラーがさらにミラーされて増殖することはありません。

## できること

- 異なる Google アカウント間の双方向・全対全同期
- 埋め込む文言を **方向ごとに個別設定**（A→B は「秘密の予定」、A→C は「プライベートの予定」など）
- 元予定の変更・削除に次回同期で追従（移動したら移動、消したら消える）
- 常に「今日から3ヶ月先」だけを同期（過去は同期しない）
- 画面で初期設定 → あとは15分間隔のバッチで同期し続ける
- 内容を一切コピーしないプライバシー設計

## 必要なもの

- Node.js 20 以上
- Google Cloud プロジェクト（無料枠で足ります）

## セットアップ

### 1. インストール

```bash
git clone https://github.com/Yamamoto-Shohei/google-calendar-sync.git
cd google-calendar-sync
npm install
npm link          # どこからでも `gcal-sync` で実行できるようにする（任意）
```

`npm link` を使わない場合は、以下すべての `gcal-sync` を `node /path/to/google-calendar-sync/src/cli.js` に読み替えてください。

### 2. Google Cloud 側の準備

一度やれば、同期するアカウントが何個あっても使い回せます。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「API とサービス」→「ライブラリ」で **Google Calendar API** を有効化
3. 「API とサービス」→「OAuth 同意画面」を設定
   - User type は **外部（External）**
   - スコープに `https://www.googleapis.com/auth/calendar` を追加
   - 「テストユーザー」に**同期したい全アカウントのメールアドレス**を追加
4. 「API とサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
   - アプリケーションの種類は **デスクトップ アプリ**
   - 作成後に表示される**クライアント ID とクライアント シークレット**を控える

> **⚠️ 重要: 同意画面を「本番環境」に公開してください**
>
> OAuth 同意画面が「テスト中（Testing）」のままだと、**リフレッシュトークンが7日で失効**します。7日ごとに再認可が必要になり、バッチ同期が止まります。
>
> 「OAuth 同意画面」→「アプリを公開」→「本番環境に push」してください。自分専用の個人用途であれば、Google の審査は不要です（審査が必要になるのは、センシティブなスコープで多数の外部ユーザーに配布する場合です）。
>
> Google Workspace アカウントの場合は、User type を「内部（Internal）」にすれば、この制限はありません。

### 3. 画面で設定する

```bash
gcal-sync setup
```

`http://localhost:4765/?t=<ワンタイムトークン>` がブラウザで開きます（URL はターミナルにも表示されます）。画面に沿って上から埋めてください。

1. **OAuth クライアント** — 手順2で控えたクライアント ID とシークレットを貼り付けて保存
2. **Google アカウント** — 「アカウントを追加」を同期したいアカウントの数だけ繰り返す
3. **同期するカレンダー** — アカウントと同期元カレンダーを選んで追加。2つ以上追加すると自動的に全対全になる
4. **埋め込む文言** — 行が送信元・列が送信先のマトリクスで、各方向の文言を入力
5. **同期の設定** — 範囲（既定3ヶ月）・間隔（既定15分）・フィルタ
6. **実行とスケジュール** — 「差分を確認」で内容を確かめてから「今すぐ同期」、最後に「定期実行を登録」

設定が済んだら Ctrl+C で画面を閉じてください。以降はバッチが動き続けます。

#### ミラーの書き込み先について

カレンダー追加時に2つから選べます。

| | 専用サブカレンダー（既定・推奨） | 送信先の primary に直接 |
| --- | --- | --- |
| ミラーの置き場所 | 自動作成される `Synced (gcal-sync)` | 送信先の primary |
| 一括で非表示にできる | **できる**（カレンダーのチェックを外す） | できない |
| 完全リセット | **カレンダーごと削除で済む** | ツール経由で消す必要がある |
| 実予定との区別 | カレンダーの色で分かれる | グレーの色分けのみ |
| ループ防止 | 構造 + マーカーの二重 | マーカーのみ |

どちらでも同期は正しく動きます。迷ったら既定のままにしてください。

## コマンド

```bash
gcal-sync setup                 # 設定画面を開く
gcal-sync sync                  # 同期を1回実行（バッチが叩く本体）
gcal-sync sync --dry-run        # 何も書き込まず、差分だけ表示
gcal-sync sync --only 'A->B'    # 1方向だけ実行（`>` がリダイレクトになるのでクォート必須）
gcal-sync sync --only A         # A に関わる4方向だけ実行
gcal-sync sync --json           # 実行結果を JSON で出力
gcal-sync status                # 設定・認可状態・スケジュール・前回実行を表示
gcal-sync install-cron          # 定期実行を登録（macOS は launchd、他は crontab）
gcal-sync uninstall-cron        # 定期実行を解除
```

終了コード: `0` 成功 / `1` 一部失敗 / `2` 設定不正・未認可。

## 仕組み

### 同期状態は予定自体に持つ

ローカル DB は持ちません。ミラー予定の `extendedProperties.private` に以下を埋め込み、毎回それを突き合わせます。

| キー | 内容 |
| --- | --- |
| `gcsMirror` | 固定値 `1`。**「これはツールが作ったミラーだ」という印** |
| `gcsPair` | 方向 ID（`A->B` など） |
| `gcsSourceEventId` | 元予定の ID |
| `gcsFingerprint` | 書き込んだ内容のハッシュ |

`extendedProperties` は Google カレンダーの UI に表示されず、ユーザーが触れないため、ID が失われて迷子のミラーが生まれることがありません。

この方式の利点は、**設定ファイルを失っても別マシンに移しても、既存のミラーをそのまま引き継げる**ことです。状態が実際のカレンダーと乖離しません。

### 1回の同期でやること

1. ウィンドウを決める（今日 00:00 〜 3ヶ月後）
2. 各カレンダーの予定を取得（`singleEvents=true` で繰り返し予定を実体に展開）。このとき **`gcsMirror` を持つ予定を除外**する ← ループ防止の中核
3. 各ミラー置き場から、マーカー付きの予定だけを取得
4. 方向ごとに突き合わせて、作成 / 更新 / 削除を適用

`gcsFingerprint` には「書き込んだ内容すべて」のハッシュが入ります。予定の時間が動いたときだけでなく、**画面で文言を変更したときも**次回同期で既存ミラー全件が更新されます。

ミラーを同期元から除外するので、方向の処理順は結果に影響しません。何度流しても同じ状態に収束します（冪等）。

### 削除の安全弁

双方向同期では「元に無い → 削除」が暴走すると被害が大きいため、4重に歯止めをかけています。

- **`gcsMirror` を持たない予定は絶対に削除しない** — 手で作った予定は消えません
- **同期元の取得に失敗した方向は丸ごとスキップ** — トークン失効を「予定ゼロ」と誤認してミラーを全消しする事故を防ぎます
- **同期元が0件なのにミラーがある場合は削除せず警告** — 本当に全部消したときは `--allow-empty-source` を付けます
- **1回・1方向あたりの削除件数に上限**（既定100件）— 超えたら中断して警告

### 過去の予定について

ウィンドウは常に「今日から先」です。ミラーは作られた位置に残り、日付が過ぎると単にウィンドウの外に出て、以後は触られません（履歴として残ります）。

## 設定ファイル

`~/.google-calendar-sync/`（ディレクトリは `0700`、ファイルは `0600`）

| ファイル | 内容 |
| --- | --- |
| `config.json` | アカウント・カレンダー・文言・フィルタ |
| `tokens.json` | リフレッシュトークン |
| `client.json` | OAuth クライアント ID / シークレット |
| `last-run.json` | 前回実行の結果 |
| `sync.log` | バッチ実行のログ |

`GCAL_SYNC_HOME` 環境変数で場所を変えられます（独立した複数のメッシュを運用する場合など）。

通常は画面から編集しますが、直接書いても構いません。

```json
{
  "version": 1,
  "window": { "futureMonths": 3 },
  "syncIntervalMinutes": 15,
  "defaultLabel": "予定あり",
  "accounts": [
    { "id": "acct-a", "email": "a@example.com" },
    { "id": "acct-b", "email": "b@example.com" }
  ],
  "members": [
    {
      "id": "A",
      "label": "仕事",
      "accountId": "acct-a",
      "sourceCalendarId": "primary",
      "writeMode": "subcalendar",
      "mirrorCalendarId": "xxxx@group.calendar.google.com",
      "enabled": true
    },
    {
      "id": "B",
      "label": "プライベート",
      "accountId": "acct-b",
      "sourceCalendarId": "primary",
      "writeMode": "subcalendar",
      "mirrorCalendarId": "yyyy@group.calendar.google.com",
      "enabled": true
    }
  ],
  "labels": {
    "A->B": "秘密の予定",
    "B->A": "プライベートの予定"
  },
  "filters": {
    "skipAllDay": false,
    "skipDeclined": true,
    "skipTransparent": true,
    "skipWorkingLocation": true,
    "minDurationMinutes": 0
  },
  "visibility": "private",
  "reminders": "none",
  "annotateDescription": true,
  "mirrorColorId": "8",
  "safety": { "maxDeletesPerPairPerRun": 100 }
}
```

### 文言の差し込みトークン

固定文字列のほか、以下が使えます。

| トークン | 展開結果 |
| --- | --- |
| `{summary}` | 元予定のタイトル（※内容が同期先に出ます） |
| `{start}` / `{end}` | `2026-10-20 14:00` 形式 |
| `{durationMinutes}` | `90` |
| `{calendarName}` | 送信元カレンダーの名前（例「仕事」） |

例: `{calendarName}の予定` → `仕事の予定`

### フィルタ

| 設定 | 既定 | 動作 |
| --- | --- | --- |
| `skipDeclined` | `true` | 自分が辞退した予定を同期しない |
| `skipTransparent` | `true` | 「空き時間」扱いの予定を同期しない |
| `skipAllDay` | `false` | 終日予定を同期しない |
| `skipWorkingLocation` | `true` | 勤務場所（在宅／出社）の登録を同期しない |
| `minDurationMinutes` | `0` | この分数未満の予定を同期しない |

フィルタを後から有効にすると、対象外になった予定のミラーは次回同期で削除されます。

## プライバシー

ミラーにコピーされるのは **開始時刻・終了時刻・終日フラグ** だけです。

- タイトルは設定した文言に置き換わります（`{summary}` を使った場合を除く）
- 詳細・場所・参加者・会議 URL・添付ファイルはコピーされません
- ミラーは `visibility: private`、通知オフで作成されます
- 参加者を付けないので、ミラー作成で第三者に招待メールが飛ぶことはありません
- 認可情報はローカルの `0600` ファイルにのみ保存され、外部に送信されません

## トラブルシューティング

**`invalid_grant` / 7日でトークンが切れる**
OAuth 同意画面が「テスト中」のままです。「本番環境に push」してから `gcal-sync setup` で再認可してください。

**リフレッシュトークンが返ってこない**
そのアカウントで以前に認可済みの場合に起きます。[アカウントのアクセス権](https://myaccount.google.com/permissions)から当該アプリを削除して、もう一度認可してください。

**ミラーが増殖している**
`gcal-sync status` で、ある member の `sourceCalendarId` が他の member の `mirrorCalendarId` と一致していないか確認してください（警告が出ます）。本来は `gcsMirror` マーカーで防がれる状況です。

**ミラーが削除されない / 警告が出る**
安全弁が働いています。`gcal-sync sync --dry-run` で削除対象を確認し、意図どおりなら `--allow-empty-source` を付けるか、`safety.maxDeletesPerPairPerRun` を上げてください。

**バッチが動いていない**
`gcal-sync status` でスケジュールの状態を確認し、`~/.google-calendar-sync/sync.log` を見てください。macOS では `launchctl print gui/$UID/com.googlecalendarsync.sync` でも確認できます。

**全部やり直したい**
サブカレンダー構成なら、Google カレンダーで `Synced (gcal-sync)` カレンダーを削除し、`gcal-sync setup` で組み直してください。

## 開発

```bash
npm test          # 55 件のユニット/結合テスト（Google API への通信は行いません）
```

テストは `test/helpers.js` のインメモリ版 Calendar API を使い、同期エンジンの冪等性・ループ防止・削除安全弁を検証しています。

## ライセンス

MIT
