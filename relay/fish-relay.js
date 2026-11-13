// AIパラス用 Fish Audio 中継サーバー（Cloudflare Workers）
//
// Fish Audio の API はブラウザから直接呼べない（CORS 非対応）ため、
// このWorkerが間に入って Fish Audio に転送し、ブラウザ向けの CORS ヘッダーを付けて返す。
// 設置方法は relay/README.md を参照。

// パラスを開くページのURL（オリジン）。ここ以外からの呼び出しは断る
const ALLOWED_ORIGINS = [
  "https://junia2009.github.io",
  "http://localhost:8000",
];

const FISH_API = "https://api.fish.audio";
// 中継してよい入口と、指定がないときのモデル
const ROUTES = {
  "/v1/tts": "s2.1-pro-free",     // 声を作る（無料モデル）
  "/v1/asr": "transcribe-1-pro",  // 声を文字にする（有料・ごく少額）
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, model",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    }
    if (!allowed) {
      return json({ status: 403, message: "このページからの呼び出しは許可されていません" }, 403, cors);
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || !Object.hasOwn(ROUTES, url.pathname)) {
      return json({ status: 404, message: "not found" }, 404, cors);
    }

    // APIキーは Worker のシークレット（FISH_API_KEY）を優先し、なければブラウザから送られたものを使う
    const auth = env.FISH_API_KEY
      ? `Bearer ${env.FISH_API_KEY}`
      : request.headers.get("Authorization");
    if (!auth) {
      return json({ status: 401, message: "Fish Audio の APIキーがありません" }, 401, cors);
    }

    const upstream = await fetch(FISH_API + url.pathname, {
      method: "POST",
      headers: {
        "Authorization": auth,
        // 文字起こしは音声ファイルを multipart で送るので、ブラウザが付けた形式をそのまま渡す
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "model": request.headers.get("model") || ROUTES[url.pathname],
      },
      body: request.body,
    });

    const headers = new Headers(cors);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
