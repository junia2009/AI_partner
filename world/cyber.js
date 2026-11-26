// パラスの世界：電脳空間（第2段階）
// パラスの家のタワーの奥深くにある、情報の中枢。静かで精密な空間で、色はパラスの状態の色ひとつだけ。
// 画像ファイルを使わず、起動時にプログラムで組み立てる。単位はメートル。
//
// 返すもの：scene / update(t, dt, camera, env) / pois / setQuality(level)

export function createCyber(THREE, opts = {}) {
  const scene = new THREE.Scene();
  const R = rng(opts.seed ?? 7071);
  const uniforms = {
    uTime: { value: 0 },
    uAccent: { value: new THREE.Color(0x7cc4ff) },
    uCam: { value: new THREE.Vector3() },
    uPx: { value: 800 },
    uFog: { value: new THREE.Color(0x050b16) },
  };
  const FOG = `
    uniform vec3 uFog;
    vec3 applyFog(vec3 col, float dist, float density) {
      float f = 1.0 - exp(-pow(dist * density, 2.0));
      return mix(col, uFog, f);
    }`;
  const HASH = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float hash1(float n) { return fract(sin(n) * 43758.5453); }`;
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

  // ---------- 空（暗い紺。うっすら経緯線のドーム） ----------
  const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false,
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 uAccent; uniform vec3 uFog; uniform float uTime; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(uFog * 1.6 + uAccent * 0.03, vec3(0.008, 0.015, 0.03), smoothstep(-0.05, 0.6, d.y));
        float lon = atan(d.z, d.x), lat = asin(clamp(d.y, -1.0, 1.0));
        float grid = max(smoothstep(0.985, 1.0, abs(cos(lon * 18.0))), smoothstep(0.985, 1.0, abs(cos(lat * 18.0))));
        col += uAccent * grid * 0.05 * smoothstep(0.02, 0.4, d.y);
        col += uAccent * 0.06 * exp(-abs(d.y) * 12.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  // ---------- 床：遠くへ消えていく格子と、格子を走る光 ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000, 1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 vW; varying float vDist;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uAccent; uniform float uTime;
      varying vec3 vW; varying float vDist;
      ${HASH}
      ${FOG}
      // 線の太さが画素より細くなっても消えないよう、覆う割合で薄く描く
      float line(float x, float w) {
        float d = abs(fract(x - 0.5) - 0.5), fw = max(fwidth(x), 1e-4);
        return clamp((w + fw * 0.75 - d) / fw, 0.0, 1.0) * min(1.0, 2.0 * w / fw + 0.35);
      }
      void main() {
        vec2 p = vW.xz;
        vec3 col = vec3(0.008, 0.016, 0.032);
        float minor = max(line(p.x / 4.0, 0.015), line(p.y / 4.0, 0.015));
        float major = max(line(p.x / 40.0, 0.006), line(p.y / 40.0, 0.006));
        float fadeMinor = 1.0 - smoothstep(60.0, 260.0, vDist);
        col += uAccent * (minor * 0.12 * fadeMinor + major * 0.45);
        // 格子を走る光（データの流れ）
        vec2 cell = floor(p / 40.0);
        float lane = hash(cell);
        float runX = fract(p.x / 400.0 - uTime * (0.05 + 0.1 * hash(vec2(cell.y, 3.0))));
        float runZ = fract(p.y / 400.0 - uTime * (0.05 + 0.1 * hash(vec2(cell.x, 7.0))));
        float onX = line(p.y / 40.0, 0.006) * smoothstep(0.0, 0.03, runX) * smoothstep(0.08, 0.03, runX) * step(0.6, hash(vec2(cell.y, 11.0)));
        float onZ = line(p.x / 40.0, 0.006) * smoothstep(0.0, 0.03, runZ) * smoothstep(0.08, 0.03, runZ) * step(0.6, hash(vec2(cell.x, 13.0)));
        col += uAccent * (onX + onZ) * 1.4;
        // 中枢のまわりの回路模様
        float r = length(p);
        float ringLines = line(r / 24.0, 0.01) * (1.0 - smoothstep(120.0, 260.0, r));
        float spokes = line(atan(p.y, p.x) / 6.2831 * 48.0, 0.02) * smoothstep(30.0, 40.0, r) * (1.0 - smoothstep(110.0, 200.0, r));
        col += uAccent * (ringLines * 0.25 + spokes * 0.18);
        col += uAccent * 0.18 * exp(-r / 60.0); // 中枢の明かりが床に落ちる
        gl_FragColor = vec4(applyFog(col, vDist, 1.0 / 1600.0), 1.0);
      }`,
  }));
  scene.add(floor);

  // ---------- 中枢コア：光の柱と、回る輪 ----------
  const core = new THREE.Group();
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 400, 32, 1, true), new THREE.ShaderMaterial({
    uniforms, ...add, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main() { vUv = uv; vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uAccent; uniform float uTime; varying vec2 vUv; varying vec3 vW;
      void main() {
        float bands = 0.55 + 0.45 * sin(vW.y * 0.25 - uTime * 4.0);
        float seam = smoothstep(0.9, 1.0, abs(sin(vUv.x * 3.14159 * 12.0)));
        float fade = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
        gl_FragColor = vec4(uAccent * (0.35 * bands + seam * 0.5) * fade, 1.0);
      }`,
  }));
  pillar.position.y = 200;
  core.add(pillar);
  const coreGlow = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 400, 32, 1, true), new THREE.ShaderMaterial({
    uniforms, ...add, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uAccent; varying vec2 vUv;
      void main() { float fade = smoothstep(0.0, 0.1, vUv.y) * (1.0 - smoothstep(0.4, 1.0, vUv.y)); gl_FragColor = vec4(uAccent * 0.06 * fade, 1.0); }`,
  }));
  coreGlow.position.y = 200;
  core.add(coreGlow);
  const ringMat = new THREE.ShaderMaterial({
    uniforms, ...add, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uAccent; uniform float uTime; varying vec2 vUv;
      void main() {
        float ticks = step(0.5, fract(vUv.x * 120.0));
        float seg = step(0.12, fract(vUv.x * 6.0 + uTime * 0.05));
        gl_FragColor = vec4(uAccent * (0.25 + 0.45 * ticks) * seg, 1.0);
      }`,
  });
  const rings = [];
  for (const [rad, y, tilt, spd] of [[34, 70, 0.0, 0.12], [52, 110, 0.18, -0.08], [76, 150, -0.1, 0.05], [44, 210, 0.3, 0.1]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(rad, 0.5, 6, 160), ringMat);
    ring.rotation.x = Math.PI / 2 + tilt;
    ring.position.y = y;
    ring.userData.spd = spd;
    core.add(ring); rings.push(ring);
  }
  scene.add(core);

  // ---------- データの塔：細長い黒い柱を、光の線が上へ流れる ----------
  const towers = [];
  for (let i = 0; i < 220; i++) {
    const a = R() * Math.PI * 2, r = 160 + Math.pow(R(), 0.7) * 1400;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = 30 + Math.pow(R(), 1.6) * 260 * (1 - r / 2200);
    const w = 6 + R() * 10;
    towers.push([x, z, w, h, R() * 100]);
  }
  const tGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  tGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(towers.map((t) => t[4])), 1));
  const tMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `attribute float aSeed; varying vec3 vW; varying vec3 vN; varying float vSeed; varying float vDist;
      void main() { vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vW = w.xyz; vN = normal; vSeed = aSeed;
        vec4 mv = viewMatrix * w; vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uAccent; uniform float uTime; varying vec3 vW; varying vec3 vN; varying float vSeed; varying float vDist;
      ${HASH}
      ${FOG}
      void main() {
        vec3 n = normalize(vN);
        vec3 col = vec3(0.012, 0.02, 0.035) * (0.7 + 0.3 * n.y);
        if (abs(n.y) < 0.5) {
          float u = abs(n.x) > 0.5 ? vW.z : vW.x;
          float colId = floor(u / 1.6);
          float on = step(0.55, hash(vec2(colId, vSeed)));
          float speed = 4.0 + 10.0 * hash(vec2(colId, vSeed + 1.0));
          float stream = fract(vW.y / 40.0 - uTime * speed / 40.0 + hash(vec2(colId, vSeed + 2.0)));
          float drop = smoothstep(0.0, 0.02, stream) * smoothstep(0.35, 0.02, stream);
          float thin = smoothstep(0.35, 0.1, abs(fract(u / 1.6) - 0.5));
          col += uAccent * on * drop * thin * 0.9;
          col += uAccent * 0.04 * step(0.92, fract(vW.y / 6.0)); // 階のすじ
        } else col += uAccent * 0.12; // 屋上のふち
        gl_FragColor = vec4(applyFog(col, vDist, 1.0 / 1400.0), 1.0);
      }`,
  });
  const tMesh = new THREE.InstancedMesh(tGeo, tMat, towers.length);
  const m4 = new THREE.Matrix4(), q0 = new THREE.Quaternion();
  towers.forEach(([x, z, w, h], i) => { m4.compose(new THREE.Vector3(x, 0, z), q0, new THREE.Vector3(w, h, w)); tMesh.setMatrixAt(i, m4); });
  tMesh.frustumCulled = false;
  scene.add(tMesh);

  // ---------- 記憶の書庫：宙に浮かぶ情報の板 ----------
  const panels = [];
  const LIB = new THREE.Vector3(-260, 0, 180);
  for (let row = 0; row < 5; row++) for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 1.4 - 0.2, rr = 46 + row * 9;
    panels.push([LIB.x + Math.cos(a) * rr, 14 + row * 11 + R() * 3, LIB.z + Math.sin(a) * rr, -a + Math.PI / 2, R() * 100]);
  }
  const pGeo = new THREE.PlaneGeometry(9, 6);
  pGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(panels.map((p) => p[4])), 1));
  const pMat = new THREE.ShaderMaterial({
    uniforms, ...add, side: THREE.DoubleSide,
    vertexShader: `attribute float aSeed; varying vec2 vUv; varying float vSeed; varying float vDist;
      void main() { vUv = uv; vSeed = aSeed; vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uAccent; uniform float uTime; varying vec2 vUv; varying float vSeed; varying float vDist;
      ${HASH}
      void main() {
        vec2 g = vUv * vec2(24.0, 12.0);
        vec2 id = floor(g), f = fract(g);
        float row = id.y;
        float len = hash(vec2(row, vSeed)) * 22.0 + 2.0;
        float glyph = step(id.x, len) * step(0.25, f.y) * step(f.y, 0.75) * step(0.15, f.x) * step(0.3, hash(id + vSeed + floor(uTime * 0.5 + vSeed)));
        float frame = max(step(vUv.x, 0.02) + step(0.98, vUv.x), step(vUv.y, 0.03) + step(0.97, vUv.y));
        float scan = smoothstep(0.02, 0.0, abs(vUv.y - fract(uTime * 0.15 + vSeed)));
        float a = (glyph * 0.35 + frame * 0.5 + scan * 0.4 + 0.04) * (1.0 - smoothstep(150.0, 400.0, vDist));
        gl_FragColor = vec4(uAccent * a, 1.0);
      }`,
  });
  const pMesh = new THREE.InstancedMesh(pGeo, pMat, panels.length);
  const e = new THREE.Euler();
  panels.forEach(([x, y, z, yaw], i) => { m4.compose(new THREE.Vector3(x, y, z), q0.clone().setFromEuler(e.set(0, yaw, 0)), new THREE.Vector3(1, 1, 1)); pMesh.setMatrixAt(i, m4); });
  pMesh.frustumCulled = false;
  scene.add(pMesh);

  // ---------- 漂う光の粒（ゆっくり上へ昇る） ----------
  const PN = 2200, pp = new Float32Array(PN * 3), ps = new Float32Array(PN);
  for (let i = 0; i < PN; i++) {
    const a = R() * Math.PI * 2, r = Math.pow(R(), 0.6) * 900;
    pp.set([Math.cos(a) * r, R() * 320, Math.sin(a) * r], i * 3);
    ps[i] = R();
  }
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
  ptGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(ps, 1));
  const pts = new THREE.Points(ptGeo, new THREE.ShaderMaterial({
    uniforms, ...add,
    vertexShader: `uniform float uTime; uniform float uPx; attribute float aSeed; varying float vA;
      void main() {
        vec3 p = position;
        p.y = mod(p.y + uTime * (1.5 + aSeed * 4.0), 320.0);
        p.x += sin(uTime * 0.3 + aSeed * 30.0) * 2.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vA = (0.3 + 0.7 * aSeed) * smoothstep(0.0, 30.0, p.y) * smoothstep(320.0, 250.0, p.y) * smoothstep(3.0, 20.0, -mv.z) * (1.0 - smoothstep(300.0, 700.0, -mv.z));
        gl_PointSize = clamp(0.9 * uPx / -mv.z, 1.0, 8.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform vec3 uAccent; varying float vA;
      void main() { vec2 c = gl_PointCoord - 0.5; float a = exp(-dot(c, c) * 14.0); gl_FragColor = vec4(uAccent * a * vA, 1.0); }`,
  }));
  pts.frustumCulled = false;
  scene.add(pts);

  // ---------- 立ち寄り先 ----------
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const yawTo = (from, x, z) => Math.atan2(-(x - from.x), -(z - from.z));
  const pois = [
    { name: "中枢コアのそば", pos: V(58, 64, 70), look: [0, 0], orbit: 0.6 },
    { name: "データの塔の間", pos: V(340, 46, -260), look: [0, 0], orbit: 0.3 },
    { name: "記憶の書庫", pos: V(-262, 34, 186), look: [-262, 120], orbit: 0.5 },
    { name: "回路の地平", pos: V(0, 260, 760), look: [0, 0], orbit: 0.5 },
  ];
  pois.forEach((p) => { p.yaw = yawTo(p.pos, p.look[0], p.look[1]); });

  function update(t, dt, camera, env = {}) {
    uniforms.uTime.value = t;
    if (env.accent) uniforms.uAccent.value.copy(env.accent);
    uniforms.uPx.value = env.px ?? 800;
    uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    sky.position.copy(uniforms.uCam.value);
    if (!env.reduceMotion) for (const r of rings) r.rotation.z += r.userData.spd * dt;
  }
  function setQuality(level) { pts.visible = level > 0; }

  return { scene, update, setQuality, pois: { cyber: pois } };
}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
