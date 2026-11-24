// render-hq.js - the Shooting Range's look: image-based lighting, ACES tone mapping, shadows, post-processing (SSAO,
// muzzle-flash-only bloom, MSAA), PBR materials (walnut furniture, blued / parkerized steel with edge wear, phosphate
// internals, brass, bakelite), the split glass side, and the range floor. Quality "ultra" = everything; "high" = IBL +
// materials, no post-processing or shadows, lighter glass on phones. All textures are CC0 (textures/SOURCES.md).
import * as THREE from "three";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
// A single NaN / Inf pixel in the HDR buffer (one bad sub-mesh or the muzzle flash) is smeared over the WHOLE frame by the bloom's blur chain and
// the view goes black (the Vykhor-6 at Ultra; the AK on firing). This pass runs before the bloom: NaN -> 0, everything clamped to 0..24.
const SANITIZE = { uniforms: { tDiffuse: { value: null } }, vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: "uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0); gl_FragColor = vec4(clamp(c.rgb, 0.0, 24.0), 1.0); }" };

const COARSE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
export const DEFAULT_QUALITY = COARSE ? "low" : (typeof innerWidth === "number" && innerWidth < 700) ? "high" : "ultra";   // phones: low quality at 0.75x pixel ratio

// ------------------------------------------------------------------ textures (lazy, cached)
const texLoader = new THREE.TextureLoader();
const texCache = {};
function tex(path, srgb = false, rep = 1) {
  const key = path + srgb;
  if (!texCache[key]) {
    const t = texLoader.load(path);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    texCache[key] = t;
  }
  return texCache[key];
}
let envPromise = null;
function loadEnv(renderer) {
  // the artifact host does not serve .hdr, so the HDR ships as base64 text (decoded to a blob URL); a plain .hdr is the local fallback
  if (!envPromise) envPromise = fetch("textures/studio_small_08_1k.hdr.b64.txt").then((r) => (r.ok ? r.text() : Promise.reject()))
    .then((t) => { const b = atob(t.replace(/\s+/g, "")), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return URL.createObjectURL(new Blob([u])); })
    .catch(() => "textures/studio_small_08_1k.hdr")
    .then((url) => new Promise((ok) => {
      new RGBELoader().load(url, (hdr) => {
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const pm = new THREE.PMREMGenerator(renderer); const env = pm.fromEquirectangular(hdr).texture; hdr.dispose(); pm.dispose();
        ok(env);
      }, undefined, () => ok(null));
    }));
  return envPromise;
}

// ------------------------------------------------------------------ part classes (by GLB part name)
const AK_WOOD = ["stock", "pistol_grip", "handguard_upper", "handguard_lower"];
const AK_INTERNAL = ["bolt", "bolt_carrier", "piston", "piston_rivet", "extractor", "firing_pin", "hammer", "trigger", "disconnector", "auto_sear", "fcg_axis_pins", "recoil_guide", "magazine_follower"];
const MAK_INTERNAL = ["hammer", "hammer__pin", "sear", "sear__pin", "trigger", "trigger__pin", "trigger_bar", "slide__firing_pin", "slide__extractor", "frame__slide_stop", "frame__slide_stop_pin", "magazine__follower"];
export const SHELL = { AK: ["receiver", "receiver_cover"], MAK: ["frame", "slide", "frame_grip__panel_l", "frame_grip__panel_r", "magazine"], GAT: ["housing", "feeder_housing", "feeder_cover", "battery_shell"] };
function classify(gun, name) {
  if (/spring/.test(name)) return "spring";
  if (gun === "AK" && AK_WOOD.includes(name)) return "wood";
  if (gun === "MAK" && /grip__panel/.test(name)) return "bakelite";
  if (/(^|_)(case|primer)$/.test(name) || /round_case|round_primer|rounds_case|rounds_primer|__case$|primer_cup/.test(name)) return (gun === "MAK" || gun === "AK") && !/primer/.test(name) ? "lacquer" : "brass";   // 7.62x39 and 9x18 PM: lacquered steel; 5.56: brass
  if (/jacket|bullet/.test(name)) return "gilding";
  if (/lead|core|powder|primer_mix/.test(name)) return "lead";
  if (gun === "GAT") return /^(bolt|cam_roller|firing_pin|extractor|feed_|delinker|motor_|planet|sun_gear|ring_gear|gearbox|rotor)/.test(name) ? "phosphate" : "steel";
  if ((gun === "AK" ? AK_INTERNAL : MAK_INTERNAL).includes(name)) return "phosphate";
  return "steel";
}

// box-projected UVs in metres, the part's long axis along u so wood grain runs lengthwise like real furniture
function boxUV(mesh, scale) {
  const g = mesh.geometry;
  if (g.userData.boxUV) return;
  g.computeBoundingBox(); const s = new THREE.Vector3(); g.boundingBox.getSize(s);
  const ax = s.x >= s.y && s.x >= s.z ? 0 : s.y >= s.z ? 1 : 2;
  const p = g.attributes.position, n = g.attributes.normal, uv = new Float32Array(p.count * 2);
  mesh.updateWorldMatrix(true, false);
  const ws = new THREE.Vector3(); mesh.getWorldScale(ws);
  const k = scale * Math.max(Math.abs(ws.x), Math.abs(ws.y), Math.abs(ws.z));   // local units -> metres
  for (let i = 0; i < p.count; i++) {
    const v = [p.getX(i), p.getY(i), p.getZ(i)], nn = n ? [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))] : [0, 0, 1];
    const dom = nn[0] > nn[1] && nn[0] > nn[2] ? 0 : nn[1] > nn[2] ? 1 : 2;
    const other = [0, 1, 2].filter((a) => a !== dom);
    const uAx = other.includes(ax) ? ax : other[0], vAx = other.find((a) => a !== uAx);
    uv[2 * i] = v[uAx] * k; uv[2 * i + 1] = v[vAx] * k * 4;   // grain: stretched along u
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); g.userData.boxUV = true;
}

