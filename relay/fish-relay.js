// AIパラス用 中継サーバー（Cloudflare Workers）
//
// ブラウザから直接呼べない／鍵を見せたくない API のために、このWorkerが間に入る。
//   /v1/tts, /v1/asr : Fish Audio（声を作る・声を文字にする）
//   /google/token    : Google ログインの維持（認可コード・リフレッシュトークンをアクセストークンに交換）
//   /maps/search     : Google マップのお店・場所検索（Places API）
//   /maps/route      : Google マップの経路検索（Routes API）。行き方・所要時間
//                      電車・バスは、RAPIDAPI_KEY があれば NAVITIME の乗換検索を使う（Google の API は日本の電車に非対応）
// 設置方法は relay/README.md を参照。

// パラスを開くページのURL（オリジン）。ここ以外からの呼び出しは断る
const ALLOWED_ORIGINS = [
  "https://junia2009.github.io",
  "http://localhost:8000",
];

const FISH_API = "https://api.fish.audio";
// Fish Audio へ中継してよい入口と、指定がないときのモデル
const FISH_ROUTES = {
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
      "Access-Control-Allow-Headers": "authorization, content-type, model, x-requested-with",
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
    if (request.method !== "POST") {
      return json({ status: 404, message: "not found" }, 404, cors);
    }

    if (url.pathname === "/google/token") return googleToken(request, env, cors);
    if (url.pathname === "/maps/search") return mapsSearch(request, env, cors);
    if (url.pathname === "/maps/route") return mapsRoute(request, env, cors);
    if (!Object.hasOwn(FISH_ROUTES, url.pathname)) {
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
        "model": request.headers.get("model") || FISH_ROUTES[url.pathname],
      },
      body: request.body,
    });

    const headers = new Headers(cors);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

// ===== Google ログインの維持 =====
// ブラウザ（Google のポップアップ）で受け取った認可コードを、アクセストークンとリフレッシュトークンに交換する。
// 以後はリフレッシュトークンで、ポップアップなしにアクセストークンを取り直す。
// クライアントシークレットはこの Worker のシークレット（GOOGLE_CLIENT_SECRET）にだけ置く。
async function googleToken(request, env, cors) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ status: 500, message: "中継サーバーに GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET が設定されていません" }, 500, cors);
  }
  // Google の推奨どおり、ポップアップ方式の CSRF 対策としてこのヘッダーを確認する
  if (request.headers.get("X-Requested-With") !== "XmlHttpRequest") {
    return json({ status: 400, message: "bad request" }, 400, cors);
  }
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  if (typeof body.code === "string" && body.code) {
    params.set("grant_type", "authorization_code");
    params.set("code", body.code);
    params.set("redirect_uri", "postmessage");
  } else if (typeof body.refresh_token === "string" && body.refresh_token) {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", body.refresh_token);
  } else {
    return json({ status: 400, message: "code か refresh_token が必要です" }, 400, cors);
  }
  const exchange = () => fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  let res = await exchange();
  let data = await res.json().catch(() => ({}));
  // ポップアップ方式の redirect_uri は "postmessage" が一般的だが、ページのオリジンを求められる場合もあるので取り直す
  if (!res.ok && data.error === "redirect_uri_mismatch" && params.get("grant_type") === "authorization_code") {
    params.set("redirect_uri", request.headers.get("Origin") || "");
    res = await exchange();
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) {
    return json({ status: res.status, message: data.error_description || data.error || "token error", error: data.error }, res.status, cors);
  }
  // ブラウザに返すのは必要なものだけ
  return json({
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token, // 初回のみ
    scope: data.scope,
  }, 200, cors);
}

