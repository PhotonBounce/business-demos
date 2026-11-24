// room.js - destructible, physically simulated ROOM for the Shooting Range.
//
//   import { createRoom } from "./room.js";
//   const room = createRoom(scene, { quality: "medium", size: "medium", wall: "drywall" });
//   const result = room.fireShot({ origin, dir, velocity, bulletMass, caliber, bulletType });
//   // in the render loop:  room.update(dtSeconds);
//
// See INTEGRATION.md for the hook points. Everything the page needs is exported from here.
//
// ---------------------------------------------------------------------------------------------
// PHYSICS MODEL AND SOURCES (all simplified; constants are calibrated to the cited ballpark figures,
// they are NOT lab-grade data - the page labels the room "approximate", like the sim's external ballistics)
//
//  Flight      Point mass, drag a = rho v^2 Cd_std(M) pi / (8 BC_SI), BC_SI = 703.07 BC (lb/in^2 -> kg/m^2),
//              the SAME form, G7 table and 1e-4 s Euler step as sim.js EXT.path (so the room and the panel agree);
//              G1 table (standard McCoy / JBM G1 Cd) for the 9x18. Gravity 9.80665, air 1.225 kg/m3, a0 340.3 m/s.
//              Refs: McCoy, "Modern Exterior Ballistics" (1999); Litz, "Applied Ballistics for Long-Range Shooting".
//  Soft/brittle targets (wood, drywall, brick, concrete, sand, paper, glass, ceramic, tissue, fibreglass)
//              Poncelet (1829) / Recht-Ipson-style resistance  F = A (S + rho k v^2).  Closed form through a slab of
//              path length L:  v_out^2 = (v^2 + S/(rho k)) exp(-2 A rho k L / m) - S/(rho k);  if <= 0 the bullet stops
//              at depth x = m/(2 A rho k) ln(1 + rho k v^2 / S).  Refs: Backman & Goldsmith, "The mechanics of penetration
//              of projectiles into targets", Int. J. Eng. Sci. 16 (1978); Forrestal et al., "Penetration into concrete
//              targets", Int. J. Impact Eng. 15 (1994) (S ~ 82.6 f_c^0.544 MPa for ogive noses, used for concrete/brick).
//  Steel plate de Marre:  v_bl = K d^0.75 T^0.7 / m^0.5  (SI; T = plate path length, i.e. thickness / cos(obliquity), the
//              NATO obliquity rule), K calibrated 1.0e5 (mild steel; 7.62x39 steel-core ~ 5 mm) and 1.4e5 (AR500-class).
//              Residual speed Recht-Ipson:  v_r = m/(m + m_plug) sqrt(v^2 - v_bl^2). Refs: de Marre (1886); Recht & Ipson,
//              J. Appl. Mech. 30 (1963); Zukas, "Impact Dynamics" (1982); THOR (Ballistic Research Lab. report 47, 1961) is the
//              empirical family de Marre belongs to - the room uses de Marre's closed form instead of THOR's tables.
//  Ricochet    Critical grazing angle by surface (below it the bullet skips, above it penetrates or embeds). Indicative
//              figures from: Jauhari, Mishra & Mukherjee, "Analysis of bullet ricochet from metal plates"; Nennstiel, "Bullet
//              ricochet" (Wiener Forensic notes); Haag, "Ricochet" (AFTE J.); Wolberg ricochet studies: steel ~25-30 deg,
//              concrete ~12-15, brick ~12, wood ~8, drywall ~3. Retention 0.85 near 0 deg falling to ~0.25 at the critical
//              angle, outgoing angle ~0.6 of incoming (lead bullets flatten), gaussian spread - the qualitative trends of
//              those papers. Lead-core pistol bullets ricochet ~20 % more readily than steel-core rifle ball.
//  Tissue      Poncelet with S 1.5 MPa, rho 1040, k 0.6: M43 ~ 0.7 m, 9x18 ~ 0.27 m in gelatin, the order of the published
//              ballistic-gelatin tests (Fackler 1988 wound-ballistics reviews; many hobbyist test compilations).
//  Glass/CRT   Brittle break: any arrival energy above a per-object threshold shatters it (stress-wave breakage does not
//              scale with the energy the bullet loses); fragment speed sqrt(2 eta Ek / M), eta 3 %, clamped 1.5..12 m/s.
//              A CRT is evacuated: a bullet through the faceplate implodes it (inward burst ~6 ms, then the outward
//              rebound); see Hamilton, "Implosion of cathode-ray tubes" (safety literature, e.g. UL 1418).
// ---------------------------------------------------------------------------------------------
import * as THREE from "three";

export const FT = 0.9144; // 3 feet, the pedestal pitch
const G = 9.80665, RHO_AIR = 1.225, A0 = 340.3;

// ---- standard drag functions (Cd vs Mach) -----------------------------------------------------
const G7 = [[0, .1198], [.05, .1197], [.1, .1196], [.15, .1194], [.2, .1193], [.25, .1194], [.3, .1194], [.35, .1194], [.4, .1193],
  [.45, .1193], [.5, .1194], [.55, .1193], [.6, .1194], [.65, .1197], [.7, .1202], [.725, .1207], [.75, .1215], [.775, .1226],
  [.8, .1242], [.825, .1266], [.85, .1306], [.875, .1368], [.9, .1464], [.925, .166], [.95, .2054], [.975, .2993], [1, .3803],
  [1.025, .4015], [1.05, .4043], [1.075, .4034], [1.1, .4014], [1.125, .3987], [1.15, .3955], [1.2, .3884], [1.25, .381],
  [1.3, .3732], [1.35, .3657], [1.4, .358], [1.5, .344], [1.55, .3376], [1.6, .3315], [1.65, .326], [1.7, .3209], [1.75, .316],
  [1.8, .3117], [1.85, .3078], [1.9, .3042], [1.95, .301], [2, .298], [2.1, .2922], [2.2, .2864], [2.3, .2807], [2.4, .2752],
  [2.5, .2697], [3, .2453], [4, .2084], [5, .1825]];
const G1 = [[0, .2629], [.05, .2558], [.1, .2487], [.15, .2413], [.2, .2344], [.25, .2278], [.3, .2214], [.35, .2155], [.4, .2104],
  [.45, .2061], [.5, .2032], [.55, .202], [.6, .2034], [.7, .2165], [.725, .223], [.75, .2313], [.775, .2417], [.8, .2546],
  [.825, .2706], [.85, .2901], [.875, .3136], [.9, .3415], [.925, .3734], [.95, .4084], [.975, .4448], [1, .4805], [1.025, .5136],
  [1.05, .5427], [1.075, .5677], [1.1, .5883], [1.125, .6053], [1.15, .6191], [1.2, .6393], [1.25, .6518], [1.3, .6589],
  [1.35, .6621], [1.4, .6625], [1.45, .6607], [1.5, .6573], [1.55, .6528], [1.6, .6474], [1.65, .6413], [1.7, .6347], [1.75, .628],
  [1.8, .621], [1.85, .6141], [1.9, .6072], [1.95, .6003], [2, .5934], [2.1, .5804], [2.2, .5685], [2.3, .5577], [2.4, .5481],
  [2.5, .5397], [2.6, .5325], [2.7, .5264], [2.8, .5211], [2.9, .5168], [3, .5133], [3.5, .504], [4, .5006], [5, .4988]];
export const DRAG_TABLES = { G7, G1 };
function cdOf(tab, M) {
  if (M <= 0) return tab[0][1];
  for (let i = 1; i < tab.length; i++) if (M <= tab[i][0]) { const [m0, c0] = tab[i - 1], [m1, c1] = tab[i]; return c0 + (c1 - c0) * (M - m0) / (m1 - m0); }
  return tab[tab.length - 1][1];
}
/** Integration step shared by the flight loop and the aiming solver (keep them identical or they disagree). */
function dtFor(v) { return v > 200 ? 1e-4 : 4e-4; }

// ---- bullets ------------------------------------------------------------------------------------
export const BULLETS = {
  AK: { id: "AK", name: "7.62x39 M43 (steel-core ball)", caliber: 0.00792, mass: 0.0079, model: "G7", bc: 0.138, sightH: 0.048, mv: 715, core: "steel", ricochetK: 1.0 },
  // The sim carries only a G7 BC (0.06) for the 9x18; G1 ~ 2x G7 for round-nose pistol bullets -> 0.12 (sectional density 0.102 / form factor ~0.85).
  MAK: { id: "MAK", name: "9x18 Makarov 57-N-181S (lead core, steel jacket)", caliber: 0.00927, mass: 0.0061, model: "G1", bc: 0.12, sightH: 0.017, mv: 315, core: "lead", ricochetK: 1.2 },
};
function resolveBullet(shot) {
  const base = BULLETS[shot.bulletType] || BULLETS.AK;
  const b = { ...base };
  if (shot.bulletMass) b.mass = shot.bulletMass;
  if (shot.caliber) b.caliber = shot.caliber > 0.1 ? shot.caliber / 1000 : shot.caliber; // accept mm or m
  if (shot.drag) { b.model = shot.drag.model || b.model; b.bc = shot.drag.bc || b.bc; }
  b.area = Math.PI * b.caliber * b.caliber / 4;
  b.table = b.model === "G1" ? G1 : G7;
  b.bcSI = b.bc * 703.07;
  return b;
}

// ---- materials ----------------------------------------------------------------------------------
// S [Pa] strength term, rho [kg/m3], k nose-shape factor, defl = 1-sigma deflection (deg) per pass, gc = critical grazing angle (deg),
// K = de Marre constant (steel), name used in events; col = display colour.
export const MATERIALS = {
  drywall: { model: "poncelet", S: 5e6, rho: 700, k: 0.5, defl: 1.2, gc: 3, col: 0xe6e2d6 },
  concrete: { model: "poncelet", S: 5.7e8, rho: 2400, k: 0.5, defl: 4, gc: 14, col: 0x9a9a96 },
  brick: { model: "poncelet", S: 3e8, rho: 1800, k: 0.5, defl: 4, gc: 12, col: 0x9c4f3a },
  wood: { model: "poncelet", S: 6e7, rho: 500, k: 0.5, defl: 2, gc: 8, col: 0x9b7447 },
  steel: { model: "demarre", K: 1.0e5, rho: 7850, defl: 3, gc: 25, col: 0x8d949c },
  steel_ar500: { model: "demarre", K: 1.4e5, rho: 7850, defl: 3, gc: 30, col: 0x5b6169 },
  tin: { model: "poncelet", S: 3e8, rho: 7800, k: 0.5, defl: 1, gc: 6, col: 0xb8bcc0 },
  glass: { model: "poncelet", S: 3e7, rho: 2500, k: 0.5, defl: 0.8, gc: 5, col: 0xa8d8d0 },
  ceramic: { model: "poncelet", S: 6e7, rho: 2400, k: 0.5, defl: 1, gc: 6, col: 0xe9e4da },
  plastic: { model: "poncelet", S: 4e7, rho: 1100, k: 0.5, defl: 1, gc: 4, col: 0x2c2c2e },
  fibreglass: { model: "poncelet", S: 4e7, rho: 1500, k: 0.5, defl: 1.2, gc: 4, col: 0xe8e0d2 },
  paper: { model: "poncelet", S: 5e6, rho: 800, k: 0.5, defl: 0.1, gc: 0, col: 0xf1ecde },
  books: { model: "poncelet", S: 1.5e7, rho: 700, k: 0.5, defl: 1, gc: 0, col: 0x7a3b2e },
  sand: { model: "poncelet", S: 3.5e7, rho: 1600, k: 0.5, defl: 3, gc: 0, col: 0xc9b27c },
  melon: { model: "poncelet", S: 1e6, rho: 950, k: 0.6, defl: 1, gc: 0, col: 0x6aa84f },
  flesh: { model: "poncelet", S: 1.5e6, rho: 1040, k: 0.6, defl: 1.5, gc: 0, col: 0xc8a882 },
  skull: { model: "poncelet", S: 1.2e7, rho: 1100, k: 0.6, defl: 2, gc: 0, col: 0xc8a882 },
  aramid: { model: "poncelet", S: 6e8, rho: 1400, k: 0.5, defl: 3, gc: 10, col: 0x3a3a2a },
};
// Wall build-ups: thickness [m] and the material the bullet meets.
export const WALLS = {
  drywall: { material: "drywall", thickness: 0.026, label: "Drywall (2 x 12.7 mm)" },
  concrete: { material: "concrete", thickness: 0.2, label: "Concrete (200 mm)" },
  brick: { material: "brick", thickness: 0.2, label: "Brick (200 mm, double wythe)" },
  wood: { material: "wood", thickness: 0.03, label: "Wood panelling (30 mm)" },
};
export const FLOORS = {
  concrete: { material: "concrete", thickness: 0.15, label: "Concrete slab" },
  wood: { material: "wood", thickness: 0.03, label: "Wood floor" },
};
export const SIZES = {
  small: { w: 5, l: 8, h: 3, label: "Small 5 x 8 x 3 m" },
  medium: { w: 8, l: 15, h: 3.5, label: "Medium 8 x 15 x 3.5 m" },
  large: { w: 12, l: 30, h: 4.5, label: "Large 12 x 30 x 4.5 m" },
};

// ---- small maths ---------------------------------------------------------------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const xyz = (a) => ({ x: a[0], y: a[1], z: a[2] });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const D2R = Math.PI / 180;
function rotY(v, f) { const c = Math.cos(f), s = Math.sin(f); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }

export class Rng {
  constructor(seed = 1) { let a = (seed >>> 0) || 1; this.f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  u() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  n() { const u = this.f() || 1e-12, v = this.f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  pick(a) { return a[Math.floor(this.f() * a.length) % a.length]; }
}
/** A unit vector near `d`, rotated by a gaussian angle (std sigmaDeg) about a random azimuth. */
function jitterDir(d, sigmaDeg, rng) {
  if (sigmaDeg <= 0) return d;
  const ang = Math.abs(rng.n()) * sigmaDeg * D2R, az = rng.u() * Math.PI * 2;
  const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(d, a)), w = cross(d, u);
  const o = add(scl(d, Math.cos(ang)), add(scl(u, Math.sin(ang) * Math.cos(az)), scl(w, Math.sin(ang) * Math.sin(az))));
  return norm(o);
}

// ---- penetration (exported for the tests) ----------------------------------------------------------
/** Poncelet slab: path length L [m] of material `mat` at speed v. */
export function ponceletSlab(mat, bullet, v, L) {
  const A = bullet.area, m = bullet.mass, rk = mat.rho * mat.k, q = mat.S / rk;
  const e = Math.exp(-2 * A * rk * L / m);
  const v2 = (v * v + q) * e - q;
  if (v2 > 0) return { pass: true, vOut: Math.sqrt(v2), depth: L };
  return { pass: false, vOut: 0, depth: m / (2 * A * rk) * Math.log(1 + v * v / q) };
}
/** de Marre + Recht-Ipson for a steel plate path length T. */
export function deMarrePlate(mat, bullet, v, T) {
  const vbl = mat.K * Math.pow(bullet.caliber, 0.75) * Math.pow(Math.max(T, 1e-5), 0.7) / Math.sqrt(bullet.mass);
  if (v <= vbl) return { pass: false, vOut: 0, vbl, depth: 0 };
  const mp = mat.rho * bullet.area * T, a = bullet.mass / (bullet.mass + mp);
  return { pass: true, vOut: a * Math.sqrt(v * v - vbl * vbl), vbl, depth: T };
}
export function penetrate(matName, bullet, v, L) {
  const mat = MATERIALS[matName];
  return mat.model === "demarre" ? deMarrePlate(mat, bullet, v, L) : ponceletSlab(mat, bullet, v, L);
}
/** Critical grazing angle [deg] of a material for a bullet (0 = never ricochets). */
export function criticalAngle(matName, bullet) { return (MATERIALS[matName].gc || 0) * (bullet.ricochetK || 1); }

// ---- ray vs primitive (local frame). Each returns {t0,t1,n0,n1} (entry/exit parameters + outward normals) or null ----
function rayBox(o, d, c, h) {
  let tmin = -Infinity, tmax = Infinity, n0 = null, n1 = null;
  for (let i = 0; i < 3; i++) {
    const p = o[i] - c[i];
    if (Math.abs(d[i]) < 1e-12) { if (Math.abs(p) > h[i]) return null; continue; }
    let ta = (-h[i] - p) / d[i], tb = (h[i] - p) / d[i], na = -1, nb = 1;
    if (ta > tb) { const s = ta; ta = tb; tb = s; na = 1; nb = -1; }
    if (ta > tmin) { tmin = ta; n0 = i * 2 + (na < 0 ? 0 : 1); }
    if (tb < tmax) { tmax = tb; n1 = i * 2 + (nb < 0 ? 0 : 1); }
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const nrm = (k) => { const v = [0, 0, 0]; v[k >> 1] = (k & 1) ? 1 : -1; return v; };
  return { t0: tmin, t1: tmax, n0: nrm(n0 ?? 0), n1: nrm(n1 ?? 0) };
}
function rayEll(o, d, c, r) {
  const op = [(o[0] - c[0]) / r[0], (o[1] - c[1]) / r[1], (o[2] - c[2]) / r[2]], dp = [d[0] / r[0], d[1] / r[1], d[2] / r[2]];
  const a = dot(dp, dp), b = 2 * dot(op, dp), cc = dot(op, op) - 1, disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc), t0 = (-b - s) / (2 * a), t1 = (-b + s) / (2 * a);
  if (t1 < 0) return null;
  const nn = (t) => norm([(op[0] + t * dp[0]) / r[0], (op[1] + t * dp[1]) / r[1], (op[2] + t * dp[2]) / r[2]]);
  return { t0, t1, n0: nn(t0), n1: nn(t1) };
}
/** Surface of revolution about the local y axis, c = base centre, prof = [[r,y],...] from bottom axis up to top axis. */
function rayLathe(o, d, c, prof) {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const hits = [];
  for (let i = 0; i + 1 < prof.length; i++) {
    const [r0, y0] = prof[i], [r1, y1] = prof[i + 1];
    if (Math.abs(y1 - y0) < 1e-9) { // flat disc / annulus
      if (Math.abs(d[1]) < 1e-12) continue;
      const t = (y0 - oy) / d[1], x = ox + t * d[0], z = oz + t * d[2], rr = Math.hypot(x, z);
      if (rr >= Math.min(r0, r1) - 1e-9 && rr <= Math.max(r0, r1) + 1e-9) hits.push({ t, n: [0, r1 > r0 ? -1 : 1, 0] });
      continue;
    }
    const k = (r1 - r0) / (y1 - y0), q0 = r0 + k * (oy - y0);
    const a = d[0] * d[0] + d[2] * d[2] - k * k * d[1] * d[1];
    const b = 2 * (ox * d[0] + oz * d[2] - k * d[1] * q0), cc = ox * ox + oz * oz - q0 * q0;
    const push = (t) => {
      const y = oy + t * d[1], x = ox + t * d[0], z = oz + t * d[2];
      if (y < Math.min(y0, y1) - 1e-9 || y > Math.max(y0, y1) + 1e-9) return;
      const rr = Math.hypot(x, z) || 1e-9;
      if (r0 + k * (y - y0) < -1e-9) return;
      hits.push({ t, n: norm([x / rr, -k, z / rr]) });
    };
    if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) push(-cc / b); continue; }
    const disc = b * b - 4 * a * cc;
    if (disc < 0) continue;
    const s = Math.sqrt(disc); push((-b - s) / (2 * a)); push((-b + s) / (2 * a));
  }
  if (!hits.length) return null;
  hits.sort((p, q) => p.t - q.t);
  const first = hits[0], last = hits[hits.length - 1];
  if (last.t < 0) return null;
  if (hits.length === 1 || first === last) return { t0: 0, t1: last.t, n0: scl(d, -1), n1: last.n };
  return { t0: first.t, t1: last.t, n0: first.n, n1: last.n };
}
function rayPart(part, o, d) {
  switch (part.shape) {
    case "box": return rayBox(o, d, part.c, part.h);
    case "ell": return rayEll(o, d, part.c, part.h);
    case "lathe": return rayLathe(o, d, part.c, part.prof);
  }
  return null;
}

// ====================================================================================================
// OBJECT CATALOG. Local frame: origin = centre of the base on its support, +y up, +z = the front (faces the shooter).
// parts = colliders (shape box|ell|lathe, material, hollow+t for thin shells); vis = instanced visuals.
// ====================================================================================================
MATERIALS.cmu = { model: "poncelet", S: 2.5e8, rho: 2000, k: 0.5, defl: 4, gc: 13, col: 0x8f8f8a }; // hollow concrete masonry unit

export const LATHES = {
  vaseA: [[0, 0], [.055, 0], [.078, .05], [.09, .14], [.072, .24], [.042, .3], [.046, .34], [.058, .365], [0, .365]],
  vaseB: [[0, 0], [.06, 0], [.07, .03], [.11, .16], [.1, .26], [.05, .36], [.04, .42], [.06, .46], [0, .46]],
  vaseC: [[0, 0], [.07, 0], [.1, .05], [.12, .12], [.09, .2], [.08, .22], [0, .22]],
  bottle: [[0, 0], [.036, 0], [.038, .02], [.038, .18], [.03, .23], [.013, .27], [.013, .31], [.016, .315], [0, .315]],
  jar: [[0, 0], [.04, 0], [.04, .11], [.034, .115], [0, .115]],
  can: [[0, 0], [.033, 0], [.033, .11], [0, .11]],
};
const VASE_COLS = [0xdad5c8, 0x2f5d8a, 0x8a3a2f, 0xc9a24a, 0x3f7a5a, 0xe9e1d0];
const bx = (c, h, material, extra) => ({ shape: "box", c, h, material, ...extra });

export const OBJECT_TYPES = {
  vase_ceramic: { label: "Vase", build(r) {
    const k = r.pick(["vaseA", "vaseB", "vaseC"]), prof = LATHES[k];
    return { mass: 0.7, parts: [{ shape: "lathe", c: [0, 0, 0], prof, material: "ceramic", hollow: true, t: 0.005 }],
      vis: [{ p: "lathe:" + k, c: [0, 0, 0], s: [1, 1, 1], col: r.pick(VASE_COLS) }],
      brk: { E: 3, n: 14, color: 0xe9e4da, e: 0.25 }, knock: true };
  } },
  bottle_glass: { label: "Bottle", build(r) {
    return { mass: 0.4, parts: [{ shape: "lathe", c: [0, 0, 0], prof: LATHES.bottle, material: "glass", hollow: true, t: 0.003 }],
      vis: [{ p: "lathe:bottle", c: [0, 0, 0], s: [1, 1, 1], col: r.pick([0x2f6b3a, 0x6b4a1f, 0x9ec8d8]) }],
      brk: { E: 1.5, n: 12, color: 0xa8d8d0, e: 0.3 }, knock: true };
  } },
  jar_glass: { label: "Jar", build(r) {
    return { mass: 0.3, parts: [{ shape: "lathe", c: [0, 0, 0], prof: LATHES.jar, material: "glass", hollow: true, t: 0.003 }],
      vis: [{ p: "lathe:jar", c: [0, 0, 0], s: [1, 1, 1], col: r.pick([0xb9d9d0, 0xd8c690, 0xc9a0a0]) }],
      brk: { E: 1.5, n: 10, color: 0xc8e4dc, e: 0.3 }, knock: true };
  } },
  can_tin: { label: "Tin can", build(r) {
    return { mass: 0.35, parts: [{ shape: "lathe", c: [0, 0, 0], prof: LATHES.can, material: "tin", hollow: true, t: 0.0003 }],
      vis: [{ p: "lathe:can", c: [0, 0, 0], s: [1, 1, 1], col: r.pick([0xc0392b, 0x2e86c1, 0xb7b7b7, 0xd4ac0d]) }], knock: true,
      collapse: { E: 0.5, mode: "squash" }, spray: true };
  } },
  book: { label: "Book", build(r) {
    return { mass: 0.5, parts: [bx([0, 0.12, 0], [0.08, 0.12, 0.02], "books")],
      vis: [{ p: "box", c: [0, 0.12, 0], s: [0.16, 0.24, 0.04], col: r.pick([0x7a3b2e, 0x2e4a7a, 0x3b6b3a, 0x6b5b2e]) }], knock: true };
  } },
  plate_ceramic: { label: "Ceramic plate", build() {
    return { mass: 0.45, parts: [bx([0, 0.11, 0], [0.11, 0.11, 0.006], "ceramic")],
      vis: [{ p: "cyl", c: [0, 0.11, 0], s: [0.11, 0.012, 0.11], col: 0xf2eee4, rot: [Math.PI / 2, 0, 0] }],
      brk: { E: 2.5, n: 10, color: 0xf2eee4, e: 0.25 }, knock: true };
  } },
  melon: { label: "Melon", build() {
    return { mass: 3, parts: [{ shape: "ell", c: [0, 0.1, 0], h: [0.11, 0.1, 0.11], material: "melon" }],
      vis: [{ p: "sphere", c: [0, 0.1, 0], s: [0.11, 0.1, 0.11], col: 0x5f9a45 }],
      brk: { E: 10, n: 12, color: 0xd9593a, e: 0.1, big: true }, knock: true };
  } },
  wood_block: { label: "Wood block", build() {
    return { mass: 1, parts: [bx([0, 0.1, 0], [0.05, 0.1, 0.05], "wood")],
      vis: [{ p: "box", c: [0, 0.1, 0], s: [0.1, 0.2, 0.1], col: 0xb58a55 }], knock: true };
  } },
  cinder_block: { label: "Cinder block", build() {
    return { mass: 8, parts: [bx([0, 0.095, 0], [0.195, 0.095, 0.095], "cmu", { hollow: true, t: 0.03 })],
      vis: [{ p: "box", c: [0, 0.095, 0], s: [0.39, 0.19, 0.19], col: 0x9a9a95 }], knock: true };
  } },
  steel_plate: { label: "Steel plate (AR500)", build() {
    return { mass: 5, parts: [bx([0, 0.35, 0], [0.15, 0.15, 0.003], "steel_ar500", { tag: "plate" }), bx([0, 0.1, -0.02], [0.03, 0.1, 0.02], "wood")],
      vis: [{ p: "box", c: [0, 0.35, 0], s: [0.3, 0.3, 0.006], col: 0x6a7077 }, { p: "box", c: [0, 0.1, -0.02], s: [0.06, 0.2, 0.04], col: 0x8a6a42 }] };
  } },
  sandbag: { label: "Sandbag", build() {
    return { mass: 15, parts: [bx([0, 0.07, 0], [0.225, 0.07, 0.125], "sand")],
      vis: [{ p: "box", c: [0, 0.07, 0], s: [0.45, 0.14, 0.25], col: 0xb59a68 }], collapse: { E: 200, mode: "squash" }, spray: true };
  } },
  mannequin: { label: "Mannequin", build() {
    const f = "fibreglass", h = { hollow: true, t: 0.003 };
    return { mass: 12, collapse: { E: 40, mode: "topple" },
      parts: [{ shape: "ell", c: [0, 1.62, 0], h: [0.09, 0.115, 0.1], material: f, hollow: true, t: 0.003 }, bx([0, 1.2, 0], [0.17, 0.27, 0.1], f, h),
        bx([-0.26, 1.15, 0], [0.04, 0.3, 0.04], f, h), bx([0.26, 1.15, 0], [0.04, 0.3, 0.04], f, h),
        bx([-0.08, 0.45, 0], [0.06, 0.45, 0.06], f, h), bx([0.08, 0.45, 0], [0.06, 0.45, 0.06], f, h)],
      vis: [{ p: "sphere", c: [0, 1.62, 0], s: [0.09, 0.115, 0.1], col: 0xe8e0d2 }, { p: "box", c: [0, 1.2, 0], s: [0.34, 0.54, 0.2], col: 0xe8e0d2 },
        { p: "box", c: [-0.26, 1.15, 0], s: [0.08, 0.6, 0.08], col: 0xe8e0d2 }, { p: "box", c: [0.26, 1.15, 0], s: [0.08, 0.6, 0.08], col: 0xe8e0d2 },
        { p: "box", c: [-0.08, 0.45, 0], s: [0.12, 0.9, 0.12], col: 0xe8e0d2 }, { p: "box", c: [0.08, 0.45, 0], s: [0.12, 0.9, 0.12], col: 0xe8e0d2 }] };
  } },
  tv_crt: { label: "CRT television", build() {
    return { mass: 14, screenType: "crt", parts: [
      bx([0, 0.2, 0], [0.225, 0.2, 0.188], "plastic", { hollow: true, t: 0.003, tag: "casing" }),
      bx([0, 0.2, 0.194], [0.17, 0.13, 0.006], "glass", { tag: "screen" })],
      vis: [{ p: "box", c: [0, 0.2, -0.02], s: [0.45, 0.4, 0.35], col: 0x3a3936 }, { p: "box", c: [0, 0.2, 0.17], s: [0.45, 0.4, 0.04], col: 0x2c2b29 }],
      screenQuad: { c: [0, 0.2, 0.1925], size: [0.34, 0.26] }, brkScreen: { E: 3, n: 16, color: 0xb9d6cf } };
  } },
  tv_lcd: { label: "LCD television", build() {
    return { mass: 5, screenType: "lcd", parts: [
      bx([0, 0.17, -0.005], [0.3, 0.17, 0.007], "plastic", { hollow: true, t: 0.003, tag: "casing" }),
      bx([0, 0.17, 0.005], [0.28, 0.155, 0.003], "glass", { tag: "screen" })],
      vis: [{ p: "box", c: [0, 0.17, -0.005], s: [0.6, 0.34, 0.014], col: 0x151515 }],
      screenQuad: { c: [0, 0.17, 0.0085], size: [0.56, 0.31] }, knock: true };
  } },
  pedestal_wood: { label: "Pedestal", build(r, o = {}) {
    const w = o.w || 0.3, h = o.h || 0.9;
    return { mass: 8, structure: { E: 60 }, dims: { w, h },
      parts: [bx([0, h / 2, 0], [w / 2, h / 2, w / 2], "wood", { hollow: true, t: 0.018 })],
      vis: [{ p: "box", c: [0, h / 2, 0], s: [w, h, w], col: o.col || 0xd9d2c2 }] };
  } },
  shelf_wood: { label: "Shelf", build(r, o = {}) {
    const l = o.l || 1.8;
    return { mass: 4, structure: { E: 100 }, dims: { l },
      parts: [bx([0, -0.015, 0], [l / 2, 0.015, 0.125], "wood")],
      vis: [{ p: "box", c: [0, -0.015, 0], s: [l, 0.03, 0.25], col: 0x8a6a42 }] };
  } },
  paper_target: { label: "Paper target", build(r, o = {}) {
    const W = (o.widthCm || 50) / 100, H = (o.heightCm || o.widthCm || 50) / 100;
    return { mass: 0.01, paper: { W, H }, parts: [bx([0, 0, 0], [W / 2, H / 2, 0.0002], "paper", { tag: "paper" })], vis: [] };
  } },
  npc_russian_private: { label: "NPC: Russian private (CONSCRIPT)", build() {
    // Proportions and colours of CONSCRIPT in the game's enemies.js buildMesh() (torso .52x.7x.26 @0.85, head .34 @1.4, 6B47 helmet,
    // legs .21x.55x.21, arms .18x.52x.18, EMR camo medium/dark/skin). Source repo: PhotonBounce/occupantkiller-1 (the game's GLBs are 708-byte placeholders; soldiers are procedural boxes).
    const SK = 0xc8a882;
    return { mass: 75, npc: true, parts: [
      bx([0, 0.85, 0], [0.26, 0.35, 0.13], "flesh", { zone: "torso" }),
      bx([0, 1.4, 0], [0.17, 0.17, 0.17], "skull", { zone: "head", skin: { material: "aramid", t: 0.01, ymin: 1.47 } }),
      bx([-0.14, 0.28, 0], [0.105, 0.275, 0.105], "flesh", { zone: "limbs" }), bx([0.14, 0.28, 0], [0.105, 0.275, 0.105], "flesh", { zone: "limbs" }),
      bx([-0.35, 0.82, 0], [0.09, 0.26, 0.09], "flesh", { zone: "limbs" }), bx([0.35, 0.82, 0], [0.09, 0.26, 0.09], "flesh", { zone: "limbs" })],
      vis: [{ p: "box", c: [0, 0.85, 0], s: [0.52, 0.7, 0.26], col: 0x4a6a3a }, { p: "box", c: [0, 1.4, 0], s: [0.34, 0.34, 0.34], col: SK },
        { p: "box", c: [0, 1.55, 0], s: [0.4, 0.16, 0.4], col: 0x3a3a2a }, { p: "box", c: [0, 1.65, 0], s: [0.34, 0.06, 0.34], col: 0x3a3a2a },
        { p: "box", c: [0, 1.49, 0.2], s: [0.42, 0.04, 0.1], col: 0x3a3a2a },
        { p: "box", c: [-0.14, 0.28, 0], s: [0.21, 0.55, 0.21], col: 0x2a3a1a }, { p: "box", c: [0.14, 0.28, 0], s: [0.21, 0.55, 0.21], col: 0x2a3a1a },
        { p: "box", c: [-0.35, 0.82, 0], s: [0.18, 0.52, 0.18], col: 0x4a6a3a }, { p: "box", c: [0.35, 0.82, 0], s: [0.18, 0.52, 0.18], col: 0x4a6a3a }] };
  } },
};
/** Sound name stem for a type (the coordinator's naming). */
export const SOUND_STEM = { paper_target: "paper", npc_russian_private: "npc" };
export const OBJECT_SOUNDS = (() => {
  const out = [];
  for (const o of ["vase_ceramic", "bottle_glass", "jar_glass", "can_tin", "book", "plate_ceramic", "melon", "wood_block", "cinder_block", "steel_plate", "sandbag", "mannequin", "tv_crt", "tv_lcd", "pedestal_wood", "shelf_wood"])
    for (const v of ["puncture", "fall", "collapse"]) out.push(`${o}_${v}`);
  for (const w of Object.keys(WALLS)) for (const v of ["puncture", "fall", "collapse"]) out.push(`wall_${w}_${v}`);
  for (const m of ["steel", "concrete", "brick"]) out.push(`ricochet_${m}`);
  out.push("paper_puncture", "npc_puncture");
  return out;
})();
/** What exists today in sounds/ai to stand in for each family until the dedicated set is cut. */
export const SOUND_FALLBACK = (name) => {
  if (name.startsWith("ricochet_")) return "ricochet";
  if (/^(paper)_/.test(name)) return "impact_paper";
  if (/(steel_plate|can_tin|tin)_/.test(name) || name.startsWith("ricochet")) return "impact_steel";
  if (/^(wall_wood|book|wood_block|pedestal_wood|shelf_wood|mannequin)/.test(name)) return "impact_wood";
  return "impact_dirt";
};