// edge wear: subtle satin bare-steel sheen on machined edges (anti-aliased, no harsh 1px fwidth stair-stepping)
function edgeWear(mat, amount = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWear = { value: amount };
    sh.fragmentShader = "uniform float uWear;\n" + sh.fragmentShader
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n float curv = smoothstep(0.65, 1.9, length(fwidth(normalize(vNormal)))) * uWear;\n roughnessFactor = mix(roughnessFactor, 0.34, curv * 0.45);")
      .replace("#include <color_fragment>", "#include <color_fragment>\n { float c2 = smoothstep(0.65, 1.9, length(fwidth(normalize(vNormal)))) * uWear; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.46, 0.48, 0.51), c2 * 0.14); }");
  };
  mat.customProgramCacheKey = () => "wear2_" + amount;
  return mat;
}

// ------------------------------------------------------------------ AK: procedural 4K maps (the Blackwell bake replaces these later)
// Drawn with canvas primitives (fast even at 4096): crystalline parkerizing mottle + lengthwise machining / grinding
// marks for steel; laminated birch (glued layers, each with its own grain) under a red lacquer for the furniture.
const procCache = {};
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function mkCanvas(N) { const c = document.createElement("canvas"); c.width = c.height = N; return c; }
function noiseOctaves(g, N, r, base, octs) {   // value noise: small random images scaled up smoothly, layered
  for (const [cells, alpha] of octs) {
    const c = mkCanvas(cells), x = c.getContext("2d"), im = x.createImageData(cells, cells);
    for (let i = 0; i < cells * cells; i++) { const v = Math.round(base + (r() - 0.5) * 255); im.data.set([v, v, v, 255], i * 4); }
    x.putImageData(im, 0, 0); g.globalAlpha = alpha; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    for (const dx of [0, -N]) for (const dy of [0, -N]) g.drawImage(c, dx, dy, N * 2, N * 2);   // scaled x2 and wrapped, so it tiles
  }
  g.globalAlpha = 1;
}
function heightToNormal(src, M, strength) {   // Sobel on a downsized copy -> tangent-space normal map
  const c = mkCanvas(M), g = c.getContext("2d"); g.drawImage(src, 0, 0, M, M);
  const d = g.getImageData(0, 0, M, M), h = new Float32Array(M * M); for (let i = 0; i < M * M; i++) h[i] = d.data[i * 4] / 255;
  const o = g.createImageData(M, M), H = (x, y) => h[((y + M) % M) * M + ((x + M) % M)];
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x - 1, y) - H(x - 1, y + 1)) * strength;
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x, y - 1) - H(x + 1, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * M + x) * 4;
    o.data[i] = (-dx / l * 0.5 + 0.5) * 255; o.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; o.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; o.data[i + 3] = 255;
  }
  g.putImageData(o, 0, 0); return c;
}
function canvasMap(c, srgb, aniso = 8) { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; }
function akSteelMaps(N) {
  if (procCache["s" + N]) return procCache["s" + N];
  const r = rnd(1947), k = N / 1024;
  // roughness / height: crystalline mottle + machining marks along u (the part's long axis)
  const rc = mkCanvas(N), g = rc.getContext("2d"); g.fillStyle = "rgb(150,150,150)"; g.fillRect(0, 0, N, N);
  noiseOctaves(g, N, r, 150, [[16, 0.3], [64, 0.28], [256, 0.3], [Math.min(1024, N / 2), 0.42], [Math.min(2048, N), 0.3]]);   // + a finer octave: higher-frequency tooth
  for (let i = 0; i < 3200 * k * k ** 0.5; i++) {   // machining marks: three times as many, finer and more contrasty
    const y = r() * N, x = r() * N, L = (0.04 + r() * 0.5) * N, v = r() < 0.55 ? 55 + r() * 50 : 200 + r() * 55;
    g.strokeStyle = `rgba(${v},${v},${v},${0.06 + r() * 0.16})`; g.lineWidth = (0.25 + r() * 0.9) * k;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + L, y + (r() - 0.5) * 2 * k); g.stroke();
    if (x + L > N) { g.beginPath(); g.moveTo(x - N, y); g.lineTo(x + L - N, y); g.stroke(); }
  }
  // brushed grain: very fine, long, parallel hairlines along the part (what makes the anisotropic sheen read)
  for (let i = 0; i < 4500 * k; i++) { const y = r() * N, x = r() * N, L = (0.2 + r() * 0.7) * N, v = r() < 0.5 ? 90 + r() * 40 : 190 + r() * 50; g.strokeStyle = `rgba(${v},${v},${v},${0.05 + r() * 0.1})`; g.lineWidth = 0.18 * k + r() * 0.3 * k; g.beginPath(); g.moveTo(x, y); g.lineTo(x + L, y + (r() - 0.5) * 0.6 * k); g.stroke(); if (x + L > N) { g.beginPath(); g.moveTo(x - N, y); g.lineTo(x + L - N, y); g.stroke(); } }
  // albedo variation: the same structure, low contrast, plus soft blotches of the finish
  const M2 = Math.min(N, 2048), ac = mkCanvas(M2), ga = ac.getContext("2d"); ga.fillStyle = "rgb(205,205,205)"; ga.fillRect(0, 0, M2, M2);
  ga.globalAlpha = 0.35; ga.drawImage(rc, 0, 0, M2, M2); ga.globalAlpha = 1; noiseOctaves(ga, M2, r, 205, [[8, 0.25], [32, 0.18]]);
  const nc = heightToNormal(rc, Math.min(N, 2048), 2.4);
  return (procCache["s" + N] = { rough: canvasMap(rc, false), color: canvasMap(ac, true), normal: canvasMap(nc, false) });
}
function akWoodMaps(N) {
  if (procCache["w" + N]) return procCache["w" + N];
  const r = rnd(1959), k = N / 1024;
  const c = mkCanvas(N), g = c.getContext("2d");
  // laminated birch: glued layers ~1.5 mm, alternating pale / dark veneer, each band wavy, with its own fine grain
  let y = 0; const tones = [[196, 120, 70], [120, 58, 28], [176, 102, 56], [98, 44, 20]];
  while (y < N) {
    const h = (34 + r() * 30) * k, t = tones[Math.floor(r() * tones.length)], a = r() * 6, ph = r() * 6.28;
    g.fillStyle = `rgb(${t[0]},${t[1]},${t[2]})`; g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= N; x += 32 * k) g.lineTo(x, y + Math.sin(x / N * 6.283 * 2 + ph) * a * k);
    for (let x = N; x >= 0; x -= 32 * k) g.lineTo(x, y + h + Math.sin(x / N * 6.283 * 2 + ph + 0.4) * a * k);
    g.closePath(); g.fill();
    g.strokeStyle = "rgba(40,15,5,0.55)"; g.lineWidth = 1.2 * k; g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= N; x += 32 * k) g.lineTo(x, y + Math.sin(x / N * 6.283 * 2 + ph) * a * k); g.stroke();   // glue line
    for (let j = 0; j < 14; j++) { const gy = y + r() * h, L = (0.1 + r() * 0.7) * N, gx = r() * N, d = r() < 0.6;
      g.strokeStyle = d ? `rgba(60,25,8,${0.12 + r() * 0.25})` : `rgba(230,170,120,${0.08 + r() * 0.15})`; g.lineWidth = (0.6 + r() * 1.6) * k;
      g.beginPath(); g.moveTo(gx, gy); g.bezierCurveTo(gx + L / 3, gy + (r() - 0.5) * 6 * k, gx + 2 * L / 3, gy + (r() - 0.5) * 6 * k, gx + L, gy + (r() - 0.5) * 4 * k); g.stroke(); }
    y += h;
  }
  noiseOctaves(g, N, r, 128, [[8, 0.08], [64, 0.06]]);
  g.globalCompositeOperation = "multiply"; g.fillStyle = "rgb(235,150,120)"; g.fillRect(0, 0, N, N); g.globalCompositeOperation = "source-over";   // red shellac lacquer
  const M2 = Math.min(N, 2048), hc = mkCanvas(M2), gh = hc.getContext("2d"); gh.filter = "grayscale(1)"; gh.drawImage(c, 0, 0, M2, M2); gh.filter = "none";
  const rc = mkCanvas(M2), gr = rc.getContext("2d"); gr.fillStyle = "rgb(140,140,140)"; gr.fillRect(0, 0, M2, M2); gr.globalAlpha = 0.4; gr.drawImage(hc, 0, 0); gr.globalAlpha = 1;
  return (procCache["w" + N] = { color: canvasMap(c, true), rough: canvasMap(rc, false), normal: canvasMap(heightToNormal(hc, M2, 0.9), false) });
}
// signed curvature from view-space derivatives: subtle machined-steel edge sheen + cavity darkening without 1px fwidth rim pixelation
function akWear(mat, wear = 1, grime = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWear = { value: wear }; sh.uniforms.uGrime = { value: grime };
    const curv = ` vec3 cN = normalize(vNormal), cP = -vViewPosition; vec3 cdpx = dFdx(cP), cdpy = dFdy(cP);
 float cK = dot(dFdx(cN), cdpx) / max(dot(cdpx, cdpx), 1e-14) + dot(dFdy(cN), cdpy) / max(dot(cdpy, cdpy), 1e-14);
 float cFace = smoothstep(0.30, 0.68, abs(dot(cN, normalize(cP))));
 cK *= cFace;
 float cWear = smoothstep(850.0, 2600.0, cK) * uWear * 0.28, cGrime = smoothstep(420.0, 1500.0, -cK) * uGrime * 0.45;`;
    sh.fragmentShader = "uniform float uWear; uniform float uGrime;\n" + sh.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>\n {${curv}\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.50, 0.52, 0.56), clamp(cWear * 0.42, 0.0, 0.30)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.045, 0.04), cGrime * 0.55); }`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n {${curv}\n roughnessFactor = mix(roughnessFactor, 0.28, clamp(cWear * 0.55, 0.0, 0.5)); roughnessFactor = mix(roughnessFactor, 0.96, cGrime * 0.6); }`);
  };
  mat.customProgramCacheKey = () => "akwear4_" + wear + "_" + grime;
  return mat;
}
const AK_CARRIER = /^(bolt_carrier|piston|bolt$)/;
const AK_BLUED = /^(barrel|gas_block|gas_tube|front_sight|muzzle|cleaning_rod|rear_sight|bayonet|handguard_retainer)/;

