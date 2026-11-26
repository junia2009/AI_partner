// パラスの世界：街（第1段階）
// 画像ファイルを使わず、起動時にプログラムで街を組み立てる。単位はメートル。
// x が東、z が南、y が上。街の中心（0, 0）にパラスの家のタワーが立ち、南側（z > 640）は湾。
//
// 返すもの：
//   scene       … 描く対象（three.js の Scene）
//   update(t, dt, camera, env)  … 毎フレームの更新（時間・雨・状態の色）
//   setWeather("clear" | "rain")
//   pois        … パラスが立ち寄る場所 [{ name, pos: Vector3, yaw }]
//   heightAt(x, z) … その地点のいちばん高い建物の高さ（飛ぶ高さを決めるため）

export function createCity(THREE, opts = {}) {
  const scene = new THREE.Scene();
  const R = rng(opts.seed ?? 20261126);

  const PITCH = 80, ROAD = 16;         // 区画の間隔と道路の幅
  const CITY = 1360;                   // 建物を建てる範囲（中心から）
  const SHORE = 640;                   // これより南は湾
  const FAR_SHORE = 2600;              // 湾の向こう岸
  const TOWER = { x: 0, z: 0 };        // パラスの家のタワー

  const uniforms = {
    uTime: { value: 0 },
    uNight: { value: 1 },
    uWet: { value: 0 },
    uFogColor: { value: new THREE.Color(0x1a1428) },
    uFogDensity: { value: 1 / 3800 },
    uAccent: { value: new THREE.Color(0x7cc4ff) },
    uFlash: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    // 時間帯（太陽の向き・空の色）と高さ
    uDay: { value: 0 }, uWarm: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, -1, 0) }, uSunCol: { value: new THREE.Color(0) },
    uHor: { value: new THREE.Color(0x1a1428) }, uZen: { value: new THREE.Color(0x050a18) },
    uAlt: { value: 0 },
    uCover: { value: 0.33 }, uCoverFar: { value: 0.68 },
    uNoise: { value: makeNoiseTexture(THREE, 256, 9, opts.anisotropy || 1) },
  };
  // 昼と夜の光の当たり方。夜は今までの暗い色、昼は空の明るさと日差しで照らす
  const LIGHT = `
    uniform float uDay; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uHor; uniform vec3 uZen;
    vec3 shade(vec3 albNight, vec3 n, float dayGain) {
      vec3 night = albNight * (0.62 + 0.30 * n.y + 0.10 * n.x - 0.05 * n.z);
      vec3 amb = (uHor * 0.55 + uZen * 0.35) * (0.7 + 0.3 * n.y);
      vec3 day = albNight * dayGain * (amb + uSunCol * max(dot(n, uSunDir), 0.0) * 1.2);
      return mix(night, day, uDay);
    }`;
  const FOG = `
    uniform vec3 uFogColor; uniform float uFogDensity; uniform float uFlash;
    vec3 applyFog(vec3 col, float dist) {
      float f = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
      return mix(col, uFogColor + uFlash * 0.25, f);
    }`;
  const HASH = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float hash1(float n) { return fract(sin(n) * 43758.5453); }`;

  // ---------- 高さの地図（飛ぶ高さを決める） ----------
  const HM_CELL = 20, HM_N = Math.ceil((CITY * 2 + 200) / HM_CELL);
  const hmap = new Float32Array(HM_N * HM_N);
  const hmIndex = (x, z) => {
    const i = Math.floor((x + CITY + 100) / HM_CELL), j = Math.floor((z + CITY + 100) / HM_CELL);
    return i < 0 || j < 0 || i >= HM_N || j >= HM_N ? -1 : j * HM_N + i;
  };
  function markHeight(x0, z0, x1, z1, h) {
    for (let x = x0; x <= x1 + HM_CELL; x += HM_CELL) for (let z = z0; z <= z1 + HM_CELL; z += HM_CELL) {
      const k = hmIndex(Math.min(x, x1), Math.min(z, z1));
      if (k >= 0) hmap[k] = Math.max(hmap[k], h);
    }
  }
  function heightAt(x, z) {
    let m = 0;
    for (const dx of [-HM_CELL, 0, HM_CELL]) for (const dz of [-HM_CELL, 0, HM_CELL]) {
      const k = hmIndex(x + dx, z + dz);
      if (k >= 0) m = Math.max(m, hmap[k]);
    }
    return m;
  }

  // ---------- 建物 ----------
  // 中心ほど高く、外へ行くほど低い。湾に近い南側は少し低め。ところどころに公園（空き地）
  function baseHeight(x, z) {
    const r = Math.hypot(x * 0.9, z + 80);
    const downtown = 230 * Math.exp(-Math.pow(r / 430, 2));
    const midtown = 70 * Math.exp(-Math.pow(r / 900, 2));
    return 14 + downtown + midtown;
  }
  const blds = []; // [x, z, w, d, y0, h, seed, lit, tintR, tintG, tintB]
  const roofs = []; // 屋上の赤い航空灯 [x, y, z]
  const antennas = [];
  const half = Math.floor(CITY / PITCH);
  for (let bi = -half; bi <= half; bi++) for (let bj = -half; bj <= half; bj++) {
    const cx = bi * PITCH + PITCH / 2, cz = bj * PITCH + PITCH / 2;
    if (cz + PITCH / 2 > SHORE - 20) continue;                  // 湾
    if (Math.hypot(cx - TOWER.x, cz - TOWER.z) < 90) continue;  // タワーの広場
    const r = Math.hypot(cx, cz);
    if (r > CITY) continue;
    if (R() < (r > 700 ? 0.12 : 0.05)) continue;                // 公園
    const hb = baseHeight(cx, cz);
    const lot = PITCH - ROAD;
    const split = hb > 150 ? (R() < 0.7 ? 1 : 2) : (R() < 0.4 ? 2 : 4);
    const lots = split === 1 ? [[0, 0, lot, lot]] : split === 2
      ? (R() < 0.5 ? [[-lot / 4, 0, lot / 2, lot], [lot / 4, 0, lot / 2, lot]] : [[0, -lot / 4, lot, lot / 2], [0, lot / 4, lot, lot / 2]])
      : [[-lot / 4, -lot / 4, lot / 2, lot / 2], [lot / 4, -lot / 4, lot / 2, lot / 2], [-lot / 4, lot / 4, lot / 2, lot / 2], [lot / 4, lot / 4, lot / 2, lot / 2]];
    for (const [ox, oz, lw, ld] of lots) {
      const w = lw * (0.72 + R() * 0.24), d = ld * (0.72 + R() * 0.24);
      const x = cx + ox + (R() - 0.5) * (lw - w), z = cz + oz + (R() - 0.5) * (ld - d);
      const h = Math.max(8, hb * (0.45 + R() * 0.85));
      const tone = 0.10 + R() * 0.08;
      const tint = R() < 0.25 ? [tone * 0.9, tone, tone * 1.25] : R() < 0.5 ? [tone * 1.1, tone, tone * 0.95] : [tone, tone, tone * 1.08];
      const lit = R() < 0.15 ? 0.04 + R() * 0.06 : 0.1 + R() * 0.32; // 明かりの点いている窓の割合（ほとんど消えているビルもある）
      blds.push([x, z, w, d, 0, h, R() * 100, lit, ...tint]);
      markHeight(x - w / 2, z - d / 2, x + w / 2, z + d / 2, h);
      let top = h;
      // 高い建物は段々に細くなる
      if (h > 90 && R() < 0.6) {
        const k = 0.55 + R() * 0.25, h2 = h * (0.12 + R() * 0.25);
        blds.push([x, z, w * k, d * k, h, h2, R() * 100, lit, ...tint]);
        top = h + h2;
        markHeight(x - w / 2, z - d / 2, x + w / 2, z + d / 2, top);
        if (R() < 0.5) {
          const k2 = k * (0.5 + R() * 0.2), h3 = h * (0.06 + R() * 0.1);
          blds.push([x, z, w * k2, d * k2, top, h3, R() * 100, lit * 0.7, ...tint]);
          top += h3;
        }
      }
      if (top > 95) {
        roofs.push([x + w * 0.35, top + 1, z + d * 0.35], [x - w * 0.35, top + 1, z - d * 0.35]);
        if (R() < 0.45) {
          const ah = 10 + R() * 25;
          antennas.push([x, top, z, ah]);
          roofs.push([x, top + ah, z]);
          markHeight(x - 5, z - 5, x + 5, z + 5, top + ah);
        }
      }
    }
  }

  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const bGeo = boxGeo.clone();
  const n = blds.length;
  const aSeed = new Float32Array(n), aLit = new Float32Array(n), aTint = new Float32Array(n * 3);
  blds.forEach((b, i) => { aSeed[i] = b[6]; aLit[i] = b[7]; aTint.set([b[8], b[9], b[10]], i * 3); });
  bGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(aSeed, 1));
  bGeo.setAttribute("aLit", new THREE.InstancedBufferAttribute(aLit, 1));
  bGeo.setAttribute("aTint", new THREE.InstancedBufferAttribute(aTint, 3));
  const bMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute float aSeed; attribute float aLit; attribute vec3 aTint;
      varying vec3 vW; varying vec3 vN; varying float vSeed; varying float vLit; varying vec3 vTint; varying float vDist;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normal; vSeed = aSeed; vLit = aLit; vTint = aTint;
        vec4 mv = viewMatrix * w; vDist = length(mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uTime; uniform float uNight; uniform float uWet; uniform vec3 uCam;
      varying vec3 vW; varying vec3 vN; varying float vSeed; varying float vLit; varying vec3 vTint; varying float vDist;
      ${HASH}
      ${FOG}
      ${LIGHT}
      void main() {
        vec3 n = normalize(vN);
        vec3 base = shade(vTint, n, 3.6);
        vec3 col = base;
        if (abs(n.y) < 0.5) {
          float u = abs(n.x) > 0.5 ? vW.z : vW.x;
          vec2 cell = vec2(u / 3.2, (vW.y - 1.5) / 3.7);
          vec2 id = floor(cell), f = fract(cell);
          float face = n.x * 3.0 + n.z * 7.0;
          vec2 fw = fwidth(cell);
          vec2 wa = smoothstep(vec2(0.16, 0.22) - fw, vec2(0.16, 0.22) + fw, f) * smoothstep(vec2(0.84, 0.82) + fw, vec2(0.84, 0.82) - fw, f);
          float win = wa.x * wa.y;
          float r = hash(id + vec2(vSeed * 13.1, face));
          float on = step(1.0 - vLit, r);
          // ときどき明かりが点いたり消えたりする（ビルごとに数分おき。窓ごとにバラバラだと街全体がチカチカする）
          float slot = floor(uTime / 240.0 + vSeed);
          on = mix(on, 1.0 - on, step(0.992, hash(id * 0.71 + slot)));
          vec3 warm = mix(vec3(1.0, 0.76, 0.46), vec3(0.72, 0.86, 1.0), step(0.72, hash(id * 1.37 + vSeed)));
          float lvl = (0.3 + 0.45 * hash(id * 2.1 + face)) * (hash(id * 3.7 + vSeed) < 0.25 ? 0.35 : 1.0);
          vec3 lit = warm * lvl * on * uNight;
          // 昼の窓ガラスは空を映す
          vec3 glass = mix(base * 0.45, uZen * 0.5 + uHor * 0.25 + uSunCol * pow(max(dot(reflect(normalize(vW - uCam), n), uSunDir), 0.0), 24.0) * 0.8, uDay);
          vec3 near = mix(base * 0.95, glass, win) + lit * win;
          // 遠くは窓の模様がちらつくので、平均の明るさに置きかえる
          vec3 far = mix(base * 0.75, base * 0.7 + uZen * 0.12, uDay) + warm * vLit * uNight * 0.24;
          float aa = clamp(max(fw.x, fw.y) * 3.2 - 0.35, 0.0, 1.0);
          col = mix(near, far, aa);
          // 1 階はお店の明かり
          if (vW.y < 5.5) col += vec3(1.0, 0.72, 0.42) * 0.22 * uNight * step(0.35, hash(vec2(floor(u / 9.0), vSeed)));
          col *= 1.0 - 0.18 * uWet * (1.0 - win);
        } else {
          col = base * 0.8;
        }
        gl_FragColor = vec4(applyFog(col, vDist), 1.0);
      }`,
  });
  const bMesh = new THREE.InstancedMesh(bGeo, bMat, n);
  const m4 = new THREE.Matrix4(), q0 = new THREE.Quaternion();
  blds.forEach((b, i) => {
    m4.compose(new THREE.Vector3(b[0], b[4], b[1]), q0, new THREE.Vector3(b[2], b[5], b[3]));
    bMesh.setMatrixAt(i, m4);
  });
  bMesh.frustumCulled = false;
  scene.add(bMesh);

  // ---------- パラスの家のタワー ----------
  const tower = new THREE.Group();
  const towerMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 vW; varying vec3 vN; varying float vDist;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * w; vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform float uNight; uniform vec3 uAccent;
      varying vec3 vW; varying vec3 vN; varying float vDist;
      ${FOG}
      ${LIGHT}
      void main() {
        vec3 n = normalize(vN);
        vec3 col = shade(vec3(0.13, 0.15, 0.2), n, 2.8);
        // 縦に走る光の筋（パラスの色）。上へ向かって流れる
        float stripe = smoothstep(0.92, 1.0, abs(sin(atan(vW.z, vW.x) * 4.0)));
        float flow = 0.5 + 0.5 * sin(vW.y * 0.06 - uTime * 1.6);
        col += uAccent * stripe * (0.25 + 0.6 * flow) * (0.4 + 0.6 * uNight);
        float floors = step(0.85, fract(vW.y / 4.0));
        col += vec3(0.6, 0.75, 1.0) * floors * 0.08 * uNight;
        gl_FragColor = vec4(applyFog(col, vDist), 1.0);
      }`,
  });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(13, 20, 250, 8, 1), towerMat);
  shaft.position.y = 125; tower.add(shaft);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(26, 22, 18, 24, 1), towerMat);
  deck.position.y = 258; tower.add(deck);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(6, 14, 60, 8, 1), towerMat);
  crown.position.y = 297; tower.add(crown);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 2, 60, 6, 1), towerMat);
  mast.position.y = 357; tower.add(mast);
  // 展望リングの光の帯（パラスの色）
  const ringMat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; varying float vDist;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uAccent; varying vec2 vUv; varying float vDist;
      void main() {
        float band = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.65, vUv.y);
        float dash = 0.65 + 0.35 * sin(vUv.x * 160.0 - uTime * 3.0);
        gl_FragColor = vec4(uAccent * band * dash * 1.3, 1.0);
      }`,
  });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(26.6, 26.6, 4, 48, 1, true), ringMat);
  ring.position.y = 260; tower.add(ring);
  tower.position.set(TOWER.x, 0, TOWER.z);
  scene.add(tower);
  markHeight(-30, -30, 30, 30, 390);
  roofs.push([0, 388, 0], [0, 268, 0]);

  // アンテナ（細い棒）
  if (antennas.length) {
    const aGeo = new THREE.CylinderGeometry(0.35, 0.6, 1, 5, 1).translate(0, 0.5, 0);
    const aMesh = new THREE.InstancedMesh(aGeo, towerMat, antennas.length);
    antennas.forEach(([x, y, z, h], i) => { m4.compose(new THREE.Vector3(x, y, z), q0, new THREE.Vector3(1, h, 1)); aMesh.setMatrixAt(i, m4); });
    aMesh.frustumCulled = false;
    scene.add(aMesh);
  }

  // ---------- 地面（道路・街灯・郊外の家の明かり） ----------
  // 湾の水面（地面と同じ板の中で描く。板を重ねると、遠くで前後が乱れてチラつくため）
  const WATER = `
    vec3 waterCol(vec3 vW) {
        vec3 col = vec3(0.02, 0.03, 0.05);
        float wave = sin(vW.x * 0.08 + uTime * 0.9) * sin(vW.z * 0.11 - uTime * 0.7) + 0.5 * sin(vW.x * 0.31 - vW.z * 0.2 + uTime * 1.7);
        // 昼：空を映し、日差しがきらめく
        vec3 wn = normalize(vec3(0.12 * cos(vW.x * 0.08 + uTime * 0.9) + 0.06 * cos(vW.x * 0.31 - vW.z * 0.2 + uTime * 1.7), 1.0, 0.1 * sin(vW.z * 0.11 - uTime * 0.7)));
        vec3 vdir = normalize(vW - uCam);
        float fres = 0.08 + 0.92 * pow(1.0 - max(dot(-vdir, wn), 0.0), 5.0);
        vec3 dayW = mix(vec3(0.03, 0.1, 0.16) * (uZen + 0.3), mix(uHor, uZen, 0.45) * (0.55 + 0.25 * wave), fres * 0.55);
        dayW += uSunCol * pow(max(dot(reflect(vdir, wn), uSunDir), 0.0), 140.0) * 2.5;
        col = mix(col, dayW, uDay);
        // 岸の明かりの映り込み：岸からの距離で弱まる縦の帯
        float fromShore = vW.z - ${SHORE}.0;
        float band = pow(hash(vec2(floor(vW.x / 7.0), 0.0)), 6.0);
        float shimmer = 0.5 + 0.5 * sin(vW.z * 0.9 + wave * 3.0 + uTime * 2.0);
        col += vec3(1.0, 0.72, 0.45) * band * shimmer * exp(-fromShore / 380.0) * 0.55 * uNight;
        // 向こう岸の明かり
        float fromFar = ${FAR_SHORE}.0 - vW.z;
        col += vec3(0.9, 0.75, 0.6) * band * shimmer * exp(-fromFar / 200.0) * 0.25 * uNight;
        // 橋の明かりの映り込み
        float bx = abs(vW.x - 300.0);
        col += vec3(1.0, 0.85, 0.6) * smoothstep(14.0, 0.0, bx + wave * 3.0) * 0.18 * uNight;
        // タワーの光の映り込み
        col += uAccent * smoothstep(30.0, 0.0, abs(vW.x) + wave * 6.0) * exp(-fromShore / 900.0) * 0.12 * uNight;
        col += vec3(0.03, 0.04, 0.06) * wave * 0.3;
        return col;
    }`;

  const groundMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 vW; varying float vDist;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform float uNight; uniform float uWet; uniform vec3 uCam; uniform vec3 uAccent;
      varying vec3 vW; varying float vDist;
      ${HASH}
      ${FOG}
      ${LIGHT}
      ${WATER}
      void main() {
        vec2 p = vW.xz;
        float r = length(p);
        vec3 col = vec3(0.045, 0.05, 0.06);
        // 昼の地面：街の外は畑や林のまだら
        float fpatch = hash(floor(p / 140.0));
        vec3 fields = mix(vec3(0.17, 0.21, 0.12), vec3(0.25, 0.24, 0.17), fpatch) * (0.85 + 0.3 * hash(floor(p / 23.0)));
        // 街の中：道路と歩道
        float inCity = 1.0 - smoothstep(${CITY + 60}.0, ${CITY + 160}.0, r);
        vec2 g = mod(p, ${PITCH}.0); vec2 gd = min(g, ${PITCH}.0 - g); // 道路の中心線からの距離
        float road = max(step(gd.x, ${ROAD / 2}.0), step(gd.y, ${ROAD / 2}.0));
        vec3 asphalt = vec3(0.035, 0.038, 0.045);
        vec3 walk = vec3(0.08, 0.08, 0.085);
        col = mix(col, mix(walk, asphalt, road), inCity);
        vec3 dayCol = mix(fields, mix(vec3(0.33, 0.32, 0.31), vec3(0.15, 0.155, 0.165), road), inCity);
        dayCol *= (uHor * 0.25 + uZen * 0.3 + uSunCol * max(uSunDir.y, 0.0) * 1.0) * 1.25;
        dayCol *= 1.0 - 0.35 * uWet;
        col = mix(col, dayCol, uDay);
        // 街灯：道路の両側に 25m おき。光だまりを描く
        vec2 lp = vec2(mod(p.x, 25.0) - 12.5, mod(p.y, 25.0) - 12.5);
        float sx = abs(gd.x - ${ROAD / 2}.0), sz = abs(gd.y - ${ROAD / 2}.0);
        float lamp = exp(-(sx * sx + lp.y * lp.y) / 60.0) + exp(-(sz * sz + lp.x * lp.x) / 60.0);
        vec3 lampCol = vec3(1.0, 0.62, 0.3);
        col += lampCol * lamp * 0.32 * uNight * inCity;
        // 雨のときは、濡れた路面に街灯が縦に長く映る
        col += lampCol * exp(-(sx * sx) / 20.0) * 0.14 * uWet * uNight * inCity;
        col += vec3(0.5, 0.6, 0.8) * 0.02 * uWet;
        // 郊外：家の明かりがぽつぽつ
        vec2 cell = floor(p / 18.0);
        float h = hash(cell);
        vec2 f = fract(p / 18.0) - 0.5;
        float dotL = smoothstep(0.12, 0.0, length(f)) * step(0.72, h) * (1.0 - inCity);
        float suburb = smoothstep(${CITY}.0, ${CITY + 400}.0, r) * (1.0 - smoothstep(9000.0, 16000.0, r) * 0.7);
        col += mix(vec3(1.0, 0.75, 0.45), vec3(0.8, 0.9, 1.0), step(0.9, h)) * dotL * suburb * uNight * 0.9;
        // 郊外の幹線道路（遠くへのびる光の線）
        float hw = min(abs(mod(p.x + 400.0, 1200.0) - 600.0), abs(mod(p.y + 400.0, 1500.0) - 750.0));
        col += vec3(1.0, 0.6, 0.3) * smoothstep(5.0, 0.0, hw) * 0.35 * suburb * uNight;
        if (vW.z > ${SHORE}.0 && vW.z < ${FAR_SHORE}.0 && abs(vW.x) < 7000.0) col = waterCol(vW);
        gl_FragColor = vec4(applyFog(col, vDist), 1.0);
      }`,
  });
  groundMat.polygonOffset = true; groundMat.polygonOffsetFactor = 4; groundMat.polygonOffsetUnits = 8; // 湾の水面とのチラつき防止
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000, 1, 1).rotateX(-Math.PI / 2), groundMat);
  scene.add(ground);

  // ---------- 湾（水面に街の明かりが揺れて映る） ----------
  // ---------- 湾にかかる橋 ----------
  const concreteMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 vN; varying float vDist;
      void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `${FOG}
      ${LIGHT}
      varying vec3 vN; varying float vDist;
      void main() { vec3 n = normalize(vN); vec3 col = shade(vec3(0.075, 0.08, 0.095), n, 4.0); gl_FragColor = vec4(applyFog(col, vDist), 1.0); }`,
  });
  const bridge = new THREE.Group();
  const deckMesh = new THREE.Mesh(new THREE.BoxGeometry(26, 3, FAR_SHORE - SHORE + 80), concreteMat);
  deckMesh.position.set(300, 42, (SHORE + FAR_SHORE) / 2);
  bridge.add(deckMesh);
  const pylonZ = [SHORE + 650, FAR_SHORE - 650];
  for (const pz of pylonZ) for (const px of [287, 313]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(5, 170, 6).translate(0, 85, 0), concreteMat);
    p.position.set(px, 0, pz); bridge.add(p);
  }
  // ケーブル
  const cable = [];
  for (const pz of pylonZ) for (const side of [287, 313]) for (let k = 1; k <= 14; k++) {
    for (const dir of [-1, 1]) {
      cable.push(side, 168 - k * 2, pz, side, 44, pz + dir * k * 22);
    }
  }
  const cableGeo = new THREE.BufferGeometry();
  cableGeo.setAttribute("position", new THREE.Float32BufferAttribute(cable, 3));
  bridge.add(new THREE.LineSegments(cableGeo, new THREE.LineBasicMaterial({ color: 0x3a4250, transparent: true, opacity: 0.6 })));
  scene.add(bridge);
  markHeight(280, SHORE, 320, Math.min(FAR_SHORE, CITY), 45);

  // ---------- 光の粒（街灯の先・車・航空灯・橋の明かり） ----------
  const glowPts = [];   // [x, y, z, r, g, b, size, blink]
  for (const [x, y, z] of roofs) glowPts.push([x, y, z, 1.0, 0.12, 0.1, 5, 1]);
  for (let z = SHORE; z <= FAR_SHORE; z += 30) for (const x of [288, 312]) glowPts.push([x, 45, z, 1.0, 0.86, 0.6, 3.2, 0]);
  for (const pz of pylonZ) for (const px of [287, 313]) glowPts.push([px, 172, pz, 1.0, 0.15, 0.1, 6, 1]);
  const gp = new THREE.BufferGeometry();
  gp.setAttribute("position", new THREE.Float32BufferAttribute(glowPts.flatMap((p) => p.slice(0, 3)), 3));
  gp.setAttribute("aColor", new THREE.Float32BufferAttribute(glowPts.flatMap((p) => p.slice(3, 6)), 3));
  gp.setAttribute("aSize", new THREE.Float32BufferAttribute(glowPts.map((p) => p[6]), 1));
  gp.setAttribute("aBlink", new THREE.Float32BufferAttribute(glowPts.map((p) => p[7]), 1));
  const pointMat = (vertexBody) => new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform float uTime; uniform float uNight; uniform float uPx;
      attribute vec3 aColor; attribute float aSize;
      varying vec3 vColor; varying float vA;
      ${HASH}
      ${vertexBody}`,
    fragmentShader: `varying vec3 vColor; varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5; float d = length(c);
        float a = exp(-d * d * 18.0) + 0.35 * exp(-d * d * 4.0);
        gl_FragColor = vec4(vColor * a * vA, 1.0);
      }`,
  });
  uniforms.uPx = { value: 800 };
  const glowMat = pointMat(`
    attribute float aBlink;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      mv.xyz *= 0.996; // 屋上や橋の面と前後を争わないよう、ほんの少し手前に描く
      float blink = aBlink > 0.5 ? step(0.55, fract(uTime * 0.6 + hash1(position.x * 0.13 + position.z))) : 1.0;
      vColor = aColor; vA = blink * (0.12 + 0.88 * uNight) * smoothstep(6.0, 40.0, -mv.z);
      gl_PointSize = clamp(aSize * uPx / -mv.z, 1.5, 16.0);
      gl_Position = projectionMatrix * mv;
    }`);
  const glowPoints = new THREE.Points(gp, glowMat);
  glowPoints.frustumCulled = false;
  scene.add(glowPoints);

  // 車：道路に沿って流れるヘッドライト（白）とテールライト（赤）
  const cars = [];
  const roadLines = [];
  for (let k = -half; k <= half; k++) {
    const c = k * PITCH;
    if (Math.abs(c) > CITY - 40) continue;
    roadLines.push({ axis: 0, at: c, from: -CITY, to: Math.min(CITY, SHORE - 10), y: 0.9 });   // 南北の道
    if (c < SHORE - 10) roadLines.push({ axis: 1, at: c, from: -CITY, to: CITY, y: 0.9 });       // 東西の道
  }
  roadLines.push({ axis: 0, at: 300, from: SHORE - 10, to: FAR_SHORE + 600, y: 44 });              // 橋
  for (const L of roadLines) {
    const busy = Math.exp(-Math.pow(L.at / 700, 2)) * 0.7 + 0.3;
    const count = Math.round(((L.to - L.from) / 90) * busy * (L.y > 10 ? 2.2 : 1));
    for (let i = 0; i < count; i++) {
      const dir = R() < 0.5 ? 1 : -1;
      const lane = dir * (2.2 + (R() < 0.5 ? 0 : 3.2));
      const speed = (9 + R() * 9) * dir;
      const phase = R();
      // 進む向きの先頭は白、後ろは赤（こちらから見たときの見え方は気にしない）
      cars.push([L.axis, L.at + lane, L.from, L.to, speed, phase, L.y, 1]);
      cars.push([L.axis, L.at + lane, L.from, L.to, speed, phase, L.y, 0]);
    }
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(cars.length * 3), 3));
  cg.setAttribute("aCar", new THREE.Float32BufferAttribute(cars.flatMap((c) => [c[0], c[1], c[2], c[3]]), 4));
  cg.setAttribute("aMove", new THREE.Float32BufferAttribute(cars.flatMap((c) => [c[4], c[5], c[6], c[7]]), 4));
  cg.setAttribute("aColor", new THREE.Float32BufferAttribute(cars.flatMap(() => [1, 1, 1]), 3));
  cg.setAttribute("aSize", new THREE.Float32BufferAttribute(cars.map(() => 2.2), 1));
  const carMat = pointMat(`
    attribute vec4 aCar; attribute vec4 aMove;
    void main() {
      float len = aCar.w - aCar.z;
      float s = fract(aMove.y + uTime * aMove.x / len);
      float along = aCar.z + s * len;
      float lead = aMove.w > 0.5 ? 0.0 : -sign(aMove.x) * 4.0;
      vec3 p = aCar.x < 0.5 ? vec3(aCar.y, aMove.z, along + lead) : vec3(along + lead, aMove.z, aCar.y);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      mv.xyz *= 0.996; // 地面と前後を争わないよう、ほんの少し手前に描く
      vColor = aMove.w > 0.5 ? vec3(1.0, 0.95, 0.85) : vec3(1.0, 0.12, 0.08);
      float edge = smoothstep(0.0, 0.03, s) * smoothstep(1.0, 0.97, s);
      vA = edge * (aMove.w > 0.5 ? 0.9 : 0.75) * (0.06 + 0.94 * uNight);
      vA *= smoothstep(4.0, 25.0, -mv.z);
      gl_PointSize = clamp(aSize * uPx / -mv.z, 1.0, 12.0);
      gl_Position = projectionMatrix * mv;
    }`);
  const carPoints = new THREE.Points(cg, carMat);
  carPoints.frustumCulled = false;
  scene.add(carPoints);

  // ---------- 遠くの山並み ----------
  {
    const seg = 220, geo = new THREE.BufferGeometry(), pos = [], idx = [];
    const RR = 5600;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const hh = 160 + 260 * (0.5 + 0.5 * Math.sin(a * 3 + 1)) * (0.6 + 0.4 * Math.sin(a * 7.3)) + 120 * Math.sin(a * 17.1) ** 2;
      pos.push(Math.cos(a) * RR, -20, Math.sin(a) * RR, Math.cos(a) * RR, hh, Math.sin(a) * RR);
      if (i < seg) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mMat = new THREE.ShaderMaterial({
      uniforms, side: THREE.DoubleSide,
      vertexShader: `varying float vDist; varying float vY;
        void main() { vY = position.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `${FOG}
        varying float vDist; varying float vY;
        uniform float uDay; uniform vec3 uHor;
        void main() { vec3 col = mix(vec3(0.03, 0.035, 0.05), vec3(0.12, 0.15, 0.18) + uHor * 0.15, uDay); gl_FragColor = vec4(applyFog(col, vDist * 0.92), 1.0); }`,
    });
    scene.add(new THREE.Mesh(geo, mMat));
  }

  // ---------- 空（夜空・街明かり・星・月） ----------
  const skyMat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false,
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform float uTime; uniform float uWet; uniform float uFlash; uniform float uDay; uniform float uWarm; uniform float uAlt;
      uniform vec3 uHor; uniform vec3 uZen; uniform vec3 uSunDir; uniform vec3 uSunCol;
      varying vec3 vDir;
      ${HASH}
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y + uAlt * 0.07;           // 高く昇るほど地平線が下がる
        vec3 col = mix(uHor, uZen, smoothstep(0.0, 0.5, y));
        // 朝焼け・夕焼け：太陽の方角の地平が赤く染まる
        vec2 hd = normalize(d.xz + 1e-4), sd = normalize(uSunDir.xz + 1e-4);
        float toward = pow(max(dot(hd, sd), 0.0), 3.0) * exp(-max(y, 0.0) * 5.0);
        col += vec3(1.0, 0.42, 0.18) * uWarm * toward * 0.7 * (1.0 - 0.7 * uWet);
        // 夜：街明かりで地平がぼんやり明るい
        col += vec3(0.22, 0.11, 0.14) * exp(-max(y, 0.0) * 14.0) * (1.0 - 0.4 * uWet) * (1.0 - uDay) * (1.0 - uAlt);
        // 太陽
        float sdt = dot(d, uSunDir);
        col += uSunCol * (smoothstep(0.9990, 0.9994, sdt) * 5.0 + pow(max(sdt, 0.0), 220.0) * 0.7 + pow(max(sdt, 0.0), 14.0) * 0.06) * (1.0 - 0.85 * uWet);
        // 高空：空が黒くなり、地平線に青い大気の帯が残る
        float limb = exp(-abs(y) * 22.0);
        vec3 space = vec3(0.004, 0.007, 0.018) + vec3(0.08, 0.2, 0.55) * limb * 0.6 + uHor * limb * 0.5;
        col = mix(col, space, uAlt); // 地平線より下も（白い帯が残らないように）
        // 星（夜か、高い空で見える。雨の日は見えない）
        float starVis = max(1.0 - uDay, uAlt * 0.85) * (1.0 - uWet);
        vec3 sp = d * 300.0;
        vec3 sc = floor(sp);
        float s = hash(sc.xy + sc.z * 17.31);
        float dotS = smoothstep(0.42, 0.0, length(fract(sp) - 0.5));
        float star = step(0.985 - uAlt * 0.01, s) * dotS * smoothstep(0.02 - uAlt * 0.1, 0.3, y) * (0.6 + 0.4 * sin(uTime * (1.5 + s * 3.0) + s * 40.0));
        col += vec3(0.85, 0.9, 1.0) * star * starVis;
        // 天の川（高空でいちばんよく見える）
        float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.55, -0.76))), 2.0) * 30.0);
        col += vec3(0.16, 0.15, 0.22) * band * (0.4 + 0.6 * hash(floor(sp.xz * 0.6))) * starVis * (0.25 + 0.75 * uAlt);
        // 月
        vec3 moonDir = normalize(vec3(-0.45, 0.42, -0.78));
        float md = dot(d, moonDir);
        float moonVis = (1.0 - uDay) * (1.0 - uWet);
        col += vec3(0.95, 0.93, 0.85) * smoothstep(0.9993, 0.9996, md) * moonVis;
        col += vec3(0.25, 0.28, 0.35) * pow(max(md, 0.0), 300.0) * moonVis;
        // 流れ星（ときどき）
        float slot = floor(uTime / 7.0), ph = fract(uTime / 7.0) * 7.0;
        if (hash1(slot * 1.7) > 0.5 && ph < 0.9) {
          vec3 a0 = normalize(vec3(hash1(slot) * 2.0 - 1.0, 0.35 + 0.4 * hash1(slot * 3.1), hash1(slot * 5.3) * 2.0 - 1.0));
          vec3 dm = normalize(cross(a0, vec3(0.0, 1.0, 0.0)) + vec3(0.0, -0.5, 0.0));
          vec3 p0 = normalize(a0 + dm * ph * 0.25), p1 = normalize(a0 + dm * max(ph - 0.2, 0.0) * 0.25);
          vec3 ab = p0 - p1; float tt = clamp(dot(d - p1, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
          col += vec3(0.9, 0.95, 1.0) * smoothstep(0.0025, 0.0, length(d - (p1 + ab * tt))) * tt * (1.0 - ph / 0.9) * starVis;
        }
        col += vec3(0.6, 0.65, 0.8) * uFlash * (0.4 + 0.6 * smoothstep(-0.1, 0.5, y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat); // カメラについて動く
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // ---------- 雨（カメラのまわりだけに降らせる） ----------
  const RAIN_N = 2600, BOX = new THREE.Vector3(60, 40, 60);
  const rp = new Float32Array(RAIN_N * 2 * 3), re = new Float32Array(RAIN_N * 2);
  for (let i = 0; i < RAIN_N; i++) {
    const x = R() * BOX.x, y = R() * BOX.y, z = R() * BOX.z;
    rp.set([x, y, z, x, y, z], i * 6);
    re[i * 2] = 0; re[i * 2 + 1] = 1;
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute("position", new THREE.Float32BufferAttribute(rp, 3));
  rg.setAttribute("aEnd", new THREE.Float32BufferAttribute(re, 1));
  const rainMat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uBox: { value: BOX } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; attribute float aEnd; varying float vA;
      void main() {
        vec3 p = position;
        p.y -= uTime * 22.0; p.x -= uTime * 3.0;
        p = mod(p - uCam, uBox) + uCam - uBox * 0.5;
        p += aEnd * vec3(0.4, 2.2, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vA = (1.0 - smoothstep(10.0, 30.0, length(mv.xyz))) * (0.35 + 0.65 * aEnd);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uWet; varying float vA; void main() { gl_FragColor = vec4(vec3(0.55, 0.62, 0.75) * vA * 0.5 * uWet, 1.0); }`,
  });
  const rain = new THREE.LineSegments(rg, rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  // ---------- 雲の層（高さ 1100〜1340m） ----------
  // 薄い板を何枚も重ねて、厚みのある雲に見せる。街の上はまばらで、遠くへ行くほど雲海になる
  const CLOUD_BASE = 1100, CLOUD_TOP = 1340, CLOUD_N = 7;
  const clouds = [];
  const cloudGeo = new THREE.PlaneGeometry(90000, 90000, 1, 1).rotateX(-Math.PI / 2);
  for (let k = 0; k < CLOUD_N; k++) {
    const f = k / (CLOUD_N - 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uSlice: { value: f } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec3 vW; varying float vDist;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uNoise; uniform float uSlice; uniform float uTime; uniform float uCover; uniform float uCoverFar;
        uniform float uDay; uniform float uWarm; uniform float uNight; uniform float uWet; uniform vec3 uSunCol; uniform vec3 uHor; uniform vec3 uSunDir; uniform vec3 uCam;
        varying vec3 vW; varying float vDist;
        ${FOG}
        void main() {
          vec2 uv = vW.xz / 7000.0 + vec2(uTime * 0.0008, uTime * 0.0003);
          float n = texture2D(uNoise, uv).r * 0.5 + texture2D(uNoise, uv * 2.7 + 0.37).r * 0.32 + texture2D(uNoise, uv * 8.3 + 0.71).r * 0.18;
          n = (n - 0.5) * 1.7 + 0.5; // 濃淡をはっきりさせる
          // 太陽の側が明るく、反対側が陰になる（少しずらした所の濃さと比べる）
          float n2 = texture2D(uNoise, uv * 2.7 + 0.37 + normalize(uSunDir.xz + 1e-4) * 0.006).r;
          float lightSide = clamp(0.5 + (texture2D(uNoise, uv * 2.7 + 0.37).r - n2) * 9.0, 0.0, 1.0);
          float r = length(vW.xz);
          float cov = mix(uCover, uCoverFar, smoothstep(2500.0, 8000.0, r));
          float dens = n - (1.0 - cov) - abs(uSlice - 0.35) * 0.24;
          float a = smoothstep(0.0, 0.07, dens);
          if (a < 0.01) discard;
          vec3 top = mix(vec3(0.15, 0.17, 0.25), mix(vec3(1.0), vec3(1.0, 0.7, 0.52), uWarm) * (0.55 + 0.45 * uSunCol.g + 0.2), uDay);
          vec3 low = mix(vec3(0.045, 0.045, 0.08), mix(vec3(0.55, 0.6, 0.7), vec3(0.42, 0.3, 0.42), uWarm), uDay);
          vec3 col = mix(low, top, clamp(uSlice * 0.45 + (dens - 0.05) * 2.6 + (lightSide - 0.5) * 0.6 * uDay, 0.0, 1.0));
          col = mix(col, col * vec3(0.7, 0.72, 0.78), uWet);
          // 夜は、街の明かりが雲の底を橙色に照らす
          col += vec3(0.3, 0.14, 0.09) * (1.0 - uSlice) * uNight * exp(-r / 2600.0);
          float edge = 1.0 - smoothstep(16000.0, 26000.0, length(vW.xz - uCam.xz));
          gl_FragColor = vec4(applyFog(col, vDist * 0.15), a * 0.5 * edge);
        }`,
    });
    const m = new THREE.Mesh(cloudGeo, mat);
    m.position.y = CLOUD_BASE + f * (CLOUD_TOP - CLOUD_BASE);
    m.frustumCulled = false;
    scene.add(m);
    clouds.push(m);
  }

  // ---------- パラスの立ち寄り先 ----------
  // 道路の交差点の上か、建物より十分高い場所。yaw はカメラが向く方角（0 = 北向き）
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const yawTo = (from, x, z) => Math.atan2(-(x - from.x), -(z - from.z));
  // orbit … 待機中にカメラが回り込む幅（狭い場所では小さく）
  const pois = [
    { name: "タワーの展望リングのそば", pos: V(52, 262, 52), look: [300, 900], orbit: 0.7 },
    { name: "大通りの上", pos: V(0, 72, -620), look: [0, 0], orbit: 0.16 },
    { name: "ビルの谷間", pos: V(-160, 48, -160), look: [400, -160], orbit: 0.2, canyon: true },
    { name: "湾にかかる橋のそば", pos: V(390, 64, 960), look: [-100, -200], orbit: 0.55 },
    { name: "港の岸辺", pos: V(-480, 24, 600), look: [300, 1300], orbit: 0.5 },
    { name: "街を見下ろす高い空", pos: V(-700, 460, 560), look: [0, -150], orbit: 0.45 },
    { name: "東の街外れ", pos: V(1040, 80, -320), look: [0, -80], orbit: 0.4 },
    { name: "タワーのふもとの広場", pos: V(-30, 26, 70), look: [0, 0], orbit: 0.35, up: 0.5 },
  ];
  // 雲の上：街から少し離れた雲海の上
  const cloudPois = [
    { name: "雲海の上", pos: V(9500, 1560, -7000), look: [0, 0], orbit: 0.6 },
    { name: "雲の切れ間の上", pos: V(-3600, 1480, -2600), look: [0, 0], orbit: 0.5 },
    { name: "雲の峰のそば", pos: V(11000, 1450, 6000), look: [20000, 9000], orbit: 0.55 },
    { name: "高い雲の上", pos: V(-12000, 2600, 4000), look: [0, 0], orbit: 0.45 },
  ];
  // 星空：雲よりずっと上の成層圏
  const spacePois = [
    { name: "成層圏", pos: V(0, 12000, 7000), look: [0, -4000], orbit: 0.5 },
    { name: "星に近い空", pos: V(-9000, 15500, -4000), look: [0, 0], orbit: 0.6 },
    { name: "大気のふち", pos: V(7000, 13500, -8000), look: [-3000, 4000], orbit: 0.5 },
  ];
  for (const p of [...pois, ...cloudPois, ...spacePois]) {
    const ground = heightAt(p.pos.x, p.pos.z);
    if (!p.canyon && p.pos.y < ground + 12) p.pos.y = ground + 12; // 谷間は交差点の上なので、そのままの高さ
    p.yaw = yawTo(p.pos, p.look[0], p.look[1]);
  }

  // ---------- 天気と時間 ----------
  let weather = "clear", wet = 0, flash = 0, nextFlash = 8;
  function setWeather(wth) { weather = wth === "rain" ? "rain" : "clear"; }
  let cloudStep = 1;
  function setQuality(level) {
    // 画質が低いときは雲の板を間引く
    cloudStep = level <= 1 ? 2 : 1;
    clouds.forEach((c, i) => { c.visible = i % cloudStep === 0 || i === clouds.length - 1; });
  }

  const C = (h) => new THREE.Color(h);
  const NIGHT_HOR = C(0x1a1428), NIGHT_ZEN = C(0x050a18), RAIN_NIGHT = C(0x141a24);
  const DAY_HOR = new THREE.Color(0.62, 0.76, 0.9), DAY_ZEN = new THREE.Color(0.16, 0.36, 0.72);
  const WARM_HOR = new THREE.Color(1.0, 0.5, 0.32), WARM_ZEN = new THREE.Color(0.24, 0.24, 0.5);
  const RAIN_DAY = new THREE.Color(0.42, 0.45, 0.5);
  const sunWhite = new THREE.Color(1, 0.97, 0.9), sunWarm = new THREE.Color(1.0, 0.55, 0.28);
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const _c = new THREE.Color(), _c2 = new THREE.Color();

  function update(t, dt, camera, env = {}) {
    uniforms.uTime.value = t;
    wet += ((weather === "rain" ? 1 : 0) - wet) * Math.min(1, dt * 0.5);
    uniforms.uWet.value = wet;
    rain.visible = wet > 0.02;

    // 太陽（env.sunDir：外から渡す。ない時は夜）
    const sun = env.sunDir || uniforms.uSunDir.value.set(0.3, -0.5, 0.2).normalize();
    uniforms.uSunDir.value.copy(sun).normalize();
    const sy = uniforms.uSunDir.value.y;
    const day = sm(-0.12, 0.18, sy);
    const warm = sm(0.4, 0.03, sy) * sm(-0.24, -0.03, sy);
    uniforms.uDay.value = day;
    uniforms.uWarm.value = warm;
    uniforms.uNight.value = 1 - sm(-0.14, 0.1, sy);
    const k = Math.min(1, day + warm * 0.6);
    const hor = uniforms.uHor.value, zen = uniforms.uZen.value;
    hor.copy(NIGHT_HOR).lerp(_c.copy(DAY_HOR).lerp(WARM_HOR, warm), k);
    zen.copy(NIGHT_ZEN).lerp(_c.copy(DAY_ZEN).lerp(WARM_ZEN, warm * 0.7), Math.min(1, day * 0.9 + warm * 0.3));
    // 雨：空も地平も灰色に
    hor.lerp(_c2.copy(RAIN_NIGHT).lerp(RAIN_DAY, day), wet * 0.8);
    zen.lerp(_c2.copy(RAIN_NIGHT).multiplyScalar(0.7).lerp(_c.copy(RAIN_DAY).multiplyScalar(0.85), day), wet * 0.8);
    uniforms.uSunCol.value.copy(sunWhite).lerp(sunWarm, warm).multiplyScalar(day * (1 - 0.6 * wet));
    uniforms.uFogColor.value.copy(hor);

    // 高さ：高いほど霧が薄くなり、空が宇宙の色になる
    uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    const camY = uniforms.uCam.value.y;
    uniforms.uAlt.value = sm(2500, 13000, camY);
    // 高く昇るほど、霧（遠くの色）も宇宙の暗い色へ。白くかすんだまま宇宙へ出ないように
    uniforms.uFogColor.value.lerp(_c.setRGB(0.012, 0.025, 0.06), sm(3000, 22000, camY) * 0.9);
    uniforms.uFogDensity.value = 1 / ((3800 - 2300 * wet) * (1 + Math.max(0, camY - 300) / 650));
    sky.position.copy(uniforms.uCam.value);
    // 雲：雨の日は空一面。カメラが雲より上なら下の板から、下なら上の板から描く
    uniforms.uCover.value = 0.33 + 0.62 * wet;
    uniforms.uCoverFar.value = 0.68 + 0.27 * wet;
    const above = camY > (CLOUD_BASE + CLOUD_TOP) / 2;
    clouds.forEach((c, i) => { c.renderOrder = above ? i : CLOUD_N - i; });

    // 雨の夜は、ときどき遠くで稲光
    if (weather === "rain" && !env.reduceMotion) {
      nextFlash -= dt;
      if (nextFlash < 0) { flash = 1; nextFlash = 14 + Math.random() * 30; }
    }
    flash = Math.max(0, flash - dt * (flash > 0.5 ? 2.5 : 1.2));
    uniforms.uFlash.value = flash > 0 ? flash * (0.6 + 0.4 * Math.sin(t * 60)) * (1 - day * 0.7) : 0;
    if (env.accent) uniforms.uAccent.value.copy(env.accent);
    uniforms.uPx.value = env.px ?? 800;
  }

  return {
    scene, update, setWeather, setQuality, heightAt, tower: TOWER, uniforms, clouds,
    pois: { city: pois, clouds: cloudPois, space: spacePois },
  };

}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 横にも縦にもくり返す値ノイズ（雲の形に使う）
function makeNoiseTexture(THREE, N, seed, anisotropy = 1) {
  const R = rng(seed);
  const grid = (g) => { const v = new Float32Array(g * g); for (let i = 0; i < v.length; i++) v[i] = R(); return v; };
  const data = new Uint8Array(N * N * 4);
  const octs = [[8, 0.5], [16, 0.25], [32, 0.15], [64, 0.1]].map(([g, w]) => ({ g, w, v: grid(g) }));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let sum = 0;
    for (const o of octs) {
      const fx = (x / N) * o.g, fy = (y / N) * o.g;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const u = tx * tx * (3 - 2 * tx), w = ty * ty * (3 - 2 * ty);
      const at = (i, j) => o.v[((j % o.g) * o.g) + (i % o.g)];
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      sum += (a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w) * o.w;
    }
    const v = Math.round(Math.min(1, Math.max(0, sum)) * 255);
    data.set([v, v, v, 255], (y * N + x) * 4);
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}
