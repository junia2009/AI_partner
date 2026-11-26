// パラスの世界：宇宙（地球の上）
// 街の真上、高さ数百 km から見る地球。街と同じ座標で、地球の中心は (0, -R, 0)。街は地球のてっぺん（原点）にある。
// 地球の画像は three.js のサンプルにある NASA の画像（昼の地表・夜の街明かり・雲・海の反射）を使う。
//
// 返すもの：scene / update(t, dt, camera, env) / pois / camRange(alt) / setQuality(level)

const TEX = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/";
const R = 6371000;                 // 地球の半径（m）
const HOME = { lat: 35.7, lon: 139.7 }; // 街のある場所（地球のてっぺんに来るように回す）

export function createOrbit(THREE, opts = {}) {
  const scene = new THREE.Scene();
  const loader = new THREE.TextureLoader();
  // 画像は読み込んだあと 1024×512 に縮めてから使う（元の 2048 のままだと iPhone のメモリを食いすぎる）
  const tex = (name, size = 1024) => {
    const t = new THREE.Texture();
    t.anisotropy = opts.anisotropy || 1;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    loader.load(TEX + name, (src) => {
      const img = src.image;
      const c = document.createElement("canvas");
      c.width = size; c.height = size / 2;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      t.image = c;
      t.needsUpdate = true;
      src.dispose();
    });
    return t;
  };
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCam: { value: new THREE.Vector3() },
    uAccent: { value: new THREE.Color(0x7cc4ff) },
    uDay: { value: tex("earth_atmos_2048.jpg") },
    uNight: { value: tex("earth_lights_2048.png") },
    uClouds: { value: tex("earth_clouds_1024.png") },
  };

  // ---------- 地球の向き：街の場所をてっぺん（+y）、北を -z に ----------
  // SphereGeometry の貼り方では、経度 lon の点は phi = (lon + 180)° の向き
  const lat = THREE.MathUtils.degToRad(HOME.lat), phi = THREE.MathUtils.degToRad(HOME.lon + 180);
  const home = new THREE.Vector3(-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat));
  const east = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi)).normalize();
  const north = new THREE.Vector3().crossVectors(east, home).normalize();
  // ローカル → 世界：east→+x、home→+y、north→-z
  const toLocal = new THREE.Matrix4().makeBasis(east, home, north.clone().negate());
  const earthQ = new THREE.Quaternion().setFromRotationMatrix(toLocal.clone().transpose());

  // ---------- 地球 ----------
  const earthMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D uDay; uniform sampler2D uNight; uniform sampler2D uClouds;
      uniform vec3 uSunDir; uniform vec3 uCam; uniform vec3 uAccent; uniform float uTime;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 n = normalize(vN);
        float ndl = dot(n, uSunDir);
        float day = smoothstep(-0.1, 0.18, ndl);
        vec3 v = normalize(uCam - vW);
        vec3 dayTex = texture2D(uDay, vUv).rgb;
        vec3 col = dayTex * (0.04 + 1.05 * max(ndl, 0.0));
        float cl = texture2D(uClouds, vUv + vec2(uTime * 0.0000035, 0.0)).a; // 雲の濃さは透明度に入っている
        // 海は日差しを映す
        float sea = smoothstep(0.02, 0.12, dayTex.b - max(dayTex.r, dayTex.g)); // 青が強い所を海とみなす
        col += vec3(1.0, 0.95, 0.85) * pow(max(dot(n, normalize(uSunDir + v)), 0.0), 70.0) * sea * 0.7 * day * (1.0 - cl);
        col = mix(col, vec3(0.95, 0.97, 1.0) * (0.03 + 1.0 * max(ndl, 0.0)), cl * 0.9);
        // 夜の側：街の明かり
        // 夜の側：月明かりで陸と海の形がうっすら見え、街の明かりが灯る
        float night = 1.0 - day;
        col += dayTex * vec3(0.06, 0.08, 0.15) * 0.35 * night;
        vec3 lights = texture2D(uNight, vUv).rgb;
        lights = pow(lights, vec3(0.85)) * 2.3;             // 縮めて薄まった細かい明かりを持ち上げる
        col += lights * vec3(1.0, 0.8, 0.52) * night * (1.0 - cl * 0.45);
        col += vec3(1.0, 0.75, 0.45) * smoothstep(0.1, 0.6, lights.r) * 0.1 * night; // 大きな街のほんのりした明るさ
        // 朝夕の境目は少し赤く
        col *= mix(vec3(1.0), vec3(1.25, 0.8, 0.6), smoothstep(0.25, 0.0, abs(ndl)) * 0.6);
        // パラスの街（てっぺん）にかすかな光
        float homeD = acos(clamp(dot(n, vec3(0.0, 1.0, 0.0)), -1.0, 1.0));
        col += uAccent * smoothstep(0.0012, 0.0, homeD) * (0.6 + 0.4 * sin(uTime * 2.0));
        // ふちの大気
        float fres = pow(1.0 - max(dot(n, v), 0.0), 2.5);
        col = mix(col, vec3(0.32, 0.56, 1.0) * (0.05 + 1.0 * smoothstep(-0.25, 0.4, ndl)), fres * 0.75);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(R, 256, 128), earthMat);
  earth.quaternion.copy(earthQ);
  earth.position.set(0, -R, 0);
  scene.add(earth);

  // 大気の光の輪（地球より少し大きい球の裏側を、ふちほど明るく）
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.008, 192, 96), new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; varying vec3 vW;
      void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uSunDir; uniform vec3 uCam; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 n = normalize(vN);
        vec3 v = normalize(vW - uCam);
        float rim = pow(clamp(1.0 - abs(dot(n, v)), 0.0, 1.0), 3.0);
        float lit = smoothstep(-0.3, 0.4, dot(n, uSunDir));
        gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * rim * (0.04 + 0.9 * lit), 1.0);
      }`,
  }));
  atmo.position.copy(earth.position);
  // 大きな球を重ねると縁が二重に見えるので、大気は地球の縁の色として描く（atmo は使わない）

  // ---------- 宇宙の背景：星・天の川・太陽・月 ----------
  const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false,
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 uSunDir; uniform float uTime; varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = vec3(0.002, 0.003, 0.008);
        vec3 sp = d * 420.0, sc = floor(sp);
        float s = hash(sc.xy + sc.z * 17.31);
        float dotS = smoothstep(0.45, 0.0, length(fract(sp) - 0.5));
        col += vec3(0.85, 0.9, 1.0) * step(0.975, s) * dotS * (0.4 + 0.6 * hash(sc.zy));
        float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.55, -0.76))), 2.0) * 26.0);
        col += vec3(0.12, 0.11, 0.16) * band * (0.5 + 0.5 * hash(floor(sp.xz * 0.5)));
        float sd = dot(d, uSunDir);
        col += vec3(1.0, 0.97, 0.92) * (smoothstep(0.99955, 0.9998, sd) * 8.0 + pow(max(sd, 0.0), 900.0) * 1.2 + pow(max(sd, 0.0), 60.0) * 0.08);
        vec3 moonDir = normalize(vec3(-0.45, 0.42, -0.78));
        col += vec3(0.85, 0.85, 0.8) * smoothstep(0.99985, 0.99992, dot(d, moonDir));
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  // ---------- 立ち寄り先（街と同じ座標。y は地表からの高さのめやす） ----------
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const yawTo = (from, x, z) => Math.atan2(-(x - from.x), -(z - from.z));
  const pois = [
    { name: "日本列島の上", pos: V(0, 1300000, 1400000), look: [0, -2000000], orbit: 0.5 },
    { name: "地球の丸さが見える高さ", pos: V(900000, 3200000, 2600000), look: [0, 0], orbit: 0.45 },
    { name: "地球をまるごと見わたす高さ", pos: V(-1500000, 8000000, 5500000), look: [0, 0], orbit: 0.4 },
    { name: "昼と夜のさかい目の上", pos: V(-2600000, 2400000, -600000), look: [0, -1500000], orbit: 0.5 },
  ];
  pois.forEach((p) => { p.yaw = yawTo(p.pos, p.look[0], p.look[1]); });

  function update(t, dt, camera, env = {}) {
    uniforms.uTime.value = t;
    if (env.accent) uniforms.uAccent.value.copy(env.accent);
    if (env.sunDir) uniforms.uSunDir.value.copy(env.sunDir).normalize();
    uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    sky.position.copy(uniforms.uCam.value);
    // 地球はゆっくり自転して見える（雲が流れる）
  }
  // 地表からの高さに合わせて、描く範囲（手前と奥）を決める
  function camRange(alt) {
    const h = Math.max(1000, alt);
    return [Math.max(5, h * 0.002), Math.sqrt(2 * R * h + h * h) + R * 0.6];
  }
  // 地平線がどれだけ下がって見えるか（ラジアン）
  function horizonDip(alt) { return Math.acos(R / (R + Math.max(0, alt))); }
  function setQuality() {}

  return { scene, update, camRange, horizonDip, setQuality, earth, atmo, sky, pois: { space: pois }, kind: "orbit" };
}
