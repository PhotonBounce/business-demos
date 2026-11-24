// audio.js - procedural sound for the Shooting Range. No samples, no external audio: every sound is synthesised
// from the shot the simulator just computed (sim.js). The pipeline is
//   sim event -> plan (a list of timed physical cues) -> render (pure DSP into Float32Arrays) -> Web Audio playback.
// The plan/render half is pure JavaScript with no browser dependency, so node tests hear exactly what the page plays.
// The same plans also drive the optional sample sets (AI / Recorded) through SampleSet, cue for cue.
//
// What is physical and what is a choice:
//  * muzzle blast: gas energy left at the muzzle = charge x impetus / (gamma - 1) x (1 - barrel heat loss) - bullet KE,
//    from THIS round's charge and muzzle velocity; blast length and pitch follow Hopkinson-Cranz scaling of that
//    energy (R0 = (E/p_atm)^(1/3)); rise time follows this round's peak chamber pressure; level follows R0 and the
//    muzzle pressure (gamma - 1) E / bore volume.
//  * supersonic crack: Whitham N-wave (duration and level from Mach number, calibre and bullet length) whenever this
//    round's muzzle velocity beats the speed of sound. The Makarov (~315 m/s) is subsonic: no crack, by physics.
//  * action: every clank is placed at the time the sim's carrier/slide trace reaches that point (unlock, ejector,
//    rear stop, battery, hammer) and sized by the momentum the sim computed there.
//  * casing / magazine: ballistic flight from the sim's ejection speed, bounces with surface restitution, Hertz-like
//    contact time per surface, shell (ovaling) modes of the case from its material and wall, plate modes of the
//    magazine and of wood / steel floors, rolling friction.
//  * absolute levels are compressed for listening (a real shot is ~80 dB above a case landing); RELATIVE scaling
//    between rounds, guns and surfaces is the physical one. Constants marked ASSUMED are not in the sims.
import { AK, MAK } from "./sim.js";

export const SR = 48000;
const C_AIR = 343.2, GRAV = 9.81, P_ATM = 101325, TAU = Math.PI * 2;
export const CEILING = Math.pow(10, -1.5 / 20);   // limiter ceiling -1.5 dBFS (test bar: nothing above -1 dBFS)

// ------------------------------------------------------------------ materials and modal formulas
const MAT = {
  brass: { E: 110e9, rho: 8500, nu: 0.34, Q: 1500 },
  steel: { E: 200e9, rho: 7850, nu: 0.29, Q: 700 },
  steel_lacquered: { E: 200e9, rho: 7850, nu: 0.29, Q: 140 },   // lacquer coat damps the ring (ASSUMED Q)
  pine: { E: 10e9, rho: 500, nu: 0.3, Q: 22 },
};
const plateWave = (m) => Math.sqrt(m.E / (12 * m.rho * (1 - m.nu * m.nu)));
// thin cylindrical shell, inextensional ovaling modes n = 2, 3 (Rayleigh / Love)
function shellModes(mat, r, h, Q) {
  const out = [];
  for (const n of [2, 3]) {
    const f = (h / (TAU * r * r)) * plateWave(mat) * n * (n * n - 1) / Math.sqrt(n * n + 1);
    out.push({ f, q: Q, a: n === 2 ? 1 : 0.45 });
    out.push({ f: f * 1.043, q: Q, a: n === 2 ? 0.55 : 0.2 });   // taper splits each mode into a close pair
  }
  return out;
}
// simply supported rectangular plate a x b, thickness h
function plateModes(mat, a, b, h, Q, fMax = 9000, maxN = 6, at = [0.37, 0.41]) {
  const k = (Math.PI / 2) * h * plateWave(mat), out = [];
  for (let m = 1; m <= maxN; m++) for (let n = 1; n <= maxN; n++) {
    const f = k * (m * m / (a * a) + n * n / (b * b));
    if (f > fMax) continue;
    const shape = Math.abs(Math.sin(m * Math.PI * at[0]) * Math.sin(n * Math.PI * at[1]));   // response at the hit point
    out.push({ f, q: Q, a: shape / Math.sqrt(m * n) });
  }
  return out.sort((x, y) => x.f - y.f).slice(0, 40);
}
// free-free bar of length L, radius of gyration rg
function beamModes(mat, L, rg, Q) {
  const f1 = (22.373 / (TAU * L * L)) * Math.sqrt(mat.E / mat.rho) * rg;
  return [1, 2.756, 5.404, 8.933].map((r, i) => ({ f: f1 * r, q: Q, a: 1 / (1 + i) }));
}
// open/closed-pipe air resonance of a case (closed at the head): c / 4L
const tubeAir = (L) => ({ f: C_AIR / (4 * L), q: 9, a: 0.35 });
// spring surge frequency of a helical spring fixed at both ends
const springSurge = (wire, D, n) => (wire / (TAU * n * D * D)) * Math.sqrt(79.3e9 / (2 * 7850));

// ------------------------------------------------------------------ gun data (from the sims unless marked ASSUMED)
function makeGuns() {
  const G = AK.G, K = AK.C.K, V = MAK.C.V, GEO = MAK.C.GEO;
  const akBullet = 7.9e-3, akCharge = AK.CHARGE_G[0] * 1e-3;
  const mkBullet = MAK.nominalRound().bullet_g * 1e-3;
  const steel = MAT.steel;
  return {
    AK: {
      id: "AK", calibre: "762x39", impetus: 1.00e6, gamma: 1.24, heatLoss: 0.30,     // ballistics.py F_FORCE / GAMMA; heat loss ASSUMED
      boreD: K.C_BULLET_D * 1e-3, bulletLen: 26.8e-3,                               // M43 bullet length ASSUMED
      Vbore: G.V0 + G.A_bore * G.travel, earToMuzzle: 0.85,                            // ear position ASSUMED (shouldered rifle)
      nominal: { mv: AK.C.nominal.mv, pmax: AK.C.nominal.pmax, charge: akCharge, bullet: akBullet },
      mCarrier: G.m_carrier + G.m_bolt, mBolt: G.m_bolt, mHammer: G.m_hammer,
      receiver: [...plateModes(steel, 0.24, 0.05, 1.0e-3, 28), ...beamModes(steel, 0.20, 0.006, 60)],  // 1.0 mm stamped receiver ASSUMED
      spring: springSurge(K.SPRING_WIRE_D * 1e-3, K.SPRING_COIL_D * 1e-3, K.SPRING_COILS),
      caseM: 7.07e-3, caseMat: "brass", caseL: K.C_CASE_L * 1e-3, caseR: 5.2e-3, caseH: 0.40e-3,     // sim parts: brass 7.07 g; wall ASSUMED
      roundM: G.m_round_g * 1e-3,
      eject: { ratio: 1.25, elev: 15, az: 80, h0: 1.45 },                                // ejector lever ratio / angles ASSUMED
      mag: { m: 0.398, a: 0.202, b: 0.136, h: 0.53e-3, dropH: 1.1, release: 0.010 },    // parts summary 398 g; wall from body volume
      hammerE: 0.736,                                                                   // AK.strike nominal pin energy (J)
    },
    MAK: {
      id: "MAK", calibre: "9x18", impetus: MAK.C.CAL.impetus_J_per_kg, gamma: 1.24, heatLoss: 0.30,
      boreD: Math.sqrt(4 * GEO.A / Math.PI), bulletLen: 10.71e-3,                        // dims.py bullet_len
      Vbore: GEO.V0 + GEO.A * GEO.travel, earToMuzzle: 0.60,
      nominal: { mv: MAK.C.CAL.mv, pmax: MAK.C.CAL.pmax_mpa * 1e6, charge: 0.25e-3, bullet: mkBullet },
      mCarrier: MAK.C.SLIDE_KG, mBolt: 0, mHammer: MAK.C.I_h / (MAK.C.r_strike * MAK.C.r_strike),
      receiver: [...beamModes(steel, 0.161, 0.008, 45), ...beamModes(steel, 0.16, 0.010, 30)],     // slide + frame bars ASSUMED
      spring: springSurge(V.rs_wire * 1e-3, V.rs_mean_d * 1e-3, V.rs_active),
      caseM: MAK.C.CASE_KG, caseMat: "steel_lacquered", caseL: V.case_len * 1e-3, caseR: 4.97e-3, caseH: 0.55e-3,
      roundM: MAK.C.CASE_KG + mkBullet + 0.25e-3,
      eject: { ratio: 0.8, elev: 30, az: 110, h0: 1.35 },
      mag: { m: 0.069, a: 0.095, b: 0.027, h: 0.70e-3, dropH: 1.0, release: 0.006 },    // manifest parts ~69 g; wall dims.py
      hammerE: 0.22,
      slideTravel: V.slide_travel * 1e-3, xCock: 0.012, xEj: -V.ejector_z * 1e-3, xLock: 0.0305,
    },
  };
}
export const GUNS = makeGuns();
export function caseSpec(g, mat) {   // mat: "brass" | "steel" | undefined (= what the sim's case is made of)
  const key = mat === "brass" ? "brass" : mat === "steel" ? "steel_lacquered" : g.caseMat, m = MAT[key];
  const k = key + "|" + g.id;
  if (!caseSpec.cache[k]) caseSpec.cache[k] = {
    mat: key, mass: g.caseM * m.rho / MAT[g.caseMat].rho,
    modes: [...shellModes(m, g.caseR, g.caseH, m.Q), tubeAir(g.caseL)],
    roundModes: shellModes(m, g.caseR, g.caseH, m.Q * 0.12),          // a live round: bullet and powder load the shell
  };
  return caseSpec.cache[k];
}
caseSpec.cache = {};
for (const g of Object.values(GUNS)) {
  const cs = caseSpec(g);
  g.caseModes = cs.modes;
  g.roundModes = cs.roundModes;
  g.magModes = plateModes(MAT.steel, g.mag.a, g.mag.b, g.mag.h, 32, 7000);
  g.springModes = [1, 2, 3, 4].map((n) => ({ f: g.spring * n, q: 25, a: 1 / n }));
  g.nominal.Eg = gasEnergy(g, g.nominal.charge, g.nominal.bullet, g.nominal.mv);
}
GUNS.GAT = GUNS.AK;   // the Vykhor-6 rotary gun: its shots are AK shots re-pitched (RangeAudio.gatShot), its handling sounds the AK's

