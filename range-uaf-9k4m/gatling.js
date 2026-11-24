// Vykhor-6: the hand-held 5.56 rotary gun, for the Shooting Range page.
// The numbers are the ones in members/cloud-claude-work/exacto-sim/gatling/DESIGN.md and dims.py (branch mudel-master):
// 6 barrels x 330 mm, 5.56x45 M855 (4.02 g bullet, 1.68 g charge), muzzle velocity 885 m/s, rate LOW 1,200 / MID 2,000 / HIGH 3,000 rpm
// (rotary selector), 0.34 s spin-up to 95 %, a 120-round side box, impulse 5.79 N s per shot, +1.18 kJ per shot into the barrels (+5.9 K
// on ONE 0.43 kg barrel, so about +1 K on the cluster mean), trigger release = clearing (every round already in a tray is fired).
// This is a rate model, not the Python mechanism simulator: duds are thrown out and firing goes on (a rotary gun's advantage), so the
// page never shows a stoppage for this gun.
import { RNG, EXT, fmt } from "./sim.js";

export const GAT = {
  name: "Vykhor-6",
  RATES: { low: 1200, med: 2000, high: 3000 },
  SPIN_UP_S: 0.34, CAP: 120, BARRELS: 6,
  MV: 885, MV_SD: 5.5, PMAX_MPA: 380, PMAX_SD: 14,
  BULLET_G: 4.02, CHARGE_G: 1.68, BULLET_D: 5.70,
  IMPULSE_NS: 5.79, J_PER_SHOT: 1180, BARREL_KG: 0.43, STEEL_CP: 480,
  CLEAR_ROUNDS: 4,            // rounds already in the trays when the trigger is released (6 bolts, one at feed, one at eject)
  MASS_KG: 16.2,
  RECOIL_N: { low: 116, med: 193, high: 290 },
  MOTOR_RPM: { low: 3200, med: 5300, high: 8000 },
};
EXT.GAT = { bc_g7: 0.151, zero_m: 100, sight_h: 0.06, nominal_mv: GAT.MV, disp_moa: 4.0, label: "5.56x45 M855 from 13 in, G7 BC ~0.151 (approx.), rotary cluster spread ~4 MOA" };

// a gun state shaped like the AK's for the parts of the page that read it (temperature, dirt)
class GatState {
  constructor() { this.dirt = 0; this.carrier_foul = 0; this.port_foul = 0; this.fouling = 0; this.ambient_c = 21; this.barrel_c = 21; }
  cool(dt) { this.barrel_c = this.ambient_c + (this.barrel_c - this.ambient_c) * Math.exp(-dt / 55); }   // six barrels in the airflow of their own rotation
}