export const TARGET_TYPES = [{ id: "paper", label: "Paper target (synced with the panel)" }, { id: "npc_russian_private", label: "NPC: Russian private" }];
export const FORMATIONS = ["line", "column", "wedge", "staggered"];
export const ADD_MENU = ["vase_ceramic", "bottle_glass", "jar_glass", "can_tin", "book", "plate_ceramic", "melon", "wood_block", "cinder_block", "steel_plate",
  "sandbag", "mannequin", "tv_crt", "tv_lcd", "npc_russian_private"];

// bounding sphere (local) of a built def
function boundOf(def) {
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of def.parts) {
    let lo, hi;
    if (p.shape === "box" || p.shape === "ell") { lo = sub(p.c, p.h); hi = add(p.c, p.h); }
    else { let R = 0, y0 = 1e9, y1 = -1e9; for (const [r, y] of p.prof) { R = Math.max(R, r); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } lo = [p.c[0] - R, p.c[1] + y0, p.c[2] - R]; hi = [p.c[0] + R, p.c[1] + y1, p.c[2] + R]; }
    for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], lo[i]); mx[i] = Math.max(mx[i], hi[i]); }
  }
  const c = scl(add(mn, mx), 0.5);
  def.bs = { c, r: len(sub(mx, mn)) / 2 + 0.02 };
  def.size = sub(mx, mn); def.lo = mn; def.hi = mx;
  return def;
}

// ====================================================================================================
// RENDER HELPERS
// ====================================================================================================
const HAS_DOM = typeof document !== "undefined";
function canvasTex(w, h, draw, repeat) {
  if (!HAS_DOM) return null;
  const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 1;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function wallTexture(kind) {
  return canvasTex(256, 256, (g, w, h) => {
    if (kind === "brick") {
      g.fillStyle = "#8c8579"; g.fillRect(0, 0, w, h);
      const bh = h / 8, bw = w / 3;
      for (let r = 0; r < 8; r++) for (let c = -1; c < 4; c++) {
        const x = c * bw + (r % 2 ? bw / 2 : 0); const sh = 120 + ((r * 7 + c * 13) % 5) * 12;
        g.fillStyle = `rgb(${sh + 30},${sh * 0.45 | 0},${sh * 0.36 | 0})`; g.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
      }
    } else if (kind === "wood") {
      for (let i = 0; i < 8; i++) { const sh = 150 + (i * 37 % 40); g.fillStyle = `rgb(${sh},${sh * 0.72 | 0},${sh * 0.45 | 0})`; g.fillRect(i * w / 8, 0, w / 8 - 2, h); g.fillStyle = "rgba(60,30,10,.18)"; for (let k = 0; k < 14; k++) g.fillRect(i * w / 8 + ((k * 17) % 28), (k * 53) % h, 1, 30 + (k * 11) % 50); }
    } else if (kind === "concrete") {
      g.fillStyle = "#9b9b97"; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) { const v = 120 + (i * 97 % 70); g.fillStyle = `rgba(${v},${v},${v - 4},.35)`; g.fillRect((i * 73) % w, (i * 191) % h, 2, 2); }
      g.strokeStyle = "rgba(60,60,60,.35)"; g.strokeRect(0, 0, w, h);
    } else { g.fillStyle = "#e4e0d4"; g.fillRect(0, 0, w, h); for (let i = 0; i < 300; i++) { g.fillStyle = "rgba(0,0,0,.025)"; g.fillRect((i * 73) % w, (i * 191) % h, 3, 3); } }
  }, true);
}
let _noiseCanvas = null, _noiseTex = null, _barsTex = null;
function tvTextures() {
  if (!HAS_DOM) return null;
  if (!_noiseTex) {
    _noiseCanvas = document.createElement("canvas"); _noiseCanvas.width = 64; _noiseCanvas.height = 48;
    _noiseTex = new THREE.CanvasTexture(_noiseCanvas); _noiseTex.colorSpace = THREE.SRGBColorSpace;
    _noiseTex.magFilter = THREE.NearestFilter;
    _barsTex = canvasTex(160, 120, (g, w, h) => {
      const cols = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
      cols.forEach((c, i) => { g.fillStyle = c; g.fillRect(i * w / 7, 0, w / 7 + 1, h * 0.7); });
      g.fillStyle = "#111"; g.fillRect(0, h * 0.7, w, h * 0.3); g.fillStyle = "#fff"; g.fillRect(w * 0.15, h * 0.78, w * 0.12, h * 0.14);
    });
    tickNoise();
  }
  return { noise: _noiseTex, bars: _barsTex };
}
function tickNoise() {
  if (!_noiseCanvas) return;
  const g = _noiseCanvas.getContext("2d"), im = g.createImageData(64, 48);
  for (let i = 0; i < im.data.length; i += 4) { const v = (Math.random() * 255) | 0; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0); _noiseTex.needsUpdate = true;
}
function crackTexture(rng) {
  return canvasTex(128, 96, (g, w, h) => {
    g.fillStyle = "#050505"; g.fillRect(0, 0, w, h);
    const cx = w * (0.3 + rng.u() * 0.4), cy = h * (0.3 + rng.u() * 0.4);
    g.strokeStyle = "rgba(210,225,235,.85)"; g.lineWidth = 1;
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2 + rng.u() * 0.3; let x = cx, y = cy; g.beginPath(); g.moveTo(x, y); for (let s = 0; s < 6; s++) { const l = 8 + rng.u() * 14; x += Math.cos(a + rng.n() * 0.25) * l; y += Math.sin(a + rng.n() * 0.25) * l; g.lineTo(x, y); } g.stroke(); }
    g.strokeStyle = "rgba(210,225,235,.5)"; for (let r = 8; r < 50; r += 10) { g.beginPath(); for (let i = 0; i <= 14; i++) { const a = i / 14 * Math.PI * 2; const rr = r * (0.85 + rng.u() * 0.3); i ? g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.stroke(); }
  });
}
function paperTexture(Wcm, Hcm) {
  const px = 4, w = Math.min(1024, Math.round(Wcm * px)), h = Math.round(w * Hcm / Wcm);
  return canvasTex(w, h, (g) => { // same rings as the panel (index.html drawTarget): radius R*i/10*0.96, rings 1-3 black
    g.fillStyle = "#efe9d8"; g.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = w / 2;
    for (let i = 10; i >= 1; i--) { g.beginPath(); g.arc(cx, cy, R * i / 10 * 0.96, 0, Math.PI * 2); g.fillStyle = i <= 3 ? "#1d1d1d" : "#efe9d8"; g.fill(); g.lineWidth = Math.max(1, w / 400); g.strokeStyle = i <= 3 ? "#e9e4d6" : "#2a2a2a"; g.stroke(); }
    g.strokeStyle = "rgba(120,120,120,.5)"; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.moveTo(0, cy); g.lineTo(w, cy); g.stroke();
  });
}

const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v3 = new THREE.Vector3(), _v3b = new THREE.Vector3(), _col = new THREE.Color(), _eu = new THREE.Euler();
const _ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

class Pool {
  constructor(root, geo, mat, cap) {
    this.cap = cap; this.n = 0; this.free = []; this.dirty = false;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap); this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(this.mesh);
  }
  alloc() { if (this.free.length) return this.free.pop(); if (this.n >= this.cap) return -1; const i = this.n++; this.mesh.count = this.n; this.mesh.setMatrixAt(i, _ZERO_M); return i; }
  set(i, m, color) { if (i < 0) return; this.mesh.setMatrixAt(i, m); if (color !== undefined) this.mesh.setColorAt(i, _col.set(color)); this.dirty = true; }
  hide(i) { if (i < 0) return; this.mesh.setMatrixAt(i, _ZERO_M); this.dirty = true; }
  release(i) { this.hide(i); this.free.push(i); }
  clear() { for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, _ZERO_M); this.n = 0; this.free = []; this.mesh.count = 0; this.dirty = true; }
  flush() { if (!this.dirty) return; this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; this.dirty = false; }
}

const QUALITY = {
  low: { debris: 100, decals: 160, sparks: 80, density: 0.35, tiers: 1, maxPed: 36, fragScale: 0.5 },
  medium: { debris: 240, decals: 400, sparks: 160, density: 0.6, tiers: 2, maxPed: 400, fragScale: 0.8 },
  high: { debris: 480, decals: 800, sparks: 320, density: 0.85, tiers: 2, maxPed: 400, fragScale: 1 },
};
const BULLET_EMIN = 0.4;      // J: below this the bullet is spent (a 7.9 g bullet at ~10 m/s)
const MAX_CONTACTS = 24;      // hard cap on contacts per shot
const MAX_FLIGHT_T = 4;       // s of flight after which a shot is abandoned

