// パラスの知識（RAG）用の索引を作る。
// knowledge/ フォルダの資料（.md / .txt / .pdf）を読み、検索しやすい大きさの断片に分けて JSON に書き出す。
// 使い方： node tools/build-knowledge.mjs <出力先.json>
// 出力：<出力先.json> は目次（分野ごとのファイル名と、その分野を呼び出す手がかりの言葉）。
//       分野ごとの中身は、同じフォルダの knowledge-shards/<番号>.json に分けて書く（必要な分野だけ読み込むため）。
// PDF は pdftotext（poppler-utils）で文字を取り出す。入っていなければ PDF は飛ばす。

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "knowledge";
const OUT = process.argv[2] || "_site/knowledge-index.json";
const CHUNK = 700;     // 1断片のおおよその文字数
const OVERLAP = 120;   // 断片どうしの重なり（文の途中で切れても前後がわかるように）
const SKIP = new Set(["README.md"]); // 置き方の説明そのものは索引に入れない

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

function readDoc(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".txt") return readFileSync(path, "utf8");
  if (ext === ".pdf") {
    try {
      return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      console.warn(`PDF を読めませんでした（pdftotext がない？）：${path}`);
      return null;
    }
  }
  return null;
}

// Markdown の見出しで区切り、長い節はさらに文字数で分ける
function chunkDoc(text, ext) {
  const sections = [];
  let heading = [];
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body) sections.push({ heading: heading.filter(Boolean).join(" > "), body });
    buf = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = ext === ".md" && /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      heading = heading.slice(0, level - 1);
      heading[level - 1] = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const sec of sections) {
    if (sec.body.length <= CHUNK) { chunks.push(sec); continue; }
    // 段落の区切りをなるべく保って分割する
    const paras = sec.body.split(/\n\s*\n/);
    let cur = "";
    for (const para of paras) {
      if ((cur + "\n\n" + para).length > CHUNK && cur) {
        chunks.push({ heading: sec.heading, body: cur.trim() });
        cur = cur.slice(-OVERLAP) + "\n\n" + para;
      } else {
        cur = cur ? cur + "\n\n" + para : para;
      }
      // 1段落がとても長いときは文字数で切る
      while (cur.length > CHUNK * 1.6) {
        chunks.push({ heading: sec.heading, body: cur.slice(0, CHUNK).trim() });
        cur = cur.slice(CHUNK - OVERLAP);
      }
    }
    if (cur.trim()) chunks.push({ heading: sec.heading, body: cur.trim() });
  }
  return chunks;
}