export class GatSession {
  constructor({ seed, cond = "clean", lot = "surplus" }) {
    this.gunName = "Vykhor-6 Gatling"; this.cap = GAT.CAP; this.seed = seed; this.cond = cond; this.lot = lot;
    this.rng = new RNG(seed); this.serial = 0; this.gun = new GatState();
    if (cond === "dirty") { this.gun.dirt = 0.4; this.gun.fouling = 0.5; } else if (cond === "sandy") { this.gun.dirt = 0.9; }
    this.mag = []; this.chamber = null; this.jam = null; this.magNo = 0; this.fired = 0; this.clock = 0; this.chamberedAt = 0; this.pulls = 0;
    this.rate = GAT.RATES.med; this.modeKey = "med"; this.hammer = "cocked"; this.locked = false;
  }
  setRate(key) { if (GAT.RATES[key]) { this.modeKey = key; this.rate = GAT.RATES[key]; } }
  newRound() {
    this.serial += 1; const r = this.rng;
    return { serial: this.serial, charge_g: GAT.CHARGE_G * (1 + 0.03 * r.stdNormal()), bullet_g: GAT.BULLET_G * (1 + 0.004 * r.stdNormal()), bullet_d: GAT.BULLET_D + 0.01 * r.stdNormal(),
      defects: [], dud: r.random() < (this.lot === "fresh" ? 0.0002 : 0.002) };
  }
  reload() {
    const rounds = []; for (let i = 0; i < this.cap; i++) rounds.push(this.newRound());
    this.mag = rounds; this.magNo += 1;
    let racked = false;
    if (!this.chamber) { this.chamber = this.mag.shift(); this.chamberedAt = this.clock; racked = true; }   // the belt feeds itself; "racked" only means the first round is in a tray
    return { racked };
  }
  advance(dt) { if (dt > 0) { this.clock += dt; this.gun.cool(dt); } }
  forceDud() { if (this.chamber) this.chamber.dud = true; }
  clearJam() { return null; }
  fire() {
    if (!this.chamber) return { type: "click", text: "Click - the box is empty. Reload." };
    this.pulls += 1;
    const rnd = this.chamber, r = this.rng, rate = this.rate;
    const ev = { gun: "AK", gat: true, round: rnd, mode: this.modeKey.toUpperCase(), rpm: rate, cyc: 60 / rate, t_lock: 4e-4, magBefore: this.mag.length, powder_c: this.gun.barrel_c };
    this.chamber = this.mag.length ? this.mag.shift() : null;
    this.chamberedAt = this.clock;
    if (rnd.dud) {   // a dud is extracted and thrown out; firing goes on
      ev.type = "ok"; ev.dud = true; ev.mv = 0; ev.text = `Round ${rnd.serial}: dud thrown out by the extractor, firing goes on (a rotary gun's advantage).`;
      ev.bal = { trace: [], t_exit: 0, exited: false, t_port_open: NaN };
      return ev;
    }
    const mv = GAT.MV * (1 + (this.lot === "fresh" ? 0.004 : 0.007) * r.stdNormal()) + GAT.MV_SD * 0 , pm = GAT.PMAX_MPA + GAT.PMAX_SD * r.stdNormal();
    this.fired += 1;
    this.gun.barrel_c += GAT.J_PER_SHOT / (GAT.BARREL_KG * GAT.BARRELS * GAT.STEEL_CP) * 1.0;   // the cluster-mean share of the 1.18 kJ
    this.gun.fouling = Math.min(1, this.gun.fouling + 0.0004);
    const tExit = 0.00075 + 0.00002 * r.stdNormal();
    ev.type = "ok"; ev.mv = mv; ev.pmax = pm * 1e6; ev.bal = { mv, pmax_breech: ev.pmax, trace: pressureTrace(pm * 1e6, tExit), t_exit: tExit, exited: true, t_port_open: NaN, charge: rnd.charge_g };
    ev.info = { v_eject: 7.5 }; ev.xt = [];
    ev.text = null;
    return ev;
  }
  status() {
    return { mag: this.mag.length, cap: this.cap, chambered: !!this.chamber, jam: null, barrel_c: this.gun.barrel_c, hammer: "cocked", locked: false };
  }
}

// a 5.56 pressure curve: fast rise to the peak, decay as the bullet travels 330 mm of barrel (shape only; the Range plots it)
function pressureTrace(pmax, tExit) {
  const out = [], n = 48, tPk = tExit * 0.22;
  for (let i = 0; i <= n; i++) { const t = (tExit * 1.6) * i / n; const p = t < tPk ? pmax * Math.sin((t / tPk) * Math.PI / 2) ** 1.6 : pmax * Math.exp(-(t - tPk) / (tExit * 0.55)); out.push([t, Math.max(0, p), 0]); }
  return out;
}

// ---- the rotor: the page's frame loop drives it. rpm is the CLUSTER speed (rate / 6 barrels).
export class Rotor {
  constructor() { this.deg = 0; this.rpm = 0; this.target = 0; this.runOn = 0; }
  // physical seconds: motor ramp to 95 % in 0.34 s (first-order, tau = 0.34/3), braking in about 0.6 s
  step(dt) {
    const up = this.target > this.rpm, tau = up ? GAT.SPIN_UP_S / 3 : 0.45;
    this.rpm += (this.target - this.rpm) * (1 - Math.exp(-dt / tau));
    if (this.rpm < 0.5 && this.target === 0) this.rpm = 0;
    this.deg = (this.deg + this.rpm * 6 * dt) % 360;
    return this.deg;
  }
  get frac() { return this.rpm / (GAT.RATES.high / GAT.BARRELS); }
}

export { fmt };