// ------------------------------------------------------------------ surfaces and spaces
const plank = beamModes(MAT.pine, 0.6, 0.02 / Math.sqrt(12), 20).map((m, i) => ({ ...m, f: m.f * [0.55, 0.41, 0.33, 0.27][i] }));  // simply supported deck plank
export const SURFACES = {
  concrete: { label: "Concrete", e: 0.45, keepH: 0.6, tau: 25e-6, rest: 0.35, rollMu: 0.035, rollF: 3600, rollQ: 0.8, grit: 1.0, refl: 0.9, click: 1.0, thud: 0.1, modes: null },
  dirt: { label: "Dirt", e: 0.08, keepH: 0.1, tau: 2.0e-3, rest: 0.02, rollMu: 0.8, rollF: 700, rollQ: 0.7, grit: 0.0, refl: 0.45, click: 0.08, thud: 3.0, modes: null },
  wood: { label: "Wood", e: 0.35, keepH: 0.55, tau: 120e-6, rest: 0.12, rollMu: 0.025, rollF: 1300, rollQ: 0.9, grit: 0.3, refl: 0.75, click: 0.25, thud: 0.35, modes: plank, modeGain: 1.2 },
  gravel: { label: "Gravel", e: 0.3, keepH: 0.35, tau: 60e-6, rest: 0.2, rollMu: 0.35, rollF: 2600, rollQ: 0.6, grit: 1.4, refl: 0.6, click: 0.7, thud: 0.4, modes: null },
  grass: { label: "Grass", e: 0.12, keepH: 0.15, tau: 1.2e-3, rest: 0.04, rollMu: 0.9, rollF: 900, rollQ: 0.5, grit: 0, refl: 0.4, click: 0.12, thud: 1.6, modes: null },
  puddle: { label: "Puddle", e: 0.04, keepH: 0.05, tau: 3e-3, rest: 0.01, rollMu: 2, rollF: 3000, rollQ: 0.5, grit: 0, refl: 0.8, click: 0.05, thud: 0.4, splash: 1, modes: null },
  metal: { label: "Steel plate", e: 0.5, keepH: 0.65, tau: 20e-6, rest: 0.6, rollMu: 0.015, rollF: 4500, rollQ: 1.2, grit: 0.6, refl: 0.95, click: 0.6, thud: 0.05, modes: "plate", modeGain: 0.45 },
};
export const SPACES = {
  // OUTDOOR: no room. Direct sound + ground reflection (in render), discrete slap-back echoes off the berm and treeline
  // (150-600 ms, high frequencies lost to air and foliage), and a long, low, rolling decay (terrain scatter, ~2.4 s).
  // The supersonic crack has its own, earlier echo path (it reflects off the berm downrange, the boom off the treeline).
  outdoor: { label: "Outdoor range", outdoor: true, echoes: [[0.19, 0.30, 1800], [0.37, 0.20, 1300], [0.58, 0.13, 900]], crackEchoes: [[0.12, 0.22, 5000], [0.31, 0.12, 3500]],
    rt: 2.4, roll: 0.055, rollLP: 520, rollPre: 0.16, wet: 0, damp: 0.85 },
  indoor: { label: "Indoor range", early: [[0.0087, 0.42], [0.0146, 0.36], [0.022, 0.28], [0.031, 0.22], [0.047, 0.15]], rt: 0.9, wet: 0.2, damp: 0.35 },
};
// listening levels (compressed, see the header); everything below is relative to these
const LEVEL = { blast: 0.62, crack: 0.30, action: 0.012, hammer: 0.02, drop: 0.07, roll: 0.018, scrape: 0.012, spring: 0.004 };

