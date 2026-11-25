// vehfire.js -- the Shooting Range's VEHICLE WEAPONS (owner, 19 Nov: "i want firing abilty for all guns in our shooting range here").
// T-64BV: 125 mm 2A46 (APFSDS 3BM42 / HEAT 3BK18M / HE-frag 3OF26), 7.62 mm PKT coax, 12.7 mm NSVT on the cupola.
// BMP-3:  100 mm 2A70 (HE-frag 3OF32, gun-launched 9M117 ATGM, guided), 30 mm 2A72 (bursts, HE-T / AP-T), 7.62 mm PKT coax.
// BM-21:  40 x 122 mm 9M22U rockets, single or ripple (one every 0.5 s); the four wrap-around fins spring open as the tail clears the tube
//         (members/cloud-claude-work/arena/requirements/BM21-FINS-TODO.md: 0 -> 90 deg in 40 ms, 96 deg at 45 ms, 90 deg locked at 60 ms, 0-4 ms stagger).
// Ballistics: point-mass flight with quadratic drag (a = -k |v| v, k in 1/m) and gravity, like the page's own external ballistics; rockets add
// thrust and burn-off mass; the ATGM rides a beam to the laid target. All numbers marked APPROX in the About list are estimates.
// The page hands this module its objects through `A` (see the VEHICLE FIRE hook in index.html); nothing here touches the guns' simulator.
// Hot paths (projectile step, particles, tracers) reuse preallocated objects: no allocation per frame.

const G = 9.81;
const D2R = Math.PI / 180;
// ---------------------------------------------------------------- ammunition (APPROX where noted in the About list)
const AMMO = {
  apfsds: { name: "APFSDS 3BM42", short: "APFSDS", v0: 1715, mass: 4.85, cal: 125, k: 5.5e-5, disp: 0.15e-3, fx: "kinetic", model: "t64apfsds", tracer: [5, 1.4, 0.4], sabot: true },
  heat:   { name: "HEAT 3BK18M", short: "HEAT", v0: 905, mass: 19.0, cal: 125, k: 1.3e-4, disp: 0.25e-3, fx: "heat", model: "t64heat", tracer: [5, 1.6, 0.4] },
  he125:  { name: "HE-frag 3OF26", short: "HE-FRAG", v0: 850, mass: 23.0, cal: 125, k: 1.1e-4, disp: 0.3e-3, fx: "he", model: "t64he", tracer: [5, 1.6, 0.4], heR: 1.6 },
  pkt:    { name: "7.62x54R LPS (PKT)", short: "7.62", v0: 825, mass: 0.0096, cal: 7.62, k: 8.7e-4, disp: 0.8e-3, fx: "bullet", tracerEvery: 4, tracer: [5, 0.5, 0.3] },
  nsvt:   { name: "12.7x108 B-32 (NSVT)", short: "12.7", v0: 845, mass: 0.048, cal: 12.7, k: 4.3e-4, disp: 1.0e-3, fx: "bullet", tracerEvery: 3, tracer: [5, 0.5, 0.3] },
  he100:  { name: "HE-frag 3OF32 (100 mm)", short: "HE-FRAG", v0: 250, mass: 15.8, cal: 100, k: 1.2e-4, disp: 0.6e-3, fx: "he", model: "bmphe", tracer: [5, 1.6, 0.4], heR: 1.4 },
  atgm:   { name: "9M117 ATGM (beam-riding)", short: "ATGM", v0: 300, vCruise: 370, mass: 17.6, cal: 100, k: 0, disp: 0, fx: "heat", model: "bmpatgm", guided: true, flare: true },
  het30:  { name: "30 mm HE-T 3UOF8", short: "HE-T", v0: 960, mass: 0.39, cal: 30, k: 5e-4, disp: 1.0e-3, fx: "he_small", tracerEvery: 1, tracer: [5, 1.2, 0.3], heR: 0.5 },
  apt30:  { name: "30 mm AP-T 3UBR6", short: "AP-T", v0: 970, mass: 0.40, cal: 30, k: 4e-4, disp: 0.9e-3, fx: "kinetic_small", tracerEvery: 1, tracer: [5, 0.9, 0.3] },
  // Phase 2 (the Godot range's infantry and support weapons): 82 mm mortar bomb by charge, PG-7VL, Javelin
  m82c4: { name: "82 mm O-832DU, charge 4 (211 m/s)", short: "HE ch.4", v0: 211, mass: 3.1, cal: 82, k: 3.1e-4, disp: 3e-3, fx: "he", heR: 1.1, highAngle: true, model: "bomb82" },
  m82c3: { name: "82 mm O-832DU, charge 3 (185 m/s)", short: "HE ch.3", v0: 185, mass: 3.1, cal: 82, k: 3.1e-4, disp: 3e-3, fx: "he", heR: 1.1, highAngle: true, model: "bomb82" },
  m82c2: { name: "82 mm O-832DU, charge 2 (150 m/s)", short: "HE ch.2", v0: 150, mass: 3.1, cal: 82, k: 3.1e-4, disp: 3e-3, fx: "he", heR: 1.1, highAngle: true, model: "bomb82" },
  m82c1: { name: "82 mm O-832DU, charge 1 (110 m/s)", short: "HE ch.1", v0: 110, mass: 3.1, cal: 82, k: 3.1e-4, disp: 3e-3, fx: "he", heR: 1.1, highAngle: true, model: "bomb82" },
  pg7vl: { name: "PG-7VL (93 mm HEAT)", short: "PG-7VL", v0: 115, vMax: 295, sustain: [0.1, 280], destruct: 4.5, mass: 2.6, cal: 93, k: 2.2e-4, disp: 2e-3, fx: "heat", model: "pg7vl", flare: true },
  jav:   { name: "Javelin FGM-148 (top attack)", short: "JAVELIN", v0: 28, vCruise: 190, mass: 11.8, cal: 127, k: 0, disp: 0, fx: "heat", model: "javm", guided: "top", flare: true },
  grad:   { name: "122 mm 9M22U rocket", short: "9M22U", v0: 0, mass: 66.6, burnMass: 20.45, burn: 1.8, thrust: 21400, cal: 122, cdA: 0.00215, disp: 4e-3, fx: "rocket_he", model: "grad", heR: 2.6, tube: 3.0, len: 2.874 },
};
// weapons per vehicle; `at` names the moving node the muzzle rides on (resolved in rigFor)
const WEAP = {
  t64bv: [
    { id: "2a46", name: "125 mm 2A46 main gun", kind: "cannon", ammo: ["apfsds", "heat", "he125"], load: { apfsds: 10, heat: 8, he125: 10 }, cap: 28, cycle: 7.1, reload: 20, recoil: 0.30, rock: 0.012, snd: "boom", follow: true },
    { id: "pkt", name: "7.62 mm PKT (coax)", kind: "mg", ammo: ["pkt"], cap: 250, rpm: 750, reload: 6, snd: "mg" },
    { id: "nsvt", name: "12.7 mm NSVT (cupola)", kind: "mg", ammo: ["nsvt"], cap: 50, rpm: 750, reload: 5, snd: "hmg" },
  ],
  bmp3: [
    { id: "2a70", name: "100 mm 2A70", kind: "cannon", ammo: ["he100", "atgm"], load: { he100: 22, atgm: 3 }, cap: 25, cycle: 6.0, reload: 20, recoil: 0.18, rock: 0.006, snd: "boom100", follow: true },
    { id: "2a72", name: "30 mm 2A72 autocannon", kind: "auto", ammo: ["het30", "apt30"], load: { het30: 305, apt30: 195 }, cap: 500, rpm: 330, reload: 10, recoil: 0.04, rock: 0.0015, snd: "ac", modes: [["b4", "Short burst (4)"], ["b10", "Long burst (10)"], ["hold", "Hold to fire"]] },
    { id: "pktb", name: "7.62 mm PKT (coax)", kind: "mg", ammo: ["pkt"], cap: 250, rpm: 750, reload: 6, snd: "mg" },
  ],
  mortar: [{ id: "2b14", name: "82 mm 2B14 mortar (stand-in model)", kind: "cannon", ammo: ["m82c4", "m82c3", "m82c2", "m82c1"], cap: 30, cycle: 3.0, reload: 15, snd: "mortar", follow: true }],
  hmg: [{ id: "nsv", name: "12.7 mm NSV on a 6T7 tripod (stand-in model)", kind: "mg", ammo: ["nsvt"], cap: 50, rpm: 750, reload: 5, snd: "hmg" }],
  rpg7: [{ id: "rpg", name: "RPG-7 with PG-7VL", kind: "cannon", ammo: ["pg7vl"], cap: 5, cycle: 4.0, reload: 15, snd: "rpg", follow: true }],
  jav: [{ id: "jav", name: "Javelin (top attack)", kind: "cannon", ammo: ["jav"], cap: 3, cycle: 20, reload: 20, snd: "jav", follow: true, lock: 1.5 }],
  bm21: [
    { id: "grad", name: "BM-21 Grad: 40 x 122 mm", kind: "rocket", ammo: ["grad"], cap: 40, reload: 15, snd: "whoosh", follow: true, modes: [["single", "Single rocket"], ["ripple", "Ripple: all loaded, 0.5 s apart"]] },
  ],
  "t64bv-cutaway-32k": [
    { id: "2a46c", name: "125 mm 2A46 main gun", kind: "cannon", ammo: ["apfsds", "heat", "he125"], load: { apfsds: 10, heat: 8, he125: 10 }, cap: 28, cycle: 7.1, reload: 20, recoil: 0.25, rock: 0.012, snd: "boom", follow: true },
  ],
  "t72b3-hd": [
    { id: "2a46m5", name: "125 mm 2A46M-5 main gun", kind: "cannon", ammo: ["apfsds", "heat", "he125"], load: { apfsds: 10, heat: 8, he125: 10 }, cap: 28, cycle: 7.1, reload: 20, recoil: 0.25, rock: 0.012, snd: "boom", follow: true },
    { id: "pkt72", name: "7.62 mm PKTM coax", kind: "mg", ammo: ["pkt"], cap: 250, rpm: 750, reload: 6, snd: "mg" },
  ],
  "leopard2a4-hd": [
    { id: "rh120", name: "120 mm Rh-120 L/44 main gun", kind: "cannon", ammo: ["apfsds", "heat", "he125"], load: { apfsds: 12, heat: 8, he125: 8 }, cap: 28, cycle: 6.0, reload: 18, recoil: 0.25, rock: 0.011, snd: "boom", follow: true },
    { id: "mg3", name: "7.62 mm MG3 coax", kind: "mg", ammo: ["pkt"], cap: 250, rpm: 1000, reload: 6, snd: "mg" },
  ],
  "pzh2000-ext": [
    { id: "l52", name: "155 mm L/52 howitzer", kind: "cannon", ammo: ["he125", "heat"], load: { he125: 20, heat: 10 }, cap: 30, cycle: 6.5, reload: 20, recoil: 0.35, rock: 0.015, snd: "boom", follow: true },
  ],
  "gepard-ext": [
    { id: "oerlikon", name: "Twin 35 mm Oerlikon KDA", kind: "auto", ammo: ["het30", "apt30"], load: { het30: 320, apt30: 180 }, cap: 500, rpm: 550, reload: 10, recoil: 0.05, rock: 0.002, snd: "ac", modes: [["b4", "Short burst (4)"], ["b10", "Long burst (10)"], ["hold", "Hold to fire"]] },
  ],
  "bmp2-hd": [
    { id: "2a42", name: "30 mm 2A42 autocannon", kind: "auto", ammo: ["het30", "apt30"], load: { het30: 300, apt30: 200 }, cap: 500, rpm: 330, reload: 10, recoil: 0.04, rock: 0.002, snd: "ac", modes: [["b4", "Short burst (4)"], ["b10", "Long burst (10)"], ["hold", "Hold to fire"]] },
  ],
  "m113-hd": [
    { id: "m2hb", name: "12.7 mm M2HB Browning", kind: "mg", ammo: ["nsvt"], cap: 100, rpm: 550, reload: 6, snd: "hmg" },
  ],
  "mtlb-hd": [
    { id: "pktm", name: "7.62 mm PKT turret", kind: "mg", ammo: ["pkt"], cap: 250, rpm: 750, reload: 6, snd: "mg" },
  ],
};
const MODELS = { t64apfsds: "models/ammo-t64-apfsds.glb.gz.b64.txt", t64heat: "models/ammo-t64-heat.glb.gz.b64.txt", t64he: "models/ammo-t64-hefrag.glb.gz.b64.txt",
  bmphe: "models/ammo-bmp3-100-hefrag.glb.gz.b64.txt", bmpatgm: "models/ammo-bmp3-100-atgm.glb.gz.b64.txt", grad: "models/9m22-rocket.glb.gz.b64.txt", javm: "models/javelin-missile.glb.gz.b64.txt" };
// the support weapons sit in their own row; they reuse the page's view-only rig path (VIEWONLY + a build() instead of a file)
const SUPPORT = { mortar: { label: "Mortar 82", name: "82 mm mortar", ranges: [-30, 30, 0, 45, 85, 60] }, hmg: { label: "HMG 12.7", name: "12.7 mm HMG", ranges: [-60, 60, 0, -10, 30, 0] },
  rpg7: { label: "RPG-7", name: "RPG-7", file: "models/rpg7.glb.gz.b64.txt", ranges: [-45, 45, 0, -10, 30, 0] }, jav: { label: "Javelin", name: "Javelin", file: "models/javelin.glb.gz.b64.txt", ranges: [-45, 45, 0, -5, 45, 0] } };
const TARGETS = [
  { id: "t200", d: 200, z: -22, kind: "steel", label: "200 m: steel plates" },
  { id: "t500", d: 500, z: 0, kind: "hulk", label: "500 m: tank hulk" },
  { id: "t1000", d: 1000, z: 40, kind: "hulk", label: "1000 m: tank hulk" },
  { id: "t5000", d: 5000, z: 0, kind: "hulk", label: "5 km: area target (Grad)", only: "bm21" },
];