// ===== Google マップの検索 =====
// Places API (New) の Text Search。キーはこの Worker のシークレット（GOOGLE_MAPS_KEY）にだけ置く。
async function mapsSearch(request, env, cors) {
  if (!env.GOOGLE_MAPS_KEY) {
    return json({ status: 500, message: "中継サーバーに GOOGLE_MAPS_KEY が設定されていません" }, 500, cors);
  }
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const query = typeof body.query === "string" ? body.query.slice(0, 200) : "";
  if (!query) return json({ status: 400, message: "query が必要です" }, 400, cors);

  const req = { textQuery: query, languageCode: "ja", regionCode: "jp", pageSize: 5 };
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    req.locationBias = { circle: { center: { latitude: body.lat, longitude: body.lng }, radius: 2000 } };
    if (body.rank === "distance") req.rankPreference = "DISTANCE";
  }
  if (body.open_now === true) req.openNow = true;

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY,
      // 取り出す項目を絞る（評価・営業中かは Enterprise 区分：毎月 1,000 回まで無料）
      "X-Goog-FieldMask": [
        "places.displayName", "places.shortFormattedAddress", "places.location", "places.googleMapsUri",
        "places.rating", "places.userRatingCount", "places.currentOpeningHours.openNow", "places.primaryTypeDisplayName",
      ].join(","),
    },
    body: JSON.stringify(req),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ status: res.status, message: data.error?.message || "maps error" }, res.status, cors);
  }
  const places = (data.places || []).map((p) => ({
    name: p.displayName?.text || "",
    type: p.primaryTypeDisplayName?.text || "",
    address: p.shortFormattedAddress || "",
    rating: p.rating ?? null,
    ratings: p.userRatingCount ?? 0,
    open_now: p.currentOpeningHours?.openNow ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    url: p.googleMapsUri || "",
  }));
  return json({ places }, 200, cors);
}

// ===== Google マップの経路検索 =====
// Routes API の computeRoutes。キーは検索と同じ GOOGLE_MAPS_KEY（キーの制限で「Routes API」も許可しておく）。
// 料金：毎月 1万回まで無料（車の渋滞を考える経路は 5千回まで無料）
const TRAVEL_MODES = { walk: "WALK", drive: "DRIVE", transit: "TRANSIT", bicycle: "BICYCLE" };
function waypoint(v) {
  if (v && typeof v.lat === "number" && typeof v.lng === "number") {
    return { location: { latLng: { latitude: v.lat, longitude: v.lng } } };
  }
  if (typeof v === "string" && v.trim()) return { address: v.trim().slice(0, 200) };
  return null;
}
async function mapsRoute(request, env, cors) {
  if (!env.GOOGLE_MAPS_KEY) {
    return json({ status: 500, message: "中継サーバーに GOOGLE_MAPS_KEY が設定されていません" }, 500, cors);
  }
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const origin = waypoint(body.origin);
  const destination = waypoint(body.destination);
  if (!origin || !destination) return json({ status: 400, message: "出発地と目的地が必要です" }, 400, cors);
  const mode = TRAVEL_MODES[body.mode] || "WALK";
  if (mode === "TRANSIT" && env.RAPIDAPI_KEY) return navitimeTransit(body, env, cors);

  const req = { origin, destination, travelMode: mode, languageCode: "ja", regionCode: "jp", units: "METRIC" };
  if (mode === "DRIVE") req.routingPreference = "TRAFFIC_AWARE";
  const t = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  if (mode === "TRANSIT" && t(body.arrive_by)) req.arrivalTime = t(body.arrive_by);
  else if ((mode === "TRANSIT" || mode === "DRIVE") && t(body.depart_at) && Date.parse(body.depart_at) > Date.now()) req.departureTime = t(body.depart_at);

  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY,
      "X-Goog-FieldMask": [
        "routes.duration", "routes.distanceMeters", "routes.polyline.encodedPolyline",
        "routes.legs.startLocation", "routes.legs.endLocation",
        "routes.legs.steps.travelMode", "routes.legs.steps.staticDuration", "routes.legs.steps.distanceMeters",
        "routes.legs.steps.navigationInstruction.instructions", "routes.legs.steps.transitDetails",
      ].join(","),
    },
    body: JSON.stringify(req),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ status: res.status, message: data.error?.message || "route error" }, res.status, cors);
  }
  const r = data.routes?.[0];
  if (!r) return json({ route: null }, 200, cors);
  const leg = r.legs?.[0] || {};
  const ll = (p) => (p?.latLng ? { lat: p.latLng.latitude, lng: p.latLng.longitude } : null);
  const sec = (d) => (d ? parseInt(d, 10) || 0 : 0);
  const steps = (leg.steps || []).map((s) => {
    const td = s.transitDetails;
    return {
      mode: s.travelMode || mode,
      seconds: sec(s.staticDuration),
      meters: s.distanceMeters || 0,
      text: s.navigationInstruction?.instructions || "",
      transit: td ? {
        line: td.transitLine?.nameShort || td.transitLine?.name || "",
        vehicle: td.transitLine?.vehicle?.name?.text || "",
        color: td.transitLine?.color || "",
        headsign: td.headsign || "",
        from: td.stopDetails?.departureStop?.name || "",
        to: td.stopDetails?.arrivalStop?.name || "",
        depart: td.stopDetails?.departureTime || "",
        arrive: td.stopDetails?.arrivalTime || "",
        stops: td.stopCount || 0,
      } : null,
    };
  });
  return json({
    route: {
      mode,
      seconds: sec(r.duration),
      meters: r.distanceMeters || 0,
      polyline: r.polyline?.encodedPolyline || "",
      start: ll(leg.startLocation),
      end: ll(leg.endLocation),
      steps,
    },
  }, 200, cors);
}