// ------------------------------------------------------------------ helpers
function gasEnergy(g, charge, bullet, mv) {
  const chem = charge * g.impetus / (g.gamma - 1) * (1 - g.heatLoss);
  return Math.max(chem - 0.5 * bullet * mv * mv, 0.02 * chem);
}
function hashNums(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    const s = Number.isFinite(x) ? x.toPrecision(12) : String(x);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  }
  return h || 1;
}
function rng(seed) {  // mulberry32 - deterministic noise from the shot's own numbers
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const crossTime = (xt, x, from = 0, rising = true) => {
  for (let i = Math.max(1, from); i < xt.length; i++) {
    const [t0, x0] = xt[i - 1], [t1, x1] = xt[i];
    if (rising ? (x0 < x && x1 >= x) : (x0 > x && x1 <= x)) return { t: t0 + (t1 - t0) * (x - x0) / ((x1 - x0) || 1e-12), i, v: (x1 - x0) / Math.max(t1 - t0, 1e-9) };
  }
  return null;
};

// ------------------------------------------------------------------ plans: sim event -> timed physical cues
// Cue kinds: blast, crack, impact (modal), scrape, drop (flight + bounces + roll). Each cue carries t (s) from the
// trigger action, and a "sample" twin used by SampleSet.
function dropCue(gun, obj, t0, { v, elev, az, h0, mass, seed, surface, layer }) {
  const S = SURFACES[surface] || SURFACES.concrete, r = rng(seed);
  const vz = v * Math.sin(elev * Math.PI / 180), vh0 = v * Math.cos(elev * Math.PI / 180);
  const tf = (vz + Math.sqrt(vz * vz + 2 * GRAV * h0)) / GRAV;
  const d = vh0 * tf, azr = az * Math.PI / 180;
  const pos = [d * Math.sin(azr), d * Math.cos(azr)], earH = 1.65;
  const dist = Math.hypot(d, earH), pan = Math.max(-1, Math.min(1, Math.sin(azr) * d / dist));
  let vImp = Math.sqrt(vz * vz + 2 * GRAV * h0), vh = vh0, t = t0 + tf;
  const e = obj === "mag" ? S.e * 0.6 : S.e;
  const bounces = [];
  for (let k = 0; k < 12 && vImp > 0.12; k++) {
    // which part hits first is set by the tumble the sim's ejection gave it (deterministic in the shot's numbers)
    const end = r();
    bounces.push({ t, v: vImp, J: mass * (1 + e) * vImp, end });
    const vUp = e * vImp * (0.75 + 0.25 * end);
    if (obj === "mag" && k === 0) {   // magazine lands on its floorplate corner, then slaps over on its side
      const L = gun.mag.a, tOver = 0.9 * Math.sqrt(L / GRAV);
      t += tOver; vImp = 0.7 * Math.sqrt(GRAV * L); vh *= S.keepH; continue;
    }
    t += 2 * vUp / GRAV; vImp = vUp; vh *= S.keepH;
  }
  const rollDur = obj === "mag" ? 0 : Math.min(1.6, vh / (S.rollMu * GRAV));
  return { k: "drop", obj, t: t0 + tf, gun: gun.id, surface, bounces, roll: { t, dur: rollDur, v0: vh }, dist, pan, pos, seed, layer: layer || obj, mass };
}

// One contact of a casing / round / magazine with the floor, for the page's 3D physics: the sound fires when the
// object visibly hits the floor. v = normal speed (m/s), vh = sliding speed, nextGap = time to its next contact (0 = it
// comes to rest here, so the surface damps the ring and it rolls on with vh).
export function planContact({ gun = "AK", obj = "case", surface = "concrete", caseMat, v, vh = 0, nextGap = 0, dist = 3, pan = 0.5, pos = [1, 1], seed = 1, end = 0.5, loaded = 0, gain = 1 }) {
  const g = GUNS[gun], S = SURFACES[surface] || SURFACES.concrete;
  const mass = obj === "mag" ? g.mag.m + loaded * g.roundM : obj === "round" ? g.roundM : caseSpec(g, caseMat).mass;
  const e = obj === "mag" ? S.e * 0.6 : S.e;
  const rollDur = !nextGap && obj !== "mag" ? Math.min(0.5, vh / (S.rollMu * GRAV)) : 0;   // a casing's roll is a short hiss now: nothing trails the burst
  const cue = { k: "drop", obj, t: 0, gun, surface, caseMat, bounces: [{ t: 0, v, J: mass * (1 + e) * v, end }], roll: { t: 0.002, dur: rollDur, v0: vh },
    dist, pan, pos, seed, layer: obj === "mag" ? "mag" : "case", mass, nextGap, loaded };
  const smp = obj === "mag" || v <= 0.5 ? [] : [caseSample(g, obj === "round" ? "brass" : caseSpec(g, caseMat).mat, surface, { t: 0, gainDb: 20 * Math.log10(Math.min(1, v / 4) * 2 / Math.max(dist, 1)), rate: 1, pan })];
  const out = finish({ gun, cues: [cue], samples: smp, seed });
  if (obj !== "mag") out.voice = "casing";   // counted against the casing voice cap (CASING_VOICES) by RangeAudio._play
  if (gain !== 1) { out.gain = gain; out.samples = out.samples.map((q) => ({ ...q, gainDb: (q.gainDb || 0) + 20 * Math.log10(Math.max(gain, 1e-4)) })); }
  return out;
}
export const CASING_VOICES = 6;   // at most this many casing contact sounds ring at once; the oldest is faded out for a new one

// a casing landing in a sample set: brass_<cal>_<surface>, or for steel cases casing_steel_<surface> when the set has it,
// else the brass file pitched down 12 % and low-passed at 2.4 kHz (steel: duller, lower, less ring)
function caseSample(g, mat, surface, base) {
  if (mat === "brass") return { ...base, name: `brass_${g.calibre}_${surface}` };
  return { ...base, name: `brass_steel_${g.calibre}_${surface}`, alt: `brass_${g.calibre}_${surface}`, altRate: 0.88, altLowpass: 2400 };
}

function blastCue(g, t, { charge, bullet, mv, pmax, lodged }) {
  const Eg = gasEnergy(g, charge, bullet, lodged ? 0 : mv);
  const R0 = Math.cbrt(Eg / P_ATM);
  const pMuzzle = (g.gamma - 1) * Eg / g.Vbore;
  const ref = GUNS.AK.nominal, refR0 = Math.cbrt(ref.Eg / P_ATM), refPm = (GUNS.AK.gamma - 1) * ref.Eg / GUNS.AK.Vbore;
  let A = LEVEL.blast * Math.pow((R0 / g.earToMuzzle) / (refR0 / GUNS.AK.earToMuzzle), 1.2) * Math.pow(pMuzzle / refPm, 0.25);
  A *= Math.pow(pmax / ref.pmax, 0.1);
  const rise = 30e-6 * Math.sqrt(ref.pmax / Math.max(pmax, 1e6));
  if (lodged) A *= 0.12;
  return { k: "blast", t, A, R0, Tp: 0.6 * R0 / C_AIR, rise, Eg, pMuzzle, lodged: !!lodged };
}
function crackCue(g, t, mv) {
  const M = mv / C_AIR;
  if (!(M > 1)) return null;
  const x = 1.5, b = Math.sqrt(M * M - 1);        // slant distance of the shock path to the ear (ASSUMED)
  const T = 1.82 * M * Math.pow(x, 0.25) * g.boreD / (C_AIR * Math.pow(b, 0.75) * Math.pow(g.bulletLen, 0.25));
  const dp = 0.53 * Math.pow(b, 0.25) * g.boreD / (Math.pow(x, 0.75) * Math.pow(g.bulletLen, 0.25));   // in units of p_atm
  const refM = GUNS.AK.nominal.mv / C_AIR, refB = Math.sqrt(refM * refM - 1);
  const ref = 0.53 * Math.pow(refB, 0.25) * GUNS.AK.boreD / (Math.pow(x, 0.75) * Math.pow(GUNS.AK.bulletLen, 0.25));
  return { k: "crack", t, T, A: LEVEL.crack * dp / ref, M };
}
const impact = (t, modes, J, tau, gain, extra = {}) => ({ k: "impact", t, modes, J, tau, A: gain * Math.pow(Math.max(J, 1e-6), 0.7), ...extra });

export function planShot(ev, { surface = "concrete", caseMat, noDrop = false, grit = 0, suppressed = false } = {}) {
  const g = GUNS[ev.gun], cues = [], samples = [];
  if (!g) return { cues, samples, dur: 0 };
  const rnd = ev.round || {};
  const seed = hashNums(ev.gun, rnd.serial ?? rnd.rid, ev.mv, ev.pmax, rnd.charge_g);
  const misfire = ev.kind === "failure_to_fire" || ev.kind === "failure to fire";
  const tLock = ev.t_lock || 0.004;
  if (misfire) return planDry(ev.gun, { energy: ev.gun === "AK" ? ev.e_pin : ev.res && ev.res.firing_pin_j * 2.3, primer: true, seed });
  const hammerE = ev.gun === "AK" ? (ev.e_pin || g.hammerE) : (ev.res ? ev.res.hammer_j : g.hammerE);
  cues.push(impact(tLock, g.receiver, Math.sqrt(2 * g.mHammer * hammerE), 40e-6, LEVEL.hammer, { layer: "action" }));
  const tIg = tLock + (ev.gun === "AK" ? AK.PRIMER_DELAY : 0);
  const lodged = ev.kind === "squib_bullet_lodged" || ev.kind === "bullet lodged" || !(ev.mv > 0);
  const charge = (rnd.charge_g ?? g.nominal.charge * 1e3) * 1e-3, bullet = (rnd.bullet_g ?? g.nominal.bullet * 1e3) * 1e-3;
  const tExit = ev.gun === "AK" ? (ev.bal ? ev.bal.t_exit : 1.05e-3) : (ev.res ? ev.res.t_exit_ms * 1e-3 : 0.5e-3);
  const tBlast = tIg + tExit + g.earToMuzzle / C_AIR;
  const bl = blastCue(g, tBlast, { charge, bullet, mv: ev.mv || 0, pmax: ev.pmax || g.nominal.pmax, lodged });
  bl.layer = "blast"; bl.seed = seed;
  // suppressor: the baffles bleed the gas slowly: about -15 dB, a lower, duller and shorter report (the crack stays)
  if (suppressed) { bl.A *= Math.pow(10, -15 / 20); bl.R0 *= 2.2; bl.Tp *= 2.2; bl.suppressed = true; }
  cues.push(bl);
  const Eratio = bl.Eg / g.nominal.Eg;
  samples.push({ t: tBlast - g.earToMuzzle / C_AIR, name: `${g.id.toLowerCase()}_shot`,
    gainDb: Math.max(-2, Math.min(2, 5 * Math.log10(Eratio))) + (suppressed ? -15 : 0), lowpass: suppressed ? 1800 : 0, rate: Math.max(0.97, Math.min(1.03, 1 - 0.25 * ((ev.mv || g.nominal.mv) / g.nominal.mv - 1))) });
  if (!lodged) {
    const cr = crackCue(g, tBlast + 0.002, ev.mv);
    if (cr) { cr.layer = "crack"; cues.push(cr); }
  }
  // ---- the action, read off the sim's own trace
  const xt = ev.xt || [];
  let eject = null;
  if (ev.gun === "AK" && ev.info && xt.length) {
    const G = AK.G, info = ev.info, base = tIg + (info.t0 || 0), mc = g.mCarrier;
    const un = crossTime(xt, G.x_free);
    if (un) cues.push(impact(base + un.t, g.receiver.slice(-4), g.mBolt * (info.v_unlock || un.v) * 0.3, 60e-6, LEVEL.action, { layer: "action" }));
    if (un) samples.push({ t: base + un.t, name: "ak_bolt", gainDb: 0, rate: 1 });
    const ej = crossTime(xt, G.x_eject);
    const ejected = ev.type === "ok" || !["failure_to_extract", "failure_to_eject", "squib_bullet_lodged"].includes(ev.kind);
    if (ej && ejected && info.v_eject) {
      cues.push(impact(base + ej.t, g.caseModes, g.caseM * info.v_eject * 1.5, 50e-6, LEVEL.action * 0.8, { layer: "action" }));
      eject = { t: base + ej.t, v: info.v_eject * g.eject.ratio };
    }
    const rear = crossTime(xt, G.x_stroke - 5e-4);
    if (rear && info.v_at_rear) {
      const J = mc * info.v_at_rear * 1.3;
      cues.push(impact(base + rear.t, g.receiver, J, 70e-6, LEVEL.action, { layer: "action" }));
      cues.push(impact(base + rear.t, g.springModes, J, 2e-3, LEVEL.spring * 10, { layer: "action" }));
    }
    if (info.t_battery && info.v_battery) {
      const tb = tIg + info.t_battery, J = mc * Math.abs(info.v_battery);
      if (info.chambered) cues.push({ k: "scrape", t: tb - 0.012, dur: 0.012, A: LEVEL.scrape * 1.5, fc: 2600, layer: "action" });
      cues.push(impact(tb, g.receiver, J, 60e-6, LEVEL.action * 1.1, { layer: "action" }));
    }
  } else if (ev.gun === "MAK" && ev.res && xt.length) {
    const res = ev.res, base = tIg, ms = g.mCarrier;
    const ck = crossTime(xt, g.xCock);
    if (ck) cues.push(impact(base + ck.t, g.receiver.slice(0, 4), 0.006 * ck.v, 40e-6, LEVEL.action * 0.6, { layer: "action" }));
    if (ck) samples.push({ t: base + ck.t, name: "mak_slide", gainDb: 0, rate: 1 });
    const ej = crossTime(xt, g.xEj);
    if (ej && res.ejected && res.v_at_ejector) {
      cues.push(impact(base + ej.t, g.caseModes, g.caseM * res.v_at_ejector * 1.5, 50e-6, LEVEL.action * 0.8, { layer: "action" }));
      eject = { t: base + ej.t, v: res.v_at_ejector * g.eject.ratio };
    }
    let iMax = 0; for (let i = 0; i < xt.length; i++) if (xt[i][1] > xt[iMax][1]) iMax = i;
    if (xt[iMax][1] >= g.slideTravel - 1e-4 && iMax > 0) {
      const v = (xt[iMax][1] - xt[iMax - 1][1]) / Math.max(xt[iMax][0] - xt[iMax - 1][0], 1e-9);
      const J = ms * v * 1.25;
      cues.push(impact(base + xt[iMax][0], g.receiver, J, 60e-6, LEVEL.action, { layer: "action" }));
      cues.push(impact(base + xt[iMax][0], g.springModes, J, 2e-3, LEVEL.spring * 10, { layer: "action" }));
    }
    const last = xt[xt.length - 1];
    if (ev.lockedOpen) cues.push(impact(base + last[0], g.receiver.slice(0, 4), 0.02, 50e-6, LEVEL.action, { layer: "action" }));
    else if (last[1] <= 1e-4 && xt.length > 2) {
      const p = xt[xt.length - 2], v = Math.abs((last[1] - p[1]) / Math.max(last[0] - p[0], 1e-9));
      if (ev.magBefore > 0) cues.push({ k: "scrape", t: base + last[0] - 0.006, dur: 0.006, A: LEVEL.scrape, fc: 3200, layer: "action" });
      cues.push(impact(base + last[0], g.receiver, ms * v, 60e-6, LEVEL.action * 1.1, { layer: "action" }));
    }
  }
  // a dirty / fouled action: grit and carbon dragging on the rails over the whole stroke (louder, rougher, longer)
  if (grit > 0.02 && xt.length) {
    const tS = tIg + (ev.gun === "AK" && ev.info ? ev.info.t0 || 0 : 0), tE = tS + xt[xt.length - 1][0];
    for (let k = 0; k < 6; k++) cues.push({ k: "scrape", t: tS + (tE - tS) * k / 6, dur: (tE - tS) / 6, A: LEVEL.scrape * (2 + 16 * grit), fc: 900 + 2600 * ((k * 0.37) % 1), layer: "action" });
  }
  if (eject && !noDrop) {
    const e = g.eject, cs = caseSpec(g, caseMat);
    const d = dropCue(g, "case", eject.t, { v: eject.v, elev: e.elev, az: e.az, h0: e.h0, mass: cs.mass, seed: seed ^ 0x9e37, surface, layer: "case" });
    d.caseMat = caseMat; cues.push(d);
    samples.push(caseSample(g, cs.mat, surface, { t: d.bounces.length ? d.bounces[0].t : d.t, gainDb: 20 * Math.log10(2 / Math.max(d.dist, 1)), rate: 1, pan: d.pan }));
  }
  return finish({ gun: g.id, cues, samples, seed, Eg: bl.Eg, R0: bl.R0, crack: cues.some((c) => c.k === "crack"), eject });
}

export function planDry(gunId, { energy, primer = false, seed = 7 } = {}) {
  const g = GUNS[gunId];
  const E = energy || g.hammerE;
  const cues = [impact(0, g.receiver, Math.sqrt(2 * g.mHammer * E), primer ? 90e-6 : 40e-6, LEVEL.hammer * 1.3, { layer: "dry" })];
  return finish({ gun: gunId, cues, samples: [{ t: 0, name: "dry_click", gainDb: 10 * Math.log10(E / g.hammerE), rate: 1 }], seed });
}

// RELOAD: release the magazine, it falls and lands on the surface; new magazine in; rack / slide release if needed.
export function planReload(gunId, { roundsLeft = 0, racked = false, surface = "concrete", seed = 11, slideLocked = false } = {}) {
  const g = GUNS[gunId], m = g.mag, cues = [], samples = [];
  const r = rng(seed);
  cues.push(impact(0, g.receiver.slice(0, 5), m.release, 40e-6, LEVEL.action * 2, { layer: "mag" }));
  cues.push({ k: "scrape", t: 0.005, dur: gunId === "AK" ? 0.07 : 0.04, A: LEVEL.scrape * 1.4, fc: 1800, layer: "mag" });
  samples.push({ t: 0, name: `${gunId.toLowerCase()}_mag_out`, gainDb: 0, rate: 1 });
  const mass = m.m + roundsLeft * g.roundM;
  const d = dropCue(g, "mag", 0.04, { v: 0.4, elev: -10, az: gunId === "AK" ? 10 : -20, h0: m.dropH, mass, seed: seed ^ 0x51ed, surface, layer: "mag" });
  d.loaded = roundsLeft; cues.push(d);
  const tIn = 0.95 + 0.1 * r();
  cues.push({ k: "scrape", t: tIn, dur: 0.06, A: LEVEL.scrape * 1.2, fc: 2200, layer: "mag" });
  cues.push(impact(tIn + 0.06, g.receiver, m.release * 3, 40e-6, LEVEL.action * 2, { layer: "mag" }));
  samples.push({ t: tIn, name: `${gunId.toLowerCase()}_mag_in`, gainDb: 0, rate: 1 });
  if (racked) {
    const rk = planRack(gunId, { t0: tIn + 0.35, slideRelease: gunId === "MAK" && slideLocked, eject: null, surface, seed: seed ^ 0x77 });
    cues.push(...rk.cues); samples.push(...rk.samples);
  }
  return finish({ gun: gunId, cues, samples, seed, magDrop: d });
}

// the two halves of a reload on their own, for the page's 3D timeline (the magazine's floor contacts come from planContact)
export function planMagOut(gunId) {
  const g = GUNS[gunId];
  return finish({ gun: gunId, seed: 21, cues: [impact(0, g.receiver.slice(0, 5), g.mag.release, 40e-6, LEVEL.action * 2, { layer: "mag" }),
    { k: "scrape", t: 0.005, dur: gunId === "AK" ? 0.07 : 0.04, A: LEVEL.scrape * 1.4, fc: 1800, layer: "mag" }],
    samples: [{ t: 0, name: `${gunId.toLowerCase()}_mag_out`, gainDb: 0, rate: 1 }] });
}
export function planMagIn(gunId) {
  const g = GUNS[gunId];
  return finish({ gun: gunId, seed: 22, cues: [{ k: "scrape", t: 0, dur: 0.06, A: LEVEL.scrape * 1.2, fc: 2200, layer: "mag" },
    impact(0.06, g.receiver, g.mag.release * 3, 40e-6, LEVEL.action * 2, { layer: "mag" })],
    samples: [{ t: 0, name: `${gunId.toLowerCase()}_mag_in`, gainDb: 0, rate: 1 }] });
}

// JAMS and CLEARING (random jams on the page). Each event is synthesised from the same parts as the shot: impacts on
// the receiver / case / magazine modes and friction scrapes. Sample sets play jam_* / clear_* files (or a stand-in).
export function planEvent(kind, gunId, { surface = "concrete", seed = 31 } = {}) {
  const g = GUNS[gunId], cues = [], samples = [];
  const name = { rack: gunId === "AK" ? "clear_rack_ak" : "clear_slide_mak" }[kind] || kind;
  if (kind === "jam_click") cues.push(impact(0, g.receiver, Math.sqrt(2 * g.mHammer * g.hammerE), 90e-6, LEVEL.hammer * 1.3, { layer: "dry" }));
  else if (kind === "jam_stovepipe") {   // the carrier slams forward onto the case pinched in the port: dull, short
    cues.push(impact(0, g.caseModes, g.caseM * 3.0, 40e-6, LEVEL.action * 1.6, { layer: "action", qScale: 0.1 }));
    cues.push(impact(0.002, g.receiver, g.mCarrier * 1.2, 80e-6, LEVEL.action * 0.8, { layer: "action" }));
  } else if (kind === "jam_dbl_feed") {   // round driven into the case still in the chamber: crunch + scrape + stop
    cues.push({ k: "scrape", t: 0, dur: 0.02, A: LEVEL.scrape * 2, fc: 2400, layer: "action" });
    cues.push(impact(0.02, g.roundModes, g.roundM * 3.5, 120e-6, LEVEL.action * 1.2, { layer: "action" }));
    cues.push(impact(0.022, g.receiver, g.mCarrier * 2.0, 150e-6, LEVEL.action, { layer: "action" }));
  } else if (kind === "clear_tap") {     // palm slap on the magazine floorplate
    cues.push(impact(0, g.magModes, 0.4, 3e-4, LEVEL.action * 3, { layer: "mag", qScale: 0.4 }));
    cues.push(impact(0.001, g.receiver.slice(0, 4), 0.05, 300e-6, LEVEL.action, { layer: "mag" }));
  } else if (kind === "clear_mag_strip") {   // magazine ripped out against the double-fed round's drag
    cues.push(impact(0, g.receiver.slice(0, 5), g.mag.release * 1.5, 40e-6, LEVEL.action * 2, { layer: "mag" }));
    cues.push({ k: "scrape", t: 0.004, dur: 0.12, A: LEVEL.scrape * 2.2, fc: 1600, layer: "mag" });
  } else if (kind === "rack") return planRack(gunId, { eject: null, surface, seed });
  else if (/^impact_/.test(kind)) {   // bullet striking the target / backstop, heard from the firing line
    const mat = kind.slice(7), A = LEVEL.action * 6;
    if (mat === "steel") cues.push(impact(0, plateModes(MAT.steel, 0.3, 0.45, 9e-3, 120, 6000, 6, [0.45, 0.4]), 2.5, 20e-6, A, { layer: "impact" }));
    else if (mat === "wood") cues.push(impact(0, plank, 1.2, 150e-6, A * 1.5, { layer: "impact" }));
    else cues.push({ k: "scrape", t: 0, dur: mat === "paper" ? 0.012 : 0.03, A: A * (mat === "paper" ? 1.2 : 2), fc: mat === "paper" ? 1800 : 400, layer: "impact" });
  } else if (kind === "ricochet") cues.push({ k: "whine", t: 0, dur: 0.45, A: LEVEL.action * 3, f0: 3800, f1: 900, layer: "impact" });
  else if (kind === "barrel_tick") for (let k = 0; k < 4; k++) cues.push(impact(0.25 * k + 0.07 * ((seed * (k + 3)) % 5), g.receiver.slice(-3), 0.002, 20e-6, LEVEL.action, { layer: "action" }));
  else if (kind === "echo_roll") { /* the synth's outdoor space already carries the roll */ }
  samples.push({ t: 0, name, gainDb: 0, rate: 1 });
  return finish({ gun: gunId, cues, samples, seed });
}
// a sound heard from a distance d (m): level by 1/d against 10 m, high frequencies lost on the way (synth cues)
export function atDistance(plan, d) {
  const g = Math.min(1, 10 / Math.max(d, 1));
  for (const c of plan.cues) { if (c.A) c.A *= g; }
  for (const s of plan.samples) s.gainDb = (s.gainDb || 0) + 20 * Math.log10(g);
  return plan;
}

// RACK (clear jam / charge): hand pulls the carrier or slide back, releases it into battery; ejects a case or a live round.
export function planRack(gunId, { t0 = 0, eject = "case", surface = "concrete", seed = 13, slideRelease = false } = {}) {
  const g = GUNS[gunId], cues = [], samples = [];
  const back = slideRelease ? 0 : 0.16;
  if (!slideRelease) {
    cues.push({ k: "scrape", t: t0, dur: back, A: LEVEL.scrape * 1.2, fc: gunId === "AK" ? 1500 : 2400, layer: "action" });
    cues.push(impact(t0 + back, g.receiver, g.mCarrier * 1.2, 120e-6, LEVEL.action * 0.6, { layer: "action" }));
  } else cues.push(impact(t0, g.receiver.slice(0, 4), 0.01, 40e-6, LEVEL.action, { layer: "action" }));
  const vFwd = gunId === "AK" ? 3.8 : 3.0;            // spring-driven return, as the sim's v_battery (ASSUMED for a hand rack)
  const tf = t0 + back + 0.11;
  cues.push({ k: "scrape", t: tf - 0.03, dur: 0.03, A: LEVEL.scrape, fc: 2600, layer: "action" });
  cues.push(impact(tf, g.receiver, g.mCarrier * vFwd, 60e-6, LEVEL.action * 1.1, { layer: "action" }));
  samples.push({ t: t0, name: gunId === "AK" ? "clear_rack_ak" : "clear_slide_mak", gainDb: 0, rate: 1 });
  if (eject) {
    const live = eject === "round", e = g.eject;
    const d = dropCue(g, live ? "round" : "case", t0 + back * 0.7, { v: 2.0, elev: e.elev + 20, az: e.az, h0: e.h0, mass: live ? g.roundM : g.caseM, seed: seed ^ 0xabc, surface, layer: "case" });
    cues.push(d);
    samples.push({ t: d.bounces.length ? d.bounces[0].t : d.t, name: `brass_${g.calibre}_${surface}`, gainDb: 20 * Math.log10(2 / Math.max(d.dist, 1)) + (live ? -3 : 0), rate: live ? 0.85 : 1, pan: d.pan });
  }
  return finish({ gun: gunId, cues, samples, seed });
}

function finish(plan) {
  let end = 0;
  for (const c of plan.cues) {
    let e = c.t + 0.3;
    if (c.k === "drop") { const b = c.bounces[c.bounces.length - 1]; e = Math.max(c.roll.t + c.roll.dur, b ? b.t : c.t) + 0.6; }
    end = Math.max(end, e);
  }
  plan.dur = end;
  return plan;
}

// ------------------------------------------------------------------ DSP primitives
const contactW = (f, tau) => { const x = 2 * f * tau; if (Math.abs(1 - x * x) < 1e-3) return Math.PI / 4; return Math.abs(Math.cos(Math.PI * f * tau) / (1 - x * x)); };
function addModes(buf, i0, modes, amp, tau, sr, maxLen = 1.5, qScale = 1) {
  for (const m of modes) {
    if (m.f >= sr * 0.45) continue;
    const a = amp * m.a * contactW(m.f, tau);
    if (!(a > 1e-5)) continue;
    const q = m.q * qScale;
    const r = Math.exp(-Math.PI * m.f / (q * sr)), om = TAU * m.f / sr;
    const n = Math.min(buf.length - i0, Math.ceil(Math.log(a / 1e-5) * q * sr / (Math.PI * m.f)), Math.floor(maxLen * sr));
    if (n <= 0) continue;
    const c2 = 2 * r * Math.cos(om), d2 = r * r;
    let y2 = 0, y1 = a * r * Math.sin(om);
    buf[i0] += 0;
    if (n > 1) buf[i0 + 1] += y1;
    for (let i = 2; i < n; i++) { const y = c2 * y1 - d2 * y2; buf[i0 + i] += y; y2 = y1; y1 = y; }
  }
}
// biquad band-pass (RBJ, constant 0 dB peak) applied in place over [i0, i1)
function bandpass(x, fc, Q, sr) {
  const w = TAU * Math.min(fc, sr * 0.45) / sr, al = Math.sin(w) / (2 * Q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y; }
  return x;
}
function lowpass1(x, fc, sr) { const k = 1 - Math.exp(-TAU * fc / sr); let y = 0; for (let i = 0; i < x.length; i++) { y += k * (x[i] - y); x[i] = y; } return x; }
function noiseBurst(n, r) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = r() * 2 - 1; return x; }

