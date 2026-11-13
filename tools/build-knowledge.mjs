// パラスの知識（RAG）用の索引を作る。
// knowledge/ フォルダの資料（.md / .txt / .pdf）を読み、検索しやすい大きさの断片に分けて JSON に書き出す。
// 使い方： node tools/build-knowledge.mjs <出力先.json>
// PDF は pdftotext（poppler-utils）で文字を取り出す。入っていなければ PDF は飛ばす。

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
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

writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), docs, chunks }));
console.log(`知識の索引：資料 ${docs.length} 件、断片 ${chunks.length} 件 → ${OUT}`);