function makeMaterials(quality) {
  const hi = quality === "ultra" && !COARSE ? "2k" : "1k";
  const M = {};
  M.wood = new THREE.MeshPhysicalMaterial({ map: tex(`textures/wood_albedo_${hi}.webp`, true), normalMap: tex(`textures/wood_normal_${hi}.webp`),
    roughnessMap: tex(`textures/wood_rough_${hi}.webp`), roughness: 0.85, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.25, color: 0xd8a27a });
  M.wood.normalScale.set(0.8, 0.8);
  M.steel = edgeWear(new THREE.MeshStandardMaterial({ color: 0x4d535c, metalness: 1, roughness: 1, roughnessMap: tex("textures/steel_rough.webp"), normalMap: tex("textures/steel_normal.webp"), envMapIntensity: 0.975 }), 1);
  M.steel.normalScale.set(0.35, 0.35);
  M.phosphate = edgeWear(new THREE.MeshStandardMaterial({ color: 0x55554e, metalness: 0.7, roughness: 1, roughnessMap: tex("textures/phosphate_rough.webp") }), 0.5);
  M.spring = new THREE.MeshStandardMaterial({ color: 0x24262a, metalness: 0.9, roughness: 0.45 });
  M.brass = new THREE.MeshPhysicalMaterial({ color: 0xd6ad55, metalness: 1, roughness: 1, roughnessMap: tex("textures/steel_rough.webp"), clearcoat: 0.15 });
  M.brass.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n roughnessFactor = 0.12 + 0.25 * smoothstep(0.45, 0.6, roughnessFactor);"); };  // high polish, slight tarnish blotches
  M.lacquer = new THREE.MeshPhysicalMaterial({ color: 0x5b5a3a, metalness: 0.6, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.3 });   // Soviet lacquered steel case
  M.gilding = new THREE.MeshStandardMaterial({ color: 0xc07a45, metalness: 1, roughness: 0.22 });
  M.lead = new THREE.MeshStandardMaterial({ color: 0x55575a, metalness: 0.4, roughness: 0.7 });
  M.bakelite = new THREE.MeshPhysicalMaterial({ color: 0x2c1a10, metalness: 0, roughness: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.35, sheen: 0.2, sheenColor: new THREE.Color(0x5a3a26) });
  // AK-47 finishes: wired directly to Blackwell 4K (4096x4096) WebP PBR maps (zero low-res canvas noise)
  if (typeof document !== "undefined") {
    const stRough = tex("textures/steel_rough.webp"), stNorm = tex("textures/steel_normal.webp"), phRough = tex("textures/phosphate_rough.webp");
    const wdCol = tex("textures/wood_albedo_2k.webp", true), wdNorm = tex("textures/wood_normal_2k.webp"), wdRough = tex("textures/wood_rough_2k.webp");
    M.akPark = akWear(new THREE.MeshStandardMaterial({ color: 0x222529, metalness: 0.62, roughness: 0.88, roughnessMap: stRough, normalMap: stNorm, envMapIntensity: 0.85 }), 0.75, 0.8);
    M.akPark.normalScale.set(0.38, 0.38);
    M.akBlued = akWear(new THREE.MeshPhysicalMaterial({ color: 0x1d2e47, metalness: 0.96, roughness: 0.46, roughnessMap: stRough, normalMap: stNorm, envMapIntensity: 1.04, clearcoat: 0.25, clearcoatRoughness: 0.32, anisotropy: 0.75, anisotropyRotation: 0 }), 0.65, 0.8);
    M.akBlued.normalScale.set(0.35, 0.35);
    M.akCarrier = akWear(new THREE.MeshPhysicalMaterial({ color: 0x7a7e86, metalness: 0.98, roughness: 0.36, roughnessMap: stRough, normalMap: stNorm, envMapIntensity: 0.975, anisotropy: 0.85, anisotropyRotation: 0 }), 0.5, 0.7);
    M.akCarrier.normalScale.set(0.32, 0.32);
    M.akWood = akWear(new THREE.MeshPhysicalMaterial({ map: wdCol, roughnessMap: wdRough, normalMap: wdNorm, color: 0xe6b58f, roughness: 0.72, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.14, envMapIntensity: 0.75 }), 0.2, 0.5);
    M.akWood.normalScale.set(0.45, 0.45);
    M.akPhos = akWear(new THREE.MeshStandardMaterial({ color: 0x7e7e76, metalness: 0.72, roughness: 0.95, roughnessMap: phRough, normalMap: stNorm }), 0.4, 0.7);
    M.akPhos.normalScale.set(0.28, 0.28);
  }
  return M;
}
function cloneMat(m) { const c = m.clone(); if (m.onBeforeCompile) { c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; } return c; }
// gun condition, made visible: carbon soot (fouled) or dust and grit (sandy) over the base finish
const COND_PARTS = {
  AK: { dirty: ["barrel", "gas_block", "gas_tube", "front_sight_block", "bolt_carrier", "piston", "piston_rivet", "bolt", "extractor", "receiver"],
        sandy: ["receiver", "receiver_cover", "bolt_carrier", "bolt", "piston", "trigger_guard", "magazine_body", "magazine_floorplate", "hammer", "trigger", "selector"] },
  GAT: { dirty: ["housing", "barrel_r1", "barrel_r2", "barrel_r3", "barrel_l1", "barrel_l2", "barrel_l3", "flash_hider_r1", "flash_hider_r2", "flash_hider_r3", "flash_hider_l1", "flash_hider_l2", "flash_hider_l3", "rotor", "cam_sleeve"],
         sandy: ["housing", "rotor", "cam_sleeve", "feeder_housing", "feed_sprocket", "trigger_guard", "rear_grip", "front_grip"] },
  MAK: { dirty: ["barrel", "slide", "slide__extractor", "slide__firing_pin", "frame"], sandy: ["frame", "slide", "frame__trigger_guard", "hammer", "trigger", "magazine", "frame__slide_stop"] },
};
function condMaterial(base, cond) {
  const m = cloneMat(base);
  if (cond === "dirty") { m.color = m.color.clone().multiplyScalar(0.32); m.roughness = 1; if (m.roughnessMap) m.roughness = 1.6; m.metalness = Math.min(m.metalness ?? 0, 0.45); if (m.clearcoat) m.clearcoat = 0; }
  else if (cond === "sandy") { m.color = m.color.clone().lerp(new THREE.Color(0xa08a63), 0.55); m.roughness = 1; if (m.roughnessMap) m.roughness = 1.8; m.metalness = Math.min(m.metalness ?? 0, 0.35); if (m.clearcoat) m.clearcoat = 0; }
  m.userData.cond = cond;
  return m;
}
// ---- skins: a finish over the outer parts (steel, wood, bakelite); internals and rounds keep the factory finish
function canvasTex(draw, N = 512) { const c = document.createElement("canvas"); c.width = c.height = N; draw(c.getContext("2d"), N); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
function seeded(seed) { let x = seed; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; }
export const SKINS = ["factory", "glass", "gold", "chrome", "black", "pink", "camo", "damascus"];
const skinCache = {};
function skinMaterial(skin) {
  if (skinCache[skin]) return skinCache[skin];
  let m = null;
  if (skin === "glass") m = glassFresnel(new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.02, transmission: 1, thickness: 0.0015, ior: 1.5, attenuationColor: new THREE.Color(0xf2fbff), attenuationDistance: 5, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.04, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  else if (skin === "gold") m = edgeWear(new THREE.MeshStandardMaterial({ color: 0xffc356, metalness: 1, roughness: 0.08, envMapIntensity: 0.9 }), 0.5);   // polished 24k (sRGB 255,195,86), slight wear on the edges
  else if (skin === "chrome") m = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.02, envMapIntensity: 1.0 });   // mirror: the environment map is the whole look (intensity already glare-capped)
  else if (skin === "black") m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, specularIntensity: 0.8, envMapIntensity: 0.85,   // Onyx black: polished deep black stone, faint grey veining
    map: canvasTex((g, N) => {
      const r = seeded(7731); g.fillStyle = "#0a0a0c"; g.fillRect(0, 0, N, N);
      for (let i = 0; i < 34; i++) { let x = r() * N, y = r() * N, a = r() * 6.28; g.strokeStyle = `rgba(150,150,158,${(0.07 + r() * 0.16).toFixed(3)})`; g.lineWidth = 0.5 + r() * 1.6; g.beginPath(); g.moveTo(x, y);
        for (let k = 0; k < 26; k++) { a += (r() - 0.5) * 0.9; x += Math.cos(a) * (8 + r() * 14); y += Math.sin(a) * (8 + r() * 14); g.lineTo(x, y); } g.stroke(); }
      for (let i = 0; i < 9; i++) { g.strokeStyle = "rgba(120,120,128,0.05)"; g.lineWidth = 9 + r() * 14; g.beginPath(); g.moveTo(r() * N, r() * N); g.bezierCurveTo(r() * N, r() * N, r() * N, r() * N, r() * N, r() * N); g.stroke(); }
    }) });
  else if (skin === "pink") m = new THREE.MeshStandardMaterial({ color: 0xe48db0, metalness: 0.1, roughness: 0.62 });
  else if (skin === "camo") m = new THREE.MeshStandardMaterial({ metalness: 0.05, roughness: 0.85, map: canvasTex((g, N) => {   // woodland: four colours in blobs
    const r = seeded(1944); g.fillStyle = "#6b6b3d"; g.fillRect(0, 0, N, N);
    for (const [col, k, sz] of [["#3d4a26", 26, 70], ["#5a4128", 22, 60], ["#1e1e18", 18, 40], ["#a59a6a", 12, 30]]) for (let i = 0; i < k; i++) {
      g.fillStyle = col; g.beginPath(); const x = r() * N, y = r() * N; g.moveTo(x, y);
      for (let a = 0; a <= 6.3; a += 0.6) g.lineTo(x + Math.cos(a) * sz * (0.5 + r()), y + Math.sin(a) * sz * 0.6 * (0.5 + r())); g.fill(); }
  }) });
  else if (skin === "damascus") m = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.28, envMapIntensity: 0.845, map: canvasTex((g, N) => {   // folded-steel waves
    const img = g.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const u = x / N, v = y / N; const w = Math.sin((v * 22 + 1.6 * Math.sin(u * 9) + 0.6 * Math.sin(u * 23 + v * 7)) * Math.PI); const c = 120 + 95 * Math.sign(w) * Math.pow(Math.abs(w), 0.35); const i = 4 * (y * N + x); img.data[i] = img.data[i + 1] = c; img.data[i + 2] = c + 6; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
  }) });
  if (m) m.userData.skin = skin;
  return (skinCache[skin] = m);
}