// ------------------------------------------------------------------ cue renderers (mono, into a bus at sample offset)
function renderBlast(c, sr) {
  const r = rng(c.seed || 1);
  const n = Math.ceil((c.Tp * 12 + 0.06) * sr), x = new Float32Array(n);
  const nr = Math.max(1, Math.round(c.rise * sr)), b = 1.4;
  for (let i = 0; i < n; i++) {   // Friedlander wave with a finite rise
    const t = i / sr - c.rise; if (t < -c.rise) continue;
    const up = i < nr ? 0.5 - 0.5 * Math.cos(Math.PI * i / nr) : 1;
    const tt = Math.max(t, 0);
    x[i] += c.A * up * (1 - tt / c.Tp) * Math.exp(-b * tt / c.Tp);
  }
  const fj = C_AIR / c.R0;                      // turbulent jet / gas-cloud noise, centred on the cloud's own scale
  const jet = bandpass(noiseBurst(n, r), fj, 0.7, sr), tj = 4 * c.Tp + 0.002;
  const fb = C_AIR / (TAU * c.R0), ob = TAU * fb / sr, db = Math.exp(-Math.PI * fb / (1.3 * sr));   // low "body" of the expanding cloud
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] += c.A * 0.9 * jet[i] * Math.exp(-t / tj) * (c.lodged ? 0.3 : 1);
    x[i] += c.A * 0.45 * Math.pow(db, i) * Math.sin(ob * i);
  }
  if (c.lodged) lowpass1(x, 900, sr);
  return x;
}
function renderCrack(c, sr) {
  // N-wave: +A step, linear fall to -A over T, step back to 0; edges spread over ~40 us so the step is band-limited
  const edge = Math.max(2, Math.round(40e-6 * sr)), nT = Math.max(3, Math.round(c.T * sr));
  const x = new Float32Array(nT + 2 * edge + 4);
  for (let i = 0; i < x.length; i++) {
    const t = (i - edge) / nT;
    let v = 0;
    if (t >= 0 && t <= 1) v = c.A * (1 - 2 * t);
    const e0 = Math.min(1, Math.max(0, (i + 0.5) / edge)), e1 = Math.min(1, Math.max(0, (nT + 2 * edge - i) / edge));
    x[i] = v * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(e0, e1)));
  }
  return x;
}
function renderImpact(c, sr, r) {
  const n = Math.ceil(1.6 * sr), x = new Float32Array(n);
  addModes(x, 0, c.modes, c.A, c.tau, sr, 1.5, c.qScale || 1);
  const nc = Math.max(8, Math.round(Math.max(c.tau, 2e-4) * sr));   // contact click
  for (let i = 0; i < nc; i++) x[i] += c.A * 0.25 * (r() * 2 - 1) * (1 - i / nc);
  return trimTail(x);
}
function renderWhine(c, sr, r) {   // ricochet: a tumbling fragment's falling whistle
  const n = Math.ceil(c.dur * sr), x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / n, f = c.f0 * Math.pow(c.f1 / c.f0, u); ph += TAU * f * (1 + 0.04 * Math.sin(TAU * 31 * i / sr)) / sr; x[i] = c.A * Math.sin(ph) * Math.sin(Math.PI * Math.min(1, u * 8)) * (1 - u) + c.A * 0.2 * (r() * 2 - 1) * (1 - u); }
  return x;
}
function renderScrape(c, sr, r) {
  const n = Math.max(8, Math.ceil(c.dur * sr)), x = bandpass(noiseBurst(n, r), c.fc, 1.2, sr);
  for (let i = 0; i < n; i++) x[i] *= c.A * 2.5 * Math.sin(Math.PI * i / n) * (0.6 + 0.4 * Math.abs(Math.sin(i * 0.013)));
  return x;
}
let plateCache = {};
function surfaceModes(S, pos) {
  if (S.modes !== "plate") return S.modes;
  const at = [0.5 + 0.12 * Math.sin(pos[0] * 3.1), 0.5 + 0.12 * Math.sin(pos[1] * 2.3)];   // hit point on the plate
  const key = at.map((v) => v.toFixed(2)).join(",");
  return plateCache[key] || (plateCache[key] = plateModes(MAT.steel, 1.0, 0.5, 3e-3, 260, 6000, 10, at));
}
function renderDrop(c, sr) {
  const g = GUNS[c.gun], S = SURFACES[c.surface] || SURFACES.concrete, r = rng(c.seed);
  const t0 = c.t, last = c.bounces.length ? c.bounces[c.bounces.length - 1].t : t0;
  const n = Math.ceil((Math.max(last, c.roll.t + c.roll.dur) - t0 + 1.2) * sr), x = new Float32Array(n);
  const cs = caseSpec(g, c.caseMat);
  const objModes = c.obj === "mag" ? g.magModes : c.obj === "round" ? cs.roundModes : cs.modes;
  const att = Math.min(1, 2 / Math.max(c.dist, 0.5)) * LEVEL.drop;
  const sModes = S.modes ? surfaceModes(S, c.pos) : null;
  const loadedDamp = c.obj === "mag" && c.loaded ? 0.35 : 1;
  for (let k = 0; k < c.bounces.length; k++) {
    const b = c.bounces[k], i0 = Math.round((b.t - t0) * sr);
    if (i0 >= n) break;
    const next = c.bounces[k + 1];
    const gap = next ? next.t - b.t : c.nextGap;
    const isLast = !gap;
    // the shell rings freely until the next contact; once it lies on the surface the surface damps it
    let qScale = isLast ? S.rest : Math.min(1, (Math.PI * 7000 * gap * 1.5) / 1500);
    if (c.obj === "mag") qScale = isLast ? Math.max(S.rest, 0.2) : 1;
    qScale *= loadedDamp;
    const endW = 0.6 + 0.8 * b.end;   // head-first hits ring more than mouth-first ones
    const A = c.obj === "mag" ? att * 0.55 * Math.pow(b.J / 1.0, 0.4) : att * Math.pow(b.J / 0.03, 0.8);
    addModes(x, i0, objModes, A * endW, S.tau, sr, isLast ? 1.2 : 0.8, Math.max(qScale, 0.01));
    if (sModes) addModes(x, i0, k < 4 ? sModes : sModes.slice(0, 8), A * (S.modeGain || 1) * (c.obj === "mag" ? 0.6 : 1), S.tau * 2, sr, k < 2 ? 0.9 : 0.35);
    // contact noise: a hard floor gives a short bright tick, dirt a dull low thud
    const nc = Math.round(Math.max(S.tau, 1.5e-4) * sr * (S.thud > 0.5 ? 4 : 1));
    const burst = noiseBurst(nc + 8, r);
    if (S.thud > 0.5) lowpass1(burst, 260, sr);
    if (S.splash) { const sp = bandpass(noiseBurst(Math.round(0.08 * sr), r), 2500, 0.6, sr); for (let i = 0; i < sp.length && i0 + i < n; i++) x[i0 + i] += A * 1.2 * sp[i] * Math.exp(-i / (0.02 * sr)); }
    for (let i = 0; i < burst.length && i0 + i < n; i++) x[i0 + i] += A * (S.click * 0.5 + S.thud * 1.8) * burst[i] * (1 - i / burst.length);
    if (c.obj === "mag") {   // follower / spring (and any rounds) rattle inside the body
      const rattles = c.loaded ? 6 : 3;
      for (let j = 0; j < rattles; j++) {
        const ij = i0 + Math.round((0.004 + 0.03 * r()) * sr);
        if (ij < n) addModes(x, ij, c.loaded ? g.roundModes : g.magModes.slice(-6), A * 0.12 * (0.4 + r()), 60e-6, sr, 0.3, 0.3);
      }
    }
  }
  // rolling: friction noise coloured by the surface, modulated at the case's own rotation rate, grit ticks ring the case
  const R = c.roll;
  if (R.dur > 0.02 && c.obj !== "mag") {
    const i0 = Math.round((R.t - t0) * sr), nr = Math.min(n - i0, Math.round(R.dur * sr));
    if (nr > 0) {
      const nz = bandpass(noiseBurst(nr, r), S.rollF, S.rollQ, sr);
      const rr = g.caseR;
      let ph = 0;
      for (let i = 0; i < nr; i++) {
        const u = i / nr, v = R.v0 * (1 - u);
        ph += v / (TAU * rr) / sr;
        const env = Math.pow(v / Math.max(R.v0, 1e-3), 1.2) * (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * ph)));
        x[i0 + i] += LEVEL.roll * Math.min(1, 2 / c.dist) * Math.min(1, R.v0 / 0.5) * env * nz[i] * 3;
        if (S.grit > 0 && r() < S.grit * v * 25 / sr) addModes(x, i0 + i, objModes.slice(0, 1), att * 0.05 * (0.3 + r()) * v, 40e-6, sr, 0.04, S.rest);
      }
    }
  }
  return trimTail(x, true);
}
function trimTail(x, keepStart = false) {
  let e = x.length - 1;
  while (e > 0 && Math.abs(x[e]) < 1e-6) e--;
  return keepStart || e < x.length - 1 ? x.subarray(0, e + 1) : x;
}