// ===== 電車・バスの乗換検索（NAVITIME Route(totalnavi)、RapidAPI 経由） =====
// RapidAPI の無料プラン（BASIC）で使える。キーは Worker のシークレット RAPIDAPI_KEY に置く。
const NAVITIME_HOST = "navitime-route-totalnavi.p.rapidapi.com";
function jstLocal(ms) {
  // NAVITIME は日本時間の「YYYY-MM-DDThh:mm:ss」で受け取る
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19);
}
async function navitimeTransit(body, env, cors) {
  const pt = (v) => (v && typeof v.lat === "number" && typeof v.lng === "number" ? `${v.lat},${v.lng}` : null);
  const start = pt(body.origin), goal = pt(body.destination);
  if (!start || !goal) return json({ status: 400, message: "電車の検索には出発地と目的地の位置（緯度経度）が必要です" }, 400, cors);
  const q = new URLSearchParams({ start, goal, limit: "1" });
  const t = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
  if (t(body.arrive_by)) q.set("goal_time", jstLocal(t(body.arrive_by)));
  else q.set("start_time", jstLocal(Math.max(Date.now(), t(body.depart_at) || 0)));

  const res = await fetch(`https://${NAVITIME_HOST}/route_transit?${q}`, {
    headers: { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": NAVITIME_HOST },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ status: res.status, message: `NAVITIME：${data.message || data.error?.message || res.status}` }, res.status, cors);
  }
  const item = data.items?.[0];
  if (!item) return json({ route: null }, 200, cors);
  const sm = item.summary?.move || {};
  const sections = item.sections || [];
  const coord = (c) => (c && typeof c.lat === "number" ? { lat: c.lat, lng: c.lon ?? c.lng } : null);
  const steps = [];
  const path = [];
  sections.forEach((sec, i) => {
    if (sec.type === "point") { const c = coord(sec.coord); if (c) path.push(c); return; }
    if (sec.type !== "move") return;
    const prev = sections[i - 1], next = sections[i + 1];
    const minutes = Number(sec.time) || 0;
    const kind = sec.move || "";
    if (kind === "walk") {
      steps.push({ mode: "WALK", seconds: minutes * 60, meters: Number(sec.distance) || 0, text: "", transit: null });
      return;
    }
    steps.push({
      mode: "TRANSIT", seconds: minutes * 60, meters: Number(sec.distance) || 0, text: "",
      transit: {
        line: sec.line_name || sec.transport?.name || "",
        vehicle: kind,
        color: /^[0-9a-f]{6}$/i.test(sec.transport?.color || "") ? `#${sec.transport.color}` : (sec.transport?.color || ""),
        headsign: sec.transport?.links?.[0]?.destination?.name || "",
        from: prev?.name || "",
        to: next?.name || "",
        depart: sec.from_time || "",
        arrive: sec.to_time || "",
        stops: Number(sec.transport?.links?.[0]?.station_count ?? sec.stop_count ?? 0) || 0,
        fare: sec.transport?.fare?.unit_0 ?? null,
      },
    });
  });
  const fare = sm.fare?.unit_0 ?? null;
  return json({
    route: {
      mode: "TRANSIT",
      seconds: (Number(sm.time) || steps.reduce((a, s) => a + s.seconds / 60, 0)) * 60,
      meters: Number(sm.distance) || steps.reduce((a, s) => a + s.meters, 0),
      polyline: "",
      path,          // 乗り換え駅を結んだ線（実際の線路の形ではない）
      fare,          // 運賃（IC 運賃がなければ切符の運賃。取れないときは null）
      transfers: Math.max(0, steps.filter((x) => x.transit).length - 1), // 乗った列車の数 − 1
      depart: sm.from_time || "",
      arrive: sm.to_time || "",
      source: "navitime",
      start: path[0] || null,
      end: path[path.length - 1] || null,
      steps,
    },
  }, 200, cors);
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