// clear glass (owner, 18 Nov: "more clear but with stronger reflections"): almost no tint, a polished surface, a mirror-like clearcoat,
// strong environment reflections on the glass only, and a subtle Fresnel edge highlight. The internals stay clearly visible.
function glassFresnel(m) {
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n { float gF = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 3.0); totalEmissiveRadiance += vec3(0.55, 0.72, 0.85) * gF * 0.16; }"); };
  m.customProgramCacheKey = () => "glassfresnel1"; return m;
}
// FULL GLASS (the Skin "Glass"): every part is clear glass. Not the transmission shader (a transmissive surface cannot see another transmissive one, so the
// internals would vanish): plain blending, so the moving works show through the shell. Shells are almost clear; internal parts carry a subtle tint per part.
const glassPartCache = {};
const TINTS = [0xbfe3ff, 0xffd7a8, 0xc9ffd6, 0xf3c6ff, 0xfff2a8, 0xffc0c0, 0xb8f0f0, 0xd6d0ff];
export function glassPartMat(name, internal) {
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const key = internal ? "i" + (h % TINTS.length) : "s"; if (glassPartCache[key]) return glassPartCache[key];
  const m = glassFresnel(new THREE.MeshPhysicalMaterial({ color: internal ? TINTS[h % TINTS.length] : 0xdcecf8, metalness: 0, roughness: 0.04, transparent: true, opacity: internal ? 0.78 : 0.2, depthWrite: false, side: THREE.DoubleSide,
    clearcoat: 0.7, clearcoatRoughness: 0.03, specularIntensity: 0.7, envMapIntensity: 1.0 }));
  m.userData.skin = "glass"; return (glassPartCache[key] = m);
}
export function skinForPart(skin, name) { return skin === "glass" ? glassPartMat(name, false) : skinMaterial(skin); }
// the Glass SIDE (mixed mode: glass near half, opaque far half). Owner, 20 Nov: "needs to be more transparent for mixed glass mode":
// no tint, half the specular / clearcoat / reflection of before, so the works behind read clearly; the light Fresnel edge still shows the pane.
function glassMaterial(full) {
  if (full) return glassFresnel(new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.01, transmission: 1, ior: 1.45, thickness: 0.0008,
    attenuationColor: new THREE.Color(0xffffff), attenuationDistance: 1e6, specularIntensity: 0.35, specularColor: new THREE.Color(0xffffff), clearcoat: 0.3, clearcoatRoughness: 0.03, envMapIntensity: 0.55, transparent: true, opacity: 1, depthWrite: false, side: THREE.FrontSide }));
  return new THREE.MeshStandardMaterial({ color: 0xe6f4fa, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.09, depthWrite: false, side: THREE.DoubleSide });
}