// ------------------------------------------------------------------ space (ground reflection, early echoes, diffuse tail)
function groundReflect(L, R, air, surface, sr) {
  const S = SURFACES[surface] || SURFACES.concrete;
  // ground reflection of the airborne sounds (muzzle 1.5 m up, ear 1.65 m): ~7 ms later, scaled by the surface
  const dG = Math.round(0.0069 * sr), gG = 0.55 * S.refl;
  const refl = new Float32Array(air.length); for (let i = dG; i < air.length; i++) refl[i] = air[i - dG] * gG;
  if (S.refl < 0.6) lowpass1(refl, 1500, sr);
  for (let i = 0; i < air.length; i++) { L[i] += refl[i]; R[i] += refl[i]; }
}
// early reflections (berms / walls) + Schroeder/Freeverb diffuse tail; adds the wet signal of `mono` into L, R
function roomTail(L, R, mono, space, sr) {
  const sp = SPACES[space] || SPACES.outdoor;
  if (sp.outdoor) return outdoorTail(L, R, mono, sp, sr);
  const er = lowpass1(Float32Array.from(mono), 3000, sr);
  for (const [d, gn] of sp.early) {
    const k = Math.round(d * sr), side = (Math.round(d * 1000) % 2) ? 1 : 0;
    for (let i = k; i < L.length; i++) { const v = er[i - k] * gn; if (side) { L[i] += v * 0.8; R[i] += v * 0.5; } else { L[i] += v * 0.5; R[i] += v * 0.8; } }
  }
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225], scale = sr / 44100;
  const tails = [0, 23].map((spread) => {
    const out = new Float32Array(L.length);
    for (const c of combs) {
      const d = Math.round((c + spread) * scale), fb = Math.pow(10, -3 * d / (sp.rt * sr)), buf = new Float32Array(d);
      let p = 0, lp = 0;
      for (let i = 0; i < mono.length; i++) { const y = buf[p]; lp = y * (1 - sp.damp) + lp * sp.damp; buf[p] = mono[i] + lp * fb; p = (p + 1) % d; out[i] += y; }
    }
    for (const a of aps) {
      const d = Math.round((a + spread) * scale), buf = new Float32Array(d); let p = 0;
      for (let i = 0; i < out.length; i++) { const b = buf[p]; const y = -out[i] + b; buf[p] = out[i] + b * 0.5; p = (p + 1) % d; out[i] = y; }
    }
    return out;
  });
  const w = sp.wet / combs.length * 2;
  for (let i = 0; i < L.length; i++) { L[i] += tails[0][i] * w; R[i] += tails[1][i] * w; }
}
function delayLP(src, d, gain, fc, sr, L, R, wl = 0.5, wr = 0.5) {
  const k = Math.round(d * sr), y = lowpass1(lowpass1(Float32Array.from(src), fc, sr), fc, sr);
  for (let i = k; i < L.length; i++) { const v = y[i - k] * gain; L[i] += v * wl * 2; R[i] += v * wr * 2; }
}
function outdoorTail(L, R, mono, sp, sr) {
  sp.echoes.forEach(([d, g, fc], i) => delayLP(mono, d, g, fc, sr, L, R, i % 2 ? 0.62 : 0.38, i % 2 ? 0.38 : 0.62));
  // rolling decay: a heavily damped, long Schroeder tail, low-passed, after a pre-delay (distant terrain)
  const pre = Math.round(sp.rollPre * sr), src = lowpass1(Float32Array.from(mono), sp.rollLP, sr), n = L.length;
  const combs = [1557, 1617, 1491, 1422, 1277, 1356], scale = sr / 44100;
  const tails = [0, 31].map((spread) => {
    const out = new Float32Array(n);
    for (const c of combs) {
      const d = Math.round((c * 2.3 + spread) * scale), fb = Math.pow(10, -3 * d / (sp.rt * sr)), buf = new Float32Array(d);
      let p = 0, lp = 0;
      for (let i = 0; i < n; i++) { const x = i >= pre ? src[i - pre] : 0; const y = buf[p]; lp = y * (1 - sp.damp) + lp * sp.damp; buf[p] = x + lp * fb; p = (p + 1) % d; out[i] += y; }
    }
    return lowpass1(out, sp.rollLP * 1.5, sr);
  });
  const w = sp.roll / combs.length * 2;
  for (let i = 0; i < n; i++) { L[i] += tails[0][i] * w; R[i] += tails[1][i] * w; }
}