const docs = [];
const chunks = [];
let files = [];
try { files = walk(ROOT); } catch { files = []; }
for (const path of files.sort()) {
  if (SKIP.has(basename(path))) continue;
  const ext = extname(path).toLowerCase();
  const text = readDoc(path);
  if (text == null || !text.trim()) continue;
  const rel = relative(ROOT, path);
  const title = (ext === ".md" && /^#\s+(.+)$/m.exec(text)?.[1]?.trim()) || basename(path, ext);
  const parts = chunkDoc(text, ext);
  docs.push({ path: rel, title, chunks: parts.length });
  parts.forEach((c, i) => chunks.push({ id: chunks.length, doc: docs.length - 1, n: i, heading: c.heading, text: c.body }));
}

// ===== 分野ごとに分ける =====
// knowledge/A/B/… の資料は「A/B」、knowledge/A/… は「A」、直下は「core」。
// 小さい分野は起動時に読み込む（preload）。大きい分野は、質問に手がかりの言葉が出たときだけ読む
const PRELOAD_MAX = 120 * 1024;
const shardOf = (path) => { const s = path.split("/"); return s.length > 2 ? s.slice(0, 2).join("/") : s.length > 1 ? s[0] : "core"; };
// 分野ごとの追加の呼び名（見出しに出てこない言い方）
const ALIASES = {
  "FF14/討滅戦": ["討滅", "討伐", "極", "真"],
  "FF14/ダンジョン": ["ダンジョン", "ID"],
  "FF14/レイド": ["レイド", "零式", "アライアンス", "24人"],
  "FF14/零式": ["零式", "アルカディア", "M1S", "M2S", "M3S", "M4S", "M5S", "M6S", "M7S", "M8S", "M9S", "M10S", "M11S", "M12S"],
  "FF14/絶": ["絶", "アルティメット", "UCOB", "UWU", "TEA", "DSR", "TOP", "FRU"],
  "FF14/探索": ["ディープダンジョン", "DD", "エウレカ", "ボズヤ", "クレセント", "特殊フィールド"],
  "FF14/ジョブ": ["回し方", "開幕", "バースト", "スキル回し", "ロール"],
  "FF14/ストーリー": ["ストーリー", "メインクエスト", "メインストーリー", "あらすじ", "解放", "解放クエスト", "登場人物", "キャラ", "誰", "どんな人", "ネタバレ"],
  "ギリシャ神話": ["ギリシャ", "ギリシア", "神話", "女神", "神様", "オリュンポス", "オリンポス", "アテナ", "アテネ", "名前の由来", "ミネルヴァ", "英雄", "怪物", "オデュッセウス", "オデュッセイア", "ユリシーズ", "テセウス", "テーセウス", "ミノタウロス", "イカロス", "ダイダロス", "トロイの木馬", "トロイアの木馬", "アルテミス", "アプロディテ", "ヴィーナス", "ニュクス", "ヒュプノス", "ステュクス", "カロン", "冥界", "エコー", "ナルキッソス", "ナルシス", "ピュグマリオン", "ペネロペ", "キュクロプス", "セイレーン", "キルケ", "タイタン", "ティタン", "クロノス", "アトラス", "ギガントマキア", "タイタノマキア", "テュポン", "アルゴー船", "金の羊毛", "イアソン", "メデイア", "オイディプス", "テバイ", "アガメムノン", "パエトン", "ミダス", "アタランテ", "ディオニュソス", "ハデス", "ペルセポネ", "星座", "ローマ神話", "ユピテル", "ジュピター", "ネプチューン", "パーシー・ジャクソン", "パーシー", "ハーフ", "ハーフブラッド", "デミゴッド", "半神", "元ネタ"],
  "FF14/生活": ["金策", "クラフター", "ギャザラー", "ギャザクラ", "風脈", "フライング", "ハウジング", "マーケット", "リテイナー"],
};
const STOP = new Set(["フェーズ", "攻略", "ポイント", "概要", "報酬", "ボス", "道中", "注意", "基本", "共通", "ノーマル", "コツ", "前半", "後半", "全体", "一覧", "仕組み", "最後", "最初", "とは"]);
const groups = new Map();
docs.forEach((d, i) => { const k = shardOf(d.path); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
const shardDir = join(dirname(OUT), "knowledge-shards");
mkdirSync(shardDir, { recursive: true });
const manifest = { built: new Date().toISOString(), version: 2, shards: [] };
const wordsOf = (s) => (s.normalize("NFKC").match(/[\u30a0-\u30ffー・]{2,}|[\u3400-\u9fff々]{2,}|[A-Za-z0-9]{3,}/g) || []).map((w) => w.replace(/^・+|・+$/g, "")).filter((w) => w.length >= 2 && !STOP.has(w));
const keyCount = new Map(); // いくつの分野に出てくる言葉か（どこにでもある言葉は手がかりにしない）
const shardKeys = new Map();
for (const [k, idxs] of groups) {
  const keys = new Set();
  for (const i of idxs) {
    wordsOf(docs[i].title).forEach((w) => keys.add(w));
    for (const c of chunks) if (c.doc === i) c.heading.split(" > ").slice(1).forEach((h) => wordsOf(h).forEach((w) => keys.add(w)));
  }
  shardKeys.set(k, keys);
  for (const w of keys) keyCount.set(w, (keyCount.get(w) || 0) + 1);
}
[...groups.keys()].forEach((k, n) => {
  const idxs = groups.get(k);
  const map = new Map(idxs.map((i, j) => [i, j]));
  const sd = idxs.map((i) => docs[i]);
  const sc = chunks.filter((c) => map.has(c.doc)).map((c, j) => ({ ...c, id: j, doc: map.get(c.doc) }));
  const body = JSON.stringify({ docs: sd, chunks: sc });
  const file = `knowledge-shards/${n}.json`;
  writeFileSync(join(dirname(OUT), file), body);
  const preload = Buffer.byteLength(body) <= PRELOAD_MAX;
  const keys = preload ? [] : [...new Set([...(ALIASES[k] || []), k.split("/").pop(), ...[...shardKeys.get(k)].filter((w) => keyCount.get(w) <= 2)])];
  manifest.shards.push({ name: k, file, preload, size: Buffer.byteLength(body), docs: sd.map((d) => ({ path: d.path, title: d.title })), keys });
});
writeFileSync(OUT, JSON.stringify(manifest));
console.log(`知識の索引：資料 ${docs.length} 件、断片 ${chunks.length} 件、分野 ${manifest.shards.length}（最初に読む ${manifest.shards.filter((s) => s.preload).length}）→ ${OUT}`);