// ------------------------------------------------------------------ per-canvas view (renderer + post-processing)
export class HQView {
  constructor(canvas, scene, camera) {
    this.scene = scene; this.camera = camera;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.9;
    r.localClippingEnabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.quality = null; this.composer = null; this.w = 0; this.h = 0; this.lost = false;
    // a lost WebGL context (a GPU that ran out of memory at Ultra) must never leave a black view: prevent the default so the browser may
    // restore it, tell the page (it lowers the quality one step) and rebuild everything that lived on the GPU when it is back
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; if (this.onLost) this.onLost(e); }, false);
    canvas.addEventListener("webglcontextrestored", () => { this.lost = false; this.setQuality(this.quality); if (this.onRestored) this.onRestored(); }, false);
  }
  // the drawing buffer is capped at a pixel budget (MSAA half-float targets at 4K are what exhaust a GPU), whatever the device pixel ratio
  ratioFor(q) {
    if (globalThis.__LOWGL) return 0.5; if (q === "low") return 0.75;
    if (this.hd && q === "ultra") return Math.min(4, 2 * Math.max(1, devicePixelRatio || 1));   // Blackwell HD: 2x supersampling
    const cap = q === "ultra" ? (COARSE ? 2 : 2.5) : q === "medium" ? 1.25 : (COARSE ? 1.5 : 2), budget = q === "ultra" ? 5.5e6 : 7e6;
    const fit = this.w && this.h ? Math.sqrt(budget / (this.w * this.h)) : cap;
    return Math.max(0.5, Math.min(devicePixelRatio || 1, cap, fit));
  }
  setQuality(q) {
    this.quality = q;
    const r = this.renderer;
    r.setPixelRatio(this.ratioFor(q));   // low = phones: 0.75x
    r.shadowMap.enabled = q === "ultra";
    if (this.composer) { this.composer.dispose?.(); this.composer = null; }
    if (q === "ultra") {
      const sz = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(sz.x, sz.y, { type: THREE.HalfFloatType, samples: 4 });   // MSAA
      const c = new EffectComposer(r, rt);
      c.addPass(new RenderPass(this.scene, this.camera));
      const ao = new SSAOPass(this.scene, this.camera, sz.x, sz.y); ao.kernelRadius = 0.012; ao.minDistance = 0.0004; ao.maxDistance = 0.02; ao.output = SSAOPass.OUTPUT.Default;
      this.ao = ao; c.addPass(ao);
      const san = new ShaderPass(new THREE.ShaderMaterial(SANITIZE)); c.addPass(san);
      const bloom = new UnrealBloomPass(new THREE.Vector2(sz.x, sz.y), 0.42, 0.35, 1.3);   // threshold above any lit surface: only the flash blooms
      c.addPass(bloom); c.addPass(new OutputPass());
      this.composer = c;
    }
    this.scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
  }
  setSize(w, h) {
    this.w = w; this.h = h; this.renderer.setPixelRatio(this.ratioFor(this.quality)); this.renderer.setSize(w, h, false);
    if (this.composer) { const pr = this.renderer.getPixelRatio(); this.composer.setPixelRatio(pr); this.composer.setSize(w, h); }
  }
  render() {
    if (this.lost) return;
    const cp = this.camera.position; if (!(Number.isFinite(cp.x) && Number.isFinite(cp.y) && Number.isFinite(cp.z))) return;   // never draw a NaN frame
    if (this.composer) {
      const far = this.camera.position.length() > 5;   // SSAO radius is tuned for the gun; off for the long-range views
      if (this.ao) this.ao.enabled = !far;
      this.composer.render();
    } else this.renderer.render(this.scene, this.camera);
  }
}