// The room as an impulse response (exactly roomTail applied to a unit impulse): the page runs it in a ConvolverNode,
// so a full-auto string shares one reverb whose tails ring under the next shot.
export function spaceIR(space, sr = SR) {
  const n = Math.ceil(((SPACES[space] || SPACES.outdoor).rt + 0.8) * sr);
  const L = new Float32Array(n), R = new Float32Array(n), mono = new Float32Array(n); mono[0] = 1;
  roomTail(L, R, mono, space, sr);
  return { L, R, sr };
}

// ------------------------------------------------------------------ mixdown
function highpassDC(x, sr, fc = 25) { const a = Math.exp(-TAU * fc / sr); let px = 0, py = 0; for (let i = 0; i < x.length; i++) { const y = a * (py + x[i] - px); px = x[i]; py = y; x[i] = y; } }
// look-ahead peak limiter: gain never lets a sample pass above `ceil` (the window includes the sample itself)
function limit(L, R, sr, ceil = CEILING) {
  const n = L.length, look = Math.max(1, Math.round(0.0015 * sr)), rel = Math.exp(-1 / (0.08 * sr));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.max(Math.abs(L[i]), Math.abs(R[i])); need[i] = p > ceil ? ceil / p : 1; }
  // running minimum of need over [i, i + look] (monotone deque)
  const target = new Float32Array(n), dq = new Int32Array(n); let h = 0, t = 0, j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && j <= i + look) { while (t > h && need[dq[t - 1]] >= need[j]) t--; dq[t++] = j; j++; }
    while (dq[h] < i) h++;
    target[i] = need[dq[h]];
  }
  let g = 1, minG = 1;
  for (let i = 0; i < n; i++) {
    g = target[i] < g ? target[i] : Math.min(1, target[i], 1 - (1 - g) * rel);
    if (g < minG) minG = g;
    L[i] *= g; R[i] *= g;
  }
  return -20 * Math.log10(minG);
}

// Render one or more plans placed at offsets: items = [{ plan, at }] or plans. Returns stereo Float32Arrays.
export function render(items, { sr = SR, space = "outdoor", surface = "concrete", only = null, dry = false, noLimit = false, crackSpace = undefined } = {}) {
  const list = (Array.isArray(items) ? items : [items]).map((it) => (it.plan ? it : { plan: it, at: 0 }));
  let dur = 0; for (const { plan, at } of list) dur = Math.max(dur, at + plan.dur);
  const tail = dry ? 0.05 : !space ? ((SPACES[crackSpace] || {}).outdoor ? 0.7 : 0.05) : (SPACES[space] || SPACES.outdoor).rt + 0.8;
  const n = Math.ceil((dur + tail) * sr) + 1;
  const L = new Float32Array(n), R = new Float32Array(n), air = new Float32Array(n), crackBus = new Float32Array(n);
  for (const { plan, at } of list) {
    const r = rng(plan.seed || 3);
    for (const c of plan.cues) {
      if (only && !only.includes(c.layer || c.k)) continue;
      let x, pan = 0, isAir = true;
      if (c.k === "blast") x = renderBlast(c, sr);
      else if (c.k === "crack") x = renderCrack(c, sr);
      else if (c.k === "impact") x = renderImpact(c, sr, r);
      else if (c.k === "scrape") x = renderScrape(c, sr, r);
      else if (c.k === "whine") x = renderWhine(c, sr, r);
      else if (c.k === "drop") { x = renderDrop(c, sr); pan = c.pan; isAir = false; }
      else continue;
      const i0 = Math.round((at + c.t) * sr);
      const gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
      for (let i = 0; i < x.length && i0 + i < n; i++) { const v = x[i]; L[i0 + i] += v * gl; R[i0 + i] += v * gr; if (isAir) air[i0 + i] += v; }
      if (c.k === "crack") for (let i = 0; i < x.length && i0 + i < n; i++) crackBus[i0 + i] += x[i];
    }
  }
  if (!dry) groundReflect(L, R, air, surface, sr);
  const cs = SPACES[crackSpace === undefined ? space : crackSpace];
  if (!dry && cs && cs.outdoor) for (const [d, g, fc] of cs.crackEchoes) delayLP(crackBus, d, g, fc, sr, L, R, 0.45, 0.55);
  if (!dry && space) { const mono = new Float32Array(n); for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i]); roomTail(L, R, mono, space, sr); }
  highpassDC(L, sr); highpassDC(R, sr);
  const grDb = noLimit ? 0 : limit(L, R, sr);
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  return { L, R, sr, peak, grDb };
}

// 16-bit PCM WAV
export function encodeWav(L, R, sr) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true);
    v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true);
  }
  return new Uint8Array(buf);
}

