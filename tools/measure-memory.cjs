// メモリの使い方を測る（ヘッドレス Chromium・iPhone と同じ画面の大きさ）。
// 使い方：リポジトリの一番上で `python3 -m http.server 8765` を動かしてから、
//   node tools/measure-memory.cjs
// 3D の街 → 宇宙 → 電脳空間 → 呼びかけの音声認識、の順に読み込み、ブラウザ全体のメモリ（RSS）を表示する。
// 何かを足したら、足す前と後で測って比べること（CLAUDE.md の方針）。
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const BASE = process.env.BASE || "http://localhost:8765";
const rss = () => {
  const out = execSync("ps -eo rss,args | grep -i chrom | grep -v grep || true").toString();
  let t = 0, gpu = 0, rend = 0;
  for (const l of out.trim().split("\n")) {
    const kb = parseInt(l); if (!kb) continue;
    t += kb; if (/type=gpu/.test(l)) gpu += kb; if (/type=renderer/.test(l)) rend += kb;
  }
  return `合計 ${(t / 1024).toFixed(0)}MB（描画 ${(rend / 1024).toFixed(0)}MB・GPU ${(gpu / 1024).toFixed(0)}MB）`;
};
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const log = (label) => console.log(label.padEnd(20), rss());
  log("起動前");
  await p.goto(`${BASE}/index.html?scene=city&spot=1`, { waitUntil: "load" });
  await p.waitForTimeout(12000); log("街を表示");
  await p.evaluate(() => window.pallasTravelTo("space")); await p.waitForTimeout(32000); log("宇宙へ移動");
  await p.evaluate(() => window.pallasTravelTo("cyber")); await p.waitForTimeout(45000); log("電脳空間へ移動");
  await p.evaluate(async () => {
    await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js"; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
    const url = URL.createObjectURL(await (await fetch("assets/vosk/model-ja-lite.tar.gz")).blob());
    const model = await window.Vosk.createModel(url); URL.revokeObjectURL(url);
    window.__m = model; window.__r = new model.KaldiRecognizer(16000, JSON.stringify(["パラス", "[unk]"]));
  });
  await p.waitForTimeout(5000); log("呼びかけを読込");
  await p.evaluate(() => window.__m.terminate()); await p.waitForTimeout(5000); log("呼びかけを解放");
  await b.close();
})();