// ------------------------------------------------------------------ scene-wide look
export class Look {
  constructor(scene, quality) {
    this.scene = scene; this.quality = quality; this.M = makeMaterials(quality); this.rigs = new Set(); this.glassOn = true;
    this.key = new THREE.DirectionalLight(0xffffff, 1.45); this.key.position.set(0.8, 2.2, 1.4);
    this.key.castShadow = true; this.key.shadow.mapSize.set(2048, 2048); this.key.shadow.radius = 6; this.key.shadow.bias = -0.0004; this.key.shadow.normalBias = 0.01;
    const sc = this.key.shadow.camera; sc.left = -1; sc.right = 1; sc.top = 1; sc.bottom = -1; sc.near = 0.1; sc.far = 6;
    scene.add(this.key, this.key.target);
    // contact shadow catcher just under the gun (the "display" shadow in the gun view)
    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.ShadowMaterial({ opacity: 0.28 }));
    this.catcher.rotation.x = -Math.PI / 2; this.catcher.receiveShadow = true; scene.add(this.catcher);
  }
  async useEnv(renderer) { const env = await loadEnv(renderer); if (env) { this.scene.environment = env; this.scene.environmentIntensity = 1.15; } return !!env; }
  setQuality(q) {
    this.quality = q; this.M = makeMaterials(q); this.condCache = new Map();
    for (const rig of this.rigs) this.dress(rig, true);
  }
  // material per part, shadows, and the glass side
  dress(rig, again = false) {
    this.rigs.add(rig); rig.outer.updateMatrixWorld(true);
    const M = this.M, gun = rig.gun, cond = rig.cond || "clean", condSet = COND_PARTS[gun];
    const caseMat = rig.caseMat === "brass" ? M.brass : rig.caseMat === "steel" ? M.lacquer : null;
    this.condCache = this.condCache || new Map();
    for (const part of rig.container.children) {
      const pname = part.name || "", slot = pname.startsWith("magslot_");
      part.traverse((o) => {
        if (!o.isMesh || o.userData.glass) return;
        const name = slot ? o.name || "" : pname, cls = classify(gun, name);
        const isCase = /case$|__case/.test(name) && (cls === "brass" || cls === "lacquer");
        // the Vykhor-6 GLB ships with NO vertex normals: the shader then normalises (0,0,0) = NaN, which lit nothing and, through the Ultra bloom, blacked out the whole frame
        if (!o.geometry.attributes.normal) { o.geometry.computeVertexNormals(); o.geometry.userData.madeNormals = true; }
        if (!o.userData.origMat) o.userData.origMat = o.material;
        if (cls === "wood" || cls === "steel" || cls === "brass" || cls === "phosphate") boxUV(o, cls === "wood" ? (gun === "AK" ? 3.2 : 2.2) : 14);
        let m = isCase && caseMat ? caseMat : (M[cls] || M.steel);
        if (gun === "GAT" && !isCase) {   // the Vykhor-6 keeps the GLB's own materials (steel, titanium, polymer, copper...), lifted so the environment shows them
          const om = o.userData.origMat; this.gatMats = this.gatMats || new Map();
          if (om && !this.gatMats.has(om.uuid)) { const c = om.clone(); c.envMapIntensity = 1.04; if (om.name === "steel" || om.name === "magnet_steel") { c.color.multiplyScalar(2.4); c.roughness = 0.38; } else if (om.name === "titanium") { c.color.multiplyScalar(1.15); c.metalness = 0.75; c.roughness = 0.4; } this.gatMats.set(om.uuid, c); }
          if (om) m = this.gatMats.get(om.uuid);
        }
        if (gun === "AK" && !isCase && M.akPark) m = cls === "wood" ? M.akWood : cls === "steel" ? (AK_BLUED.test(name) ? M.akBlued : AK_CARRIER.test(name) ? M.akCarrier : M.akPark) : cls === "phosphate" ? M.akPhos : m;
        if (rig.skin === "glass") m = glassPartMat(name, !["steel", "wood", "bakelite"].includes(cls));
        else if (rig.skin && rig.skin !== "factory" && (cls === "steel" || cls === "wood" || cls === "bakelite" || (gun === "GAT" && !isCase && !/brass|copper|bullet|case|round|primer|belt/i.test(name)))) { const sm = skinMaterial(rig.skin); if (sm) { m = sm; if (sm.map) boxUV(o, 6); } }
        if (cond !== "clean" && condSet[cond] && condSet[cond].includes(name)) {
          const key = m.uuid + cond; if (!this.condCache.has(key)) this.condCache.set(key, condMaterial(m, cond)); m = this.condCache.get(key);
        }
        o.material = m; o.castShadow = rig.skin !== "glass"; o.receiveShadow = this.quality === "ultra"; o.renderOrder = rig.skin === "glass" ? (m.opacity > 0.3 ? 3 : 4) : 0;
      });
    }
    this.setGlass(rig, this.glassOn);
    const b = new THREE.Box3().setFromObject(rig.outer);
    this.catcher.position.y = b.min.y - 0.004;
  }
  // split each outer shell part at the gun's lateral centre plane (world z = 0): the half facing the default camera
  // (+z) becomes glass, the far half stays opaque. The glass copy is a child of the part, so it moves with the slide.
  setSkin(rig, skin) { rig.skin = SKINS.includes(skin) ? skin : "factory"; this.dress(rig); }
  setCaseMat(rig, mat) { if ((rig.caseMat || null) === (mat || null) && rig.dressedCase) return; rig.caseMat = mat || null; rig.dressedCase = true; this.dress(rig); }
  setCondition(rig, cond) { if ((rig.cond || "clean") === cond && rig.dressedCond) return; rig.cond = cond; rig.dressedCond = true; this.dress(rig); }
  // which outer parts get the glass half. Makarov: its frame and slide. AK: found by geometry, not by part names (the
  // photo rebuild renames and splits shells): every non-moving outer part that a lateral ray from inside the action
  // (points along the internals and the barrel) hits on BOTH sides, i.e. a part that wraps around the works --
  // receiver, dust cover, gas tube, handguards. Parts lying wholly on the near side over the works count too.
  shellParts(rig) {
    if (rig.shellParts) return rig.shellParts;
    const kids = rig.container.children;
    if (rig.gun !== "AK") return (rig.shellParts = SHELL[rig.gun].map((n) => rig.container.getObjectByName(n)).filter(Boolean));   // by name anywhere under the model: a part can sit in a pivot (the Vykhor-6 feeder cover swings on one)
    rig.outer.updateMatrixWorld(true);
    const isContent = (p) => !p.name || ["phosphate", "spring"].includes(classify("AK", p.name)) || p.name === "barrel";
    const skip = (p) => !p.name || p.name.startsWith("magslot_") || /^(mag|round)/.test(p.name) || isContent(p);
    const cands = kids.filter((p) => !skip(p)), meshes = []; cands.forEach((p) => p.traverse((o) => { if (o.isMesh) { o.userData.shellOf = p; meshes.push(o); } }));
    const pts = [], brl = kids.find((p) => p.name === "barrel"), zb = brl ? new THREE.Box3().setFromObject(brl).getCenter(new THREE.Vector3()).z : 0;   // the bore plane
    for (const p of kids.filter(isContent)) {
      const b = new THREE.Box3().setFromObject(p); if (b.isEmpty()) continue; const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
      const ax = sz.x >= sz.y && sz.x >= sz.z ? "x" : sz.y >= sz.z ? "y" : "z";
      const ax2 = ["x", "y"].find((a) => a !== ax) || "y";   // a 7 x 3 grid in the side plane: long axis x height
      for (let i = 0; i < 7; i++) for (let j = 0; j < 3; j++) { const q = c.clone(); q[ax] = b.min[ax] + sz[ax] * (i + 0.5) / 7; q[ax2] = b.min[ax2] + sz[ax2] * (j + 0.5) / 3; q.z = zb; pts.push(q); }
    }
    const sides = meshes.map((o) => { const m = o.material, sd = m.side; m.side = THREE.DoubleSide; return [m, sd]; });   // single-sided shells too
    const ray = new THREE.Raycaster(), hitBy = new Map(), dirs = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
    for (const q of pts) {
      const hs = dirs.map((d) => { ray.set(q, d); ray.far = 0.2; return new Set(ray.intersectObjects(meshes, false).map((h) => h.object.userData.shellOf)); });
      for (const p of hs[0]) if (hs[1].has(p)) hitBy.set(p, (hitBy.get(p) || 0) + 1);
    }
    for (const [m, sd] of sides) m.side = sd;
    const out = cands.filter((p) => hitBy.get(p) > 0);
    for (const p of kids) if (p.name === "magazine_body" && !out.includes(p)) out.push(p);   // the magazine's right side too, so the stack of rounds shows through it
    rig.shellParts = out; rig.shellNames = out.map((p) => p.name);
    return out;
  }
  setGlass(rig, on) {
    this.glassOn = on;
    if (rig.skin === "glass") { rig.container.traverse((o) => { if (o.userData && o.userData.glass) o.visible = false; }); rig.glass = on; return; }   // the Glass skin already is every part
    const full = (this.quality === "ultra" || !COARSE) && !globalThis.__LOWGL;
    // the split plane: the gun's centre plane (world z = 0); the Vykhor-6's own axis is off-centre, so it splits through the rotor axis
    let z0 = 0; if (rig.gun === "GAT" && rig.spin) { rig.outer.updateMatrixWorld(true); z0 = rig.spin.pivot.getWorldPosition(new THREE.Vector3()).z; }
    const near = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z0), far = new THREE.Plane(new THREE.Vector3(0, 0, -1), z0);
    const shells = this.shellParts(rig);
    for (const part of shells) {
      part.traverse((o) => {
        if (!o.isMesh || o.userData.glass) return;
        let twin = o.children.find((c) => c.userData.glass);
        if (on) {
          o.material = cloneMat(o.material); o.material.clippingPlanes = [far]; o.material.clipShadows = true;
          if (!twin) { twin = new THREE.Mesh(o.geometry, null); twin.userData.glass = true; twin.renderOrder = 2; o.add(twin); }
          twin.material = glassMaterial(full); twin.material.clippingPlanes = [near]; twin.visible = true; twin.castShadow = false;
        } else {
          o.material.clippingPlanes = null; if (twin) twin.visible = false;
        }
      });
    }
    rig.glass = on;
  }
}