export function installVehicleFire(A) {
  const THREE = A.THREE, $ = A.$, S = A.S, CLOCK = A.CLOCK;
  const LOW = () => S.quality === "low";
  const V3 = () => new THREE.Vector3();
  const st = { wind: { x: 0, z: 0 }, camSel: {}, key: null, rig: null, W: null, weapons: {}, sel: {}, ammoSel: {}, modeSel: {}, target: "t500", cam: "follow", autoLay: true,
    lay: null, laid: true, queued: false, holding: false, burst: 0, nextAuto: 0, ripple: null, events: [], shots: 0, impacts: 0, lastPhys: CLOCK.t,
    camHold: null, savedCam: null, followP: null, rockQ: 0, rockV: 0, signY: 1, signE: 1, models: {}, modelLoading: {}, tubes: null, info: "", lastInfoAt: 0 };
  window.__vf = st; A.extraBoxes = A.extraBoxes || [];
  const root = new THREE.Group(); root.name = "vehfire"; root.visible = false; A.scene.add(root);

  // ---------------------------------------------------------------- ground and targets (only while a vehicle's weapons are active)
  // ground: a subtle dirt texture with a faint 50 m grid that fades with distance (mipmaps + haze), so the horizon has no hard edge
  const groundTex = (() => { const N = 512, c = document.createElement("canvas"); c.width = c.height = N; const g = c.getContext("2d"); g.fillStyle = "#7a7158"; g.fillRect(0, 0, N, N);
    let r = 7; const rn = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 2600; i++) { const v = 95 + rn() * 50; g.fillStyle = `rgba(${v + 18},${v + 10},${v - 12},0.35)`; g.fillRect(rn() * N, rn() * N, 2 + rn() * 5, 2 + rn() * 5); }
    g.strokeStyle = "rgba(60,54,40,0.12)"; g.lineWidth = 2; g.strokeRect(0, 0, N, N); g.beginPath(); g.moveTo(N / 2, 0); g.lineTo(N / 2, N); g.stroke();
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(30000 / 100, 6000 / 100); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: groundTex, roughness: 0.97, metalness: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30000, 6000), groundMat); ground.rotation.x = -Math.PI / 2; ground.position.set(14000, 0, 0); ground.receiveShadow = false; root.add(ground);
  const hulkMat = new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 0.95, metalness: 0.25 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.6, metalness: 0.4 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3d3a34, roughness: 0.9 });
  const tgts = [], markers = [];
  function boxMesh(w, h, d, mat, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; return m; }
  function buildTargets() {
    for (const T of TARGETS) {
      const g = new THREE.Group(); g.name = "target_" + T.id; root.add(g);
      const t = { ...T, group: g, boxes: [], plates: [] };
      if (T.kind === "steel") {
        for (const dz of [-4, 0, 4]) {   // three poppers on a frame; each swings back when hit and resets after 3 s
          const pv = new THREE.Group(); pv.position.set(0, 2.1, dz); g.add(pv);
          const pl = boxMesh(0.04, 1.5, 1.5, plateMat.clone(), 0, -0.85, 0); pv.add(pl);
          g.add(boxMesh(0.12, 2.2, 0.12, postMat, 0.2, 1.1, dz - 0.85)); g.add(boxMesh(0.12, 2.2, 0.12, postMat, 0.2, 1.1, dz + 0.85));
          t.plates.push({ pv, pl, ang: 0, w: 0, hitAt: -1e9, box: new THREE.Box3() });
        }
      } else {   // a burnt-out tank: a box stand-in until the real model (loadHulks) has arrived
        g.add(boxMesh(6.4, 1.0, 3.3, hulkMat, 0, 1.0, 0)); g.add(boxMesh(6.6, 0.75, 0.55, postMat, 0, 0.4, 1.45)); g.add(boxMesh(6.6, 0.75, 0.55, postMat, 0, 0.4, -1.45));
        const tur = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 0.7, 14), hulkMat); tur.position.set(0.3, 1.85, 0); tur.castShadow = true; g.add(tur);
        const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 8), hulkMat); gun.rotation.z = Math.PI / 2 - 0.05; gun.position.set(-2.4, 1.95, 0.2); g.add(gun);
        t.local = [[-3.3, 0, -1.75, 3.3, 1.5, 1.75], [-0.85, 1.5, -1.25, 1.45, 2.2, 1.25]];
      }
      if (T.d >= 5000) for (const [dx, dz] of [[-60, -60], [-60, 60], [60, -60], [60, 60]]) { const f = boxMesh(0.2, 3, 0.2, new THREE.MeshBasicMaterial({ color: 0xff3020 }), dx, 1.5, dz); f.userData.keep = true; g.add(f); }
      tgts.push(t);
    }
  }
  buildTargets();
  // range markers: a board at 200 / 500 / 1000 m on the left of the lanes
  for (const d of [200, 500, 1000]) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 128; const g = c.getContext("2d"); g.fillStyle = "#f2efe4"; g.fillRect(0, 0, 256, 128); g.fillStyle = "#c62f2b"; g.fillRect(0, 0, 256, 18); g.fillStyle = "#1c1e21"; g.font = "bold 64px system-ui,sans-serif"; g.textAlign = "center"; g.fillText(d + " m", 128, 98);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; const m = new THREE.Group(); m.name = "marker_" + d;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(d / 70 + 2, (d / 70 + 2) / 2), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide })); board.rotation.y = -Math.PI / 2 + 0.35; board.position.y = 1.6 + d / 140;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, board.position.y, 0.12), postMat); post.position.y = board.position.y / 2; m.add(board, post); m.userData.d = d; root.add(m); markers.push(m);
  }
  let groundY = 0;
  // target hulks: the range's own BMP-3 and old T-64 models, burnt (one charcoal / rust palette), static; loaded only once vehicle firing is used
  const burnt = [0x423b34, 0x524031, 0x34302c].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.92, metalness: 0.1 }));
  const HULKS = { t500: ["models/bmp3.glb.gz.b64.txt", 7.1, 0.5], t1000: ["models/t64bv.glb.gz.b64.txt", 9.5, -0.4], t5000: ["models/t64bv.glb.gz.b64.txt", 9.5, 0.9] };
  let hulksLoading = false;
  function loadHulks() {
    if (hulksLoading) return; hulksLoading = true; const cache = {};
    for (const [id, [file, len, yaw]] of Object.entries(HULKS)) {
      (cache[file] ||= A.fetchGLB(file, "target hulk")).then((gltf) => {
        const T = tgts.find((t) => t.id === id); if (!T) return;
        const src = T.id === "t5000" ? gltf.scene.clone(true) : gltf.scene, g = new THREE.Group(); let k = 0;
        src.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = burnt[k++ % 3]; o.castShadow = true; o.frustumCulled = true; } });
        g.add(src); g.updateMatrixWorld(true); let b = new THREE.Box3().setFromObject(src), sz = b.getSize(V3());
        const sc = len / Math.max(sz.x, sz.z); src.scale.multiplyScalar(sc); if (sz.x > sz.z) src.rotation.y = Math.PI / 2;
        g.rotation.y = yaw; g.updateMatrixWorld(true); b = new THREE.Box3().setFromObject(g); const c = b.getCenter(V3()); src.position.x -= c.x; src.position.z -= c.z; src.position.y -= b.min.y;
        for (const ch of T.group.children) if (!ch.userData.keep) ch.visible = false;
        T.group.add(g); T.model = g; fitHulkBoxes(T); A.markDirty();
      }).catch((e) => console.warn("hulk", e));
    }
  }
  function fitHulkBoxes(T) {   // two collision boxes from the model: the hull (lower 55 %) and the turret (upper part, central 60 %)
    T.group.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(T.model), s = b.getSize(V3()), c = b.getCenter(V3()), ym = b.min.y + s.y * 0.55;
    T.boxes = [new THREE.Box3(b.min.clone(), new THREE.Vector3(b.max.x, ym, b.max.z)), new THREE.Box3(new THREE.Vector3(c.x - s.x * 0.3, ym, c.z - s.z * 0.3), new THREE.Vector3(c.x + s.x * 0.3, b.max.y, c.z + s.z * 0.3))];
    T.aim = new THREE.Vector3(c.x, b.min.y + s.y * 0.45, c.z); T.top = b.max.y;
  }
  const KILL = { kinetic: 900, heat: 800, he: 600, rocket_he: 1000, he_small: 60, kinetic_small: 40, bullet: 1 };
  function hurtHulk(T, a) {
    if (T.dead) return; T.hp = (T.hp ?? 2400) - (KILL[a.fx] || 5);
    if (T.hp <= 0) { T.dead = CLOCK.t; T.burnAcc = 0; st.events.push({ e: "kill", t: CLOCK.t, id: T.id }); A.toast(`Target at ${T.d >= 1000 ? T.d / 1000 + " km" : T.d + " m"} destroyed: it burns.`); }
  }
  function stepBurning(dt) {
    let any = false;
    for (const T of tgts) {
      if (!T.dead || !T.group.visible) continue; if (CLOCK.t - T.dead > 90 * S.speed) { T.dead = 0; T.hp = 2400; continue; }   // a fresh hulk after 90 s
      T.burnAcc += dt; const top = T.top ?? (groundY + 2.2), x = T.aim.x, z = T.aim.z;
      while (T.burnAcc > (LOW() ? 0.35 : 0.12)) { T.burnAcc -= LOW() ? 0.35 : 0.12;
        emitP(smoke, x + rnd(1), top, z + rnd(1), rnd(0.6) + 1, 3 + Math.random() * 2, rnd(0.6), 1.2, 2.2, 7, 0.09, 0.08, 0.07, 0.5, 0.3, 0.6);
        if (Math.random() < 0.7) emitP(fire, x + rnd(1.2), top - 0.3, z + rnd(1.2), rnd(0.5), 1.5 + Math.random() * 2, rnd(0.5), 0.8, 0.8, 0.5, 1, 0.45, 0.12, 0.8, 1, 2); }
      any = true;
    }
    return any;
  }
  function placeTargets() {
    const r = st.rig; groundY = r ? -r.box.y / 2 : 0;
    ground.position.y = groundY - 0.03;
    for (const t of tgts) {
      t.group.position.set(t.d, groundY, t.z); t.group.visible = !t.only || t.only === st.key; t.group.updateMatrixWorld(true);
      t.boxes = (t.local || []).map((b) => new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]).add(t.group.position), new THREE.Vector3(b[3], b[4], b[5]).add(t.group.position)));
      for (const p of t.plates) { p.pv.rotation.z = 0; p.pv.updateMatrixWorld(true); p.box.setFromObject(p.pl); }
      t.aim = new THREE.Vector3(t.d, groundY + (t.kind === "steel" ? 1.25 : 1.4), t.z);
      if (t.model) fitHulkBoxes(t);
    }
    for (const m of markers) m.position.set(m.userData.d, groundY, -52);
  }

  // ---------------------------------------------------------------- particles: smoke (normal blend) and fire (additive), ring buffers
  function makePoints(cap, additive) {
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(cap * 3), size = new Float32Array(cap), col = new Float32Array(cap * 4);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("size", new THREE.BufferAttribute(size, 1)); geo.setAttribute("col", new THREE.BufferAttribute(col, 4));
    const mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 500 } }, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: "attribute float size; attribute vec4 col; uniform float uScale; varying vec4 vC; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * uScale / max(0.05, -mv.z); gl_Position = projectionMatrix * mv; vC = col; }",
      fragmentShader: "varying vec4 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard; float a = vC.a * smoothstep(0.5, 0.05, r); gl_FragColor = vec4(vC.rgb * (" + (additive ? "a" : "1.0") + "), " + (additive ? "1.0" : "a") + "); }" });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = additive ? 12 : 11; root.add(pts);
    const P = { cap, pts, pos, size, col, vel: new Float32Array(cap * 3), age: new Float32Array(cap), life: new Float32Array(cap), grow: new Float32Array(cap), a0: new Float32Array(cap), drag: new Float32Array(cap), lift: new Float32Array(cap), head: 0, live: 0 };
    for (let i = 0; i < cap; i++) P.life[i] = 0;
    return P;
  }
  const smoke = makePoints(1400, false), fire = makePoints(700, false);   // flames are drawn opaque-ish, not additive: they must read against the light sky and haze smoke.isSmoke = true; smoke.alphaSum = 0;
  function emitP(P, x, y, z, vx, vy, vz, size, grow, life, r, g, b, a, drag = 1.5, lift = 0) {
    if (P.isSmoke) { const capA = LOW() ? 18 : 42; if (P.alphaSum > capA) { a *= capA / P.alphaSum; if (a < 0.02) return; } P.alphaSum += a; }   // a budget on the total smoke opacity: a ripple never whites out the view
    const cap = LOW() ? (P === smoke ? 350 : 180) : P.cap, i = P.head % cap; P.head = (P.head + 1) % cap;
    P.pos[i * 3] = x; P.pos[i * 3 + 1] = y; P.pos[i * 3 + 2] = z; P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz;
    P.size[i] = size; P.grow[i] = grow; P.age[i] = 0; P.life[i] = life; P.col[i * 4] = r; P.col[i * 4 + 1] = g; P.col[i * 4 + 2] = b; P.col[i * 4 + 3] = a; P.a0[i] = a; P.drag[i] = drag; P.lift[i] = lift;
  }
  function stepP(P, dt) {
    let live = 0, aSum = 0; const wx = P.isSmoke ? st.wind.x : 0, wz = P.isSmoke ? st.wind.z : 0;
    for (let i = 0; i < P.cap; i++) {
      if (P.life[i] <= 0) continue;
      P.age[i] += dt; const u = P.age[i] / P.life[i];
      if (u >= 1) { P.life[i] = 0; P.size[i] = 0; P.col[i * 4 + 3] = 0; continue; }
      live++; const k = Math.exp(-P.drag[i] * dt);
      P.vel[i * 3] *= k; P.vel[i * 3 + 1] = P.vel[i * 3 + 1] * k + P.lift[i] * dt; P.vel[i * 3 + 2] *= k;
      P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      if (P.pos[i * 3 + 1] < groundY) P.pos[i * 3 + 1] = groundY;
      P.size[i] += P.grow[i] * dt; P.col[i * 4 + 3] = P.a0[i] * (1 - u) * (u < 0.08 ? u / 0.08 : 1); aSum += P.col[i * 4 + 3];
      if (wx || wz) { P.pos[i * 3] += wx * dt; P.pos[i * 3 + 2] += wz * dt; }
    }
    P.live = live; P.alphaSum = aSum;
    if (live || P.wasLive) { P.pts.geometry.attributes.position.needsUpdate = true; P.pts.geometry.attributes.size.needsUpdate = true; P.pts.geometry.attributes.col.needsUpdate = true; }
    P.wasLive = live > 0;
    return live;
  }
  const rnd = (a) => (Math.random() * 2 - 1) * a;

  // ---------------------------------------------------------------- tracers: ONE LineSegments for every projectile
  const MAXP = 160;
  const trGeo = new THREE.BufferGeometry(), trPos = new Float32Array(MAXP * 6), trCol = new Float32Array(MAXP * 6);
  trGeo.setAttribute("position", new THREE.BufferAttribute(trPos, 3)); trGeo.setAttribute("color", new THREE.BufferAttribute(trCol, 3));
  const tracers = new THREE.LineSegments(trGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
  tracers.frustumCulled = false; tracers.renderOrder = 13; root.add(tracers);

  // ---------------------------------------------------------------- craters and hit marks (pooled discs with a radial scorch texture)
  const scorchTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    gr.addColorStop(0, "rgba(10,8,6,0.95)"); gr.addColorStop(0.45, "rgba(30,24,18,0.8)"); gr.addColorStop(0.75, "rgba(60,50,38,0.45)"); gr.addColorStop(1, "rgba(60,50,38,0)"); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const decalMat = new THREE.MeshBasicMaterial({ map: scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const splashMat = new THREE.MeshBasicMaterial({ color: 0xf2efe6, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const discGeo = new THREE.CircleGeometry(1, 20), decals = []; let decalHead = 0;
  const Z = new THREE.Vector3(0, 0, 1), tmpQ = new THREE.Quaternion();
  function addDecal(p, n, r, steel, parent) {
    const cap = LOW() ? 30 : 90; let d = decals[decalHead % cap];
    if (!d) { d = new THREE.Mesh(discGeo, decalMat); d.renderOrder = 2; decals[decalHead % cap] = d; }
    decalHead++; d.material = steel ? splashMat : decalMat; (parent || root).add(d);
    d.scale.setScalar(r); d.quaternion.copy(tmpQ.setFromUnitVectors(Z, n)); d.position.copy(p).addScaledVector(n, 0.012);
    if (parent) parent.worldToLocal(d.position), d.quaternion.premultiply(parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    d.visible = true;
  }

  // ---------------------------------------------------------------- muzzle flash meshes and the explosion light
  const flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.3, 0.8), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  function makeFlash() { const g = new THREE.Group(); const c = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.2, 14, 1, true), flashMat); c.rotation.x = -Math.PI / 2; c.position.z = -1.1; const b = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), flashMat); g.add(c, b); g.visible = false; root.add(g); return g; }
  const flashes = [makeFlash(), makeFlash()];
  let boomLight = null;

  // ---------------------------------------------------------------- sounds: synthesised once into buffers, played through the page's audio bus (its volume, its room)
  const SND = {};
  function synth(ctx, name) {
    const sr = ctx.sampleRate, dur = { mortar: 1.4, rpg: 1.6, jav: 2.4, boom: 2.6, boom100: 2.0, ac: 0.7, mg: 0.32, hmg: 0.45, whoosh: 3.2, expl: 3.2, expl_small: 1.2, clang: 0.8, crack: 0.25 }[name] || 1, n = Math.floor(sr * dur);
    const b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0); let lp = 0, lp2 = 0, seed = 1234 + name.length * 77;
    const nz = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
    for (let i = 0; i < n; i++) {
      const t = i / sr; let s = 0;
      if (name === "boom" || name === "boom100" || name === "expl" || name === "expl_small") {
        const big = name === "boom" ? 1 : name === "expl" ? 1.25 : name === "boom100" ? 0.75 : 0.45, cut = name.startsWith("expl") ? 0.04 : 0.09;
        lp += cut * (nz() - lp); lp2 += 0.02 * (lp - lp2);
        s = (t < 0.006 ? nz() * (1 - t / 0.006) : 0) + lp * 2.4 * Math.exp(-t / (0.18 * big)) + lp2 * 5 * Math.exp(-t / (0.7 * big)) + 0.8 * Math.sin(2 * Math.PI * (55 - 25 * Math.min(1, t)) * t) * Math.exp(-t / (0.45 * big));
      } else if (name === "ac") { lp += 0.15 * (nz() - lp); s = (t < 0.004 ? nz() : 0) + lp * 2.2 * Math.exp(-t / 0.05) + 0.7 * Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t / 0.09); }
      else if (name === "mg" || name === "hmg") { const k = name === "hmg" ? 1.6 : 1; lp += 0.3 * (nz() - lp); s = (t < 0.002 ? nz() : 0) + lp * 1.8 * Math.exp(-t / (0.018 * k)) + 0.4 * Math.sin(2 * Math.PI * 160 / k * t) * Math.exp(-t / (0.035 * k)); }
      else if (name === "whoosh") { const env = t < 0.04 ? t / 0.04 : t < 1.8 ? 1 - 0.25 * (t / 1.8) : 0.75 * Math.exp(-(t - 1.8) / 0.4); lp += (0.05 + 0.1 * Math.min(1, t)) * (nz() - lp); s = lp * 2.2 * env + (t < 0.05 ? nz() * 0.8 * (1 - t / 0.05) : 0); }
      else if (name === "mortar") { lp += 0.1 * (nz() - lp); s = (t < 0.004 ? nz() * 0.7 : 0) + lp * 1.6 * Math.exp(-t / 0.07) + 0.9 * Math.sin(2 * Math.PI * 62 * t) * Math.exp(-t / 0.22) + 0.12 * Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t / 0.35); }
      else if (name === "rpg" || name === "jav") { const j = name === "jav", e2 = t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / (j ? 0.9 : 0.5)); lp += (0.06 + 0.1 * Math.min(1, t)) * (nz() - lp); s = (t < 0.005 ? nz() * (j ? 0.4 : 1) : 0) + (j ? 0.3 : 1.3) * lp * Math.exp(-t / 0.05) + lp * 1.6 * e2 * (j && t < 0.35 ? 0.2 : 1); }
      else if (name === "clang") { s = (0.5 * Math.sin(2 * Math.PI * 1130 * t) + 0.35 * Math.sin(2 * Math.PI * 2390 * t) + 0.2 * Math.sin(2 * Math.PI * 3710 * t)) * Math.exp(-t / 0.18) + (t < 0.003 ? nz() : 0); }
      else if (name === "crack") { s = (t < 0.0015 ? nz() : 0) + nz() * 0.3 * Math.exp(-t / 0.01); }
      d[i] = Math.max(-1, Math.min(1, s * 0.55));
    }
    return b;
  }
  function play(name, dist = 10, gain = 1, pan = 0) {
    try {
      A.emit("sound", { name: "veh_" + name, gun: st.key, t: CLOCK.t });
      const au = A.audio; if (!au || au.volume <= 0 || (au.muteSlow && S.speed > 10)) return;
      const ctx = au._ctx(); if (!ctx || !au.bus) return;
      const buf = SND[name] || (SND[name] = synth(ctx, name));
      const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = (au.rate || 1) * (1 + rnd(0.04));
      const g = ctx.createGain(); g.gain.value = gain * Math.min(1, 25 / Math.max(25, dist));
      const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = Math.max(300, 16000 * Math.exp(-dist / 900));
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      src.connect(f); f.connect(g); if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(au.bus); } else g.connect(au.bus);
      src.start();
    } catch (e) { /* sound is never allowed to stop a shot */ }
  }

  // ---------------------------------------------------------------- models (lazy; a simple stand-in shape until a model arrives)
  function loadModel(key) {
    if (st.models[key] || st.modelLoading[key] || !MODELS[key]) return;
    st.modelLoading[key] = A.fetchGLB(MODELS[key], "ammunition").then((gltf) => {
      let src = key === "grad" ? gltf.scene.getObjectByName("folded_spin") : gltf.scene.getObjectByName("projectile");
      if (key === "javm") { src = new THREE.Group(); for (const c of [...gltf.scene.children[0] ? gltf.scene.children[0].children : []]) if (!/display_stand/.test(c.name)) src.add(c); src.position.set(0, -0.2, 0); const w = new THREE.Group(); w.add(src); src = w; }
      if (!src) src = gltf.scene;
      src.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
      st.models[key] = src;
    }).catch((e) => { console.warn("vehfire model", key, e); });
  }
  function standIn(a) {
    const g = new THREE.Group(), r = a.cal / 2000, L = a === AMMO.grad ? a.len : a.model === "bomb82" ? 0.33 : a.cal / 1000 * 5.5;
    const m = new THREE.MeshStandardMaterial({ color: a === AMMO.grad ? 0x56604a : 0x6a6a5a, metalness: 0.6, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L * 0.8, 12), m); body.rotation.x = Math.PI / 2; body.position.z = -L * 0.4; g.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(r, L * 0.2, 12), m); nose.rotation.x = -Math.PI / 2; nose.position.z = -L * 0.9; g.add(nose);
    return g;
  }
  // a pooled projectile body: the model's projectile subtree (forward = local -Z, base at z = 0); for the rocket the folded 9M22 with its fin hinges
  const bodies = [];
  function getBody(a) {
    const key = a.model; if (!key) return null;
    for (const b of bodies) if (!b.busy && b.key === key && b.real === !!st.models[key]) { b.busy = true; return b; }
    const src = st.models[key], obj = new THREE.Group(); let inner;
    if (src) { inner = src.clone(true); inner.position.set(0, 0, 0); inner.quaternion.identity(); } else inner = standIn(a);
    obj.add(inner); root.add(obj);
    const b = { key, real: !!src, obj, inner, busy: true, fins: [], sabot: null, petals: [] };
    inner.traverse((o) => { if (/fin_\d_hinge$/.test(o.name)) b.fins.push({ n: o, q0: o.quaternion.clone(), ang: 0, stagger: 0 }); if (o.name === "sabot") b.sabot = o; if (/^sabot_petal_\d$/.test(o.name)) b.petals.push(o); });
    bodies.push(b); return b;
  }
  const finAxis = new THREE.Vector3(0, 0, -1), finQ = new THREE.Quaternion();
  function setFin(f, deg) { f.ang = deg; finQ.setFromAxisAngle(finAxis, deg * D2R); f.n.quaternion.copy(finQ).multiply(f.q0); }
  // sabot petals flying off after discard (clones of the APFSDS model's own petals)
  const debris = [];
  function spawnPetals(b, p, v) {
    if (!b.petals.length) return;
    b.obj.updateMatrixWorld(true);
    for (const pe of b.petals) {
      let d = debris.find((x) => !x.busy && x.name === pe.name); if (!d) { const o = pe.clone(true); o.matrixAutoUpdate = true; root.add(o); d = { name: pe.name, o, busy: false, v: new THREE.Vector3(), w: new THREE.Vector3() }; debris.push(d); }
      d.busy = true; d.o.visible = true; pe.getWorldPosition(d.o.position); pe.getWorldQuaternion(d.o.quaternion);
      const c = new THREE.Box3().setFromObject(pe).getCenter(new THREE.Vector3()).sub(p).normalize();
      d.v.copy(v).multiplyScalar(0.92).addScaledVector(c, 55 + Math.random() * 25); d.w.set(rnd(30), rnd(30), rnd(30)); d.t = 0;
    }
  }

  // ---------------------------------------------------------------- projectiles (pooled)
  const proj = []; for (let i = 0; i < MAXP; i++) proj.push({ on: false, p: V3(), v: V3(), p0: V3(), dir: V3(), aim: V3(), launch: V3(), age: 0, a: null, w: null, body: null, tracer: false, mass: 0, inTube: false, s: 0, finAt: 0, spin: 0, followed: false, serial: 0, trailAcc: 0, discard: false });
  let serial = 0;
  const tmp = V3(), tmp2 = V3(), seg = V3(), ray = new THREE.Ray(), hitP = V3(), nrm = V3();

  // ---------------------------------------------------------------- the vehicle rig: pivots, muzzles, tubes
  function nodeBoxLocal(node, frame) { const b = new THREE.Box3(); node.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(frame.matrixWorld).invert(); node.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); b.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld))); } }); return b; }
  function pivot(parent, nodes, p) { const pv = new THREE.Object3D(); pv.position.copy(p); parent.add(pv); for (const n of nodes) { n.position.sub(p); pv.add(n); } return pv; }
  function marker(parent, x, y, z) { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; }
  function rigForFallback(key, rig) {
    const sc = rig.gltf.scene, W = { muz: {}, recoil: {}, dirNode: {} };
    sc.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(sc), sz = b.getSize(V3()), c = b.getCenter(V3());
    const inv = new THREE.Matrix4().copy(sc.matrixWorld).invert();
    const tip = new THREE.Vector3(b.max.x, b.min.y + sz.y * 0.72, c.z).applyMatrix4(inv);
    for (const w of (WEAP[key] || [])) {
      W.muz[w.id] = marker(sc, tip.x, tip.y, tip.z);
      W.dirNode[w.id] = sc;
    }
    return (rig.vf = W);
  }
  function rigFor(key, rig) {
    if (rig.vf) return rig.vf;
    if (SUPPORT[key]) return (rig.vf = rigSupport(key, rig));
    const sc = rig.gltf.scene, by = (n) => sc.getObjectByName(n), W = { muz: {}, recoil: {}, dirNode: {} };
    try {
    if (key === "t64bv" && by("turret_body") && by("mantlet_cast") && by("main_gun_muzzle")) {   // the v4 hero is flat (every part a root node): build turret and gun pivots from the parts' own geometry
      const tb = nodeBoxLocal(by("turret_body"), sc), tc = tb.getCenter(V3()), turretRe = /^(turret_|era_turret_|stowage_turret|stowage_latches$|snorkel|smoke_|marking_cross_[lr]$|antenna_base|antenna_whip|mantlet|gun_|main_gun_|coax_mg|searchlight_|cupola_|hatch_commander|hatch_gunner|gunner_|nsvt_|kobra_|turret_vent|elec_cable_searchlight)/;
      const gunRe = /^(mantlet|gun_|main_gun_|coax_mg|searchlight_)/, recRe = /^(gun_thermal_sleeve|gun_fume_extractor|gun_sleeve_bands|main_gun_)/;
      const kids = [...sc.children];
      const inTurret = (n) => { if (turretRe.test(n.name)) return true; if (!n.isMesh) return false; const b = nodeBoxLocal(n, sc), c = b.getCenter(V3()); return b.min.y > tb.min.y - 0.02 && Math.hypot(c.x - tc.x, c.z - tc.z) < 1.25 && /^(kit_bag|tarp)/.test(n.name); };
      const tNodes = kids.filter(inTurret), gNodes = tNodes.filter((n) => gunRe.test(n.name));
      const mb = nodeBoxLocal(by("mantlet_cast"), sc), bore = nodeBoxLocal(by("main_gun_muzzle"), sc);
      const yawP = pivot(sc, tNodes.filter((n) => !gunRe.test(n.name)), new THREE.Vector3(tc.x, 0, tc.z));
      const trun = new THREE.Vector3(0, (bore.min.y + bore.max.y) / 2, mb.max.z).sub(yawP.position);
      const off = yawP.position.clone().add(trun), elP = pivot(yawP, [], trun);
      for (const n of gNodes) { n.position.sub(off); elP.add(n); }
      const recP = pivot(elP, gNodes.filter((n) => recRe.test(n.name)), new THREE.Vector3());
      rig.pv = { yaw: yawP, elev: elP };
      W.muz["2a46"] = marker(recP, 0 - off.x, (bore.min.y + bore.max.y) / 2 - off.y, bore.min.z - off.z);
      const cx = nodeBoxLocal(by("coax_mg"), sc); W.muz.pkt = marker(elP, (cx.min.x + cx.max.x) / 2 - off.x, (cx.min.y + cx.max.y) / 2 - off.y, cx.min.z - off.z);
      const ns = nodeBoxLocal(by("nsvt_gun"), sc); W.muz.nsvt = marker(yawP, (ns.min.x + ns.max.x) / 2 - yawP.position.x, (ns.min.y + ns.max.y) / 2, ns.min.z - yawP.position.z);
      W.dirNode = { "2a46": elP, pkt: elP, nsvt: yawP }; W.recoil = { "2a46": recP };
    } else if (key === "bmp3" && by("gun") && by("main_gun_barrel")) {
      const gun = by("gun"), ch = (re) => gun.children.filter((n) => re.test(n.name));
      const recP = pivot(gun, ch(/^main_gun_/), new THREE.Vector3()), recA = pivot(gun, ch(/^coax_2a72/), new THREE.Vector3());
      const mb = nodeBoxLocal(by("main_gun_barrel"), gun), ac = nodeBoxLocal(by("coax_2a72_muzzle_brake"), gun), pk = nodeBoxLocal(by("coax_pkt_barrel"), gun);
      W.muz["2a70"] = marker(recP, 0, (mb.min.y + mb.max.y) / 2, mb.min.z); W.muz["2a72"] = marker(recA, (ac.min.x + ac.max.x) / 2, (ac.min.y + ac.max.y) / 2, ac.min.z); W.muz.pktb = marker(gun, (pk.min.x + pk.max.x) / 2, (pk.min.y + pk.max.y) / 2, pk.min.z);
      W.dirNode = { "2a70": gun, "2a72": gun, pktb: gun }; W.recoil = { "2a70": recP, "2a72": recA };
    } else if (key === "bm21" && by("launcher_elevation")) {
      const el = by("launcher_elevation"), bores = by("launch_tube_bores"), caps = by("tube_rubber_muzzle_caps");
      W.dirNode = { grad: el }; W.caps = caps;
      // the 40 tubes: connected components of the bore mesh (each bore is its own piece), centres in the elevation frame
      const centers = []; bores.traverse((o) => { if (!o.isMesh) return; const g = o.geometry, pa = g.attributes.position, ix = g.index, n = pa.count, par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
        const f = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
        if (ix) for (let t = 0; t < ix.count; t += 3) { const a = f(ix.getX(t)), b = f(ix.getX(t + 1)), c = f(ix.getX(t + 2)); par[b] = a; par[f(c)] = a; }
        const acc = new Map(); for (let i = 0; i < n; i++) { const r = f(i); const e = acc.get(r) || acc.set(r, [0, 0, 0, 0]).get(r); e[0] += pa.getX(i); e[1] += pa.getY(i); e[2] += pa.getZ(i); e[3]++; }
        const M = new THREE.Matrix4().copy(el.matrixWorld).invert().multiply(o.matrixWorld);
        for (const e of acc.values()) if (e[3] > 8) centers.push(new THREE.Vector3(e[0] / e[3], e[1] / e[3], e[2] / e[3]).applyMatrix4(M)); });
      // merge components that belong to one bore (rings inside one tube): within 4 cm in x-y
      const tubes = []; for (const c of centers) { const t = tubes.find((q) => Math.hypot(q.x - c.x, q.y - c.y) < 0.04); if (t) { t.x = (t.x * t.n + c.x) / (t.n + 1); t.y = (t.y * t.n + c.y) / (t.n + 1); t.n++; } else tubes.push({ x: c.x, y: c.y, n: 1 }); }
      let list = tubes;
      if (list.length !== 40) { list = []; const b = nodeBoxLocal(bores, el); for (let r = 0; r < 4; r++) for (let k = 0; k < 10; k++) list.push({ x: b.min.x + 0.061 + k * (b.max.x - b.min.x - 0.122) / 9, y: b.max.y - 0.061 - r * (b.max.y - b.min.y - 0.122) / 3 }); }
      list.sort((a, b) => (b.y - a.y) || (a.x - b.x));   // top row first, left to right
      const tb = nodeBoxLocal(by("launch_tubes"), el), zf = tb.min.z, zr = tb.max.z;
      const noseMat = new THREE.MeshStandardMaterial({ color: 0x6d7466, metalness: 0.5, roughness: 0.5 }), noseGeo = new THREE.ConeGeometry(0.04, 0.23, 12); noseGeo.rotateX(-Math.PI / 2);
      W.tubes = list.map((t, i) => { const nose = new THREE.Mesh(noseGeo, noseMat); nose.position.set(t.x, t.y, zf + 0.16); nose.name = "grad_loaded_" + i; el.add(nose); return { i, x: t.x, y: t.y, front: marker(el, t.x, t.y, zf), rear: zr, nose, loaded: true }; });
      W.muz.grad = W.tubes[0].front; W.tubeLen = zr - zf; W.tubesFound = tubes.length;
    }
    if (!Object.keys(W.muz).length) return rigForFallback(key, rig);
    rig.vf = W; return W;
    } catch (e) { console.warn("rigFor fallback:", key, e); return rigForFallback(key, rig); }
  }
  const muzzleW = V3(), dirW = V3();
  function bore(wid, tube) {   // muzzle point and bore direction, in the world, as the vehicle is posed right now
    const W = st.W; st.rig.outer.updateMatrixWorld(true);
    const m = tube ? tube.front : W.muz[wid]; m.getWorldPosition(muzzleW);
    dirW.set(0, 0, -1).transformDirection(W.dirNode[wid].matrixWorld);
    return muzzleW;
  }

  // ---------------------------------------------------------------- laying: solve the elevation for the chosen ammunition, traverse onto the target
  function flyTo(a, m, dir, D, T) {   // integrate a launch along `dir` from m; return the height at horizontal distance D (or -1e4 if it never gets there)
    const p = tmp.copy(m), v = tmp2.copy(dir).multiplyScalar(a.v0 || 1); let mass = a.mass, s = 0, t = 0; flyTo.tof = 0; const h = a.thrust ? 0.01 : Math.min(0.01, D / Math.max(200, a.v0) / 150);
    const dx = T.x - m.x, dz = T.z - m.z, hl = Math.hypot(dx, dz) || 1;
    for (let i = 0; i < 40000; i++) {
      const sp = v.length() || 1e-6;
      if (a.thrust && t < a.burn) { mass = a.mass - a.burnMass * t / a.burn; v.addScaledVector(v, (a.thrust / mass) * h / sp); }
      if (a.thrust && s < a.tube) { s += sp * h; p.addScaledVector(v, h); t += h; continue; }
      const k = a.cdA ? a.cdA / mass : a.k;
      if (a.sustain && t > a.sustain[0] && sp < a.vMax) v.addScaledVector(v, a.sustain[1] * h / sp);
      v.addScaledVector(v, -k * sp * h); v.y -= G * h; p.addScaledVector(v, h); t += h;
      const along = ((p.x - m.x) * dx + (p.z - m.z) * dz) / hl;
      if (along >= D && (!a.highAngle || v.y < 0)) { flyTo.tof = t; return p.y; }
      if (a.highAngle && v.y < 0 && p.y < T.y - 1) { flyTo.tof = t; return T.y - 1 - (D - along); }   // fell short of the target: negative, by how far short
      if (p.y < T.y - 1 && v.y < 0) return T.y - 1 - (D - along);   // fell short: a signed error (how far short), so the solver always has a slope
      if (t > 120) return -1e4;
    }
    return -1e4;
  }
  function solvePitch(a, m, T) {
    const D = Math.hypot(T.x - m.x, T.z - m.z), bear = Math.atan2(T.z - m.z, T.x - m.x), los = Math.atan2(T.y - m.y, D);
    if (a.highAngle) {   // a mortar: the high-angle solution, found from where the bomb comes back down to the target's height (monotonic above 45 deg)
      const L = (al) => { const c = Math.cos(al), p = tmp.copy(m), v = tmp2.set(c * Math.cos(bear), Math.sin(al), c * Math.sin(bear)).multiplyScalar(a.v0); let t = 0; const h = 0.01;
        for (let i = 0; i < 20000; i++) { const sp = v.length(); v.addScaledVector(v, -a.k * sp * h); v.y -= G * h; p.addScaledVector(v, h); t += h; if (v.y < 0 && p.y <= T.y) { flyTo.tof = t; return Math.hypot(p.x - m.x, p.z - m.z); } } return 0; };
      let x0 = 1.15, x1 = 1.1, f0 = L(x0) - D, f1 = L(x1) - D;
      for (let i = 0; i < 30 && Math.abs(f1) > 0.5; i++) { const d = f1 - f0; if (Math.abs(d) < 1e-9) break; let x2 = x1 - f1 * (x1 - x0) / d; x2 = Math.max(0.8, Math.min(1.5, x2)); x0 = x1; f0 = f1; x1 = x2; f1 = L(x1) - D; }
      L(x1); solvePitch.tof = flyTo.tof; return x1;
    }
    if (a.guided === "top") return los + 0.31;   // the Javelin leaves the tube lofted (about 18 deg); the seeker does the rest
    if (a.guided) return los;
    const f = (al) => { const d = new THREE.Vector3(Math.cos(al) * Math.cos(bear), Math.sin(al), Math.cos(al) * Math.sin(bear)); return flyTo(a, m, d, D, T) - T.y; };
    let x0 = a.highAngle ? 1.15 : los, x1 = a.highAngle ? 1.1 : los + 0.004, f0 = f(x0), f1 = f(x1);   // a mortar takes the high-angle solution
    const lo = a.highAngle ? 0.8 : -0.2, hi = a.highAngle ? 1.49 : 1.2;
    for (let i = 0; i < 24 && Math.abs(f1) > 0.02; i++) { const d = f1 - f0; if (Math.abs(d) < 1e-9) break; let x2 = x1 - f1 * (x1 - x0) / d; x2 = Math.max(lo, Math.min(hi, x2)); x0 = x1; f0 = f1; x1 = x2; f1 = f(x1); }
    f(x1); solvePitch.tof = flyTo.tof;
    return x1;
  }
  const sl = (id) => $(id);
  function sliders(y, e) { const Y = sl("yaw"), E = sl("elev"); Y.value = String(y); E.value = String(e); A.staticPose(); }
  function measureSigns() {
    const Y = +sl("yaw").value, E = +sl("elev").value, w = curW().id;
    sliders(0, 2); bore(w); const b0 = Math.atan2(dirW.z, dirW.x), p0 = Math.asin(dirW.y);
    sliders(5, 6); bore(w); const b1 = Math.atan2(dirW.z, dirW.x), p1 = Math.asin(dirW.y);
    st.signY = Math.abs(b1 - b0) > 0.02 ? (b1 - b0) / (5 * D2R) : 1; st.signE = Math.abs(p1 - p0) > 0.01 ? (p1 - p0) / (4 * D2R) : 1;
    sliders(Y, E);
  }
  function solveLay() {
    const w = curW(), a = AMMO[curAmmo()], T = tgtById(st.target); if (!T || !st.rig) return null;
    const Y0 = +sl("yaw").value, E0 = +sl("elev").value; let y = Y0, e = E0;
    const lim = (el) => Math.max(+sl("elev").min, Math.min(+sl("elev").max, el)), limY = (v) => Math.max(+sl("yaw").min, Math.min(+sl("yaw").max, v));
    const tube = w.kind === "rocket" ? nextTube() : null;
    let req = 0, clamped = false;
    for (let it = 0; it < 4; it++) {
      sliders(y, e); bore(w.id, tube);
      const bB = Math.atan2(dirW.z, dirW.x), bT = Math.atan2(T.aim.z - muzzleW.z, T.aim.x - muzzleW.x);
      y = limY(y + (bT - bB) / D2R / st.signY);
      req = solvePitch(a, muzzleW.clone(), T.aim);
      if (w.id === "nsvt") continue;   // the cupola gun lays itself in elevation (fireOnce); the main gun stays where it is
      const ne = e + (req - Math.asin(dirW.y)) / D2R / st.signE; e = lim(ne); clamped = Math.abs(ne - e) > 0.01;
    }
    sliders(Y0, E0);
    st.tof = solvePitch.tof || 0;
    return { yaw: y, el: e, clamped, pitch: req };
  }
  function startLay() { if (!st.autoLay) { st.lay = null; st.laid = true; return; } st.lay = solveLay(); st.laid = !st.lay; if (st.lay && st.lay.clamped) A.msg("The launcher cannot lay that low: the rockets will fly over the target (elevation clamped)."); }
  function stepLay(dt) {
    if (!st.lay) return;
    const w = curW(), Y = +sl("yaw").value, E = +sl("elev").value, ry = (w.kind === "rocket" ? 7 : 24) * dt, re = 4 * dt;
    const ny = Y + Math.max(-ry, Math.min(ry, st.lay.yaw - Y)), ne = E + Math.max(-re, Math.min(re, st.lay.el - E));
    sliders(+ny.toFixed(3), +ne.toFixed(3)); $("yawv").textContent = (+ny).toFixed(1); $("elv").textContent = (+ne).toFixed(2);
    if (Math.abs(ny - st.lay.yaw) < 0.01 && Math.abs(ne - st.lay.el) < 0.005) { st.lay = null; st.laid = true; if (st.queued) { st.queued = false; fireOnce(); } }
  }

  // ---------------------------------------------------------------- firing
  const curW = () => { const L = WEAP[st.key]; return L.find((w) => w.id === st.sel[st.key]) || L[0]; };
  const curAmmo = () => { const w = curW(); return st.ammoSel[w.id] && w.ammo.includes(st.ammoSel[w.id]) ? st.ammoSel[w.id] : w.ammo[0]; };
  const tgtById = (id) => tgts.find((t) => t.id === id && (!t.only || t.only === st.key)) || tgts[1];
  function stock(w) { const s = st.weapons[w.id]; return w.load ? s.left[curAmmo()] : s.left.all; }
  function ready(w) { const s = st.weapons[w.id]; return CLOCK.t >= s.readyAt && CLOCK.t >= s.reloadUntil; }
  function nextTube() { return st.W.tubes.find((t) => t.loaded) || null; }
  function fireOnce() {
    const w = curW(), s = st.weapons[w.id], aid = curAmmo(), a = AMMO[aid];
    if (CLOCK.t < s.reloadUntil) { A.msg(`${w.name}: reloading...`); return false; }
    if (stock(w) <= 0) { A.msg(`${w.name}: ${w.load ? a.short + " is used up in the autoloader" : "empty"}. RELOAD.`, true); if ($("autoreload").checked) reload(); return false; }
    if (w.kind === "cannon" && CLOCK.t < s.readyAt) { A.msg(`${WEAP.t64bv.concat(WEAP.bmp3).includes(w) ? "Autoloader cycling" : "Next round ready in"}: ${((s.readyAt - CLOCK.t) / S.speed).toFixed(1)} s`); return false; }
    if ((w.kind === "cannon" || w.kind === "rocket") && !st.laid) { st.queued = true; A.msg("Laying the gun on the target..."); return false; }
    const tube = w.kind === "rocket" ? nextTube() : null;
    const m = bore(w.id, tube).clone(), d = dirW.clone();
    if (st.autoLay && (w.id === "nsvt")) { const T = tgtById(st.target).aim, al = solvePitch(a, m, T), b = Math.atan2(T.z - m.z, T.x - m.x); d.set(Math.cos(al) * Math.cos(b), Math.sin(al), Math.cos(al) * Math.sin(b)); }   // the cupola gun lays itself
    if (a.disp) { const u = new THREE.Vector3(0, 1, 0).cross(d).normalize(), vv = d.clone().cross(u); const g1 = gauss() * a.disp, g2 = gauss() * a.disp; d.addScaledVector(u, g1).addScaledVector(vv, g2).normalize(); }
    const P = proj.find((q) => !q.on); if (!P) return false;
    serial++; s.fired++;
    if (w.load) s.left[aid]--; else s.left.all--;
    if (w.kind === "cannon") s.readyAt = CLOCK.t + w.cycle * S.speed;
    P.on = true; P.a = a; P.aid = aid; P.w = w; P.age = 0; P.serial = serial; P.p.copy(m); P.p0.copy(m); P.launch.copy(m); P.dir.copy(d); P.mass = a.mass; P.trailAcc = 0; P.discard = false; P.spin = 0;
    P.v.copy(d).multiplyScalar(a.v0 || 0.01); P.inTube = !!a.thrust; P.s = 0; P.finAt = -1; P.tube = tube; P.target = tgtById(st.target);
    P.tracer = !!a.tracer && (!a.tracerEvery || (s.fired % a.tracerEvery === 0));
    P.aim.copy(P.target.aim); P.dive = false; P.apex = Math.min(150, 0.25 * P.target.d + 40);
    if (st.W.loaded) st.W.loaded.visible = false; if (st.W.caps2) for (const c of st.W.caps2) c.visible = false;
    if (tube) { tube.loaded = false; tube.nose.visible = false; if (st.W.caps) st.W.caps.visible = false; P.p.addScaledVector(d, -(a.len / 2 + 0.04)); P.p0.copy(P.p); P.s = 0; }
    P.body = getBody(a); if (P.body) { P.body.obj.visible = true; for (const f of P.body.fins) { f.stagger = Math.random() * 0.004; if (a === AMMO.grad) setFin(f, 0); } if (P.body.sabot) P.body.sabot.visible = true; orient(P); }
    P.followed = !!w.follow && st.cam !== "launcher";
    if (P.followed) startFollow(P);
    muzzleFx(w, a, m, d);
    A.emit("shot", { origin: m.toArray(), dir: d.toArray(), velocity: a.v0 || AMMO.grad.thrust / a.mass * 0.137, bulletMass: a.mass, caliber: a.cal, t: CLOCK.t, gun: st.key + ":" + w.id, ammo: aid, serial });
    st.shots++; st.events.push({ e: "shot", w: w.id, a: aid, t: CLOCK.t }); if (st.events.length > 300) st.events.shift();
    if (st.autoLay && st.target && (w.kind === "cannon" || w.kind === "rocket")) { /* stay laid */ }
    updInfo(true); A.markDirty();
    if (w.kind === "cannon" && stock(w) > 0) A.later(w.cycle * S.speed, () => { if (st.key && curW() === w) { play("crack", 3, 0.25); if (st.W.loaded) st.W.loaded.visible = true; updInfo(true); } });   // the rammer: next round ready
    return true;
  }
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const qO = new THREE.Quaternion(), NZ = new THREE.Vector3(0, 0, -1);
  function orient(P) { const b = P.body; if (!b) return; b.obj.position.copy(P.p); tmp.copy(P.v); if (tmp.lengthSq() < 1e-6) tmp.copy(P.dir); b.obj.quaternion.setFromUnitVectors(NZ, tmp.normalize()); if (P.spin) { qO.setFromAxisAngle(NZ, P.spin); b.obj.quaternion.multiply(qO); } }
  function muzzleFx(w, a, m, d) {
    const big = a.cal >= 100, f = flashes[big ? 0 : 1], sc = a === AMMO.grad ? 0.9 : a.cal >= 120 ? 1.3 : a.cal >= 100 ? 1 : a.cal >= 30 ? 0.35 : a.cal >= 12 ? 0.16 : 0.1;
    if (a !== AMMO.grad) { f.position.copy(m); f.quaternion.setFromUnitVectors(NZ, d); f.scale.setScalar(sc * (0.8 + Math.random() * 0.4)); f.visible = true; f.userData.off = CLOCK.t + (big ? 0.07 : 0.03) * S.speed; }
    const n = a === AMMO.grad ? (LOW() ? 2 : 5) : LOW() ? (big ? 6 : 2) : (big ? 16 : 4);   // a ripple fires 40: keep each rocket's launch puff small
    if (a === AMMO.grad) { for (let i = 0; i < n; i++) emitP(smoke, m.x - d.x * 3 + rnd(1.5), m.y + rnd(0.6), m.z - d.z * 3 + rnd(1.5), -d.x * 6 + rnd(2), 2.5 + Math.random() * 2, -d.z * 6 + rnd(2), 0.9, 1.6, 1.4 + Math.random() * 0.6, 0.85, 0.83, 0.8, 0.22, 1.6, 2.2); }
    else for (let i = 0; i < n; i++) {   // blast smoke ring and the dust it kicks off the ground
      const sp = big ? 18 : 4; emitP(smoke, m.x + d.x * 0.5, m.y + d.y * 0.5, m.z + d.z * 0.5, d.x * sp * Math.random() * 2 + rnd(sp), d.y * sp + rnd(sp * 0.6), d.z * sp * Math.random() * 2 + rnd(sp), big ? 1.0 : 0.25, big ? 2.6 : 0.8, big ? 2.4 : 1.2, 0.72, 0.7, 0.66, big ? 0.3 : 0.3, 1.6, 1.2);
      if (big && i % 3 === 0) emitP(smoke, m.x + rnd(3), groundY + 0.3, m.z + rnd(3), rnd(6), 1.5, rnd(6), 1.5, 3, 4, 0.62, 0.56, 0.45, 0.45, 1.2, 0.3);
    }
    if (big && a !== AMMO.grad) for (let i = 0; i < (LOW() ? 6 : 18); i++) emitP(fire, m.x, m.y, m.z, d.x * 60 * Math.random() + rnd(10), d.y * 60 * Math.random() + rnd(10), d.z * 60 * Math.random() + rnd(10), 0.9, 2, 0.12, 1, 0.55, 0.2, 0.9, 6);
    const s = st.weapons[w.id];
    if (w.recoil && st.W.recoil[w.id]) s.recoilT = 0.0001;
    if (w.rock) st.rockV += w.rock * 8;
    play(w.snd, 12, w.kind === "mg" ? 0.5 : 1, 0);
  }
  function startFollow(P) {
    const cam = A.camera, c = A.getControls();
    if (!st.savedCam) st.savedCam = { p: cam.position.clone(), t: c ? c.target.clone() : V3(), far: cam.far, auto: c ? c.autoRotate : false };
    if (c) { c.autoRotate = false; c.enabled = false; }
    cam.far = 32000; cam.updateProjectionMatrix();
    st.follow = P; st.camHold = null;
    if (st.cam === "target") { const T = P.target.aim, k = P.a === AMMO.grad ? 2.6 : 1; cam.position.set(T.x - 45 * k, T.y + 9 * k + 4, T.z + 30 * k); if (c) c.target.copy(T); cam.lookAt(T); }
    if (st.cam === "salvo" && !st.salvoCam) { st.salvoCam = { p: cam.position.clone(), t: c ? c.target.clone() : P.p.clone() }; }
  }
  // the default BM-21 view: the tube pack and the first ~30 m of flight in frame, from the side and a little behind
  function frameLauncher() {
    if (!st.W || !st.W.tubes) return; const cam = A.camera, c = A.getControls(), t = st.W.tubes[19]; bore("grad", t);
    const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3().crossVectors(dirW, up).normalize(), F = muzzleW.clone();
    cam.position.copy(F).addScaledVector(dirW, -10).addScaledVector(side, -13).addScaledVector(up, 3.6); if (cam.position.y < groundY + 1) cam.position.y = groundY + 1;
    const T = F.clone().addScaledVector(dirW, 9); if (c) { c.autoRotate = false; c.target.copy(T); c.update(); } cam.lookAt(T); cam.far = Math.max(cam.far, 3000); cam.updateProjectionMatrix(); A.markDirty();
  }
  function endFollow(atP) {
    st.follow = null; st.camHold = { until: CLOCK.t + 2.2 * S.speed, p: atP ? atP.clone() : null };
  }
  function restoreCam() {
    const cam = A.camera, c = A.getControls(), s = st.savedCam; if (!s) return;
    cam.position.copy(s.p); cam.far = Math.max(1200, s.far); cam.updateProjectionMatrix(); if (c) { c.target.copy(s.t); c.enabled = true; c.update(); }
    st.savedCam = null; st.camHold = null; A.markDirty();
  }
  function stepCam() {
    const cam = A.camera, c = A.getControls();
    if (st.follow && st.follow.on && st.cam === "follow") {
      const P = st.follow; tmp.copy(P.v); if (tmp.lengthSq() < 1) tmp.copy(P.dir); tmp.normalize();
      const back = P.a === AMMO.grad || P.a.guided ? 9 : 7; cam.position.copy(P.p).addScaledVector(tmp, -back); cam.position.y += 1.6;
      if (cam.position.y < groundY + 0.5) cam.position.y = groundY + 0.5;
      tmp2.copy(P.p).addScaledVector(tmp, 25); cam.lookAt(tmp2); if (c) c.target.copy(tmp2);
    } else if (st.cam === "salvo" && st.salvoCam && proj.some((q) => q.on && q.a === AMMO.grad)) {   // behind and above the launcher, tracking the middle of the rockets in flight
      let n = 0; tmp.set(0, 0, 0); for (const q of proj) if (q.on && q.a === AMMO.grad) { tmp.add(q.p); n++; } tmp.multiplyScalar(1 / n);
      tmp2.copy(tmp).sub(st.W ? muzzleW : tmp).setY(0); const dl = tmp2.length() || 1; tmp2.multiplyScalar(1 / dl);
      const want = seg.copy(tmp).addScaledVector(tmp2, -Math.min(260, 40 + dl * 0.5)); want.y = Math.max(groundY + 6, tmp.y * 0.6 + 14);
      cam.position.lerp(want, Math.min(1, 3 * (1 / 60))); st.salvoCam.t.lerp(tmp, 0.12); cam.lookAt(st.salvoCam.t); if (c) c.target.copy(st.salvoCam.t);
    } else if (st.camHold && CLOCK.t > st.camHold.until) { restoreCam(); st.salvoCam = null; }
    else if (st.camHold && st.camHold.p && st.cam === "follow") { cam.lookAt(st.camHold.p); }
  }

  // ---------------------------------------------------------------- flight, hits and effects
  function hitTest(P, a, b, out) {   // first target box crossed by the segment a->b; returns {t, kind, plate, tgt}
    seg.subVectors(b, a); const L = seg.length(); if (L < 1e-9) return null; ray.set(a, seg.multiplyScalar(1 / L)); let best = null;
    for (const T of tgts) {
      if (!T.group.visible) continue;
      if (Math.abs(T.d - a.x) > L + 20 && Math.abs(T.d - b.x) > L + 20) continue;
      for (const bx of T.boxes) if (ray.intersectBox(bx, hitP)) { const t = hitP.distanceTo(a); if (t <= L && (!best || t < best.t)) { best = { t, kind: "hulk", tgt: T, box: bx }; out.copy(hitP); } }
      for (const pl of T.plates) if (ray.intersectBox(pl.box, hitP)) { const t = hitP.distanceTo(a); if (t <= L && (!best || t < best.t)) { best = { t, kind: "steel", tgt: T, plate: pl, box: pl.box }; out.copy(hitP); } }
    }
    for (const sb of A.extraBoxes || []) if (sb.box && ray.intersectBox(sb.box, hitP)) { const t = hitP.distanceTo(a); if (t <= L && (!best || t < best.t)) { best = { t, kind: "structure", sb, box: sb.box }; out.copy(hitP); } }
    return best;
  }
  function boxNormal(box, p, out) { const c = box.getCenter(tmp2), s = box.getSize(seg); const dx = (p.x - c.x) / (s.x || 1), dy = (p.y - c.y) / (s.y || 1), dz = (p.z - c.z) / (s.z || 1); const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz); if (ax >= ay && ax >= az) out.set(Math.sign(dx), 0, 0); else if (ay >= az) out.set(0, Math.sign(dy), 0); else out.set(0, 0, Math.sign(dz)); return out; }
  const impactP = V3();
  function impact(P, p, kind, info) {
    const a = P.a; P.on = false; if (P.body) { P.body.obj.visible = false; P.body.busy = false; P.body = null; }
    if (st.follow === P) endFollow(p);
    const n = kind === "ground" || kind === "air" ? nrm.set(0, 1, 0) : boxNormal(info.box, p, nrm);
    const fx = a.fx, big = fx === "he" || fx === "rocket_he" || fx === "heat";
    // effects
    if (big) explosion(p, n, a, kind);
    else if (fx === "kinetic" || fx === "kinetic_small") { sparks(p, n, kind === "ground" ? 0 : (fx === "kinetic" ? 40 : 10)); dust(p, fx === "kinetic" ? 14 : 4, fx === "kinetic" ? 1.2 : 0.5, kind); }
    else if (fx === "he_small") { explosion(p, n, a, kind); dust(p, 4, 0.5, kind); }
    else { if (kind === "steel") sparks(p, n, 5); dust(p, LOW() ? 1 : 3, 0.25, kind); }
    const r = fx === "rocket_he" ? 2.6 : fx === "he" ? (a.cal >= 120 ? 1.7 : 1.3) : fx === "heat" ? 0.9 : fx === "kinetic" ? 0.25 : fx === "he_small" ? 0.45 : fx === "kinetic_small" ? 0.08 : 0.05;
    if (kind === "air") { /* no crater */ }
    else if (kind === "ground") addDecal(p.set(p.x, groundY + 0.02, p.z), nrm, r, false);
    else if (kind === "steel") { addDecal(p, n, Math.min(0.5, Math.max(0.05, r * 0.6)), true, info.plate.pl); info.plate.w += (fx === "bullet" ? 2 : 12); info.plate.hitAt = CLOCK.t; }
    else { addDecal(p, n, Math.min(1.2, Math.max(0.05, r * 0.5)), false); if (kind === "hulk" && info.tgt) hurtHulk(info.tgt, a); }
    if (kind === "structure" && A.onStructureHit) A.onStructureHit(info.sb, p, a);
    A.emit("impact", { pos: p.toArray(), normal: n.toArray(), kind: kind === "ground" ? "dirt" : kind === "air" ? "airburst" : kind, t: CLOCK.t, gun: st.key + ":" + P.w.id, ammo: P.aid, serial: P.serial, distance: +P.launch.distanceTo(p).toFixed(1), v: +P.v.length().toFixed(1) });
    A.emit("decal", { pos: p.toArray(), normal: n.toArray(), radius: r, kind: kind === "ground" ? "crater" : kind });
    if (A.onImpact) try { A.onImpact(p, a, kind); } catch (e) { console.warn("build impact", e); }
    st.impacts++; st.events.push({ e: "impact", w: P.w.id, a: P.aid, kind, t: CLOCK.t, d: P.launch.distanceTo(p) });
    // the sound comes back after its own trip from the target
    const dist = P.launch.distanceTo(p), name = big ? (fx === "he" && a.cal < 120 ? "expl_small" : "expl") : kind === "steel" ? "clang" : fx === "he_small" ? "expl_small" : "crack";
    A.later(dist / 343 * S.speed, () => play(name, dist, big ? 1.2 : 0.6));
    A.markDirty();
  }
  // layered blast: a white-hot core (2-3 frames), an orange fireball that rises and dies, a dark smoke column, a ground dust ring,
  // glowing fragments that fall, and the scorch decal (impact()); scaled by the warhead: 30 mm small, 100 / 125 mm HE medium, Grad large
  function explosion(p, n, a, kind) {
    const s = a.fx === "rocket_he" ? 1.8 : a.fx === "he_small" ? 0.35 : a.fx === "heat" ? 0.75 : a.cal >= 120 ? 1.15 : 1.0, L = LOW(), y0 = p.y + 0.3 * s;
    emitP(fire, p.x, y0 + 0.4 * s, p.z, 0, 0, 0, 4.5 * s, 14 * s, 0.05, 1, 0.97, 0.9, 1, 0, 0);   // core flash
    for (let i = 0, nF = L ? 6 : 16; i < nF; i++) emitP(fire, p.x + rnd(0.7 * s), y0 + Math.random() * s, p.z + rnd(0.7 * s), rnd(5 * s), 2.5 * s + Math.random() * 4 * s, rnd(5 * s), 1.4 * s, 2.6 * s, 0.35 + Math.random() * 0.35, 1, 0.42 + Math.random() * 0.2, 0.08, 0.85, 2.5, 3);
    for (let i = 0, nS = L ? 5 : 14; i < nS; i++) emitP(smoke, p.x + rnd(0.9 * s), y0 + 0.4 * s + Math.random() * 2 * s, p.z + rnd(0.9 * s), rnd(1.4 * s), 1.5 + Math.random() * 3.5 * s, rnd(1.4 * s), 1.3 * s, 1.9 * s, 4 + Math.random() * 3, 0.11, 0.1, 0.09, 0.5, 1.3, 1.4);
    if (kind === "ground") for (let i = 0, nD = L ? 6 : 18; i < nD; i++) { const ang = i / nD * 6.283 + Math.random() * 0.3; emitP(smoke, p.x, groundY + 0.25, p.z, Math.cos(ang) * 9 * s, 0.5, Math.sin(ang) * 9 * s, 0.8 * s, 2 * s, 2.4, 0.52, 0.47, 0.37, 0.32, 2.4, 0.25); }
    for (let i = 0, nG = L ? 4 : 12; i < nG; i++) emitP(fire, p.x, y0, p.z, rnd(18 * s), 5 + Math.random() * 12 * s, rnd(18 * s), 0.16, 0, 0.8 + Math.random() * 0.6, 1, 0.62, 0.22, 1, 0.12, -9.8);   // fragments
    if (boomLight) { boomLight.position.copy(p).y += 2; boomLight.intensity = 3500 * s; boomLight.userData.t = CLOCK.t; }
  }
  // APFSDS and AP: a spark shower that falls, and a small flash, no fireball
  function sparks(p, n, k) { if (k > 8) emitP(fire, p.x, p.y, p.z, 0, 0, 0, 1.4, 4, 0.04, 1, 0.95, 0.85, 1, 0, 0);
    for (let i = 0; i < (LOW() ? Math.ceil(k / 3) : k); i++) emitP(fire, p.x, p.y, p.z, n.x * 18 + rnd(22), n.y * 18 + rnd(18) + 6, n.z * 18 + rnd(22), 0.11, 0, 0.45 + Math.random() * 0.4, 1, 0.8, 0.4, 1, 0.6, -9.8); }
  function dust(p, k, s, kind) { const c = kind === "steel" || kind === "hulk" ? [0.5, 0.48, 0.44] : [0.55, 0.5, 0.4]; for (let i = 0; i < k; i++) emitP(smoke, p.x + rnd(0.3 * s), Math.max(groundY + 0.1, p.y), p.z + rnd(0.3 * s), rnd(3 * s), Math.random() * 6 * s, rnd(3 * s), 0.6 * s, 1.6 * s, 1.5 + Math.random() * 1.5, c[0], c[1], c[2], 0.6, 1.8, 0.2); }

  const pPrev = V3();
  function stepProj(P, dt) {
    const a = P.a; let t = dt;
    const hMax = a.v0 > 600 ? 0.002 : 0.004;
    while (t > 1e-6 && P.on) {
      const h = Math.min(hMax, t); t -= h; P.age += h; pPrev.copy(P.p);
      const sp = P.v.length() || 1e-6;
      if (a.thrust) {   // the rocket: guide rail, motor, fins
        if (P.age < a.burn) { P.mass = a.mass - a.burnMass * P.age / a.burn; P.v.addScaledVector(P.inTube && sp < 1 ? P.dir : P.v, (a.thrust / P.mass) * h / (P.inTube && sp < 1 ? 1 : sp)); }
        P.spin += Math.min(2, P.age / 0.12 * 2) * 2 * Math.PI * h;   // the guide stud ramps the roll to ~2 rev/s (E)
        if (P.inTube) {
          P.s += P.v.length() * h; P.p.addScaledVector(P.v, h);
          if (P.s >= a.len + 0.04) { P.inTube = false; P.finAt = P.age; P.exitV = P.v.length(); }   // the tail clears the muzzle: fins release
          if (P.age < a.burn && Math.random() < (LOW() ? 0.04 : 0.12)) { tmp.copy(P.p).addScaledVector(P.dir, -1.6); emitP(smoke, tmp.x, tmp.y, tmp.z, -P.dir.x * 14 + rnd(3), rnd(1.5) + 2, -P.dir.z * 14 + rnd(3), 0.6, 1.3, 1.2, 0.84, 0.82, 0.78, 0.16, 2.6, 2); emitP(fire, tmp.x, tmp.y, tmp.z, -P.dir.x * 15, 0, -P.dir.z * 15, 0.6, 1, 0.07, 1, 0.6, 0.25, 1, 4); }
          continue;
        }
        const k = a.cdA / P.mass; P.v.addScaledVector(P.v, -k * sp * h); P.v.y -= G * h;
      } else if (a.guided === "top") {   // Javelin: soft launch, motor, climb to the apex, then dive onto the top of the target (approximate profile)
        if (P.age < 0.35) { P.v.y -= G * h; }
        else {
          const T = P.aim, dx = T.x - P.p.x, dz = T.z - P.p.z, hd = Math.hypot(dx, dz) || 1, alt = P.p.y - T.y;
          if (!P.dive && hd < alt * 1.1 + 15) P.dive = true;
          if (P.dive) tmp.copy(T).sub(P.p).normalize(); else tmp.set(P.p.x + dx / hd * 70, T.y + P.apex, P.p.z + dz / hd * 70).sub(P.p).normalize();
          const vt = a.vCruise; tmp2.copy(P.v).normalize().lerp(tmp, Math.min(1, (P.dive ? 3 : 1.6) * h)).normalize(); P.v.copy(tmp2).multiplyScalar(sp + (vt - sp) * Math.min(1, 1.2 * h));
        }
      } else if (a.guided) {   // beam riding: the missile steers onto the laid line of sight (approximate guidance law)
        const vt = a.vCruise; tmp.copy(P.aim).sub(P.p); const dist = tmp.length(); tmp.normalize();
        if (P.age > 0.25) { tmp2.copy(P.v).normalize().lerp(tmp, Math.min(1, 2.5 * h)).normalize(); P.v.copy(tmp2).multiplyScalar(sp + (vt - sp) * Math.min(1, 1.5 * h)); }
        else P.v.y -= G * h * 0.3;
        if (dist < 1) { /* hit test below decides */ }
      } else { if (a.sustain && P.age > a.sustain[0] && sp < a.vMax) P.v.addScaledVector(P.v, a.sustain[1] * h / sp); P.v.addScaledVector(P.v, -a.k * sp * h); P.v.y -= G * h; }
      if (a.destruct && P.age > a.destruct) { impactP.copy(P.p); impact(P, impactP, "air", null); return; }   // the PG-7VL self-destructs after about 4.5 s
      P.p.addScaledVector(P.v, h);
      // sabot discard about 20 m out
      if (a.sabot && !P.discard && P.p.distanceTo(P.launch) > 20) { P.discard = true; if (P.body) { spawnPetals(P.body, P.p, P.v); if (P.body.sabot) P.body.sabot.visible = false; } }
      const hit = hitTest(P, pPrev, P.p, impactP);
      if (hit) { impact(P, impactP, hit.kind, hit); return; }
      if (P.p.y <= groundY) { const u = (pPrev.y - groundY) / ((pPrev.y - P.p.y) || 1e-9); impactP.copy(pPrev).lerp(P.p, Math.max(0, Math.min(1, u))); impact(P, impactP, "ground", null); return; }
      if (P.age > 120 || Math.abs(P.p.z) > 4000 || P.p.x > 29000 || P.p.x < -2000) { P.on = false; if (P.body) { P.body.obj.visible = false; P.body.busy = false; P.body = null; } if (st.follow === P) endFollow(null); return; }
      // the rocket's smoke trail, the ATGM's flare
      if (((a.thrust && P.age < a.burn + 0.4) || a.flare) && P.p.distanceTo(P.launch) > (a.thrust ? 12 : 0)) { P.trailAcc += sp * h; const step = LOW() ? 9 : a.thrust ? 4 : 3; while (P.trailAcc > step) { P.trailAcc -= step; tmp.copy(P.v).normalize(); emitP(smoke, P.p.x - tmp.x * 1.5, P.p.y - tmp.y * 1.5, P.p.z - tmp.z * 1.5, rnd(1.5), rnd(1.5) + 0.6, rnd(1.5), a.flare ? 0.5 : 0.9, a.flare ? 1 : 1.8, a.flare ? 1.6 : 2.6, 0.86, 0.85, 0.83, a.flare ? 0.35 : 0.24, 0.6, 0.8); if (!LOW() || Math.random() < 0.3) emitP(fire, P.p.x - tmp.x * 1.6, P.p.y - tmp.y * 1.6, P.p.z - tmp.z * 1.6, rnd(2), rnd(2), rnd(2), a.flare ? 0.35 : 0.8, 0.5, 0.08, 1, 0.65, 0.3, 1, 2); } }
    }
    // fins: spring open after the tail clears the tube (spec: 90 deg at 40 ms ease-out, 96 deg at 45 ms, back to 90 deg locked at 60 ms)
    if (P.body && P.body.fins.length && a === AMMO.grad) for (const f of P.body.fins) {
      let deg = 0; if (P.finAt >= 0) { const u = P.age - P.finAt - f.stagger; deg = u <= 0 ? 0 : u < 0.040 ? 90 * (1 - Math.pow(1 - u / 0.040, 3)) : u < 0.045 ? 90 + 6 * (u - 0.040) / 0.005 : u < 0.060 ? 96 - 6 * (u - 0.045) / 0.015 : 90; }
      if (deg !== f.ang) setFin(f, deg);
    }
    if (P.body) orient(P);
    if (a.thrust && P.age < a.burn) emitP(fire, P.p.x - P.v.x / (P.v.length() || 1) * 1.6, P.p.y - P.v.y / (P.v.length() || 1) * 1.6, P.p.z - P.v.z / (P.v.length() || 1) * 1.6, 0, 0, 0, 1.5, 0.6, 0.05, 1, 0.8, 0.4, 1, 0, 0);
  }
  function stepTracers() {
    let k = 0;
    for (const P of proj) {
      if (!P.on || !P.tracer || P.inTube) continue;
      const sp = P.v.length(), L = Math.min(45, sp * 0.03); tmp.copy(P.v).multiplyScalar(-L / (sp || 1)).add(P.p);
      const c = P.a.tracer, o = k * 6; trPos[o] = P.p.x; trPos[o + 1] = P.p.y; trPos[o + 2] = P.p.z; trPos[o + 3] = tmp.x; trPos[o + 4] = tmp.y; trPos[o + 5] = tmp.z;
      trCol[o] = c[0]; trCol[o + 1] = c[1]; trCol[o + 2] = c[2]; trCol[o + 3] = c[0] * 0.2; trCol[o + 4] = c[1] * 0.2; trCol[o + 5] = c[2] * 0.2; k++;
    }
    for (let i = k; i < (stepTracers.last || 0); i++) trPos.fill(0, i * 6, i * 6 + 6);
    stepTracers.last = k; trGeo.attributes.position.needsUpdate = true; trGeo.attributes.color.needsUpdate = true; trGeo.setDrawRange(0, Math.max(2, k * 2));
  }

  // ---------------------------------------------------------------- reload
  function reload() {
    if (!st.key) return false;
    const w = curW(), s = st.weapons[w.id];
    if (CLOCK.t < s.reloadUntil) { A.msg("Already reloading..."); return true; }
    s.reloadUntil = CLOCK.t + w.reload * S.speed; st.ripple = null;
    A.msg(w.kind === "rocket" ? `Reloading 40 rockets by hand (shortened to ${w.reload} s here; a real crew takes about 7 minutes)...` : w.load ? `Replenishing the autoloader carousel (${w.reload} s, shortened)...` : `Reloading the ${w.name.split(" (")[0]} (${w.reload} s)...`);
    A.later(w.reload * S.speed, () => {
      if (w.load) s.left = { ...w.load }; else s.left = { all: w.cap };
      if (st.W && st.W.loaded) st.W.loaded.visible = true; if (st.W && st.W.caps2) for (const c of st.W.caps2) c.visible = true;
      if (w.kind === "rocket" && st.W && st.W.tubes) { for (const t of st.W.tubes) { t.loaded = true; t.nose.visible = true; } if (st.W.caps) st.W.caps.visible = true; }
      st.events.push({ e: "reload", w: w.id, t: CLOCK.t }); A.msg(`${w.name}: reloaded.`); updInfo(true); A.markDirty();
    });
    updInfo(true); return true;
  }

  // ---------------------------------------------------------------- the trigger
  function press() {
    if (!st.key || !st.W) { A.msg("The vehicle's weapons are still loading..."); return; }
    st.holding = true; const w = curW();
    if (st.autoRotOff !== true) { const c = A.getControls(); if (c) c.autoRotate = false; if ($("autorot").checked) { $("autorot").checked = false; $("autorot").dispatchEvent(new Event("change")); } st.autoRotOff = true; }
    if (w.kind === "rocket") {
      if (st.ripple) { st.ripple = null; A.msg("Ripple stopped (cease fire)."); return; }
      const mode = st.modeSel[w.id] || "single";
      if (mode === "ripple") { st.ripple = { next: CLOCK.t }; A.msg("Ripple fire: one rocket every 0.5 s. FIRE again stops it."); return; }
      fireOnce(); return;
    }
    if (w.kind === "cannon" && w.lock) {
      if (st.locking) return; if (stock(w) <= 0 || CLOCK.t < st.weapons[w.id].readyAt) { fireOnce(); return; }
      st.locking = true; A.msg("CLU: seeker cooled, locking on the target (top attack)..."); play("crack", 2, 0.15);
      A.later(w.lock * S.speed, () => { st.locking = false; if (st.key && curW() === w) fireOnce(); }); return;
    }
    if (w.kind === "cannon") { fireOnce(); return; }
    const mode = w.modes ? (st.modeSel[w.id] || w.modes[0][0]) : "hold";
    st.burst = mode === "b4" ? 4 : mode === "b10" ? 10 : Infinity; st.nextAuto = CLOCK.t;
  }
  function release() { st.holding = false; if (st.burst === Infinity) st.burst = 0; }
  function stepTrigger() {
    const w = st.key && curW(); if (!w) return;
    if (w.kind === "rocket" && st.ripple) {
      let guard = 0; while (st.ripple && CLOCK.t >= st.ripple.next && guard++ < 4) {
        if (!nextTube() || CLOCK.t < st.weapons[w.id].reloadUntil) { st.ripple = null; A.msg("Ripple complete: all tubes empty. RELOAD."); if ($("autoreload").checked) reload(); break; }
        if (!st.laid) break;
        fireOnce(); st.ripple.next += 0.5 * S.speed; }
    }
    if ((w.kind === "mg" || w.kind === "auto") && st.burst > 0) {
      const iv = 60 / w.rpm * S.speed; let guard = 0;
      while (st.burst > 0 && CLOCK.t >= st.nextAuto && guard++ < 6) { if (!fireOnce()) { st.burst = 0; break; } st.burst--; st.nextAuto += iv; }
      if (st.burst !== Infinity && st.burst <= 0) st.burst = 0;
    }
  }

  // ---------------------------------------------------------------- the panel (under the vehicle sliders)
  const panel = document.createElement("div"); panel.className = "vehpanel"; panel.id = "vfpanel"; panel.hidden = true; panel.setAttribute("aria-label", "Vehicle weapons");
  panel.innerHTML = `<style>#vfpanel{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}#vfpanel select{width:100%;min-height:44px}#vfpanel .vfinfo{grid-column:1/-1;font-size:13px;color:var(--muted);overflow-wrap:anywhere;margin:0}#vfpanel .vfinfo b{color:var(--ink)}#vfpanel .vfrow{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}#vfpanel .vfrow button{min-height:44px;flex:1 1 120px}#vfpanel .vffire{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:700;letter-spacing:.06em;touch-action:none;user-select:none;-webkit-user-select:none}</style>
    <label class="ctl"><span>Weapon</span><select id="vfWeapon"></select></label>
    <label class="ctl" id="vfAmmoWrap"><span>Ammunition</span><select id="vfAmmo"></select></label>
    <label class="ctl" id="vfModeWrap"><span>Fire mode</span><select id="vfMode"></select></label>
    <label class="ctl"><span>Target</span><select id="vfTarget"></select></label>
    <label class="ctl"><span>Camera</span><select id="vfCam"><option value="follow">Follow the round</option><option value="salvo">Follow the salvo</option><option value="target">Impact area (cut to the target)</option><option value="launcher">At the vehicle</option></select></label>
    <label class="ctl chk"><input type="checkbox" id="vfLay" checked> Auto-lay (fire control)</label>
    <div class="vfrow"><button type="button" class="vffire" id="vfFire">FIRE</button><button type="button" id="vfReload">RELOAD</button></div>
    <p class="vfinfo" id="vfInfo" role="status" aria-live="polite"></p>`;
  const vp = $("vehpanel"); vp.parentNode.insertBefore(panel, vp.nextSibling);
  const opt = (sel, list, val) => { sel.innerHTML = list.map(([v, t]) => `<option value="${v}">${t}</option>`).join(""); if (val != null) sel.value = val; };
  function fillPanel() {
    const L = WEAP[st.key], w = curW();
    opt($("vfWeapon"), L.map((x) => [x.id, x.name]), w.id);
    opt($("vfAmmo"), w.ammo.map((k) => [k, AMMO[k].name]), curAmmo()); $("vfAmmoWrap").hidden = w.ammo.length < 2;
    $("vfModeWrap").hidden = !w.modes; if (w.modes) opt($("vfMode"), w.modes, st.modeSel[w.id] || w.modes[0][0]);
    opt($("vfTarget"), tgts.filter((t) => !t.only || t.only === st.key).map((t) => [t.id, t.label]), st.target);
    $("vfCam").querySelector('[value="salvo"]').hidden = st.key !== "bm21"; $("vfCam").value = st.cam; $("vfLay").checked = st.autoLay;
    updInfo(true);
  }
  $("vfWeapon").addEventListener("change", () => { st.sel[st.key] = $("vfWeapon").value; st.ripple = null; st.burst = 0; fillPanel(); startLay(); });
  $("vfAmmo").addEventListener("change", () => { st.ammoSel[curW().id] = $("vfAmmo").value; startLay(); updInfo(true); });
  $("vfMode").addEventListener("change", () => { st.modeSel[curW().id] = $("vfMode").value; updInfo(true); });
  $("vfTarget").addEventListener("change", () => { st.target = $("vfTarget").value; startLay(); });
  $("vfCam").addEventListener("change", () => { st.cam = st.camSel[st.key] = $("vfCam").value; if (st.cam === "launcher") { restoreCam(); if (st.key === "bm21") frameLauncher(); } });
  $("vfLay").addEventListener("change", () => { st.autoLay = $("vfLay").checked; startLay(); });
  const vf = $("vfFire");
  vf.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); try { vf.setPointerCapture(e.pointerId); } catch {} A.pressFire(); });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) vf.addEventListener(t, () => A.releaseFire());
  vf.addEventListener("click", (e) => { if (e.detail === 0) { A.pressFire(); A.releaseFire(); } });
  $("vfReload").addEventListener("click", () => reload());
  for (const id of ["yaw", "elev"]) $(id).addEventListener("input", (e) => { if (e.isTrusted && st.key) { st.lay = null; st.laid = true; if (st.autoLay) { st.autoLay = false; $("vfLay").checked = false; A.msg("Manual lay: auto-lay is off (tick it to lay on the target again)."); } } });
  // Phase 3: build mode and NPC minds live in build.js, inside this panel
  let BLD = null;
  Object.assign(A, { root, panel, groundY: () => groundY, targets: () => tgts.filter((t) => t.group.visible) });
  import("./build.js").then((m) => { BLD = m.installBuild(A); if (st.key) BLD.reset(); }).catch((e) => console.warn("build.js", e));
  function updInfo(force) {
    if (!st.key || !st.W) return; if (!force && CLOCK.t - st.lastInfoAt < 0.1) return; st.lastInfoAt = CLOCK.t;
    const w = curW(), s = st.weapons[w.id], a = AMMO[curAmmo()];
    const left = w.load ? Object.entries(s.left).map(([k, n]) => `${AMMO[k].short} ${n}`).join(" · ") : `${s.left.all} / ${w.cap}`;
    const rl = CLOCK.t < s.reloadUntil ? `reloading ${((s.reloadUntil - CLOCK.t) / S.speed).toFixed(1)} s` : w.kind === "cannon" && CLOCK.t < s.readyAt ? `autoloader ${((s.readyAt - CLOCK.t) / S.speed).toFixed(1)} s` : st.ripple ? "ripple firing" : !st.laid ? "laying..." : "ready";
    const T = tgtById(st.target), lay = st.autoLay ? ` · laid for ${a.short} at ${T.d >= 1000 ? T.d / 1000 + " km" : T.d + " m"}` : " · manual lay";
    const fl = proj.find((p) => p.on && p.w === w && p.a.highAngle), tof = a.highAngle && st.tof ? ` · time of flight ${st.tof.toFixed(1)} s` + (fl ? ` · SPLASH IN ${Math.max(0, (st.tof - fl.age)).toFixed(1)} s` : "") : "";
    const html = `<b>${w.name}</b> · ${a.name} · ${a.v0 ? a.v0 + " m/s" : "motor " + a.burn + " s"} · <b>${left}</b> · ${rl}${lay}${tof}`;
    if (html !== st.info) { $("vfInfo").innerHTML = html; st.info = html; }
    const tot = w.load ? Object.values(s.left).reduce((x, y) => x + y, 0) : s.left.all, mt = `${tot}/${w.cap}`;
    if ($("magc").textContent !== mt) $("magc").textContent = mt;
    if ($("chtxt").textContent !== rl) $("chtxt").textContent = rl;
    const dot = $("chdot"), cls = "dot" + (rl === "ready" ? " on" : ""); if (dot.className !== cls) dot.className = cls;
  }

  // ---------------------------------------------------------------- Phase 2: support weapons (a row of their own under the vehicles)
  const SW = (() => {
    const seg = document.createElement("div"); seg.className = "seg"; seg.id = "supSeg"; seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Support weapons"); seg.style.marginTop = "6px";
    seg.innerHTML = Object.entries(SUPPORT).map(([k, d]) => `<button type="button" data-sup="${k}" aria-pressed="false">${d.label}</button>`).join("");
    const vs = $("vehSeg"); vs.parentNode.insertBefore(seg, vs.nextSibling);
    seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; const k = b.dataset.sup; A.setVehicle(S.vehicle === k ? null : k).then(A.syncVehSeg, A.syncVehSeg); });
    return seg;
  })();
  const mat = (c, m, r) => new THREE.MeshStandardMaterial({ color: c, metalness: m, roughness: r });
  function cyl(r1, r2, L, m, segs = 16) { const o = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, L, segs), m); o.castShadow = true; return o; }
  function along(o, z0, z1) { o.rotation.x = Math.PI / 2; o.position.z = (z0 + z1) / 2; return o; }   // a cylinder laid along z
  function rigGroups(scene, pivotY, pivotZ) { const tr = new THREE.Group(); tr.name = "sw_traverse"; tr.position.set(0, pivotY, pivotZ); scene.add(tr); const el = new THREE.Group(); el.name = "sw_elevation"; tr.add(el); return { tr, el }; }
  function sandbags(scene, top) { const bag = mat(0x8d7f5a, 0, 0.95); for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.62, top / 3 - 0.01, 0.5), bag); b.position.set(0, top / 6 + i * top / 3, 0.05); b.castShadow = true; b.name = "sw_stand_sandbag"; scene.add(b); } }
  async function buildSupport(key) {
    const scene = new THREE.Group(); scene.name = "support_" + key; let muzzle = null;
    if (key === "mortar") {   // 2B14 "Podnos" (owner, 20 Nov "mortar looks bad"): round ribbed baseplate with its socket, 1.22 m tube with breech cap,
      // ball and muzzle band, clamp collar with two shock absorbers and the sight on its bracket, and a bipod that stays ATTACHED to the tube:
      // its legs, elevating column and traverse bar are re-solved every frame from where the collar actually is, so they follow the elevation.
      const olive = mat(0x4b5236, 0.35, 0.7), dark = mat(0x2a2d2a, 0.75, 0.4), black = mat(0x151515, 0.2, 0.9), bore = mat(0x050505, 0, 1), glass = mat(0x6f8fa0, 0.2, 0.15);
      const plate = cyl(0.255, 0.27, 0.03, olive, 40); plate.position.y = 0.015; plate.name = "sw_baseplate"; scene.add(plate);
      for (let k = 0; k < 6; k++) { const rib = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.2), olive); const a = k * Math.PI / 3; rib.position.set(Math.sin(a) * 0.13, 0.045, 0.15 + Math.cos(a) * 0.13 - 0.15); rib.rotation.y = a; rib.castShadow = true; scene.add(rib); }
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.262, 0.012, 8, 48), olive); rim.rotation.x = Math.PI / 2; rim.position.y = 0.03; scene.add(rim);
      const sock = cyl(0.06, 0.07, 0.07, dark, 24); sock.position.set(0, 0.065, 0.15); scene.add(sock);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 8, 16, Math.PI), dark); handle.position.set(0, 0.03, 0.42); scene.add(handle);
      plate.position.z = 0.15; rim.position.z = 0.15; for (const c of scene.children) if (c.geometry && c.geometry.type === "BoxGeometry") c.position.z += 0.15;
      const { tr, el } = rigGroups(scene, 0.08, 0.15);
      const tube = along(cyl(0.047, 0.047, 1.1, olive, 32), -0.1, -1.2); tube.name = "sw_tube"; el.add(tube);
      el.add(along(cyl(0.056, 0.05, 0.12, dark, 32), 0.02, -0.1));                          // breech cap
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), dark); ball.position.z = 0.03; el.add(ball);   // the ball that seats in the socket
      el.add(along(cyl(0.053, 0.053, 0.05, olive, 32), -1.17, -1.22));                      // muzzle band
      const mz = new THREE.Mesh(new THREE.CircleGeometry(0.041, 24), bore); mz.position.z = -1.215; mz.rotation.y = Math.PI; el.add(mz);
      const CL = -0.82, col = along(cyl(0.062, 0.062, 0.07, dark, 24), CL + 0.035, CL - 0.035); el.add(col);    // clamp collar
      for (const sx of [-1, 1]) { const sa = along(cyl(0.017, 0.017, 0.2, dark, 12), CL + 0.1, CL - 0.1); sa.position.x = sx * 0.045; sa.position.y = 0.055; el.add(sa); }   // shock absorbers
      const br = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 0.04), dark); br.position.set(-0.1, 0.03, CL + 0.02); el.add(br);     // sight bracket, left
      const sb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.1), olive); sb.position.set(-0.16, 0.07, CL + 0.02); el.add(sb);
      const sc = along(cyl(0.016, 0.016, 0.09, black, 12), CL + 0.07, CL - 0.02); sc.position.set(-0.16, 0.125, 0); el.add(sc);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.013, 12), glass); lens.position.set(-0.16, 0.125, CL + 0.071); el.add(lens);
      const yoke = new THREE.Object3D(); yoke.position.set(0, -0.075, CL); el.add(yoke);   // where the bipod's traverse mechanism grips the collar
      // the bipod: feet fixed on the ground (laid for ~65 deg), everything above them follows the yoke
      const FX = 0.36, FZ = -0.36;
      const mkRod = (r, m) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10), m); o.castShadow = true; scene.add(o); return o; };
      const legs = [mkRod(0.016, olive), mkRod(0.016, olive)], column = mkRod(0.022, dark), screw = mkRod(0.012, dark), crossbar = mkRod(0.014, dark), traverse = mkRod(0.016, dark), chain = mkRod(0.004, dark);
      for (const sx of [-1, 1]) { const foot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.018, 0.1), dark); foot.position.set(sx * FX, 0.012, FZ); foot.castShadow = true; scene.add(foot); }
      const hand = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 6, 16), black); scene.add(hand);   // elevating handwheel
      const V = () => new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), inv = new THREE.Matrix4();
      const rod = (o, a, b) => { const d = V().subVectors(b, a), L = d.length(); o.position.copy(a).addScaledVector(d, 0.5); o.scale.set(1, Math.max(1e-3, L), 1); o.quaternion.setFromUnitVectors(up, d.normalize()); };
      const solve = () => {
        scene.updateMatrixWorld(true); inv.copy(scene.matrixWorld).invert();
        const Y = yoke.getWorldPosition(V()).applyMatrix4(inv);
        const C = Y.clone(); C.y = Math.max(0.16, Y.y - 0.34);                 // the elevating column hangs under the yoke
        const B1 = C.clone().add(V().set(-0.13, -0.02, 0)), B2 = C.clone().add(V().set(0.13, -0.02, 0));
        const F1 = V().set(-FX, 0.02, FZ), F2 = V().set(FX, 0.02, FZ);
        rod(legs[0], F1, B1); rod(legs[1], F2, B2); rod(crossbar, B1, B2);
        rod(column, C.clone().add(V().set(0, -0.04, 0)), Y.clone().add(V().set(0, -0.06, 0))); rod(screw, Y.clone().add(V().set(0, -0.08, 0)), Y);
        rod(traverse, Y.clone().add(V().set(-0.12, 0, 0)), Y.clone().add(V().set(0.12, 0, 0)));
        const m1 = F1.clone().lerp(B1, 0.45), m2 = F2.clone().lerp(B2, 0.45); rod(chain, m1, m2);
        hand.position.copy(C).add(V().set(0.07, 0.04, 0)); hand.rotation.y = Math.PI / 2;
      };
      tube.onBeforeRender = solve; solve();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.17, 0.27), mat(0x55603f, 0, 0.85)); box.position.set(0.55, 0.085, 0.55); box.rotation.y = 0.3; box.castShadow = true; scene.add(box);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.012, 0.28), mat(0x48523a, 0, 0.85)); lid.position.set(0.55, 0.176, 0.55); lid.rotation.y = 0.3; scene.add(lid);
      muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -1.24); el.add(muzzle);
    } else if (key === "hmg") {   // NSV on a 6T7 tripod (stand-in shapes; the gun is 1.56 m long)
      const steel = mat(0x2f3330, 0.6, 0.5);
      for (const [a, b] of [[0.0, -0.55], [2.2, 0.45], [-2.2, 0.45]]) { const leg = cyl(0.016, 0.016, 0.7, steel, 8); leg.position.set(Math.sin(a) * 0.3, 0.22, b * 0.6); leg.rotation.set(b < 0 ? 0.9 : -0.9, 0, Math.sin(a) * 0.6); scene.add(leg); }
      const { tr, el } = rigGroups(scene, 0.48, 0.1);
      const rec = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.62), steel); rec.position.z = 0.0; el.add(rec);
      el.add(along(cyl(0.022, 0.022, 1.0, steel, 12), -0.31, -1.31)); el.add(along(cyl(0.034, 0.034, 0.12, steel, 12), -1.2, -1.32));
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.2, 0.26), mat(0x4a5a3a, 0, 0.8)); box.position.set(-0.13, -0.05, 0.05); el.add(box);
      muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -1.33); el.add(muzzle);
    } else {   // the repo's RPG-7 hero (with its PG-7VL) or the Javelin launcher, on a sandbag rest
      const gltf = await A.fetchGLB(SUPPORT[key].file, SUPPORT[key].name), src = gltf.scene.children[0] || gltf.scene, parts = [...src.children];
      const keep = parts.filter((c) => !/(display|cradle|pg7vl|fin_\d_hinge)/.test(c.name)), gren = parts.filter((c) => /(pg7vl|fin_\d_hinge)/.test(c.name));
      const tubeN = src.getObjectByName(key === "rpg7" ? "steel_launch_tube" : "paint_launch_tube"), tb = nodeBoxLocal(tubeN, src), ty = (tb.min.y + tb.max.y) / 2, tx = (tb.min.x + tb.max.x) / 2;
      const H = 1.25; sandbags(scene, H - 0.12 - (ty - tb.min.y));
      const { tr, el } = rigGroups(scene, H, 0); for (const c of keep) { c.position.x -= tx; c.position.y -= ty; el.add(c); }
      muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, tb.min.z); el.add(muzzle);
      if (key === "rpg7" && gren.length) {   // the grenade: its own template (forward -Z), and a copy loaded in the tube with the warhead out of the muzzle
        const g = new THREE.Group(); for (const c of gren) g.add(c); const gb = nodeBoxLocal(g, src), gc = gb.getCenter(V3()), nose = nodeBoxLocal(src.getObjectByName("alu_pg7vl_nose_probe") || g, src).getCenter(V3());
        const t = new THREE.Group(), inner = new THREE.Group(); t.add(inner); inner.add(g); g.position.sub(gc); if (nose.z > gc.z) inner.rotation.y = Math.PI;
        st.models.pg7vl = t; const len = gb.max.z - gb.min.z; const ld = t.clone(true); ld.position.set(0, 0, tb.min.z + len * 0.5 - 0.42); ld.name = "sw_loaded"; el.add(ld);
      }
    }
    if (muzzle) muzzle.name = "sw_muzzle";
    scene.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(scene), sz = bb.getSize(V3());
    A.VIEWONLY[key].lenM = Math.max(sz.x, sz.z);
    return { scene, parser: { json: {} } };
  }
  for (const [k, d] of Object.entries(SUPPORT)) if (!A.VIEWONLY[k]) A.VIEWONLY[k] = { label: d.name, lenM: 1, build: () => buildSupport(k) };
  function rigSupport(key, rig) {
    const sc = rig.gltf.scene, W = { muz: {}, recoil: {}, dirNode: {} }, el = sc.getObjectByName("sw_elevation"), tr = sc.getObjectByName("sw_traverse"), wid = WEAP[key][0].id;
    rig.pv = { yaw: tr, elev: el }; W.muz[wid] = sc.getObjectByName("sw_muzzle"); W.dirNode[wid] = el; W.loaded = sc.getObjectByName("sw_loaded");
    W.caps2 = ["plastic_end_cap_front", "plastic_end_cap_rear", "strap_end_cap_front_pull_tab", "strap_end_cap_rear_pull_tab"].map((n) => sc.getObjectByName(n)).filter(Boolean);
    return W;
  }

  // ---------------------------------------------------------------- activation (polled: the page's own vehicle code stays as it is)
  let prevTgtVis = null;
  function activate(key, rig) {
    if (st.key && !key) {   // leaving
      root.visible = false; panel.hidden = true; st.key = null; st.rig = null; st.W = null; st.ripple = null; st.burst = 0; st.lay = null; st.autoRotOff = false;
      for (const P of proj) if (P.on) { P.on = false; if (P.body) { P.body.obj.visible = false; P.body.busy = false; P.body = null; } }
      if (st.savedCam) restoreCam(); st.follow = null;
      for (const id of ["yaw", "elev"]) $(id).step = "1";
      if (A.tgt3 && prevTgtVis != null) { A.tgt3.group.visible = prevTgtVis; prevTgtVis = null; }
      if (st.floor && st.floorVis != null) { st.floor.visible = st.floorVis; st.floorVis = null; } A.scene.fog = st.prevFog || null;
      try { A.refresh(); } catch {}
      return;
    }
    if (!key) return;
    st.key = key; st.rig = rig; st.W = rigFor(key, rig); root.visible = true; panel.hidden = false;
    for (const w of WEAP[key]) if (!st.weapons[w.id]) st.weapons[w.id] = { left: w.load ? { ...w.load } : { all: w.cap }, readyAt: 0, reloadUntil: 0, fired: 0, recoilT: 0 };
    for (const w of WEAP[key]) for (const am of w.ammo) if (AMMO[am].model) loadModel(AMMO[am].model);
    if (!boomLight && !LOW()) { boomLight = new THREE.PointLight(0xffa860, 0, 300, 1.6); root.add(boomLight); }
    $("yaw").step = "0.01"; $("elev").step = "0.01";
    if (SUPPORT[key]) { const r = SUPPORT[key].ranges, set = (id, a, b, v) => { const e = $(id); e.min = a; e.max = b; e.value = v; }; set("yaw", r[0], r[1], r[2]); set("elev", r[3], r[4], r[5]); $("yawlbl").textContent = "Traverse"; $("elvlbl").textContent = "Elevation"; }
    if (!st.sel[key]) st.sel[key] = WEAP[key][0].id;
    if (!tgts.find((t) => t.id === st.target && (!t.only || t.only === key))) st.target = "t500";
    if (key === "bm21" && st.target === "t500") st.target = "t1000";
    A.staticPose(); placeTargets(); measureSigns(); fillPanel(); startLay(); if (BLD) BLD.reset();
    if (A.tgt3) { prevTgtVis = A.tgt3.group.visible; A.tgt3.group.visible = false; }
    loadHulks();
    if (!st.floor) st.floor = A.scene.children.find((o) => o.isMesh && o.geometry && o.geometry.parameters && o.geometry.parameters.width === 700 && o.geometry.parameters.height === 60) || null;
    if (st.floor) { st.floorVis = st.floor.visible; st.floor.visible = false; }   // the gun range's concrete strip: the vehicle range is open ground
    st.prevFog = A.scene.fog; const bg = A.scene.background && A.scene.background.isColor ? A.scene.background : new THREE.Color(0xe9e7e1); A.scene.fog = new THREE.Fog(bg.clone(), 350, 6500);
    st.cam = st.camSel[key] || (key === "bm21" ? "launcher" : "follow"); $("vfCam").value = st.cam;
    { const cp = A.camera.position; st.wind.x = 2.5; st.wind.z = Math.sign(-cp.z || 1) * 1.5; }   // drift smoke downrange and away from the default viewpoint
    if (key === "bm21" && st.cam === "launcher") frameLauncher();
    A.camera.far = Math.max(A.camera.far, 3000); A.camera.updateProjectionMatrix();
    A.msg(`${WEAP[key].map((w) => w.name).join(", ")}: pick the weapon and ammunition below, then FIRE (Space). The gun lays itself on the chosen target.`);
  }

  let lastT = CLOCK.t;
  function tick() {
    requestAnimationFrame(tick);
    const v = S.vehicle, rig = A.getRig(), want = v && WEAP[v] && rig && rig.vehicle === v && rig.gltf ? v : null;
    if (want !== st.key || (want && rig !== st.rig)) activate(want, rig);
    const now = CLOCK.t, raw = Math.max(0, Math.min(0.25, now - lastT)); lastT = now;
    for (const b of SW.children) { const on = String(S.vehicle === b.dataset.sup); if (b.getAttribute("aria-pressed") !== on) b.setAttribute("aria-pressed", on); }
    if (!st.key) return;
    const dt = raw / S.speed;   // physical seconds this frame (slow motion slows the flight)
    if (A.tgt3 && A.tgt3.group.visible) A.tgt3.group.visible = false;
    stepLay(raw / S.speed); stepTrigger();
    let any = false;
    if (dt > 0) for (const P of proj) if (P.on) { stepProj(P, dt); any = true; }
    for (const d of debris) if (d.busy) { d.t += dt; d.v.addScaledVector(d.v, -0.02 * d.v.length() * dt); d.v.y -= G * dt; d.o.position.addScaledVector(d.v, dt); d.o.rotation.x += d.w.x * dt; d.o.rotation.y += d.w.y * dt; if (d.o.position.y < groundY + 0.05) { d.o.position.y = groundY + 0.05; d.v.multiplyScalar(0.3); d.v.y = Math.abs(d.v.y) * 0.2; } if (d.t > 6) { d.busy = false; d.o.visible = false; } any = true; }
    stepTracers();
    const ls = stepP(smoke, dt), lf = stepP(fire, dt); if (ls || lf) any = true;
    const r = A.hqHeight ? A.hqHeight() : 600; smoke.pts.material.uniforms.uScale.value = fire.pts.material.uniforms.uScale.value = r * 0.5 / Math.tan(A.camera.fov * D2R / 2);
    for (const f of flashes) if (f.visible && now > f.userData.off) { f.visible = false; any = true; }
    if (boomLight && boomLight.intensity > 0) { boomLight.intensity *= Math.exp(-dt * 9); if (boomLight.intensity < 5) boomLight.intensity = 0; any = true; }
    // recoil and the hull rocking on its suspension (a damped spring)
    for (const w of WEAP[st.key]) { const s = st.weapons[w.id], R = st.W.recoil[w.id]; if (!R || !s.recoilT) continue; s.recoilT += dt; const u = s.recoilT, x = u < 0.012 ? w.recoil * u / 0.012 : w.recoil * Math.exp(-(u - 0.012) / 0.12); R.position.z = x; if (u > 1.2) { s.recoilT = 0; R.position.z = 0; } any = true; }
    for (let k = 0, n = Math.min(60, Math.ceil(dt / 0.004)); k < n; k++) { const h = dt / n; st.rockV += (-60 * st.rockQ - 7 * st.rockV) * h; st.rockQ += st.rockV * h; }   // substepped: stable at any frame rate
    st.rockQ = Math.max(-0.03, Math.min(0.03, st.rockQ)); if (Math.abs(st.rockQ) > 1e-5 || Math.abs(st.rockV) > 1e-4) { st.rig.outer.rotation.z = st.rockQ; any = true; } else if (st.rig.outer.rotation.z) { st.rig.outer.rotation.z = 0; st.rockQ = st.rockV = 0; }
    // steel poppers swing back and reset
    for (const T of tgts) for (const p of T.plates) if (p.w || p.ang) { for (let k = 0, n = Math.min(60, Math.ceil(dt / 0.005)); k < n; k++) { const h = dt / n; p.w += (-40 * p.ang - 4 * p.w) * h; p.ang = Math.max(0, Math.min(1.3, p.ang + p.w * h)); } if (now - p.hitAt > 3 * S.speed && p.ang < 0.02 && Math.abs(p.w) < 0.05) { p.ang = 0; p.w = 0; } p.pv.rotation.z = -p.ang; any = true; }
    if (stepBurning(dt)) any = true;
    if (BLD && BLD.step(dt)) any = true;
    stepCam(); if (st.follow || st.camHold) any = true;
    updInfo(false);
    if (any) A.markDirty();
  }
  requestAnimationFrame(tick);

  const api = {
    press, release, reload, active: () => !!st.key,
    // test hooks
    state: () => ({ key: st.key, weapon: st.key && curW().id, ammo: st.key && curAmmo(), shots: st.shots, impacts: st.impacts, laid: st.laid, ripple: !!st.ripple, live: proj.filter((p) => p.on).length,
      left: st.key ? JSON.parse(JSON.stringify(st.weapons[curW().id].left)) : null, tubes: st.W && st.W.tubes ? st.W.tubes.filter((t) => t.loaded).length : null, tubesFound: st.W && st.W.tubesFound, events: st.events.slice(-50), models: Object.keys(st.models) }),
    select: (wid, aid, mode) => { if (!st.key) return false; st.sel[st.key] = wid; if (aid) st.ammoSel[wid] = aid; if (mode) st.modeSel[wid] = mode; fillPanel(); startLay(); return true; },
    setTarget: (id) => { st.target = id; fillPanel(); startLay(); }, setCam: (c) => { st.cam = c; $("vfCam").value = c; },
    cam: (p, t, fov) => { const c = A.getControls(), cam = A.camera; if (!p) { cam.fov = 32; cam.updateProjectionMatrix(); return; } if (fov) cam.fov = fov; cam.position.set(p[0], groundY + p[1], p[2]); if (c) { c.autoRotate = false; c.target.set(t[0], groundY + t[1], t[2]); c.update(); } cam.lookAt(c ? c.target : new THREE.Vector3(t[0], groundY + t[1], t[2])); cam.far = 6000; cam.updateProjectionMatrix(); A.markDirty(); },
    hulks: () => tgts.map((t) => ({ id: t.id, model: !!t.model, hp: t.hp ?? 2400, dead: !!t.dead })), frameLauncher, smokeAlpha: () => smoke.alphaSum,
    get build() { return BLD && BLD.api; },
    tof: () => st.tof, javAlt: () => { const P = proj.find((p) => p.on && p.a === AMMO.jav); return P ? { y: P.p.y - groundY, dive: P.dive, age: P.age } : null; },
    finAngles: () => { const P = proj.find((p) => p.on && p.a === AMMO.grad && p.body); return P ? { age: P.age, finAt: P.finAt, inTube: P.inTube, fins: P.body.fins.map((f) => f.ang), real: P.body.real, s: P.s } : null; },
    finReach: () => { const b = bodies.find((x) => x.key === "grad" && x.real); if (!b) return null; const out = []; b.obj.updateMatrixWorld(true); const ax = new THREE.Vector3(0, 0, -1).transformDirection(b.obj.matrixWorld), o = b.obj.getWorldPosition(V3());
      for (const f of b.fins) { let mx = 0; f.n.traverse((m) => { if (!m.isMesh) return; const pa = m.geometry.attributes.position; for (let i = 0; i < pa.count; i += 3) { const q = V3().fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld).sub(o); q.addScaledVector(ax, -q.dot(ax)); mx = Math.max(mx, q.length()); } }); out.push(+mx.toFixed(4)); } return out; },
    finTest: (deg) => { const b = bodies.find((x) => x.key === "grad" && x.real) || null; if (!b) return null; for (const f of b.fins) setFin(f, deg); return api.finReach(); },
    proj: () => proj.filter((p) => p.on).map((p) => ({ a: p.aid, p: p.p.toArray().map((x) => +x.toFixed(2)), v: +p.v.length().toFixed(1) })),
    lay: () => ({ yaw: +$("yaw").value, el: +$("elev").value, laid: st.laid, lay: st.lay }), WEAP, AMMO, TARGETS, tgts: () => tgts.map((t) => ({ id: t.id, vis: t.group.visible, pos: t.group.position.toArray() })),
  };
  return api;
}