// ====================================================================================================
// DEBRIS / BODY STEPPING (pure, used live and for the deterministic dry-run that predicts *_fall events)
// ====================================================================================================
function stepPiece(p, dt, ctx) {
  if (p.asleep) return null;
  p.vy -= G * dt; const k = 1 - 0.15 * dt; p.vx *= k; p.vz *= k;
  const oy = p.y;
  p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.age += dt;
  let landed = null;
  if (p.vy < 0) {
    let best = null;
    for (const s of ctx.supports) {
      if (!s.alive) continue;
      if (oy - p.r >= s.y - 1e-3 && p.y - p.r < s.y && p.x > s.x0 - 0.02 && p.x < s.x1 + 0.02 && p.z > s.z0 - 0.02 && p.z < s.z1 + 0.02 && (!best || s.y > best.y)) best = s;
    }
    if (best) landed = { y: best.y, mat: best.mat };
    else if (p.y - p.r < 0) landed = { y: 0, mat: ctx.floorMat };
  }
  let ev = null;
  if (landed) {
    const vimp = -p.vy; p.y = landed.y + p.r;
    if (!p.hitDone && vimp > 0.5) { p.hitDone = true; ev = { t: p.age, v: Math.hypot(p.vx, p.vy, p.vz), vy: vimp, mat: landed.mat, piece: p }; }
    if (vimp > 0.6) { p.vy = vimp * p.e; p.vx *= 0.75; p.vz *= 0.75; p.wx *= 0.6; p.wy *= 0.6; p.wz *= 0.6; }
    else { p.vy = 0; const f = Math.pow(0.03, dt); p.vx *= f; p.vz *= f; p.wx *= f; p.wy *= f; p.wz *= f; p.hitDone = true; }
    p.grounded = true;
    if (Math.hypot(p.vx, p.vy, p.vz) < 0.15) { p.rest += dt; if (p.rest > 0.35) p.asleep = true; } else p.rest = 0;
  } else p.grounded = false;
  const hx = ctx.W / 2 - p.r, hz = ctx.L / 2 - p.r;
  if (p.x < -hx) { p.x = -hx; p.vx = Math.abs(p.vx) * 0.3; } else if (p.x > hx) { p.x = hx; p.vx = -Math.abs(p.vx) * 0.3; }
  if (p.z < -hz) { p.z = -hz; p.vz = Math.abs(p.vz) * 0.3; } else if (p.z > hz) { p.z = hz; p.vz = -Math.abs(p.vz) * 0.3; }
  if (p.y > ctx.H - p.r) { p.y = ctx.H - p.r; p.vy = -Math.abs(p.vy) * 0.2; }
  return ev;
}
/** Deterministic dry run of fresh pieces; returns the landing records and groups them into at most 3 *_fall events per owner. */
function predictFalls(pieces, ctx, t0, bucketCount = 3) {
  const sim = pieces.map((p) => ({ ...p, age: 0, hitDone: false, asleep: false, rest: 0 }));
  const hits = [];
  const dt = 1 / 120;
  for (let i = 0; i < 4 * 120; i++) { let any = false; for (const p of sim) { if (p.asleep) continue; any = true; const e = stepPiece(p, dt, ctx); if (e) hits.push({ ...e, owner: p.owner }); } if (!any) break; }
  const byOwner = new Map();
  for (const h of hits) { const k = h.owner.id; if (!byOwner.has(k)) byOwner.set(k, []); byOwner.get(k).push(h); }
  const out = [];
  for (const [, list] of byOwner) {
    list.sort((a, b) => a.t - b.t);
    const nb = Math.min(bucketCount, list.length);
    for (let b = 0; b < nb; b++) {
      const lo = Math.floor(b * list.length / nb), hi = Math.floor((b + 1) * list.length / nb), grp = list.slice(lo, hi);
      const mass = grp.reduce((s, h) => s + h.piece.m, 0), vmax = Math.max(...grp.map((h) => h.v));
      const tm = grp.reduce((s, h) => s + h.t, 0) / grp.length;
      const first = grp[0];
      out.push({ t: t0 + tm, owner: first.owner, v: vmax, mass, mat: first.mat, pos: [first.piece.x, first.piece.y, first.piece.z] });
    }
  }
  return out;
}

// ====================================================================================================
// THE ROOM
// ====================================================================================================
const WALL_IDS = ["west", "east", "north", "south"]; // x-, x+, z- (target end), z+ (shooter end)