// ------------------------------------------------------------------ the range floor, its look follows the surface picker
function floorCanvas(surface) {
  const N = 512, c = document.createElement("canvas"); c.width = c.height = N; const g = c.getContext("2d");
  let seed = 1234; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const base = { concrete: "#8d8b86", dirt: "#6b5235", wood: "#8a5f38", metal: "#5c6066", gravel: "#86807a", grass: "#4f6a33", puddle: "#5d5145" }[surface] || "#888";
  g.fillStyle = base; g.fillRect(0, 0, N, N);
  if (surface === "wood") {
    for (let y = 0; y < N; y += 64) { g.fillStyle = `hsl(28,${35 + rnd() * 10}%,${30 + rnd() * 10}%)`; g.fillRect(0, y, N, 62); g.fillStyle = "#3a2615"; g.fillRect(0, y + 62, N, 2);
      for (let i = 0; i < 40; i++) { g.strokeStyle = `rgba(40,22,10,${0.08 + rnd() * 0.12})`; g.beginPath(); const yy = y + rnd() * 60; g.moveTo(0, yy); g.bezierCurveTo(N / 3, yy + rnd() * 6 - 3, 2 * N / 3, yy + rnd() * 6 - 3, N, yy); g.stroke(); } }
  } else if (surface === "metal") {
    for (let y = 0; y < N; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x < N; x += 32) { g.save(); g.translate(x + 8, y + 8); g.rotate(((x + y) / 32) % 2 ? 0.6 : -0.6); g.fillStyle = "#7d828a"; g.fillRect(-9, -2.5, 18, 5); g.fillStyle = "#3e4247"; g.fillRect(-9, 2.5, 18, 1.5); g.restore(); }
  } else if (surface === "gravel") {
    for (let i = 0; i < 2600; i++) { const v = rnd(); g.fillStyle = `rgb(${100 + v * 90},${95 + v * 85},${88 + v * 80})`; g.beginPath(); g.ellipse(rnd() * N, rnd() * N, 2 + rnd() * 6, 2 + rnd() * 5, rnd() * 3, 0, Math.PI * 2); g.fill(); }
  } else if (surface === "grass") {
    for (let i = 0; i < 9000; i++) { const x = rnd() * N, y = rnd() * N, h = 4 + rnd() * 10; g.strokeStyle = `hsl(${85 + rnd() * 30},${35 + rnd() * 25}%,${22 + rnd() * 22}%)`; g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd() * 4 - 2, y - h); g.stroke(); }
  } else if (surface === "puddle") {
    for (let i = 0; i < 9000; i++) { const v = rnd(); g.fillStyle = `rgba(${40 + v * 80},${30 + v * 50},${15 + v * 30},.5)`; g.fillRect(rnd() * N, rnd() * N, 2, 2); }
    g.fillStyle = "rgba(30,38,48,.85)"; for (let i = 0; i < 5; i++) { g.beginPath(); g.ellipse(rnd() * N, rnd() * N, 60 + rnd() * 90, 30 + rnd() * 50, rnd() * 3, 0, Math.PI * 2); g.fill(); }
  } else {
    const n = surface === "dirt" ? 9000 : 14000;
    for (let i = 0; i < n; i++) { const v = rnd(); g.fillStyle = surface === "dirt" ? `rgba(${40 + v * 80},${30 + v * 50},${15 + v * 30},.5)` : `rgba(${110 + v * 70},${110 + v * 70},${105 + v * 70},.35)`; const s = surface === "dirt" ? 1 + rnd() * 4 : 1 + rnd() * 2; g.fillRect(rnd() * N, rnd() * N, s, s); }
    if (surface === "concrete") { g.strokeStyle = "rgba(60,60,58,.35)"; g.lineWidth = 2; g.strokeRect(1, 1, N - 2, N - 2); }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
export class RangeFloor {
  constructor(scene) {
    this.mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(700, 60), this.mat);
    this.mesh.rotation.x = -Math.PI / 2; this.mesh.position.x = 300; this.mesh.receiveShadow = true; scene.add(this.mesh);
    this.cache = {};
  }
  set(surface, y) {
    if (!this.cache[surface]) this.cache[surface] = floorCanvas(surface);
    const t = this.cache[surface]; t.repeat.set(700 / (surface === "wood" ? 1.2 : 2), 60 / (surface === "wood" ? 1.2 : 2));
    this.mat.map = t; this.mat.metalness = surface === "metal" ? 0.7 : 0; this.mat.roughness = surface === "metal" ? 0.45 : surface === "wood" ? 0.6 : surface === "puddle" ? 0.25 : 0.92;
    this.mat.needsUpdate = true; this.mesh.position.y = y; this.surface = surface;
  }
}