// ------------------------------------------------------------------ sample sets (AI / Recorded), played from the same plans
const SET_NAMES = ["ak_mag_out", "ak_mag_in", "ak_bolt", "mak_mag_out", "mak_mag_in", "mak_slide", "dry_click"];
export function parseManifest(m) {
  // tolerant: ["ak_shot_1.wav", ...] | [{file|path|src|name}] | {files: ...} | {name: "file"}
  const out = {};
  const add = (name, file) => { if (!file || typeof file !== "string") return; const base = (name || file).split("/").pop().replace(/\.[a-z0-9]+$/i, "").toLowerCase(); out[base] = file; };
  const walk = (x) => {
    if (Array.isArray(x)) for (const e of x) { if (typeof e === "string") add(null, e); else if (e && typeof e === "object") add(e.name || e.id || null, e.file || e.path || e.src || e.url); }
    else if (x && typeof x === "object") {
      if (x.files || x.samples || x.sounds) return walk(x.files || x.samples || x.sounds);
      for (const [k, v] of Object.entries(x)) { if (typeof v === "string") add(k, v); else if (v && typeof v === "object") add(k, v.file || v.path || v.src || v.url); }
    }
  };
  walk(m);
  return out;
}
// Variant families: "<family>_<N>" files (ak_shot_1..100, jam_click_1..) are picked from a shuffled bag: no variant
// repeats until every loaded one has played. Families with many files load lazily, a few at a time.
const VARIANT_FAMILIES = ["ak_shot", "mak_shot", "jam_click", "jam_stovepipe", "jam_dbl_feed", "clear_tap", "clear_rack_ak", "clear_slide_mak", "clear_mag_strip"];
// nearest stand-in when a set has no file for an event (e.g. the Recorded set has no jam files)
const FALLBACK = { jam_click: ["dry_click"], jam_stovepipe: ["ak_bolt", "mak_slide"], jam_dbl_feed: ["ak_bolt", "mak_slide"], clear_tap: ["ak_mag_in", "mak_mag_in"],
  clear_rack_ak: ["ak_bolt"], clear_slide_mak: ["mak_slide"], clear_mag_strip: ["ak_mag_out", "mak_mag_out"] };
const familyOf = (name) => { const m = /^(.*)_(\d+)$/.exec(name); return m ? m[1] : null; };   // any "<group>_<N>" is a variant group
const normName = (n) => n.toLowerCase().replace(/\./g, "");   // brass_7.62x39_grass == brass_762x39_grass
export class ShuffleBag {   // no repeat until all items are used; items added later join the current round
  constructor(seed = 1) { this.r = rng(seed); this.items = []; this.bag = []; this.last = null; }
  add(item) { if (this.items.includes(item)) return; this.items.push(item); this.bag.splice(Math.floor(this.r() * (this.bag.length + 1)), 0, item); }
  next() {
    if (!this.items.length) return null;
    if (!this.bag.length) {
      this.bag = this.items.slice();
      for (let i = this.bag.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]; }
      if (this.bag.length > 1 && this.bag[this.bag.length - 1] === this.last) [this.bag[0], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1], this.bag[0]];
    }
    return (this.last = this.bag.pop());
  }
}
export class SampleSet {
  constructor(base, fetchFn = globalThis.fetch && globalThis.fetch.bind(globalThis), { firstBatch = 4, batch = 3 } = {}) {
    Object.assign(this, { base, fetch: fetchFn, map: null, buffers: {}, ok: false, loading: null, bags: {}, pending: {}, firstBatch, batch, fetched: 0, ctx: null });
  }
  async probe() {   // reads only the manifest; audio files load lazily on selection
    try {
      const res = await this.fetch(this.base + "MANIFEST.json", { cache: "no-cache" });
      if (!res.ok) return (this.ok = false);
      this.map = parseManifest(await res.json());
      const has = (p) => Object.keys(this.map).some((k) => k.startsWith(p));
      this.ok = has("ak_shot") && has("mak_shot");
    } catch { this.ok = false; }
    return this.ok;
  }
  url(file) { return new URL(file, new URL(this.base, globalThis.location ? location.href : "http://x/")).href; }
  // A manifest entry is either a plain file ("ak_bolt.mp3") or a file inside a bundle ("ai-ak.bundle.json#ak_bolt.mp3"): the
  // artifact host caps the number of files, so the samples ship as a few bundles of base64 (a bundle loads once, on first use).
  async bytesOf(file) {
    const h = file.indexOf("#");
    if (h < 0) { const res = await this.fetch(this.url(file)); return res.ok ? res.arrayBuffer() : null; }
    const bf = file.slice(0, h), key = file.slice(h + 1);
    const bp = (this.bundles ||= {})[bf] ||= this.fetch(this.url(bf)).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.files) || null).catch(() => null);
    const files = await bp;
    if (!files || !files[key]) { if (!files) delete this.bundles[bf]; return null; }
    const bin = atob(files[key]), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  async loadOne(name) {
    if (this.buffers[name] || this.pending[name] === true) return;
    this.pending[name] = true;
    try {
      this.fetched++;
      const bytes = await this.bytesOf(this.map[name]);
      if (!bytes) return;
      this.buffers[name] = await this.ctx.decodeAudioData(bytes);
      const fam = familyOf(name);
      if (fam) (this.bags[fam] ||= new ShuffleBag(hashNums(this.base, fam))).add(name);
    } catch {} finally { this.pending[name] = "done"; }
  }
  // queue of variant files not loaded yet, per family
  rest(fam) { return Object.keys(this.map || {}).filter((k) => familyOf(k) === fam && !this.buffers[k] && !this.pending[k]); }
  realFamily(n) { if (!this.famIdx) { this.famIdx = new Map(); this.singIdx = new Map(); for (const k of Object.keys(this.map || {})) { const f = familyOf(k); if (f) this.famIdx.set(normName(f), f); else this.singIdx.set(normName(k), k); } } return this.famIdx.get(normName(n)); }
  realSingle(n) { this.realFamily(n); return this.singIdx.get(normName(n)); }
  // first use: every single file, plus the first few variants of each family; the rest follow a few at a time
  load(ctx) {
    if (this.loading) return this.loading;
    this.ctx = ctx;
    this.loading = (async () => {
      // on selection: the small single files and the first few shots of each gun (indoor and outdoor); every other group
      // loads the first time it is used
      const names = Object.keys(this.map || {}), first = [];
      for (const n of names) if (!familyOf(n) && !/^brass_/.test(n)) first.push(n);
      for (const fam of ["ak_shot", "mak_shot", "outdoor_ak_shot", "outdoor_mak_shot"]) first.push(...this.rest(fam).sort((a, b) => +a.split("_").pop() - +b.split("_").pop()).slice(0, this.firstBatch));
      await Promise.all(first.map((n) => this.loadOne(n)));
      this.ok = !!(this.bags.ak_shot && this.bags.mak_shot);
      return Object.keys(this.buffers).length;
    })();
    return this.loading;
  }
  topUp(fam) { const r = this.rest(fam).slice(0, this.batch); for (const n of r) this.loadOne(n); return r.length; }
  pick(name) {
    const fam = this.realFamily(name);
    if (fam) {
      const bag = this.bags[fam];
      this.topUp(fam);                                   // lazy: the group loads a few at a time from its first use
      if (bag) return this.buffers[bag.next()];
    }
    const single = this.realSingle(name);
    if (single) { if (this.buffers[single]) return this.buffers[single]; this.loadOne(single); }
    if (fam || single) { for (const f of FALLBACK[name] || []) if (this.buffers[f]) return this.buffers[f]; return null; }
    if (VARIANT_FAMILIES.includes(name)) { for (const f of FALLBACK[name] || []) if (this.buffers[f]) return this.buffers[f]; return null; }
    if (name.startsWith("brass_")) {   // brass_<calibre>_<surface>: tolerant calibre spelling, fall back to any calibre
      const [, cal, surf] = name.split("_");
      const digits = cal.replace(/\D/g, "");
      const keys = Object.keys(this.buffers).filter((k) => k.startsWith("brass_") && k.endsWith("_" + surf));
      return this.buffers[keys.find((k) => k.replace(/\D/g, "").startsWith(digits)) || keys[0]] || null;
    }
    if (this.buffers[name]) return this.buffers[name];
    for (const f of FALLBACK[name] || []) if (this.buffers[f]) return this.buffers[f];
    return null;
  }
  play(ctx, dest, plan, when, rate = 1, { space = null, dryDest = null } = {}) {   // returns how many cues were played from samples
    let n = 0;
    for (const s of plan.samples || []) {
      let b = null, r = s.rate || 1, lp = s.lowpass || 0, used = s.name, out = dest;
      // outdoor shots recorded with their own echoes and tail: use them dry, past the room convolver
      if (space === "outdoor" && /^(ak|mak)_shot$/.test(s.name) && this.realFamily("outdoor_" + s.name)) { b = this.pick("outdoor_" + s.name); if (b) { used = "outdoor_" + s.name; out = dryDest || dest; } }
      if (!b) b = this.pick(s.name, plan.gun);
      if (!b && s.alt) { b = this.pick(s.alt, plan.gun); r *= s.altRate || 1; lp = s.altLowpass || 0; used = s.alt; }
      if (!b) continue;
      const src = ctx.createBufferSource(); src.buffer = b; src.playbackRate.value = r * rate;
      const gn = ctx.createGain(); gn.gain.value = Math.pow(10, (s.gainDb || 0) / 20);
      let node = gn;
      if (lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; f.Q.value = 0.5; gn.connect(f); node = f; }
      this.lastPlayed = { name: used, rate: r, lowpass: lp };
      if (s.pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = s.pan; node.connect(p); node = p; }
      src.connect(gn); node.connect(out); src.start(when + s.t / rate); n++;
    }
    return n;
  }
}
export { SET_NAMES };

export function windLoop(sr = SR, seconds = 6) {   // brown-ish noise, slow gusts; loops seamlessly (cross-faded ends)
  const n = Math.round(seconds * sr), r = rng(77), x = new Float32Array(n); let b = 0;
  for (let i = 0; i < n; i++) { b = 0.995 * b + 0.05 * (r() * 2 - 1); x[i] = b * (0.6 + 0.4 * Math.sin(TAU * i / n * 3 + 1.3 * Math.sin(TAU * i / n))); }
  lowpass1(x, 700, sr); const f = Math.round(0.5 * sr); for (let i = 0; i < f; i++) { const w = i / f; x[i] = x[i] * w + x[n - f + i] * (1 - w); }
  return x.subarray(0, n - f);
}