class Room {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = { quality: "medium", size: "medium", wall: "drywall", floor: "concrete", seed: 7, autoPopulate: true, pedestalSpacing: FT, eyeHeight: 1.45, ...opts };
    this.Q = QUALITY[this.opts.quality] || QUALITY.medium;
    this.rng = new Rng(this.opts.seed);
    this.wallName = this.opts.wall; this.floorName = this.opts.floor;
    const sz = typeof this.opts.size === "string" ? SIZES[this.opts.size] : this.opts.size;
    this.W = sz.w; this.L = sz.l; this.H = sz.h; this.sizeName = typeof this.opts.size === "string" ? this.opts.size : "custom";
    this.root = new THREE.Group(); this.root.name = "room"; scene.add(this.root);
    this.shell = new THREE.Group(); this.root.add(this.shell);
    this.objects = []; this.supports = []; this.nextId = 1; this.pools = {};
    this.pieces = []; this.bodies = []; this.pending = []; this.listeners = []; this.anims = [];
    this.simTime = 0; this.timeScale = 1; this.autoSlowmo = !!this.opts.autoSlowmo; this.slowScale = this.opts.slowScale || 0.15; this.slowWindows = [];
    this.shotCount = 0; this.target = null; this.lastResult = null; this.paperHoles = []; this.disposed = false;
    this.shooter = { x: 0, z: this.L / 2 - 1.2 };
    this._ground = {};
    this._initRender(); this._buildShell();
    if (this.opts.autoPopulate) this.populate();
    this.setTarget({ type: "paper", distance: Math.min(this.L - 2.4, 15) });
  }

  // ---------------------------------------------------------------- rendering infrastructure
  /** Cheap Lambert shading on phones (quality "low"), PBR otherwise. */
  _mat(p) { if (this.opts.quality === "low") { const { roughness, metalness, flatShading, ...q } = p; return new THREE.MeshLambertMaterial(q); } return new THREE.MeshStandardMaterial(p); }
  /** Shell surfaces (the large, full-screen ones): unlit with a baked tint on phones, lit otherwise. */
  _shellMat(p, tint) { if (this.opts.quality === "low") { const { roughness, metalness, emissive, ...q } = p; return new THREE.MeshBasicMaterial({ ...q, color: new THREE.Color(q.color).multiplyScalar(tint) }); } return this._mat(p); }
  _initRender() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x777066, 0.95); const sun = new THREE.DirectionalLight(0xfff4e0, 0.7); sun.position.set(2, 6, 3);
    this.root.add(hemi, sun);
    this.matBox = this._mat({ color: 0xffffff, roughness: 0.85, metalness: 0.05 });
    this.matLathe = this._mat({ color: 0xffffff, roughness: 0.35, metalness: 0.05 });
    this.geoBox = new THREE.BoxGeometry(1, 1, 1); this.geoSphere = new THREE.SphereGeometry(1, 14, 10); this.geoCyl = new THREE.CylinderGeometry(1, 1, 1, 18, 1);
    // decals (bullet holes, wound marks): one instanced mesh
    this.decals = new Pool(this.root, new THREE.CircleGeometry(1, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, transparent: true, opacity: 0.95, side: THREE.DoubleSide }), this.Q.decals);
    this.decalRing = 0;
    this.holes = new Pool(this.root, new THREE.CircleGeometry(1, 14), new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide }), 600);
    // debris: flat shards
    const g = new THREE.BufferGeometry();
    const v = new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0.5, 1, -1, 0, -1, 0, 0.5, 1, 0, -0.6, 0, 1, 0, -1, 0, -0.6, 0, 0, 0.5, 1, -1, 0, -1, 0, -0.6, 0, 1, 0, -1, 0, 0.5, 1, 0, -0.6, 0]);
    g.setAttribute("position", new THREE.BufferAttribute(v, 3)); g.computeVertexNormals();
    this.debris = new Pool(this.root, g, this._mat({ color: 0xffffff, roughness: 0.5, metalness: 0.1, flatShading: true, side: THREE.DoubleSide }), this.Q.debris);
    this.debrisRing = 0;
    // sparks
    const cap = this.Q.sparks; this.spark = { cap, i: 0, pos: new Float32Array(cap * 3), vel: new Float32Array(cap * 3), life: new Float32Array(cap) };
    this.spark.pos.fill(-999);
    const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(this.spark.pos, 3));
    this.sparkPts = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffb040, size: 0.035, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.sparkPts.frustumCulled = false; this.root.add(this.sparkPts);
    // tracer
    this.tracer = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd070 })); this.tracer.visible = false; this.root.add(this.tracer);
    this.trails = [];
    this._noiseAcc = 0;
  }
  _pool(key) {
    if (this.pools[key]) return this.pools[key];
    let geo, mat = this.matLathe;
    if (key === "box") { geo = this.geoBox; mat = this.matBox; } else if (key === "sphere") { geo = this.geoSphere; mat = this.matBox; } else if (key === "cyl") { geo = this.geoCyl; mat = this.matBox; }
    else if (key.startsWith("lathe:")) geo = new THREE.LatheGeometry(LATHES[key.slice(6)].map(([r, y]) => new THREE.Vector2(r, y)), 20);
    return (this.pools[key] = new Pool(this.root, geo, mat, key === "box" ? 2400 : 400));
  }
  _buildShell() {
    for (const c of [...this.shell.children]) { this.shell.remove(c); c.geometry?.dispose(); if (c.material?.map) c.material.map.dispose(); c.material?.dispose(); }
    const W = this.W, L = this.L, H = this.H, wk = this.wallName;
    const tex = (kind, rx, ry) => { const t = wallTexture(kind); if (t) t.repeat.set(rx, ry); return t; };
    const kind = wk === "brick" ? "brick" : wk === "wood" ? "wood" : wk === "concrete" ? "concrete" : "plain";
    const mk = (w, h, tx) => this._shellMat({ color: 0xffffff, map: tex(kind, w / 2, h / 2), roughness: 0.95, side: THREE.FrontSide }, 0.82);
    const plane = (w, h, pos, rotY_, mat) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(...pos); m.rotation.y = rotY_; this.shell.add(m); return m; };
    plane(L, H, [-W / 2, H / 2, 0], Math.PI / 2, mk(L, H));        // west, facing +x
    plane(L, H, [W / 2, H / 2, 0], -Math.PI / 2, mk(L, H));        // east
    plane(W, H, [0, H / 2, -L / 2], 0, mk(W, H));                  // north, facing +z
    plane(W, H, [0, H / 2, L / 2], Math.PI, mk(W, H));             // south
    const fk = this.floorName === "wood" ? "wood" : "concrete";
    const fl = this._shellMat({ color: 0xffffff, map: tex(fk, W / 2, L / 2), roughness: 0.9 }, 0.62);
    const floor = plane(W, L, [0, 0, 0], 0, fl); floor.rotation.x = -Math.PI / 2;
    const ceil = plane(W, L, [0, H, 0], 0, this._shellMat({ color: 0xdcd8cc, emissive: 0x6b6860, roughness: 1 }, 0.6)); ceil.rotation.x = Math.PI / 2;
  }

  // ---------------------------------------------------------------- configuration
  get catalog() {
    return { sizes: Object.entries(SIZES).map(([id, s]) => ({ id, label: s.label })).concat([{ id: "custom", label: "Custom..." }]),
      walls: Object.entries(WALLS).map(([id, w]) => ({ id, label: w.label })), floors: Object.entries(FLOORS).map(([id, w]) => ({ id, label: w.label })),
      addMenu: ADD_MENU.map((id) => ({ id, label: OBJECT_TYPES[id].label })), targets: TARGET_TYPES, formations: FORMATIONS, bullets: Object.values(BULLETS).map((b) => ({ id: b.id, label: b.name })), sounds: OBJECT_SOUNDS };
  }
  /** size: "small"|"medium"|"large" or {w,l,h} metres (w 3-30, l 4-60, h 2.4-8). Rebuilds the shell and re-populates. */
  setSize(size) {
    const s = typeof size === "string" ? SIZES[size] : size; if (!s) throw new Error("unknown size");
    this.sizeName = typeof size === "string" ? size : "custom";
    this.W = clamp(s.w ?? this.W, 3, 30); this.L = clamp(s.l ?? this.L, 4, 60); this.H = clamp(s.h ?? this.H, 2.4, 8);
    this._buildShell(); this.shooter.z = this.L / 2 - 1.2;
    this.populate();
    const d = this.target?.distance ?? 15; this.setTarget({ type: this.target?.type || "paper", distance: Math.min(d, this.L - 2.4), platoon: this.target?.platoon, widthCm: this.target?.widthCm, _noExtend: true });
    return { w: this.W, l: this.L, h: this.H };
  }
  setWall(name) { if (!WALLS[name]) throw new Error("unknown wall " + name); this.wallName = name; this._buildShell(); }
  setFloor(name) { if (!FLOORS[name]) throw new Error("unknown floor " + name); this.floorName = name; this._buildShell(); }
  setTimeScale(s) { this.timeScale = clamp(s, 1e-4, 4); }
  on(fn) { this.listeners.push(fn); return () => this.off(fn); }
  off(fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  get muzzle() { return [this.shooter.x, this.opts.eyeHeight - (this._sightH ?? 0.048), this.shooter.z]; }
  setShooter({ x = 0, z, eyeHeight } = {}) { this.shooter.x = x; if (z !== undefined) this.shooter.z = z; if (eyeHeight) this.opts.eyeHeight = eyeHeight; this.setTarget({ ...this.target, distance: this.target.distance, _noExtend: true }); }

  // ---------------------------------------------------------------- objects
  clearObjects() {
    for (const o of this.objects) this._dispose(o);
    this.objects = []; this.supports = []; this.paperHoles = [];
    for (const p of this.bodies) p.dead = true; this.bodies = [];
    this.pieces = []; this.debrisRing = 0; this.debris.clear(); this.decals.clear(); this.holes.clear(); this.decalRing = 0;
    this.pending = []; this.anims = [];
  }
  _dispose(o) {
    for (const v of o.vis) v.pool.release(v.idx);
    if (o.group) { this.root.remove(o.group); o.group.traverse((c) => { c.geometry?.dispose(); if (c.material) { c.material.map && c.material.map !== _noiseTex && c.material.map !== _barsTex && c.material.map.dispose(); c.material.dispose(); } }); }
  }
  removeObject(id) {
    const i = this.objects.findIndex((o) => o.id === id); if (i < 0) return false;
    const o = this.objects[i]; this._dispose(o); this.objects.splice(i, 1);
    for (const s of this.supports) if (s.owner === id) { s.alive = false; this._release(s); }
    return true;
  }
  _spawn(type, pos, yaw = 0, o = {}) {
    const spec = OBJECT_TYPES[type]; if (!spec) throw new Error("unknown object type " + type);
    const def = boundOf(spec.build(this.rng, o));
    const obj = { id: this.nextId++, type, def, pos: [...pos], yaw, alive: true, parts: def.parts.map((p) => ({ ...p, alive: true })), mass: def.mass, absorbed: 0,
      supportId: o.supportId ?? -1, vis: [], group: null, tilt: null, fy: 1, piece: null, isTarget: !!o.isTarget, hits: 0, dead: false };
    for (const v of def.vis) {
      const pool = this._pool(v.p), idx = pool.alloc(); _eu.set(...(v.rot || [0, 0, 0])); _q.setFromEuler(_eu);
      const local = new THREE.Matrix4().compose(new THREE.Vector3(...v.c), _q.clone(), new THREE.Vector3(...v.s));
      obj.vis.push({ pool, idx, local, col: v.col });
    }
    if (def.screenQuad || def.paper) {
      obj.group = new THREE.Group(); obj.group.matrixAutoUpdate = false; this.root.add(obj.group);
      if (def.screenQuad) {
        const tx = tvTextures(), mat = new THREE.MeshBasicMaterial({ color: tx ? 0xffffff : 0x445566, map: tx ? (this.rng.u() < 0.5 ? tx.noise : tx.bars) : null });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(...def.screenQuad.size), mat); m.position.set(...def.screenQuad.c); obj.group.add(m); obj.screen = m;
      }
      if (def.paper) {
        const t = paperTexture(def.paper.W * 100, def.paper.H * 100);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(def.paper.W, def.paper.H), new THREE.MeshBasicMaterial({ color: t ? 0xffffff : 0xefe9d8, map: t, side: THREE.DoubleSide })); m.position.z = 0.0001; obj.group.add(m);
        const hh = pos[1] + def.paper.H / 2, post = (x) => { const p = new THREE.Mesh(this.geoBox, this._mat({ color: 0x8a6a42 })); p.scale.set(0.03, hh, 0.03); p.position.set(x, def.paper.H / 2 - hh / 2, -0.03); obj.group.add(p); };
        post(-def.paper.W / 2 - 0.02); post(def.paper.W / 2 + 0.02);
      }
    }
    this._sync(obj);
    this.objects.push(obj);
    if (def.structure) {
      const w = def.dims.w, l = def.dims.l;
      const sup = { id: this.supports.length, owner: obj.id, y: pos[1] + (def.dims.h || 0), alive: true, mat: "wood", x0: 0, x1: 0, z0: 0, z1: 0 };
      const hx = (l ? l / 2 : w / 2), hz = l ? 0.125 : w / 2, sw = Math.abs(Math.sin(yaw)) > 0.7;
      const ax = sw ? hz : hx, az = sw ? hx : hz;
      sup.x0 = pos[0] - ax; sup.x1 = pos[0] + ax; sup.z0 = pos[2] - az; sup.z1 = pos[2] + az; sup.y = pos[1] + (l ? 0 : def.dims.h);
      this.supports.push(sup); obj.supportRef = sup;
    }
    return obj;
  }
  /** Public: add an object. where: {x,z,on:'floor'|'pedestal'|'shelf'|'wall', y, yaw}. Returns the object (id, type, pos) or null. */
  addObject(type, where = {}) {
    const spec = OBJECT_TYPES[type]; if (!spec) throw new Error("unknown object type " + type);
    const hw = this.W / 2 - 1.0, rn = this.rng;
    const yawToShooter = 0; // fronts face +z (the shooter) by default
    let x = where.x, z = where.z, on = where.on;
    if (x === undefined) x = rn.range(-hw, hw); if (z === undefined) z = clamp(this.shooter.z - (this.target?.distance ?? 10) * rn.range(0.3, 0.9), -this.L / 2 + 1.5, this.shooter.z - 2);
    const small = ["vase_ceramic", "bottle_glass", "jar_glass", "can_tin", "book", "plate_ceramic", "melon", "wood_block", "steel_plate"].includes(type);
    if (!on) on = type === "tv_lcd" ? "wall" : small || type === "tv_crt" ? "pedestal" : "floor";
    if (on === "pedestal") {
      const tv = type === "tv_crt", ped = this._spawn("pedestal_wood", [x, 0, z], 0, tv ? { w: 0.6, h: 0.5 } : {});
      const o = this._spawn(type, [x, ped.supportRef.y, z], where.yaw ?? yawToShooter, { supportId: ped.supportRef.id }); o.ped = ped.id; return o;
    }
    if (on === "wall") { // wall-mounted flat screen on the nearest wall
      const wx = x < 0 ? -this.W / 2 + 0.03 : this.W / 2 - 0.03, yaw = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      return this._spawn(type, [wx, where.y ?? 1.5, z], yaw, {});
    }
    return this._spawn(type, [x, where.y ?? 0, z], where.yaw ?? yawToShooter, {});
  }
  /** Fills the room: pedestals + vases every 3 ft along the walls, two tiers of shelves, a CRT on a stand, an LCD on a shelf. */
  populate() {
    this.clearObjects();
    const rn = this.rng, W = this.W, L = this.L, H = this.H, step = this.opts.pedestalSpacing, ins = 0.6;
    const slots = [];
    for (let x = -W / 2 + 0.9; x <= W / 2 - 0.9 + 1e-6; x += step) { slots.push({ x, z: -L / 2 + ins, wall: "north" }); slots.push({ x, z: L / 2 - ins, wall: "south" }); }
    for (let z = -L / 2 + 0.9 + step; z <= L / 2 - 0.9 - step + 1e-6; z += step) { slots.push({ x: -W / 2 + ins, z, wall: "west" }); slots.push({ x: W / 2 - ins, z, wall: "east" }); }
    const crt = { x: -W / 2 + 0.75, z: -L * 0.12 };
    const ok = slots.filter((s) => !(s.wall === "north" && Math.abs(s.x) < 1.3) && Math.hypot(s.x - crt.x, s.z - crt.z) > 0.9 && !(s.wall === "south" && Math.abs(s.x - this.shooter.x) < 0.6 && false));
    for (const s of ok.slice(0, this.Q.maxPed)) {
      const ped = this._spawn("pedestal_wood", [s.x, 0, s.z], 0);
      this._spawn("vase_ceramic", [s.x, ped.supportRef.y, s.z], 0, { supportId: ped.supportRef.id });
    }
    // shelves: planks along the wall, 1.8 m with a 0.1 m gap
    const tiers = [1.3, 1.9].slice(0, H >= 3 ? this.Q.tiers : 1), mix = ["bottle_glass", "bottle_glass", "bottle_glass", "jar_glass", "jar_glass", "can_tin", "can_tin", "book", "book", "book", "plate_ceramic", "wood_block", "steel_plate"];
    let lcdPlaced = false;
    const walls = [{ name: "north", len: W, at: (u) => [u, 0, -L / 2 + 0.125], yaw: 0 }, { name: "south", len: W, at: (u) => [u, 0, L / 2 - 0.125], yaw: Math.PI },
      { name: "west", len: L, at: (u) => [-W / 2 + 0.125, 0, u], yaw: Math.PI / 2 }, { name: "east", len: L, at: (u) => [W / 2 - 0.125, 0, u], yaw: -Math.PI / 2 }];
    for (const w of walls) {
      let melon = true;
      for (let u0 = -w.len / 2 + 0.6; u0 + 1.8 <= w.len / 2 - 0.5; u0 += 1.9) {
        const uc = u0 + 0.9; if (w.name === "north" && Math.abs(uc) < 2.3) continue;
        for (const ty of tiers) {
          const p = w.at(uc); p[1] = ty;
          const shelf = this._spawn("shelf_wood", p, w.yaw, { l: 1.8 });
          for (let k = 0; k < 6; k++) {
            if (rn.u() > this.Q.density) continue;
            const lx = -0.75 + k * 0.3, wp = add(p, rotY([lx, 0, 0], w.yaw));
            let t = rn.pick(mix); if (melon && rn.u() < 0.12) { t = "melon"; melon = false; }
            if (!lcdPlaced && w.name === "east" && ty === tiers[0] && k === 2) { this._spawn("tv_lcd", wp, w.yaw, { supportId: shelf.supportRef.id }); lcdPlaced = true; k++; continue; }
            if (t === "melon" && ty !== tiers[0]) t = "book";
            this._spawn(t, [wp[0], p[1], wp[2]], w.yaw, { supportId: shelf.supportRef.id });
          }
        }
      }
    }
    const stand = this._spawn("pedestal_wood", [crt.x, 0, crt.z], Math.PI / 2, { w: 0.6, h: 0.5 });
    this._spawn("tv_crt", [crt.x, stand.supportRef.y, crt.z], Math.PI / 2, { supportId: stand.supportRef.id });
    for (const o of this.objects) this._sync(o);
    this._flush();
  }

  // ---------------------------------------------------------------- targets
  /** type 'paper' | 'npc_russian_private'; distance in m from the firing line; widthCm = the panel's paper width; platoon {n, formation}. */
  setTarget({ type = "paper", distance = 15, widthCm = 50, heightCm, platoon, _noExtend } = {}) {
    if (this.target) { for (const o of this.objects.filter((o) => o.isTarget)) this.removeObject(o.id); }
    let d = distance, clamped = false;
    if (d > this.L - 2.4) {
      if (!_noExtend && this.L < 60 && this.opts.autoExtend !== false) { this.L = clamp(d + 2.4, 4, 60); this._buildShell(); this.shooter.z = this.L / 2 - 1.2; this.populate(); }
      if (d > this.L - 2.4) { d = this.L - 2.4; clamped = true; }
    }
    const zt = this.shooter.z - d, cy = this.opts.eyeHeight, cx = this.shooter.x;
    this.target = { type, distance: d, requested: distance, clamped, widthCm, heightCm: heightCm || widthCm, platoon, center: [cx, cy, zt], objs: [] };
    if (type === "paper") {
      const o = this._spawn("paper_target", [cx, cy, zt], 0, { widthCm, heightCm: heightCm || widthCm, isTarget: true }); this.target.objs.push(o); this.target.paper = o;
    } else {
      const n = platoon?.n ? clamp(platoon.n | 0, 1, 40) : 1, form = platoon?.formation || "line", sp = platoon?.spacing || 1.3;
      for (let i = 0; i < n; i++) {
        let dx = 0, dz = 0;
        if (n > 1) {
          if (form === "line") dx = (i - (n - 1) / 2) * sp;
          else if (form === "column") dz = -i * 1.6;
          else if (form === "wedge") { const r = Math.floor((1 + Math.sqrt(1 + 8 * i)) / 2) - 1, c = i - r * (r + 1) / 2; dx = (c - r / 2) * sp; dz = -r * 1.5; }
          else { dx = (i - (n - 1) / 2) * sp * 0.75; dz = (i % 2) * -1.2; }
        }
        const x = clamp(cx + dx, -this.W / 2 + 0.6, this.W / 2 - 0.6), z = clamp(zt + dz, -this.L / 2 + 0.6, this.shooter.z - 1);
        const o = this._spawn("npc_russian_private", [x, 0, z], 0, { isTarget: true }); this.target.objs.push(o);
      }
    }
    this._flush();
    return { distance: d, clamped, center: xyz(this.target.center), count: this.target.objs.length };
  }
  panelToWorld(xcm, ycm) { const c = this.target.center; return [c[0] + xcm / 100, c[1] + ycm / 100, c[2]]; }
  worldToPanel(p) { const c = this.target.center; return { x_cm: (p[0] - c[0]) * 100, y_cm: (p[1] - c[1]) * 100 }; }
  clearHoles() { this.holes.clear(); this.paperHoles = []; }

  // ---------------------------------------------------------------- transforms
  _sync(o) {
    if (o.piece) { const p = o.piece; _v3.set(p.x, p.y, p.z); _m4.compose(_v3, p.q, new THREE.Vector3(1, 1, 1)); _m4b.makeTranslation(0, -p.r, 0); _m4.multiply(_m4b); }
    else {
      _q.setFromAxisAngle(_v3b.set(0, 1, 0), o.yaw); if (o.tilt) _q.premultiply(o.tilt);
      _m4.compose(_v3.set(...o.pos), _q, _v3b.set(1, o.fy, 1));
    }
    for (const v of o.vis) { _m4b.multiplyMatrices(_m4, v.local); v.pool.set(v.idx, _m4b, v.col); }
    if (o.group) { o.group.matrix.copy(_m4); o.group.matrixWorldNeedsUpdate = true; o.group.updateMatrixWorld(true); }
  }
  _flush() { for (const k in this.pools) this.pools[k].flush(); this.decals.flush(); this.holes.flush(); this.debris.flush(); }
  objCenter(o) { return add(o.pos, rotY(o.def.bs.c, o.yaw)); }

  // ---------------------------------------------------------------- scheduling / events
  _at(t, fn) { // keep sorted by t (stable)
    const a = this.pending; let i = a.length; while (i > 0 && a[i - 1].t > t) i--; a.splice(i, 0, { t, fn });
  }
  _emitLive(e) { for (const f of this.listeners) { try { f(e); } catch (err) { console.error(err); } } if (this.opts.onEvent) this.opts.onEvent(e); }
  _scaleNow() {
    if (this.autoSlowmo) for (const w of this.slowWindows) if (this.simTime >= w.t0 && this.simTime <= w.t1) return w.scale;
    return this.timeScale;
  }
  _ctx() { return { W: this.W, L: this.L, H: this.H, supports: this.supports, floorMat: FLOORS[this.floorName].material }; }

  // ---------------------------------------------------------------- shot
  /**
   * shot: {origin:{x,y,z}|[x,y,z] (muzzle; default room.muzzle), dir (unit; default -z), velocity (m/s; default the bullet's mv), bulletMass (kg), caliber (m or mm),
   *        bulletType:'AK'|'MAK', drag?:{model,bc}, panelImpact?:{x_cm,y_cm} (the panel's hole: steers the shot through it)}
   * returns {t0, events[], segments[], end, contacts, paper, slowmo[], bullet, solve}
   */
  fireShot(shot = {}) {
    const bullet = resolveBullet(shot); this._sightH = bullet.sightH ?? 0.048;
    const v3 = (a) => Array.isArray(a) ? [a[0], a[1], a[2]] : [a.x, a.y, a.z];
    const speed = shot.velocity ?? bullet.mv;
    const origin = shot.origin ? v3(shot.origin) : this.muzzle;
    let dir = norm(shot.dir ? v3(shot.dir) : [0, 0, -1]), solve = null;
    const paperObj = this.target?.paper;
    if (shot.panelImpact && paperObj) {
      const px = shot.panelImpact.x_cm ?? shot.panelImpact.x, py = shot.panelImpact.y_cm ?? shot.panelImpact.y;
      const tp = this.panelToWorld(px, py);
      solve = this._solveAim(bullet, origin, speed, dir, tp); if (solve.ok) dir = solve.dir;
    }
    const t0 = this.simTime, events = [];
    const ctx = { t0, events, bullet, shotNo: ++this.shotCount, paper: null, npc: [] };
    const run = this._run(bullet, origin, scl(dir, speed), ctx);
    // fall events predicted by the deterministic dry run were pushed to ctx.events during the run; order everything
    events.sort((a, b) => a.t - b.t);
    for (const e of events) this._at(e.tAbs, () => this._emitLive(e));
    // slow-motion hint: from the shot to 0.3 s after the last dramatic contact
    const dramatic = events.filter((e) => e.kind === "shatter" || e.kind === "ricochet" || (e.kind === "collapse"));
    this.slowWindows = this.slowWindows.filter((w) => w.t1 > this.simTime);
    const slowmo = dramatic.length ? [{ t0: 0, t1: dramatic[dramatic.length - 1].t + 0.3, scale: this.slowScale }] : [];
    for (const w of slowmo) this.slowWindows.push({ t0: t0 + w.t0, t1: t0 + w.t1, scale: w.scale });
    // trail line
    this._addTrail(run.segments, t0);
    const result = { t0, shot: ctx.shotNo, bullet: { id: bullet.id, mass: bullet.mass, caliber: bullet.caliber, model: bullet.model, bc: bullet.bc, mv: speed }, dir: xyz(dir),
      events, segments: run.segments, end: run.end, contacts: run.contacts, paper: ctx.paper, npc: ctx.npc, slowmo, solve };
    this.lastResult = result; this._resultStart = t0;
    return result;
  }
  /** Position/speed of the bullet at t seconds after the shot (for the page's own tracer animation). */
  static bulletAt(result, t) {
    for (const s of result.segments) {
      if (t < s.t0 || t > s.t1) continue;
      const P = s.pts; for (let i = 0; i + 1 < P.length; i++) if (t <= P[i + 1][3] || i + 2 === P.length) { const a = P[i], b = P[i + 1], u = b[3] > a[3] ? clamp((t - a[3]) / (b[3] - a[3]), 0, 1) : 0; return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, z: a[2] + (b[2] - a[2]) * u, speed: s.v0 + (s.v1 - s.v0) * clamp((t - s.t0) / Math.max(1e-9, s.t1 - s.t0), 0, 1), kind: s.kind }; }
    }
    return null;
  }
  bulletAt(result, t) { return Room.bulletAt(result, t); }

  _plainCross(bullet, o, v, zt) {
    let p = o.slice(), vv = v.slice(), t = 0; const m = bullet.mass;
    for (let i = 0; i < 60000; i++) {
      const s = len(vv), dt = dtFor(s), dec = RHO_AIR * s * s * cdOf(bullet.table, s / A0) * Math.PI / (8 * bullet.bcSI);
      const nv = [vv[0] - dec * (vv[0] / s) * dt, vv[1] - (dec * (vv[1] / s) + G) * dt, vv[2] - dec * (vv[2] / s) * dt];
      const np = [p[0] + nv[0] * dt, p[1] + nv[1] * dt, p[2] + nv[2] * dt];
      if ((p[2] - zt) * (np[2] - zt) <= 0 && p[2] !== np[2]) { const u = (zt - p[2]) / (np[2] - p[2]); return [p[0] + (np[0] - p[0]) * u, p[1] + (np[1] - p[1]) * u]; }
      p = np; vv = nv; t += dt; if (p[1] < -1 || t > 6 || nv[2] > 0) return null;
    }
    return null;
  }
  /** Newton iteration on (azimuth, elevation) so the bullet's flight crosses the paper plane exactly at `tp` (the panel's hole). */
  _solveAim(bullet, origin, speed, d0, tp) {
    const zt = tp[2] + 0.0002; // front face of the paper
    const right = norm(cross(d0, [0, 1, 0])), up = cross(right, d0);
    const mk = (a, b) => norm(add(d0, add(scl(right, a), scl(up, b))));
    let a = 0, b = 0, err = Infinity;
    for (let it = 0; it < 14; it++) {
      const c = this._plainCross(bullet, origin, scl(mk(a, b), speed), zt); if (!c) return { ok: false };
      const r = [tp[0] - c[0], tp[1] - c[1]]; err = Math.hypot(r[0], r[1]); if (err < 1e-5) break;
      const e = 2e-4, c1 = this._plainCross(bullet, origin, scl(mk(a + e, b), speed), zt), c2 = this._plainCross(bullet, origin, scl(mk(a, b + e), speed), zt);
      if (!c1 || !c2) return { ok: false };
      const j00 = (c1[0] - c[0]) / e, j10 = (c1[1] - c[1]) / e, j01 = (c2[0] - c[0]) / e, j11 = (c2[1] - c[1]) / e, det = j00 * j11 - j01 * j10;
      if (Math.abs(det) < 1e-9) return { ok: false };
      a += (j11 * r[0] - j01 * r[1]) / det; b += (-j10 * r[0] + j00 * r[1]) / det;
    }
    return { ok: err < 1e-4, dir: mk(a, b), residual_m: err };
  }

  _run(bullet, p0, v0, ctx) {
    const m = bullet.mass, rng = this.rng, W = this.W, L = this.L, H = this.H, events = ctx.events, segs = [];
    let p = p0.slice(), v = v0.slice(), t = 0, contacts = 0, reason = "timeout";
    let pts = [[p[0], p[1], p[2], 0]], segT0 = 0, segV0 = len(v), ignore = null, endPos = p, stepCounter = 0;
    const closeSeg = (tEnd, vEnd) => { segs.push({ kind: "flight", t0: segT0, t1: tEnd, v0: segV0, v1: vEnd, pts }); };
    const startSeg = (pos, tt, vv) => { pts = [[pos[0], pos[1], pos[2], tt]]; segT0 = tt; segV0 = vv; };
    const wallSound = (wallId) => wallId === "floor" ? FLOORS[this.floorName].material : this.wallName;
    const ricoOf = (mat) => (mat === "steel" || mat === "steel_ar500") ? "ricochet_steel" : (mat === "concrete" || mat === "cmu") ? "ricochet_concrete" : mat === "brick" ? "ricochet_brick" : null;
    const stemOf = (type) => type.startsWith("wall:") ? "wall_" + type.slice(5) : (SOUND_STEM[type] || type);
    const sound = (type, kind, mat) => {
      if (kind === "ricochet") { const r = ricoOf(mat); if (r) return r; return stemOf(type) + "_puncture"; }
      return stemOf(type) + "_" + (kind === "penetrate" || kind === "embed" ? "puncture" : kind === "shatter" || kind === "collapse" ? "collapse" : "fall");
    };
    this._sound = sound;

    outer: while (true) {
      const sp = len(v);
      if (0.5 * m * sp * sp < BULLET_EMIN) { reason = "spent"; break; }
      if (t > MAX_FLIGHT_T) { reason = "timeout"; break; }
      // ---- integrate a chunk of steps (same scheme as sim.js EXT.path: update v, then advance with the new v)
      const P = [p], V = [v], T = [t]; let cp = p, cv = v, ct = t;
      for (let i = 0; i < 16; i++) {
        const s = len(cv), dt = dtFor(s), dec = RHO_AIR * s * s * cdOf(bullet.table, s / A0) * Math.PI / (8 * bullet.bcSI);
        const nv = [cv[0] - dec * (cv[0] / s) * dt, cv[1] - (dec * (cv[1] / s) + G) * dt, cv[2] - dec * (cv[2] / s) * dt];
        const np = [cp[0] + nv[0] * dt, cp[1] + nv[1] * dt, cp[2] + nv[2] * dt];
        P.push(np); V.push(nv); T.push(ct + dt); cp = np; cv = nv; ct += dt;
        if (0.5 * m * len(nv) ** 2 < BULLET_EMIN) break;
      }
      const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
      for (const q of P) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); }
      const cand = [];
      for (const o of this.objects) {
        if (!o.alive) continue; const c = this.objCenter(o), r = o.def.bs.r;
        if (c[0] + r < mn[0] || c[0] - r > mx[0] || c[1] + r < mn[1] || c[1] - r > mx[1] || c[2] + r < mn[2] || c[2] - r > mx[2]) continue;
        cand.push(o);
      }
      // ---- find the earliest hit in this chunk
      let best = null;
      for (let i = 0; i + 1 < P.length && !best; i++) {
        const A = P[i], B = P[i + 1], d = sub(B, A), dl = len(d);
        const tryPlane = (axis, level, inward, id) => { const da = d[axis]; if (inward[axis] < 0 ? !(A[axis] <= level && B[axis] > level) : !(A[axis] >= level && B[axis] < level)) return; const s = (level - A[axis]) / da; if (!best || s < best.s) best = { kind: "plane", s, wallId: id, n0: inward }; };
        tryPlane(0, -W / 2, [1, 0, 0], "west"); tryPlane(0, W / 2, [-1, 0, 0], "east"); tryPlane(2, -L / 2, [0, 0, 1], "north"); tryPlane(2, L / 2, [0, 0, -1], "south");
        tryPlane(1, 0, [0, 1, 0], "floor"); tryPlane(1, H, [0, -1, 0], "ceiling");
        for (const o of cand) {
          const lo = rotY(sub(A, o.pos), -o.yaw), ld = rotY(d, -o.yaw);
          for (const part of o.parts) {
            if (!part.alive) continue;
            const r = rayPart(part, lo, ld); if (!r || r.t0 > 1 || r.t1 < 0) continue;
            const s = Math.max(r.t0, 0);
            if (ignore && ignore.part === part && (stepCounter - ignore.step) < 3 && s * dl < 0.01) continue;
            if (best && s >= best.s) continue;
            best = { kind: "part", s, obj: o, part, n0: rotY(r.n0, o.yaw), n1: rotY(r.n1, o.yaw), chord: Math.max((r.t1 - Math.max(r.t0, 0)) * dl, 1e-4), exit: add(A, scl(d, r.t1)) };
          }
        }
        if (best) { best.i = i; best.A = A; best.d = d; }
      }
      stepCounter++;
      if (!best) { // free flight through the chunk
        for (let i = 1; i < P.length; i++) if ((i & 3) === 0 || i === P.length - 1) pts.push([P[i][0], P[i][1], P[i][2], T[i]]);
        p = P[P.length - 1]; v = V[V.length - 1]; t = T[T.length - 1]; continue;
      }
      // ---- a contact
      const i = best.i, hitPos = add(best.A, scl(best.d, best.s)), tHit = T[i] + (T[i + 1] - T[i]) * best.s;
      const vvec = [V[i][0] + (V[i + 1][0] - V[i][0]) * best.s, V[i][1] + (V[i + 1][1] - V[i][1]) * best.s, V[i][2] + (V[i + 1][2] - V[i][2]) * best.s];
      for (let k = 1; k <= i; k++) if ((k & 3) === 0) pts.push([P[k][0], P[k][1], P[k][2], T[k]]);
      pts.push([hitPos[0], hitPos[1], hitPos[2], tHit]); closeSeg(tHit, len(vvec));
      contacts++;
      const vv = len(vvec), vh = scl(vvec, 1 / vv), n = best.n0, Ek = 0.5 * m * vv * vv;
      const cosn = clamp(-dot(vh, n), 0.02, 1), gr = Math.asin(cosn) / D2R, thetaN = Math.acos(cosn) / D2R;
      let matName, objType, obj = null, part = null, wallId = null, mass, objId = 0, zone = null;
      if (best.kind === "plane") { wallId = best.wallId; const fl = wallId === "floor"; matName = fl ? FLOORS[this.floorName].material : WALLS[this.wallName].material; objType = "wall:" + wallSound(wallId); const cfg = fl ? FLOORS[this.floorName] : WALLS[this.wallName]; mass = cfg.thickness * MATERIALS[matName].rho; }
      else { obj = best.obj; part = best.part; matName = part.material; objType = obj.type; mass = obj.mass; objId = obj.id; zone = part.zone || null; }
      const dupe = (kind) => (kind === "penetrate" || kind === "embed") && obj && events.some((e) => e.objectId === objId && (e.kind === "penetrate" || e.kind === "embed") && tHit - e.t < 0.003);
      const mkEv = (kind, extra) => ({ t: tHit, tAbs: ctx.t0 + tHit, pos: xyz(hitPos), normal: xyz(n), material: matName, kind, object: obj ? obj.type : "wall", objectId: objId, wall: wallId, zone,
        sound: dupe(kind) ? null : sound(objType, kind, matName), merged: dupe(kind) || undefined, mass, bulletMass: m, vIn: vv, angleDeg: gr, ...extra });
      // ---- ricochet?
      const gc = criticalAngle(matName, bullet);
      if (gc > 0 && gr < gc * (1 + 0.12 * clamp(rng.n(), -1.5, 1.5))) {
        const r = clamp(0.85 - 0.6 * Math.pow(gr / gc, 1.5), 0.15, 0.9), vOut = vv * r;
        const tdir = norm(sub(vh, scl(n, dot(vh, n)))), gout = Math.max(0.6 * D2R, gr * D2R * (0.55 + 0.2 * rng.u()) + rng.n() * 1.0 * D2R);
        let out = norm(add(scl(tdir, Math.cos(gout)), scl(n, Math.sin(gout))));
        const az = rng.n() * 2.5 * D2R * (1 + gr / gc), ca = Math.cos(az), sa = Math.sin(az), kx = cross(n, out); // Rodrigues about n
        out = norm(add(add(scl(out, ca), scl(kx, sa)), scl(n, dot(n, out) * (1 - ca))));
        const dep = 0.5 * m * (vv * vv - vOut * vOut);
        const ev = mkEv("ricochet", { vOut, energyJ: dep }); events.push(ev);
        if (obj) this._objectHit(ctx, { obj, part, hitPos, exitPos: null, n0: n, n1: null, vh, vIn: vv, vOut, passed: false, deposit: dep, Ek, tHit, tAbs: ctx.t0 + tHit, ricochet: true, bullet });
        else this._wallHit(ctx, { hitPos, n, matName, tAbs: ctx.t0 + tHit, kind: "ricochet", bullet, Ek, vv });
        p = add(hitPos, scl(n, 0.002)); v = scl(out, vOut); t = tHit; ignore = { part, step: stepCounter };
        startSeg(p, t, vOut); endPos = p;
        if (contacts >= MAX_CONTACTS) { reason = "max_contacts"; break; }
        continue outer;
      }
      // ---- penetrate / embed
      const stages = [];
      const cap = (x) => Math.min(x, 6);
      if (best.kind === "plane") { const cfg = wallId === "floor" ? FLOORS[this.floorName] : WALLS[this.wallName]; stages.push({ mat: matName, L: cap(cfg.thickness / cosn) }); }
      else {
        const cos1 = clamp(dot(vh, best.n1), 0.02, 1);
        if (part.skin && hitPos[1] >= part.skin.ymin) stages.push({ mat: part.skin.material, L: part.skin.t / cosn });
        if (part.hollow) { const L1 = part.t / cosn, L2 = part.t / cos1; stages.push({ mat: matName, L: L1 }); if (best.chord > L1 + L2 + 1e-4) stages.push({ mat: matName, L: L2 }); }
        else stages.push({ mat: matName, L: best.chord });
        if (part.skin && best.exit[1] >= part.skin.ymin) stages.push({ mat: part.skin.material, L: part.skin.t / cos1 });
      }
      let v1 = vv, stuck = false, depth = 0, sig = 0;
      for (const st of stages) { const r = penetrate(st.mat, bullet, v1, st.L); if (!r.pass) { stuck = true; depth += r.depth; break; } v1 = r.vOut; depth += st.L; sig += MATERIALS[st.mat].defl; }
      if (stuck) {
        const ev = mkEv("embed", { vOut: 0, energyJ: Ek, depth }); events.push(ev);
        endPos = add(hitPos, scl(vh, Math.min(depth, best.kind === "part" ? best.chord : 0.3)));
        if (obj) this._objectHit(ctx, { obj, part, hitPos, exitPos: null, n0: n, n1: null, vh, vIn: vv, vOut: 0, passed: false, deposit: Ek, Ek, tHit, tAbs: ctx.t0 + tHit, bullet });
        else this._wallHit(ctx, { hitPos, n, matName, tAbs: ctx.t0 + tHit, kind: "embed", bullet, Ek, vv });
        reason = "embed"; segs.push({ kind: "inside", t0: tHit, t1: tHit + 1e-4, v0: vv, v1: 0, material: matName, pts: [[hitPos[0], hitPos[1], hitPos[2], tHit], [endPos[0], endPos[1], endPos[2], tHit + 1e-4]] });
        t = tHit; break;
      }
      const exitPos = best.kind === "plane" ? add(hitPos, scl(vh, stages[0].L)) : best.exit;
      const tExit = tHit + len(sub(exitPos, hitPos)) / Math.max(1, (vv + v1) / 2), dep = 0.5 * m * (vv * vv - v1 * v1);
      const sigma = Math.min(9, sig * (1 + thetaN / 30)), nd = jitterDir(vh, sigma, rng);
      const ev = mkEv("penetrate", { vOut: v1, energyJ: dep, exitPos: xyz(exitPos), walls: stages.length }); events.push(ev);
      segs.push({ kind: "inside", t0: tHit, t1: tExit, v0: vv, v1, material: matName, pts: [[hitPos[0], hitPos[1], hitPos[2], tHit], [exitPos[0], exitPos[1], exitPos[2], tExit]] });
      if (obj) this._objectHit(ctx, { obj, part, hitPos, exitPos, n0: n, n1: best.n1, vh, vIn: vv, vOut: v1, passed: true, deposit: dep, Ek, tHit, tAbs: ctx.t0 + tHit, bullet });
      else this._wallHit(ctx, { hitPos, n, matName, tAbs: ctx.t0 + tHit, kind: "penetrate", bullet, Ek, vv, exitPos });
      if (best.kind === "plane") { endPos = exitPos; t = tExit; reason = "left_room"; this._lastExitV = v1; break; }
      p = add(exitPos, scl(nd, 0.0006)); v = scl(nd, v1); t = tExit; ignore = { part, step: stepCounter }; startSeg(p, t, v1); endPos = p;
      if (contacts >= MAX_CONTACTS) { reason = "max_contacts"; break; }
    }
    if (reason === "spent" || reason === "timeout" || reason === "max_contacts") { // close the trailing flight
      const last = pts[pts.length - 1]; if (last) { closeSeg(t, len(v)); endPos = [last[0], last[1], last[2]]; }
    }
    return { segments: segs, contacts, end: { reason, pos: xyz(endPos), t, v: reason === "embed" ? 0 : reason === "left_room" ? this._lastExitV : len(v) } };
  }

  // ---------------------------------------------------------------- effects (physics state changes now; visuals scheduled at the event's time)
  _decal(tAbs, pos, n, r, color) {
    this._at(tAbs, () => {
      const pool = this.decals; let idx;
      if (pool.n < pool.cap) idx = pool.alloc(); else idx = (this.decalRing++ % pool.cap);
      _q.setFromUnitVectors(_v3.set(0, 0, 1), _v3b.set(n[0], n[1], n[2]).normalize());
      _m4.compose(_v3.set(pos[0] + n[0] * 8e-4, pos[1] + n[1] * 8e-4, pos[2] + n[2] * 8e-4), _q, _v3b.set(r, r, r)); pool.set(idx, _m4, color);
    });
  }
  _sparks(tAbs, pos, n, count, speed) {
    const cnt = Math.round(count * (this.Q === QUALITY.low ? 0.6 : 1));
    this._at(tAbs, () => {
      const S = this.spark;
      for (let k = 0; k < cnt; k++) {
        const i = S.i++ % S.cap, r = this.rng; const d = norm([n[0] * 0.8 + r.n() * 0.6, n[1] * 0.8 + Math.abs(r.n()) * 0.4, n[2] * 0.8 + r.n() * 0.6]), sp = speed * (0.4 + r.u());
        S.pos[i * 3] = pos[0]; S.pos[i * 3 + 1] = pos[1]; S.pos[i * 3 + 2] = pos[2]; S.vel[i * 3] = d[0] * sp; S.vel[i * 3 + 1] = d[1] * sp; S.vel[i * 3 + 2] = d[2] * sp; S.life[i] = 0.25 + r.u() * 0.4;
      }
      this.sparkPts.geometry.attributes.position.needsUpdate = true;
    });
  }
  _piece(o) {
    return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, m: 0.01, r: 0.012, sx: 0.03, sy: 0.01, sz: 0.03, color: 0xffffff, e: 0.3, age: 0, hitDone: false, asleep: false, rest: 0, grounded: false, slot: -1, owner: { id: 0, type: "debris", mass: 0 }, ...o };
  }
  _spawnPieces(list) {
    const rn = this.rng;
    for (const d of list) {
      const p = { ...d, q: new THREE.Quaternion(rn.n(), rn.n(), rn.n(), rn.n()).normalize() };
      const cap = this.debris.cap, i = this.debrisRing++ % cap; p.slot = i;
      this.pieces[i] = p;
      _m4.compose(_v3.set(p.x, p.y, p.z), p.q, _v3b.set(p.sx, p.sy, p.sz)); this.debris.set(i, _m4, p.color);
      if (this.debris.n <= i) { this.debris.n = i + 1; this.debris.mesh.count = this.debris.n; }
    }
  }
  _fallEvents(ctx, pieces, tHit, tSpawnRel) {
    const falls = predictFalls(pieces, this._ctx(), tSpawnRel);
    for (const f of falls) {
      const type = f.owner.type;
      ctx.events.push({ t: f.t, tAbs: ctx.t0 + f.t, pos: xyz(f.pos), kind: "fall", material: f.mat, floor: f.mat, object: type, objectId: f.owner.id, sound: this._sound(type, "fall", f.mat),
        mass: f.mass, bulletMass: ctx.bullet.mass, vIn: f.v, vOut: 0 });
    }
  }
  _hideObj(obj) { const o = obj; for (const v of o.vis) v.pool.hide(v.idx); if (o.group) o.group.visible = false; }
  _killParts(obj) { obj.alive = false; for (const p of obj.parts) p.alive = false; }
  _wallHit(ctx, I) {
    const { hitPos, n, matName, tAbs, kind, bullet, Ek } = I, mat = MATERIALS[matName], rn = this.rng;
    const r = Math.max(bullet.caliber * 0.6, 0.004);
    if (kind === "ricochet") this._decal(tAbs, hitPos, n, 0.012, 0xcfcac0); else this._decal(tAbs, hitPos, n, r, 0x14110e);
    const hard = matName === "concrete" || matName === "brick" || matName === "cmu";
    if (hard || kind === "ricochet") this._sparks(tAbs, hitPos, n, kind === "ricochet" ? 10 : 6, 3.5);
    if (hard || matName === "drywall" || matName === "wood") { // dust / chips
      const cnt = Math.round((hard ? 6 : 4) * this.Q.fragScale), list = [];
      for (let k = 0; k < cnt; k++) { const d = norm([n[0] + rn.n() * 0.7, n[1] + rn.n() * 0.7, n[2] + rn.n() * 0.7]), sp = 0.8 + rn.u() * 2;
        list.push(this._piece({ x: hitPos[0], y: hitPos[1], z: hitPos[2], vx: d[0] * sp, vy: d[1] * sp, vz: d[2] * sp, wx: rn.n() * 5, wy: rn.n() * 5, wz: rn.n() * 5, m: 0.003, r: 0.006, sx: 0.008, sy: 0.004, sz: 0.008, color: mat.col, e: 0.2 })); }
      this._at(tAbs, () => this._spawnPieces(list));
    }
  }
  _objectHit(ctx, I) {
    const { obj, part, hitPos, exitPos, n0, n1, vh, vIn, vOut, passed, deposit, Ek, tAbs, tHit, bullet } = I, def = obj.def, rn = this.rng;
    const holeR = Math.max(bullet.caliber * 0.5, 0.003), metal = part.material === "steel" || part.material === "steel_ar500" || part.material === "tin";
    if (part.tag === "paper") {
      const pos = [hitPos[0], hitPos[1], this.target.center[2]], pan = this.worldToPanel(pos);
      const hole = { x_cm: pan.x_cm, y_cm: pan.y_cm, pos: xyz(pos), t: tHit, shot: ctx.shotNo, slot: -1, objectId: obj.id };
      this.paperHoles.push(hole); if (!ctx.paper) ctx.paper = { x_cm: pan.x_cm, y_cm: pan.y_cm, pos: xyz(pos), holeIndex: this.paperHoles.length - 1 };
      this._at(tAbs, () => { const pool = this.holes; const idx = pool.alloc(); hole.slot = idx; const r = Math.max(holeR, 0.0035);
        _m4.compose(_v3.set(pos[0], pos[1], pos[2] + 0.0006), _q.identity(), _v3b.set(r, r, r)); pool.set(idx, _m4, 0x151515); });
      return;
    }
    if (metal) this._sparks(tAbs, hitPos, n0, I.ricochet ? 16 : vOut === 0 ? 12 : 7, 4.5);
    if (def.npc) {
      ctx.npc.push({ objectId: obj.id, zone: part.zone, entry: xyz(hitPos), exit: passed ? xyz(exitPos) : null, vIn, vOut });
      this._decal(tAbs, hitPos, n0, 0.008, 0x5a1010); if (passed) this._decal(tAbs, exitPos, n1, 0.014, 0x6e1616);
    } else if (!def.brk && part.shape === "box" && !I.ricochet) {
      this._decal(tAbs, hitPos, n0, holeR * 1.1, 0x14110e); if (passed) this._decal(tAbs, exitPos, n1, holeR * 1.7, 0x2a2118);
    }
    if (def.brk && obj.alive && Ek >= def.brk.E) this._shatter(ctx, obj, I, def.brk);
    else if (def.screenType === "crt" && part.tag === "screen" && part.alive && Ek >= 2) this._crtBreak(ctx, I);
    else if (def.screenType === "lcd" && part.tag === "screen" && !obj.screenDead) this._lcdCrack(ctx, I);
    if (!obj.alive && !obj.dead) return;
    if (def.collapse && !obj.collapsed && obj.alive) { obj.absorbed += deposit; if (obj.absorbed >= def.collapse.E) this._collapse(ctx, I, def.collapse.mode); }
    else if (def.structure && !obj.collapsed && obj.alive) { obj.absorbed += deposit; if (obj.absorbed >= def.structure.E) this._collapseStructure(ctx, I); }
    if (def.knock && obj.alive && !obj.moving && obj.supportId >= 0) {
      const dp = bullet.mass * (vIn - (I.ricochet ? vOut * 0.5 : vOut)), dv = 2 * dp / obj.mass;
      if (dv >= 0.3) this._makeBody(ctx, obj, add(scl(vh, dv), [0, 0.9, 0]), tHit, tAbs);
    }
  }
  _shatter(ctx, obj, I, spec) {
    const rn = this.rng, def = obj.def, n = Math.max(4, Math.round(spec.n * this.Q.fragScale)), blast = clamp(Math.sqrt(2 * 0.03 * I.Ek / obj.mass), 1.5, 12);
    const owner = { id: obj.id, type: obj.type, mass: obj.mass }, list = [];
    for (let k = 0; k < n; k++) {
      const lp = [def.lo[0] + rn.u() * (def.hi[0] - def.lo[0]), def.lo[1] + rn.u() * (def.hi[1] - def.lo[1]), def.lo[2] + rn.u() * (def.hi[2] - def.lo[2])], wp = add(obj.pos, rotY(lp, obj.yaw));
      const rad = norm(add(sub(wp, I.hitPos), [rn.n() * 0.05, rn.n() * 0.05, rn.n() * 0.05])), d = norm(add(add(rad, scl(I.vh, 0.7)), [rn.n() * 0.3, rn.u() * 0.4, rn.n() * 0.3])), sp = blast * (0.35 + 0.9 * rn.u());
      const big = spec.big, sz = big ? rn.range(0.04, 0.08) : rn.range(0.018, 0.055);
      list.push(this._piece({ x: wp[0], y: wp[1], z: wp[2], vx: d[0] * sp, vy: d[1] * sp, vz: d[2] * sp, wx: rn.n() * 8, wy: rn.n() * 8, wz: rn.n() * 8, m: obj.mass / n, r: big ? 0.03 : 0.012,
        sx: sz, sy: big ? sz * 0.8 : 0.006, sz: sz * rn.range(0.6, 1), color: big && rn.u() < 0.4 ? 0x5f9a45 : spec.color, e: spec.e, owner }));
    }
    this._killParts(obj); obj.dead = true;
    ctx.events.push({ t: I.tHit, tAbs: I.tAbs, pos: xyz(I.hitPos), kind: "shatter", material: obj.def.parts[0].material, object: obj.type, objectId: obj.id, sound: obj.type + "_collapse", mass: obj.mass, bulletMass: ctx.bullet.mass, vIn: I.vIn, vOut: I.vOut, energyJ: I.Ek, fragments: n });
    this._at(I.tAbs, () => { this._hideObj(obj); this._spawnPieces(list); });
    this._fallEvents(ctx, list, I.tHit, I.tHit);
  }
  _crtBreak(ctx, I) {
    const obj = I.obj, def = obj.def, rn = this.rng, sq = def.screenQuad, spec = def.brkScreen, n = Math.max(6, Math.round(spec.n * this.Q.fragScale));
    for (const p of obj.parts) if (p.tag === "screen") p.alive = false; obj.crt = true;
    const tI = I.tHit + 0.0015, tB = I.tHit + 0.006, nrm = rotY([0, 0, 1], obj.yaw), owner = { id: obj.id, type: obj.type, mass: 6 }, list = [];
    for (let k = 0; k < n; k++) {
      const lp = [sq.c[0] + (rn.u() - 0.5) * sq.size[0], sq.c[1] + (rn.u() - 0.5) * sq.size[1], sq.c[2]], wp = add(obj.pos, rotY(lp, obj.yaw));
      const d = norm(add(scl(nrm, 1), [rn.n() * 0.45, rn.n() * 0.4 + 0.15, rn.n() * 0.45])), sp = 3 + rn.u() * 6, sz = rn.range(0.02, 0.06);
      list.push(this._piece({ x: wp[0] + nrm[0] * 0.01, y: wp[1], z: wp[2] + nrm[2] * 0.01, vx: d[0] * sp, vy: d[1] * sp, vz: d[2] * sp, wx: rn.n() * 10, wy: rn.n() * 10, wz: rn.n() * 10, m: 6 / n, r: 0.01, sx: sz, sy: 0.006, sz: sz * 0.8, color: spec.color, e: 0.25, owner }));
    }
    const mk = (t, phase, snd) => ({ t, tAbs: ctx.t0 + t, pos: xyz(I.hitPos), kind: "shatter", phase, material: "glass", object: obj.type, objectId: obj.id, sound: snd, mass: obj.mass, bulletMass: ctx.bullet.mass, vIn: I.vIn, vOut: I.vOut, energyJ: I.Ek });
    ctx.events.push(mk(tI, "implode", "tv_crt_collapse"), mk(tB, "burst", null));
    const c = add(obj.pos, rotY(sq.c, obj.yaw));
    this._sparks(ctx.t0 + tI, c, nrm, 36, 5);
    this._at(ctx.t0 + tI, () => { if (obj.screen) obj.screen.position.z = sq.c[2] - 0.035; });
    this._at(ctx.t0 + tB, () => { if (obj.screen) { obj.screen.material.map = null; obj.screen.material.color.set(0x040404); obj.screen.position.z = sq.c[2] - 0.05; } this._spawnPieces(list); });
    this._fallEvents(ctx, list, tB, tB);
    obj.screenDead = true;
  }
  _lcdCrack(ctx, I) {
    const obj = I.obj, rn = this.rng, sq = obj.def.screenQuad; obj.screenDead = true;
    const c = add(obj.pos, rotY(sq.c, obj.yaw)), nrm = rotY([0, 0, 1], obj.yaw), owner = { id: obj.id, type: obj.type, mass: 0.05 }, list = [];
    for (let k = 0; k < Math.max(3, Math.round(5 * this.Q.fragScale)); k++) {
      const d = norm(add(nrm, [rn.n() * 0.5, rn.n() * 0.4, rn.n() * 0.5])), sp = 0.6 + rn.u() * 1.6;
      list.push(this._piece({ x: I.hitPos[0], y: I.hitPos[1], z: I.hitPos[2], vx: d[0] * sp, vy: d[1] * sp, vz: d[2] * sp, wx: rn.n() * 6, wy: rn.n() * 6, wz: rn.n() * 6, m: 0.01, r: 0.008, sx: 0.015, sy: 0.004, sz: 0.012, color: 0xb9d6cf, e: 0.2, owner }));
    }
    this._sparks(I.tAbs, I.hitPos, nrm, 18, 3);
    this._at(I.tAbs, () => { if (obj.screen) { const t = crackTexture(this.rng); obj.screen.material.map = t; obj.screen.material.color.set(t ? 0xffffff : 0x050505); obj.screen.material.needsUpdate = true; } this._spawnPieces(list); });
    this._fallEvents(ctx, list, I.tHit, I.tHit);
  }
  _makeBody(ctx, obj, vel, tHit, tAbs) {
    const rn = this.rng, r = Math.max(0.03, obj.def.size[1] / 2), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), obj.yaw);
    this._killParts(obj); obj.moving = true; obj.dead = false;
    const owner = { id: obj.id, type: obj.type, mass: obj.mass };
    const p = this._piece({ x: obj.pos[0], y: obj.pos[1] + r, z: obj.pos[2], vx: vel[0], vy: vel[1], vz: vel[2], wx: rn.n() * 4, wy: rn.n() * 2, wz: rn.n() * 4, m: obj.mass, r, e: 0.3, owner, obj });
    p.q = q; obj.supportId = -1;
    if (ctx) this._fallEvents(ctx, [{ ...p, obj: undefined }], tHit, tHit);
    this._at(tAbs ?? this.simTime, () => { obj.piece = p; this.bodies.push(p); });
  }
  _release(sup, ctx, tHit, tAbs) {
    for (const o of this.objects) if (o.supportId === sup.id && o.alive && !o.moving) this._makeBody(ctx, o, [this.rng.n() * 0.2, 0, this.rng.n() * 0.2], tHit ?? 0, tAbs ?? this.simTime);
  }
  _collapse(ctx, I, mode) {
    const obj = I.obj, def = obj.def; obj.collapsed = true;
    const tC = I.tHit + 0.01, ev = { t: tC, tAbs: ctx.t0 + tC, pos: xyz(I.hitPos), kind: "collapse", material: def.parts[0].material, object: obj.type, objectId: obj.id, sound: obj.type + "_collapse", mass: obj.mass, bulletMass: ctx.bullet.mass, vIn: I.vIn, vOut: I.vOut, energyJ: I.deposit };
    ctx.events.push(ev);
    if (mode === "squash") {
      this.anims.push({ obj, kind: "squash", t0: ctx.t0 + tC, dur: 0.3 });
      if (def.spray) { // sand / liquid spray
        const rn = this.rng, list = [], owner = { id: obj.id, type: obj.type, mass: obj.mass * 0.05 }; const c = this.objCenter(obj);
        for (let k = 0; k < Math.round(12 * this.Q.fragScale); k++) { const d = norm([rn.n(), 0.5 + rn.u(), rn.n()]), sp = 1 + rn.u() * 2.5;
          list.push(this._piece({ x: c[0], y: c[1] + 0.05, z: c[2], vx: d[0] * sp, vy: d[1] * sp, vz: d[2] * sp, m: obj.mass * 0.05 / 12, r: 0.005, sx: 0.01, sy: 0.01, sz: 0.01, color: obj.type === "sandbag" ? 0xc9b27c : 0xcfd8dc, e: 0.1, owner })); }
        this._at(ctx.t0 + tC, () => this._spawnPieces(list)); if (obj.type === "sandbag") this._fallEvents(ctx, list, tC, tC);
      }
    } else { // topple away from the shot
      const hdir = norm([I.vh[0], 0, I.vh[2]]), axis = cross([0, 1, 0], hdir), h = def.size[1], T = 1.8 * Math.sqrt(h / G);
      this._killParts(obj);
      this.anims.push({ obj, kind: "topple", t0: ctx.t0 + tC, dur: T, axis });
      const tF = tC + T; ctx.events.push({ t: tF, tAbs: ctx.t0 + tF, pos: xyz(obj.pos), kind: "fall", material: FLOORS[this.floorName].material, floor: FLOORS[this.floorName].material, object: obj.type, objectId: obj.id,
        sound: obj.type + "_fall", mass: obj.mass, bulletMass: ctx.bullet.mass, vIn: Math.sqrt(3 * G * h), vOut: 0 });
    }
  }
  _collapseStructure(ctx, I) {
    const obj = I.obj, def = obj.def; obj.collapsed = true; this._killParts(obj); const sup = obj.supportRef;
    const tC = I.tHit + 0.01, isShelf = !!def.dims.l, h = isShelf ? obj.pos[1] : def.dims.h, T = isShelf ? Math.sqrt(2 * Math.max(h, 0.1) / G) : 1.8 * Math.sqrt(h / G);
    ctx.events.push({ t: tC, tAbs: ctx.t0 + tC, pos: xyz(I.hitPos), kind: "collapse", material: "wood", object: obj.type, objectId: obj.id, sound: obj.type + "_collapse", mass: obj.mass, bulletMass: ctx.bullet.mass, vIn: I.vIn, vOut: I.vOut, energyJ: I.deposit });
    const tF = tC + T, fm = FLOORS[this.floorName].material;
    ctx.events.push({ t: tF, tAbs: ctx.t0 + tF, pos: xyz(obj.pos), kind: "fall", material: fm, floor: fm, object: obj.type, objectId: obj.id, sound: obj.type + "_fall", mass: obj.mass, bulletMass: ctx.bullet.mass, vIn: isShelf ? Math.sqrt(2 * G * h) : Math.sqrt(3 * G * h), vOut: 0, floorMat: fm });
    if (isShelf) this.anims.push({ obj, kind: "drop", t0: ctx.t0 + tC, dur: T, y0: obj.pos[1], axis: rotY([1, 0, 0], obj.yaw) });
    else this.anims.push({ obj, kind: "topple", t0: ctx.t0 + tC, dur: T, axis: cross([0, 1, 0], norm([I.vh[0], 0, I.vh[2]])) });
    sup.alive = false; this._release(sup, ctx, tC, ctx.t0 + tC);
  }
  _addTrail(segs, t0) {
    const pts = []; for (const s of segs) for (const q of s.pts) pts.push(q[0], q[1], q[2]);
    if (pts.length < 6) return;
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.9 })); line.frustumCulled = false; this.root.add(line);
    this.trails.push({ line, age: 0 }); while (this.trails.length > 3) { const o = this.trails.shift(); this.root.remove(o.line); o.line.geometry.dispose(); o.line.material.dispose(); }
  }

  // ---------------------------------------------------------------- per-frame update
  /** Call every frame with the REAL frame time in seconds; the room applies its own time scale (setTimeScale / auto slow-mo). */
  update(dtReal) {
    const sc = this._scaleNow(), dt = Math.min(dtReal, 0.1) * sc; this.simTime += dt;
    while (this.pending.length && this.pending[0].t <= this.simTime) this.pending.shift().fn();
    // debris + bodies: fixed 1/120 s steps
    this._acc = (this._acc || 0) + dt; const ctx = this._ctx(); let n = 0;
    while (this._acc >= 1 / 120 && n < 8) {
      for (const p of this.pieces) if (p && !p.asleep) stepPiece(p, 1 / 120, ctx);
      for (const p of this.bodies) if (!p.asleep) stepPiece(p, 1 / 120, ctx);
      this._acc -= 1 / 120; n++;
    }
    if (n === 8) this._acc = 0;
    for (const p of this.pieces) {
      if (!p || (p.asleep && p.synced)) continue;
      const w = Math.hypot(p.wx, p.wy, p.wz); if (w > 1e-3 && !p.asleep) { _q2.setFromAxisAngle(_v3.set(p.wx / w, p.wy / w, p.wz / w), w * dt); p.q.premultiply(_q2); }
      _m4.compose(_v3.set(p.x, p.y, p.z), p.q, _v3b.set(p.sx, p.sy, p.sz)); this.debris.set(p.slot, _m4); if (p.asleep) p.synced = true;
    }
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const p = this.bodies[i], w = Math.hypot(p.wx, p.wy, p.wz);
      if (w > 1e-3 && !p.asleep) { _q2.setFromAxisAngle(_v3.set(p.wx / w, p.wy / w, p.wz / w), w * dt); p.q.premultiply(_q2); }
      this._sync(p.obj); if (p.asleep) this.bodies.splice(i, 1);
    }
    // object animations
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i], u = clamp((this.simTime - a.t0) / a.dur, 0, 1); if (this.simTime < a.t0) continue; const o = a.obj;
      if (a.kind === "squash") o.fy = 1 - 0.45 * u;
      else if (a.kind === "topple") o.tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...a.axis), u * u * 1.5);
      else if (a.kind === "drop") { o.pos[1] = Math.max(0.03, a.y0 - 0.5 * G * (u * a.dur) ** 2); o.tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...a.axis), u * 1.3); }
      this._sync(o); if (u >= 1) this.anims.splice(i, 1);
    }
    // sparks
    const S = this.spark; let sdirty = false;
    for (let i = 0; i < S.cap; i++) if (S.life[i] > 0) {
      S.life[i] -= dt; S.vel[i * 3 + 1] -= G * dt; S.pos[i * 3] += S.vel[i * 3] * dt; S.pos[i * 3 + 1] += S.vel[i * 3 + 1] * dt; S.pos[i * 3 + 2] += S.vel[i * 3 + 2] * dt; sdirty = true;
      if (S.life[i] <= 0 || S.pos[i * 3 + 1] < 0) { S.life[i] = 0; S.pos[i * 3 + 1] = -999; }
    }
    if (sdirty) this.sparkPts.geometry.attributes.position.needsUpdate = true;
    // tracer
    const r = this.lastResult;
    if (r) { const tt = this.simTime - this._resultStart, b = Room.bulletAt(r, tt); if (b && tt >= 0) { this.tracer.visible = true; this.tracer.position.set(b.x, b.y, b.z); } else this.tracer.visible = false; }
    for (let i = this.trails.length - 1; i >= 0; i--) { const tr = this.trails[i]; tr.age += dtReal; tr.line.material.opacity = Math.max(0, 0.9 - tr.age * 0.55); if (tr.age > 1.8) { this.root.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); this.trails.splice(i, 1); } }
    this._noiseAcc += dtReal; if (this._noiseAcc > 0.1) { this._noiseAcc = 0; tickNoise(); }
    this._flush();
  }
  /** Advance the simulation by `seconds` of sim time in small steps (tests / headless). */
  advance(seconds, step = 1 / 60) { for (let t = 0; t < seconds; t += step) this.update(step / Math.max(1e-6, this._scaleNow())); }
  activeDebris() { let n = 0; for (const p of this.pieces) if (p && !p.asleep) n++; return n; }
  stats() {
    let draws = 0; for (const k in this.pools) if (this.pools[k].n) draws++; draws += 6 /*shell*/ + 3 /*decals,holes,debris*/ + 1 /*sparks*/ + this.objects.filter((o) => o.group).length * 2;
    return { objects: this.objects.length, alive: this.objects.filter((o) => o.alive).length, debris: this.pieces.filter(Boolean).length, activeDebris: this.activeDebris(), decals: this.decals.n, paperHoles: this.paperHoles.length,
      shots: this.shotCount, estimatedDrawCalls: draws, size: { w: this.W, l: this.L, h: this.H }, wall: this.wallName, floor: this.floorName, quality: this.opts.quality };
  }
  reset() { this.simTime = 0; this.shotCount = 0; this.slowWindows = []; this.lastResult = null; this.populate(); const t = this.target; this.setTarget({ type: t.type, distance: t.distance, widthCm: t.widthCm, heightCm: t.heightCm, platoon: t.platoon, _noExtend: true }); }
  dispose() { this.disposed = true; this.clearObjects(); this.scene.remove(this.root); this.root.traverse((c) => { c.geometry?.dispose(); c.material?.dispose?.(); }); }
}

export function createRoom(scene, opts) { return new Room(scene, opts); }
export { Room };
