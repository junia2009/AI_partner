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