// ------------------------------------------------------------------ Web Audio front end used by the page
// Each sound is rendered dry (with its ground reflection) and sent to the master bus and to ONE shared ConvolverNode
// that holds the room (spaceIR), so in full auto the tail of one shot rings under the next.
export class RangeAudio {
  constructor({ volume = 0.35, surface = "concrete", space = "outdoor", source = "synth", caseMat = null } = {}) {
    Object.assign(this, { volume, surface, space, source, caseMat, ctx: null, sets: {}, last: null, played: 0, rate: 1, muteSlow: false });
  }
  get available() { return !!(globalThis.AudioContext || globalThis.webkitAudioContext); }
  _ctx() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext; if (!AC) return null;
      try { this.ctx = new AC({ latencyHint: "interactive" }); } catch { return null; }
      const ctx = this.ctx;
      this.master = ctx.createGain(); this.master.gain.value = this.volume;
      const lim = ctx.createDynamicsCompressor();   // safety for overlapping full-auto tails
      lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
      this.master.connect(lim); lim.connect(ctx.destination);
      this.bus = ctx.createGain(); this.bus.connect(this.master);
      this.conv = ctx.createConvolver(); this.conv.normalize = false; this.conv.connect(this.master);
      this.bus.connect(this.conv); this._setIR();
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }
  _setIR() {
    if (!this.ctx) return;
    const ir = spaceIR(this.space, this.ctx.sampleRate), b = this.ctx.createBuffer(2, ir.L.length, ir.sr);
    b.getChannelData(0).set(ir.L); b.getChannelData(1).set(ir.R); this.conv.buffer = b;
  }
  setSpace(s) { this.space = s; this._setIR(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  addSet(id, base) { this.sets[id] = new SampleSet(base); return this.sets[id].probe(); }
  async useSource(id) {
    this.source = id;
    if (id === "synth") return true;
    const set = this.sets[id]; if (!set || !set.ok) { this.source = "synth"; return false; }
    const ctx = this._ctx(); if (!ctx) { this.source = "synth"; return false; }
    await set.load(ctx);
    if (!set.ok) { this.source = "synth"; return false; }
    return true;
  }
  _play(plan) {
    if (!plan || this.volume <= 0) return null;
    if (this.rate < 0.1 - 1e-9 && this.muteSlow) return null;   // below 1/10 slow motion: muted unless the viewer opts in
    const ctx = this._ctx(); if (!ctx) return null;
    const when = ctx.currentTime + 0.01;
    this.played++;
    const set = this.source !== "synth" ? this.sets[this.source] : null;
    if (set && set.ok && Object.keys(set.buffers).length && set.play(ctx, this.bus, plan, when, this.rate * (plan.pitch || 1), { space: this.space, dryDest: this.master }) > 0) { this.last = { source: this.source, cues: plan.samples.length }; return this.last; }
    const out = render(plan, { sr: ctx.sampleRate, space: null, crackSpace: this.space, surface: this.surface });
    const buf = ctx.createBuffer(2, out.L.length, out.sr);
    buf.getChannelData(0).set(out.L); buf.getChannelData(1).set(out.R);
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = this.rate * (plan.pitch || 1);
    let pg0 = null;
    if (plan.gain != null && plan.gain !== 1) { const pg = ctx.createGain(); pg.gain.value = plan.gain; src.connect(pg); pg.connect(this.bus); pg0 = pg; } else src.connect(this.bus);
    src.start(when);   // slow motion: pitch and time scale together
    if (plan.voice === "casing") {   // cap concurrent casing sounds: drop the oldest with a 25 ms fade
      const now = ctx.currentTime, dur = out.L.length / out.sr / Math.max(this.rate * (plan.pitch || 1), 1e-3);
      const live = (this._cv = (this._cv || []).filter((v) => v.end > now));
      const vg = ctx.createGain(); try { src.disconnect(); } catch {} src.connect(vg); vg.connect(pg0 || this.bus);
      live.push({ src, vg, end: when + dur });
      while (live.length > CASING_VOICES) { const o = live.shift(); try { o.vg.gain.setTargetAtTime(0, now, 0.008); o.src.stop(now + 0.05); } catch {} }
      this.casingStarts = (this.casingStarts || 0) + 1;
    }
    this.last = { source: "synth", peak: out.peak, grDb: out.grDb, seconds: out.L.length / out.sr, buffer: buf };
    return this.last;
  }
  plan(kind, a = {}) {
    const o = { surface: this.surface, caseMat: this.caseMat };
    if (kind === "shot") return planShot(a.ev, { ...o, noDrop: a.noDrop, grit: a.grit || 0, suppressed: !!a.suppressed });
    if (kind === "dry") return planDry(a.gun, { energy: a.energy });
    if (kind === "reload") return planReload(a.gun, { ...a, surface: this.surface });
    if (kind === "rack") return planRack(a.gun, { ...a, surface: this.surface });
    if (kind === "contact") return planContact({ ...o, ...a });
    if (kind === "magOut") return planMagOut(a.gun);
    if (kind === "magIn") return planMagIn(a.gun);
    if (kind === "event") return planEvent(a.name, a.gun, { surface: this.surface });
    return null;
  }
  shot(ev, opts = {}) { return this._play(this.plan("shot", { ev, ...opts })); }
  // Vykhor-6 (5.56 rotary): the AK shot plan re-pitched up (a 5.56 crack is higher and shorter), thinned and quieter as the rate climbs
  // (50 overlapping tails a second are a wall, so the case landings go above 22 shots/s and the voices are capped), over the motor whine
  gatShot(ev, opts = {}) {
    const hz = Math.max(1, (ev.rpm || 2000) / 60), now = this.ctx ? this.ctx.currentTime : 0, k = Math.min(1, hz / 50);
    this._gv = (this._gv || []).filter((t) => t > now);
    if (this._gv.length >= 20) return null;
    const plan = this.plan("shot", { ev: { ...ev, gun: "AK" }, ...opts }); if (!plan) return null;
    const gainDb = -1 - 8 * k, out = { ...plan, pitch: 1.12 + 0.1 * Math.random() + 0.1 * k, gain: Math.pow(10, gainDb / 20) };
    if (plan.samples) out.samples = plan.samples.filter((s) => hz < 22 || !/^brass/.test(s.name)).map((s) => ({ ...s, gainDb: (s.gainDb || 0) + gainDb }));
    if (plan.cues && hz >= 22) out.cues = plan.cues.filter((c) => c.k !== "case");
    this._gv.push(now + 0.3);
    return this._play(out);
  }
  // the electric drive: a brushless motor (3,200 / 5,300 / 8,000 rpm) through a 16:1 planetary; frac = cluster speed / HIGH speed
  gatMotor(frac) {
    const ctx = this._ctx(); if (!ctx || (this.volume <= 0 && !this.mot)) return;
    if (!this.mot) {
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o1.type = "sawtooth"; o2.type = "triangle"; f.type = "lowpass"; f.frequency.value = 1600; g.gain.value = 0;
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(this.master); o1.start(); o2.start(); this.mot = { o1, o2, g };
    }
    const t = ctx.currentTime, mute = this.rate < 0.1 - 1e-9 && this.muteSlow;
    this.mot.o1.frequency.setTargetAtTime(30 + 110 * frac, t, 0.05); this.mot.o2.frequency.setTargetAtTime((30 + 110 * frac) * 2.97, t, 0.05);
    this.mot.g.gain.setTargetAtTime(frac > 0.01 && !mute ? 0.03 + 0.05 * frac : 0, t, 0.08);
    this.motFrac = frac;
  }
  dry(gun, energy) { return this._play(this.plan("dry", { gun, energy })); }
  reload(gun, opts) { return this._play(this.plan("reload", { gun, ...opts })); }
  rack(gun, opts) { return this._play(this.plan("rack", { gun, ...opts })); }
  contact(opts) { return this._play(this.plan("contact", opts)); }
  magOut(gun) { return this._play(this.plan("magOut", { gun })); }
  magIn(gun) { return this._play(this.plan("magIn", { gun })); }
  event(name, gun, { distance = 0 } = {}) { const p = this.plan("event", { name, gun }); return this._play(distance ? atDistance(p, distance) : p); }
  // a low wind loop: the AI set's ambience_wind files when that set is chosen, else the synth loop
  setAmbience(on) {
    this.ambience = on;
    if (this.ambSrc) { try { this.ambSrc.stop(); } catch {} this.ambSrc = null; }
    if (!on || this.volume <= 0) return;
    const ctx = this._ctx(); if (!ctx) return;
    const set = this.source !== "synth" ? this.sets[this.source] : null;
    let buf = set && set.ok ? set.pick("ambience_wind") : null;
    if (!buf) { const w = windLoop(ctx.sampleRate); buf = ctx.createBuffer(2, w.length, ctx.sampleRate); buf.getChannelData(0).set(w); buf.getChannelData(1).set(w.map((v, i) => w[(i + 2400) % w.length])); }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; const g = ctx.createGain(); g.gain.value = 0.18; src.connect(g); g.connect(this.master); src.start(); this.ambSrc = src;
  }
  // render the given plan through an OfflineAudioContext with the page's own graph (bus -> room convolver -> master)
  async offlineCheck(plan) {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext; if (!OAC) return null;
    const sr = 48000, out = render(plan, { sr, space: null, surface: this.surface });
    const ir = spaceIR(this.space, sr), n = out.L.length + ir.L.length;
    const ctx = new OAC(2, n, sr);
    const mk = (L, R) => { const b = ctx.createBuffer(2, L.length, sr); b.getChannelData(0).set(L); b.getChannelData(1).set(R); return b; };
    const master = ctx.createGain(); master.gain.value = this.volume;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    master.connect(lim); lim.connect(ctx.destination);
    const conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = mk(ir.L, ir.R); conv.connect(master);
    const src = ctx.createBufferSource(); src.buffer = mk(out.L, out.R); src.connect(master); src.connect(conv); src.start(0);
    const res = await ctx.startRendering();
    let peak = 0, e = 0; for (let c = 0; c < 2; c++) { const d = res.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; e += v * v; } }
    return { peak, rms: Math.sqrt(e / (2 * res.length)), seconds: res.length / sr };
  }
}
