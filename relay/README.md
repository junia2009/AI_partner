# Fish Audio 中継サーバーの設置手順

パラスの声を Fish Audio にするための準備です。
Fish Audio の API はブラウザから直接呼べないため、Cloudflare Workers（無料）に小さな中継サーバーを置きます。

## 1. Fish Audio の APIキーを作る

1. https://fish.audio でアカウントを作る（無料）
2. 開発者向けページ（Developers → API Keys）で APIキーを作成してコピーする

パラスは無料モデル `s2.1-pro-free` を使うので、クレジットを買わなくても声を作れます（公正利用の範囲内）。

iPhone・iPad では、マイクの声を文字にするのにも Fish Audio（`transcribe-1-pro`）を使います。
こちらは有料（1時間あたり0.36ドル、1回話しかけて0.1円以下）なので、Fish Audio の API Billing で少額のクレジットを追加してください。

## 2. Cloudflare に中継サーバーを置く

1. https://dash.cloudflare.com でアカウントを作る（無料）
2. 左メニューの **Workers & Pages** → **Create** → **Create Worker**（Hello World のテンプレート）
3. 名前を `pallas-fish-relay` などにして **Deploy**
4. **Edit code** を開き、中身をすべて消して [`fish-relay.js`](./fish-relay.js) の内容を貼り付け、**Deploy**
5. 表示されたURL（`https://pallas-fish-relay.xxxx.workers.dev`）をコピーする

## 3. パラスの設定

パラスの「設定」で次を入力して保存します。

- 声のエンジン：**Fish Audio**
- 中継サーバーのURL：手順2でコピーしたURL
- Fish Audio の APIキー：手順1でコピーしたキー
- 声：候補から選ぶ（Fish Audio の声のIDを直接入れることもできます）

「声を試す」で声が出れば完了です。

## より安全にしたい場合（任意）

APIキーをブラウザに置きたくない場合は、Cloudflare の Worker の
**Settings → Variables and Secrets** に `FISH_API_KEY` という名前のシークレットとしてキーを登録してください。
その場合、パラスの設定の「Fish Audio の APIキー」は空欄で動きます。

## 中継サーバーのコードを更新するとき

`fish-relay.js` が更新されたら（例：文字起こしの入口 `/v1/asr` の追加）、Cloudflare の Worker の **Edit code** で中身を貼り替えて **Deploy** してください。

## 自分のPCで動かすときなど

`fish-relay.js` 冒頭の `ALLOWED_ORIGINS` に、パラスを開くページのURL（オリジン）を追加してください。
ここに無いページからの呼び出しは断るようにしています。

## Google 連携（カレンダー・Gmail・マップ）の準備

### 1. Google Cloud でプロジェクトを作る
1. https://console.cloud.google.com を開き、新しいプロジェクト（例：`pallas`）を作る
2. 「API とサービス」→「ライブラリ」で次を有効にする
   - Google Calendar API
   - Gmail API
   - Places API (New)（マップ検索を使う場合）
   - Routes API（経路案内を使う場合）

### 2. ログインの設定（カレンダー・Gmail 用）
1. 「Google Auth Platform」（または「OAuth 同意画面」）を開き、アプリ名 `パラス`、ユーザーの種類「外部」で作成
2. 「対象」（テストユーザー）に、自分の Gmail アドレスを追加する（公開はしない＝テスト中のまま）
3. 「クライアント」→「クライアントを作成」→ 種類「ウェブ アプリケーション」
   - 承認済みの JavaScript 生成元：`https://junia2009.github.io`
4. 表示された **クライアントID** と **クライアントシークレット** を控える

テスト中のアプリは、Google の仕様で7日ほどでログインが切れます。そのときはパラスの画面の「Googleに再接続」を押してください。

### 3. マップ検索のキー（使う場合）
1. 「お支払い」で請求先アカウントを作り、カードを登録してプロジェクトに紐づける（無料枠の範囲なら請求はありません）
2. 「API とサービス」→「認証情報」→「API キーを作成」。キーの制限で「Places API (New)」だけを許可する
3. 使いすぎ防止：「割り当て」で Places API (New) の Text Search の1日の上限を 30 などに下げる

### 3.2 経路案内（ナビ）を使う場合
「〇〇までの行き方」「〇〇まで何分？」に答えるため、経路検索の「Routes API」を使います（毎月1万回まで無料。車の渋滞を考える経路は5千回まで無料）。
1. 「API とサービス」→「ライブラリ」で **Routes API** を有効にする
2. 「認証情報」で、3. で作ったマップ検索のキーを開き、API の制限に「Routes API」を追加する（Places API (New) と Routes API の2つを許可）
3. 中継サーバー（Worker）のコードを、このリポジトリの最新の `relay/fish-relay.js` に貼り替えて Deploy する（`/maps/route` が加わっています）
4. 使いすぎ防止：「割り当て」で Routes API の1日の上限を 50 などに下げておくと安心

電車・バスの経路は、地域によって Google の API から取れないことがあります。そのときパラスは車での目安を出し、「ナビ開始」ボタンで Google マップのアプリを開くと電車の乗り換え案内が見られます。

### 3.5 地図を Google マップで表示するキー（任意）
地図の表示は、マップ検索とは別の「Maps JavaScript API」を使います（毎月1万回の表示まで無料）。
1. 「API とサービス」→「ライブラリ」で **Maps JavaScript API** を有効にする
2. 「認証情報」→「API キーを作成」で、もう1つキーを作る（マップ検索のキーとは別にする）
3. キーの制限
   - アプリケーションの制限：「ウェブサイト」→ `https://junia2009.github.io/*` を追加
   - API の制限：「Maps JavaScript API」だけ
4. このキーはパラスの設定の「Google マップ表示用のキー」に入れる（ブラウザで使うキーなので、サイトの制限で守る）

### 4. 中継サーバーに鍵を登録する
Cloudflare の Worker の **Settings → Variables and Secrets** に、種類「Secret」で次を追加して Deploy する。
- `GOOGLE_CLIENT_ID`：クライアントID
- `GOOGLE_CLIENT_SECRET`：クライアントシークレット
- `GOOGLE_MAPS_KEY`：マップの API キー

### 5. パラスの設定
「Google 連携」にクライアントIDを入れて保存し、「Googleに接続」を押す。
「このアプリは Google で確認されていません」と出たら「詳細」→「パラス（安全ではないページ）に移動」で進み、すべての項目にチェックを入れて許可する。
