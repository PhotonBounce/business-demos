// sim.js - JS port of the AK Claude and Makarov Claude simulators (exacto-sim ak47/sim, makarov/sim).
// Random numbers exist ONLY in the ammunition samplers (and the shooter's aim dispersion, which never
// touches the mechanism). Every stoppage is the outcome of a force / energy / travel / time inequality
// computed from the round's sampled physical properties and the gun's state, exactly as in the Python.
// Geometry-derived constants dumped from the Python sims (ak47/sim/geomlink.G, makarov dims + calibration.json)
const AKC = {"G":{"A_bore":4.69341993565337e-05,"bullet_base_s0_mm":28.749999999999996,"V_case_mm3":2307.416804898095,"V0":1.8594945444455868e-06,"travel":0.38625,"port_station_mm":255.0,"port_travel":0.22625,"jump_mm":3.6015000000000015,"A_port":3.141592653589793e-06,"A_piston":0.00020106192982974675,"A_vent":3.848451000647497e-05,"A_leak":5.089380098815447e-06,"V_pocket":1.108982206717197e-06,"m_carrier":0.44881491875,"m_bolt":0.10789432500000001,"m_firing_pin":0.0054204249999999995,"m_barrel":0.6284327312500001,"m_round_g":17.159265,"m_hammer":0.0578231,"I_hammer":5.220053749999995e-05,"hammer_strike_arm":0.05796173306587718,"x_free":0.0055,"x_unlocked":0.0135,"x_stroke":0.1,"x_eject":0.06825,"x_feed_clear":0.07314999999999998,"x_rim_contact":0.07064999999999998,"x_case_clear":0.053200000000000004,"x_autosear":0.003,"chamber_d_shoulder":10.12,"case_d_shoulder":10.07,"case_head_area":0.0001011769549042678,"case_wall_area":0.0010875408368564465},"K":{"BOLT_ROT":35.0,"CAM_TRAVEL":8.0,"FP_PROTRUSION":1.5,"CH_L1":30.25,"HEADSPACE_OFFSET":0.25,"C_L1":30.5,"CH_P2":10.12,"C_SHOULDER_D":10.07,"STACK_PITCH":5.7,"C_CASE_L":38.7,"CH_H1":8.74,"C_BULLET_D":7.92,"RX_U1":625.0,"SPRING_SEAT_U":455.0,"SPRING_WIRE_D":1.2,"SPRING_COIL_D":10.0,"SPRING_COILS":40.0,"GAS_VENT_TRAVEL":10.0,"GAS_POCKET_L":5.0,"FREE_TRAVEL":5.5,"STROKE":100.0,"BARREL_L":415.0},"HAMMER_PIVOT_MM":[492.5,-30.1],"nominal":{"mv":714.9748571450418,"pmax":295476964.2530307,"t_exit":0.0010517500000000585}};
const MKC = {"V":{"shear_modulus_gpa":79.3,"rs_wire":1.6,"rs_mean_d":15.0,"rs_active":14.0,"rs_free_len":115.0,"rs_installed_len":66.3,"hammer_cock_deg":62.0,"hammer_inertia":1.98e-06,"trigger_bar_ratio":0.62,"ms_hammer_torque_down":0.14,"ms_hammer_torque_cocked":0.3,"trigger_return_n":9.0,"disconnector_window_mm":0.6,"firing_pin_mass_g":6.29,"case_len":18.1,"ejector_z":-22.0,"slide_travel":32.0,"frame_stop_restitution":0.25,"mag_spring_n_one":18.0,"mag_spring_n_full":42.0,"feed_mu":0.3,"ramp_window_mm":1.55,"extractor_snap_n":14.0,"eject_min_mps":2.2,"extractor_claw_n":260.0,"chamber_rear_dia":10.05,"case_base_dia":9.95},"hammer_pivot":[-52.0,-16.0],"CAL":{"impetus_J_per_kg":850194.2646224052,"burn_B":0.0011818824669425692,"n":0.82,"mv":315.0000000244924,"pmax_mpa":159.71346474969553},"GEO":{"A":6.567499736152824e-05,"V0":5.827059486963652e-07,"travel":0.07921224142028148,"Ac":6.720063035569416e-05,"seat_mm":3.8122414202814703,"case_web_mm":3.5078199103985304},"SLIDE_KG":0.3182579331420899,"CASE_KG":0.00405391171875,"HAMMER_COCK_WORK_J":0.23806290997202656,"x_feed":0.03013804155233375,"I_h":1.98e-06,"r_strike":0.017307801709055947,"theta_c":1.0821041362364843,"theta_trip":1.0471975511965976};

// ====================================================================== seeded PRNG (sfc32)
export class RNG {
  constructor(seed) {
    let s = (seed >>> 0) || 1;
    const sm = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    for (let i = 0; i < 12; i++) this.u32();
    this._spare = null;
  }
  u32() {
    let { a, b, c, d } = this;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0; a = b ^ (b >>> 9); b = (c + (c << 3)) >>> 0; c = (c << 21) | (c >>> 11); c = (c + t) >>> 0;
    this.a = a; this.b = b; this.c = c; this.d = d; return t;
  }
  random() { return ((this.u32() >>> 5) * 67108864 + (this.u32() >>> 6)) / 9007199254740992; }
  stdNormal() {
    if (this._spare !== null) { const s = this._spare; this._spare = null; return s; }
    let u, v, q;
    do { u = 2 * this.random() - 1; v = 2 * this.random() - 1; q = u * u + v * v; } while (q >= 1 || q === 0);
    const f = Math.sqrt(-2 * Math.log(q) / q); this._spare = v * f; return u * f;
  }
  normal(m = 0, sd = 1) { return m + sd * this.stdNormal(); }
  lognormal(m = 0, s = 1) { return Math.exp(this.normal(m, s)); }
  exponential(scale = 1) { return -scale * Math.log(1 - this.random()); }
  integers(n) { return Math.floor(this.random() * n); }
  gamma(shape, scale = 1) {
    if (shape < 1) { const u = this.random(); return this.gamma(1 + shape, scale) * Math.pow(u, 1 / shape); }
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v; do { x = this.stdNormal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v; const u = this.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }
}

const RAD = Math.PI / 180;
const fmt = (x, n = 2) => (x === Infinity ? "infinite" : Number(x).toFixed(n));

// ======================================================================================== AK CLAUDE
export const AK = (() => {
  const G = AKC.G, K = AKC.K;
  // ---- ballistics constants (sim/ballistics.py)
  const F_FORCE = 1.00e6, GAMMA = 1.24, ETA = 1.0e-3, RHO_P = 1600.0, CHI = 1.06, LAM = -0.06, T_FLAME = 2900.0;
  const R_GAS = F_FORCE / T_FLAME, PHI1 = 1.05, P_IGN = 6.0e6, BULLET_PULL_N = 300.0, P_ENGRAVE = 32.0e6;
  const ENGRAVE_LEN = 4.0e-3, P_FRICTION = 6.0e6, P_FOUL_MAX = 2.5e6, TEMP_COEF = 0.003, IK = 0.13581e6;
  // ---- cartridge (sim/cartridge.py)
  const CHARGE_G = [1.600, 0.016], BULLET_G = [7.90, 0.05], BULLET_D = [7.920, 0.006], OAL = [55.80, 0.12];
  const CASE_SHOULDER_D = [10.040, 0.010], PRIMER_SEAT = [0.10, 0.04], PRIMER_E50_J = 0.16, PRIMER_LOG_SD = 0.22;
  const CASE_MU = [0.18, 0.015], BURN_FACTOR = [1.000, 0.006];
  const DEFECTS = {
    primer_compound_missing: 1 / 6000, primer_contaminated: 1 / 4000, short_powder_charge: 1 / 15000,
    degraded_powder: 1 / 3000, dented_case: 1 / 2500, bent_round: 1 / 4000, bullet_setback: 1 / 5000, corroded_case: 1 / 1500,
  };
  // ---- gun state (sim/gunstate.py)
  const BORE_FOUL_PER_SHOT = 1 / 8000, CHAMBER_FOUL_PER_SHOT = 1 / 4000, PORT_FOUL_PER_SHOT = 1 / 6000;
  const CARRIER_FOUL_PER_SHOT = 1 / 5000, HEAT_FRACTION = 0.10, C_STEEL = 470.0, BARREL_AREA = 0.025;
  const COOKOFF_C = 170.0, COOKOFF_TAU = 40.0;
  // ---- mechanism (sim/mechanism.py)
  const G_ACC = 9.81, P_ATM = 0.101e6, MU_RAIL = 0.10, MU_RAIL_FOUL = 0.06, MU_RAIL_DIRT = 0.15, E_HAMMER = 1.00;
  const HAMMER_ARC = 90 * RAD, X_COCK = [0.015, 0.060], F_LOCK_CAM = 25.0, F_LOCK_DIRT = 60.0, MU_LUG = 0.15;
  const R_LUG = 0.01125, R_CAM = 0.012, CAM_TAN = R_CAM * (K.BOLT_ROT * RAD) / (K.CAM_TRAVEL * 1e-3);
  const PRIMARY_LEN = 0.4e-3, F_SEAT = 120.0, RIM_STRENGTH = 2600.0, K_EXT = 8000.0, STICK_P0 = 380e6, STICK_COEF = 0.0004;
  const V_EJECT_MIN = 1.8, E_REAR = 0.10, F_MAG_FULL = 38.0, F_MAG_EMPTY = 14.0, MU_LIP = 0.30, STRIP_LEN = 0.012;
  const K_CH = 6000.0, CH_LEN = 2.0e-3, TIP_CAPTURE = 1.0, THROAT_CLEAR = (K.CH_H1 - K.C_BULLET_D) / 2, K_TILT = 3000.0;
  const CD_PORT = 0.50,   // CALIBRATED to the filmed AK carrier peak 7.0 m/s (Nguyen et al. 2024, doi:10.5937/vojtehg72-50987); was 0.75
    TAPER_FREE = 5.0e-3, T_GAS_COOL = 0.70, REAR_SPRING_INSTALLED = (K.RX_U1 - 7 - K.SPRING_SEAT_U) * 1e-3;
  const SPRING_FREE_LEN = 0.200;
  // ---- run.py
  const MIN_INDENT = 0.55, PRIMER_DELAY = 0.3e-3, N_MAGS = 10;

  const psiF = (z) => (z >= 1.0 ? 1.0 : CHI * z * (1.0 + LAM * z));

  function nominalRound(serial = 0) {
    return { serial, charge_g: CHARGE_G[0], bullet_g: BULLET_G[0], bullet_d: BULLET_D[0], oal: OAL[0],
      case_shoulder_d: CASE_SHOULDER_D[0], primer_seat: PRIMER_SEAT[0], primer_e_ign: PRIMER_E50_J, case_mu: CASE_MU[0],
      burn_factor: BURN_FACTOR[0], rim_strength: 1.0, bullet_tilt_deg: 0.0, defects: [] };
  }

  function makeRound(rng, serial, defectScale = 1) {
    const n = (m, s) => rng.normal(m, s);
    const r = { serial, charge_g: n(...CHARGE_G), bullet_g: n(...BULLET_G), bullet_d: n(...BULLET_D), oal: n(...OAL),
      case_shoulder_d: n(...CASE_SHOULDER_D), primer_seat: Math.max(0.0, n(...PRIMER_SEAT)),
      primer_e_ign: PRIMER_E50_J * Math.exp(PRIMER_LOG_SD * rng.stdNormal()), case_mu: n(...CASE_MU),
      burn_factor: n(...BURN_FACTOR), rim_strength: 1.0, bullet_tilt_deg: Math.abs(n(0.0, 0.15)), defects: [] };
    const draws = {}, mags = {};
    for (const k in DEFECTS) draws[k] = rng.random();
    for (const k in DEFECTS) mags[k] = rng.random();
    for (const k in DEFECTS) {
      if (draws[k] >= DEFECTS[k] * defectScale) continue;
      r.defects.push(k); const u = mags[k];
      if (k === "primer_compound_missing") r.primer_e_ign = Infinity;
      else if (k === "primer_contaminated") r.primer_e_ign *= 3.0 + 9.0 * u;
      else if (k === "short_powder_charge") r.charge_g *= 0.55 * u;
      else if (k === "degraded_powder") r.burn_factor *= 0.80 + 0.17 * u;
      else if (k === "dented_case") r.case_shoulder_d += 0.05 + 0.55 * u;
      else if (k === "bent_round") r.bullet_tilt_deg = 0.5 + 3.5 * u;
      else if (k === "bullet_setback") r.oal -= 1.0 + 3.0 * u;
      else if (k === "corroded_case") { r.case_mu *= 1.4 + 1.6 * u; r.rim_strength *= 0.95 - 0.40 * u; }
    }
    return r;
  }

  // -------------------------------------------------------------- interior ballistics (fire)
  function fire(rnd, foul = 0.0, powder_temp_c = 21.0, opt = {}) {
    const dt = opt.dt || 2.5e-7, keep = !!opt.keepTrace;
    const A = G.A_bore, m = rnd.bullet_g / 1000.0, C = Math.max(rnd.charge_g, 0.0) / 1000.0;
    const d_seat = (rnd.oal - 55.80) * 1e-3;
    const V0 = G.V0 + A * d_seat, travel = G.travel - d_seat;
    const jump = Math.max(G.jump_mm * 1e-3 + d_seat, 0.0), port_x = G.port_travel - d_seat;
    const Ik_eff = (opt.Ik || IK) / (rnd.burn_factor * (1.0 + TEMP_COEF * (powder_temp_c - 21.0)));
    const engrave = P_ENGRAVE * Math.max(0.2, (rnd.bullet_d - 7.62) / 0.30);
    const p_fric = P_FRICTION + P_FOUL_MAX * foul, p_pull = BULLET_PULL_N / A;
    const phi = PHI1 + C / (3.0 * m);
    const kb = (1 + C / (2 * PHI1 * m)) / (1 + C / (3 * PHI1 * m)), ks = 1.0 / (1 + C / (3 * PHI1 * m));
    const psi0_gas = P_IGN * (V0 - C / RHO_P) / F_FORCE, l0 = V0 / A;
    const resist = (x) => {
      if (x < jump) return 0.0;
      const e = x - jump;
      if (e < ENGRAVE_LEN) return engrave * (1.0 - Math.abs(2.0 * e / ENGRAVE_LEN - 1.0)) + p_fric * e / ENGRAVE_LEN;
      return p_fric;
    };
    const state = (z, x, v) => {
      const psi = C > 0 ? psiF(z) : 0.0;
      const Vpsi = V0 - (C / RHO_P) * (1 - psi) - ETA * C * psi;
      const energy = F_FORCE * (C * psi + psi0_gas) - 0.5 * (GAMMA - 1) * phi * m * v * v;
      return [Math.max(energy, 0.0) / (Vpsi + A * x), psi, Vpsi];
    };
    const deriv = (z, x, v, moving) => {
      const p = state(z, x, v)[0];
      const dz = (C > 0 && z < 1.0) ? p / Ik_eff : 0.0;
      if (!moving) return [dz, 0.0, 0.0];
      return [dz, v, A * (p - resist(x)) / (phi * m)];
    };
    let z = 0, x = 0, v = 0, t = 0, moving = false, lodged = false, pmax = 0, step = 0;
    const trace = [], ts = [], ps = [], Ts = [];
    while (t < 0.03) {
      let [p, psi, Vpsi] = state(z, x, v);
      if (!moving) {
        if (p * ks > p_pull) moving = true;
        else if (C <= 0 || z >= 1.0) { lodged = true; break; }
      }
      const d1 = deriv(z, x, v, moving);
      const d2 = deriv(z + 0.5 * dt * d1[0], x + 0.5 * dt * d1[1], v + 0.5 * dt * d1[2], moving);
      z += dt * d2[0]; x += dt * d2[1]; v += dt * d2[2]; t += dt;
      if (moving && v <= 0.0) {
        v = 0.0;
        if (state(z, x, 0.0)[0] <= resist(x) && (z >= 1.0 || C <= 0)) { lodged = true; break; }
      }
      [p, psi, Vpsi] = state(z, x, v);
      const pb = p * kb;
      if (pb > pmax) pmax = pb;
      if (keep && (step++ % 8 === 0)) trace.push([t, pb]);
      if (x >= port_x) {
        const Lg = l0 + x;
        const pp = pb - (pb - p * ks) * Math.pow((l0 + port_x) / Lg, 2);
        const T = p * (Vpsi + A * x) / Math.max((C * psi + psi0_gas) * R_GAS, 1e-12);
        ts.push(t); ps.push(pp); Ts.push(T);
      }
      if (x >= travel) break;
    }
    const exited = x >= travel && !lodged;
    const out = { mv: exited ? v : 0.0, pmax_breech: pmax, t_exit: t, exited, lodged: !exited,
      x_lodged: exited ? null : x, travel, port_x, V0, charge: C, m, t_port_open: ts.length ? ts[0] : Infinity };
    out.spin_rps = out.mv / 240e-3;
    out.muzzle_energy_J = 0.5 * m * out.mv * out.mv;
    if (exited) {
      let [p, psi, Vpsi] = state(z, x, v);
      const Vt = Vpsi + A * travel;
      let M = C * psi + psi0_gas;
      let T = p * Vt / (M * R_GAS);
      const Gam = Math.sqrt(GAMMA) * Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1)));
      const dtb = 2e-6; let tb = t;
      out.p_muzzle_exit = p;
      while (tb < t + 6e-3 && p > 0.15e6) {
        const mdot = 0.9 * A * p * Gam / Math.sqrt(R_GAS * T);
        const M_new = Math.max(M - mdot * dtb, 1e-9);
        p *= Math.pow(M_new / M, GAMMA); T *= Math.pow(M_new / M, GAMMA - 1); M = M_new; tb += dtb;
        ts.push(tb); ps.push(p); Ts.push(T);
        if (keep && (step++ % 8 === 0)) trace.push([tb, p]);
      }
    }
    out.port = { t: ts, p: ps, T: Ts };
    if (keep) out.trace = trace;
    return out;
  }

  // -------------------------------------------------------------- gun state
  class GunState {
    constructor(o = {}) {
      Object.assign(this, { shots: 0, bore_foul: 0, chamber_foul: 0, port_foul: 0, carrier_foul: 0, dirt: 0,
        recoil_spring_cycles: 0, hammer_spring_cycles: 0, barrel_c: 21.0, ambient_c: 21.0, peak_barrel_c: 21.0 }, o);
    }
    recoil_spring_loss() { return 0.04 * Math.log10(1 + this.recoil_spring_cycles / 500.0); }
    hammer_spring_factor() { return 1.0 - 0.03 * Math.log10(1 + this.hammer_spring_cycles / 500.0); }
    after_shot(charge_kg) {
      this.shots += 1; this.bore_foul += BORE_FOUL_PER_SHOT; this.chamber_foul += CHAMBER_FOUL_PER_SHOT;
      this.port_foul += PORT_FOUL_PER_SHOT; this.carrier_foul += CARRIER_FOUL_PER_SHOT;
      const q = HEAT_FRACTION * F_FORCE * charge_kg / (GAMMA - 1);
      this.barrel_c += q / (G.m_barrel * C_STEEL);
      this.peak_barrel_c = Math.max(this.peak_barrel_c, this.barrel_c);
    }
    cool(seconds) {
      let t = 0.0;
      while (t < seconds) {
        const dt = Math.min(1.0, seconds - t);
        const h = 12.0 + 0.045 * (this.barrel_c - this.ambient_c);
        const k = h * BARREL_AREA / (G.m_barrel * C_STEEL);
        this.barrel_c = this.ambient_c + (this.barrel_c - this.ambient_c) * Math.exp(-k * dt);
        t += dt;
      }
    }
    chamber_d_eff(nominal_d) {
      return nominal_d - 2 * 0.012 * Math.min(this.chamber_foul, 2.0) + nominal_d * 12e-6 * (this.barrel_c - 21.0);
    }
  }

  const spring_rate = () => {
    const Gm = 79.3e9, d = K.SPRING_WIRE_D * 1e-3, D = K.SPRING_COIL_D * 1e-3;
    return Gm * d ** 4 / (8 * D ** 3 * K.SPRING_COILS);
  };
  const SPRING_RATE = spring_rate();
  const spring_force = (x, gun) => {
    const L0 = SPRING_FREE_LEN * (1.0 - gun.recoil_spring_loss());
    return Math.max(0.0, SPRING_RATE * (L0 - (REAR_SPRING_INSTALLED - x)));
  };
  const mag_spring_force = (n_rounds, mag_cycles = 0) => {
    const fatigue = 1.0 - 0.03 * Math.log10(1 + mag_cycles / 200.0);
    return (F_MAG_EMPTY + (F_MAG_FULL - F_MAG_EMPTY) * n_rounds / 30.0) * fatigue;
  };
  function orifice(p_up, T_up, p_dn, A) {
    if (p_up <= p_dn || A <= 0) return 0.0;
    const g = GAMMA, R = R_GAS, r = p_dn / p_up, crit = Math.pow(2 / (g + 1), g / (g - 1));
    if (r < crit) return A * p_up * Math.sqrt(g / (R * T_up)) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
    return A * p_up * Math.sqrt(2 * g / ((g - 1) * R * T_up) * (Math.pow(r, 2 / g) - Math.pow(r, (g + 1) / g)));
  }
  class Stoppage extends Error {
    constructor(kind, quantity, value, limit, detail) { super(kind); Object.assign(this, { kind, quantity, value, limit, detail }); }
  }

  function strike(rnd, gun) {
    const E = E_HAMMER * gun.hammer_spring_factor() * (1.0 - 0.25 * gun.dirt) * 0.92;
    const t_fall = Math.sqrt(2 * HAMMER_ARC ** 2 * G.I_hammer / Math.max(E, 1e-6));
    const E_pin = E * 0.80 * (1.0 - 0.05 * Math.min(gun.carrier_foul, 2.0));
    const shoulder_gap = (K.CH_L1 + K.HEADSPACE_OFFSET) - K.C_L1;
    const indent = K.FP_PROTRUSION - Math.max(shoulder_gap, 0.0) - rnd.primer_seat;
    return [t_fall, E_pin, indent];
  }

  // -------------------------------------------------------------- operating cycle (mechanism.cycle)
  function cycle(rnd, bal, nxt, mag_left, gun, mag_cycles = 0, rec = null) {
    const dt_fast = 2e-6, dt_slow = 2e-5;
    const mc = G.m_carrier, mb = G.m_bolt, m_case = 0.0075, Ap = G.A_piston;
    const tp = bal.port.t, pp = bal.port.p, Tp = bal.port.T;
    const A_port = G.A_port * CD_PORT * Math.max(0.0, 1.0 - 0.25 * gun.port_foul);
    const mu_rail = MU_RAIL + MU_RAIL_FOUL * Math.min(gun.carrier_foul, 2.0) + MU_RAIL_DIRT * gun.dirt;
    const info = { pmax_MPa: bal.pmax_breech / 1e6, mv: bal.mv };
    const ch_d0 = gun.chamber_d_eff(K.CH_P2);
    const dent = Math.max(0.0, rnd.case_shoulder_d - K.C_SHOULDER_D);
    let resid = 0.5 * dent + STICK_COEF * Math.max(0.0, (bal.pmax_breech - STICK_P0) / 1e6);
    resid -= (ch_d0 - K.CH_P2) * 0.5;
    resid = Math.max(0.0, resid);
    const mu = rnd.case_mu * (1.0 + 0.5 * Math.min(gun.chamber_foul, 2.0)) * (1.0 + 0.8 * gun.dirt);
    let x = 0, v = 0;
    const n_p = tp.length;
    let t = n_p ? tp[0] : 0.0;
    const t0 = t;
    let m_gas = 0.0, T_c = 1500.0, bolt_on = false, case_on = false, hammer_cocked = false, x_max = 0.0, v_peak = 0.0;
    let v_unlock = null, v_extract = null, v_eject = null, ejected = false, F_ext_static = null, k = 0;
    const t_end_gas = (n_p ? tp[n_p - 1] : 0.0) + 0.5e-3;
    const push = rec ? (tt, xx) => rec.push([tt - t0, xx]) : null;
    let si = 0;
    if (push) push(t, 0);
    try {
      // ---------------------------------------------------------- rearward stroke
      for (;;) {
        const dt = t < t_end_gas ? dt_fast : dt_slow;
        while (k + 1 < n_p && tp[k + 1] <= t) k += 1;
        let pb, Tb;
        if (n_p && t <= tp[n_p - 1]) { pb = pp[k]; Tb = Tp[k]; } else { pb = P_ATM; Tb = 300.0; }
        const V_c = G.V_pocket + Ap * x;
        const p_c = Math.max(m_gas * R_GAS * T_c / V_c, P_ATM);
        const din = orifice(pb, Tb, p_c, A_port);
        const dback = pb < p_c ? orifice(p_c, T_c, pb, A_port) : 0.0;
        const a_out = G.A_leak + (x >= K.GAS_VENT_TRAVEL * 1e-3 ? G.A_vent : 0.0);
        const dout = orifice(p_c, T_c, P_ATM, a_out * 0.65);
        if (din > 0) T_c = (m_gas * T_c + din * dt * Tb * T_GAS_COOL) / (m_gas + din * dt);
        m_gas = Math.max(0.0, m_gas + (din - dback - dout) * dt);
        let F = (p_c - P_ATM) * Ap;
        const m = mc + (bolt_on ? mb : 0.0) + (case_on ? m_case : 0.0);
        F -= spring_force(x, gun);
        F -= mu_rail * (m * G_ACC + 0.3 * spring_force(x, gun)) * (v >= 0 ? 1 : -1);
        if (X_COCK[0] <= x && x <= X_COCK[1] && v > 0 && !hammer_cocked) F -= E_HAMMER / (X_COCK[1] - X_COCK[0]) * 1.1;
        if (G.x_free <= x && x < G.x_unlocked && v > 0) {
          const F_head = Math.max(pb - P_ATM, 0.0) * G.case_head_area;
          const T_lug = MU_LUG * F_head * R_LUG;
          let F_cam = (T_lug / R_CAM) * CAM_TAN + 5.0;
          if (F_ext_static === null) {
            F_ext_static = F_SEAT + mu * Math.max(pb - P_ATM, 0) * G.case_wall_area * 0.25
              - Math.max(pb - P_ATM, 0) * G.case_head_area * 0.7 + K_EXT * resid;
            F_ext_static = Math.max(F_ext_static, F_SEAT * 0.5);
            const rim = RIM_STRENGTH * rnd.rim_strength;
            info.F_extract_N = F_ext_static; info.rim_strength_N = rim; info.resid_interference_mm = resid;
            if (F_ext_static > rim)
              throw new Stoppage("failure_to_extract", "extraction force vs rim/extractor strength", F_ext_static, rim,
                { case_mu: rnd.case_mu, resid_interference_mm: resid, dent_mm: dent, pmax_MPa: bal.pmax_breech / 1e6,
                  rim_strength: rnd.rim_strength, chamber_foul: gun.chamber_foul, dirt: gun.dirt, mu_eff: mu, x_mm: x * 1e3 });
          }
          F_cam += F_ext_static * PRIMARY_LEN / (K.CAM_TRAVEL * 1e-3);
          F -= F_cam;
        }
        if (case_on && x < G.x_unlocked + TAPER_FREE && v > 0) F -= 0.05 * F_ext_static;
        const a = F / m;
        let v_new = v + a * dt;
        let x_new = x + v_new * dt;
        t += dt;
        if (!bolt_on && x_new >= G.x_unlocked) {
          v_new = v_new * mc / (mc + mb + m_case); bolt_on = case_on = true; v_extract = v_new;
        }
        if (v_unlock === null && x_new >= G.x_free) v_unlock = v_new;
        if (x_new >= X_COCK[1]) hammer_cocked = true;
        if (case_on && !ejected && x_new >= G.x_eject) {
          v_eject = v_new;
          if (v_new < V_EJECT_MIN)
            throw new Stoppage("failure_to_eject", "bolt speed at the ejector", v_new, V_EJECT_MIN,
              { port_foul: gun.port_foul, charge_g: rnd.charge_g, burn_factor: rnd.burn_factor, mv: bal.mv,
                carrier_foul: gun.carrier_foul, dirt: gun.dirt, F_extract_N: F_ext_static, x_mm: x_new * 1e3 });
          ejected = true; case_on = false;
        }
        if (x_new >= G.x_stroke) { x_new = G.x_stroke; v_new = -E_REAR * v_new; info.v_at_rear = v; }
        x = x_new; v = v_new;
        x_max = Math.max(x_max, x); v_peak = Math.max(v_peak, v);
        if (push && (++si % (dt === dt_fast ? 25 : 5) === 0)) push(t, x);
        if (v <= 0 && t > t_end_gas) break;
        if (t - t0 > 0.5) break;
      }
      Object.assign(info, { x_max_mm: x_max * 1e3, v_unlock, v_extract, v_eject, t_rear: t - t0, v_peak });
      if (!bolt_on)
        throw new Stoppage("failure_to_extract", "carrier travel (short stroke, bolt never unlocked)", x_max * 1e3,
          G.x_unlocked * 1e3, { charge_g: rnd.charge_g, mv: bal.mv, port_foul: gun.port_foul, burn_factor: rnd.burn_factor,
            lodged: bal.lodged, short_stroke: true });
      if (case_on && x_max < G.x_eject)
        throw new Stoppage("failure_to_eject", "carrier travel (case extracted but never reached the ejector)",
          x_max * 1e3, G.x_eject * 1e3, { charge_g: rnd.charge_g, mv: bal.mv, port_foul: gun.port_foul,
            burn_factor: rnd.burn_factor, F_extract_N: F_ext_static, short_stroke: true });
      const fed = nxt != null && x_max >= G.x_feed_clear;
      if (nxt != null && !fed)
        throw new Stoppage("failure_to_feed", "carrier travel vs bolt face behind the next rim (short stroke)",
          x_max * 1e3, G.x_feed_clear * 1e3, { charge_g: rnd.charge_g, mv: bal.mv, burn_factor: rnd.burn_factor,
            port_foul: gun.port_foul, recoil_spring_loss: gun.recoil_spring_loss(), short_stroke: true });
      const t_avail = info.t_rear;
      if (fed) {
        const n_after = mag_left - 1;
        const m_stack = n_after * G.m_round_g / 1000 + 0.070 + 0.010;
        const F_net = mag_spring_force(n_after + 1, mag_cycles) - m_stack * G_ACC * 0.94
          - 0.30 * (1 + 2 * gun.dirt) * m_stack * G_ACC;
        const rise = K.STACK_PITCH * 1e-3;
        const t_rise = F_net > 0 ? Math.sqrt(2 * rise * m_stack / F_net) : Infinity;
        info.t_stack_rise_ms = t_rise * 1e3;
      }
      // ---------------------------------------------------------- forward stroke
      let m_fwd = mc + mb, stripped = false, chambered = false;
      const tf0 = t;
      for (;;) {
        const dt = dt_slow;
        let F = -spring_force(x, gun);
        F += mu_rail * (m_fwd * G_ACC + 0.3 * spring_force(x, gun)) * (v < 0 ? 1 : 0);
        if (fed && !stripped && x <= G.x_rim_contact) {
          stripped = true;
          if ((info.t_stack_rise_ms || 0) / 1e3 > (t - tf0) + t_avail)
            throw new Stoppage("failure_to_feed", "magazine stack rise time vs bolt return", info.t_stack_rise_ms,
              ((t - tf0) + t_avail) * 1e3, { mag_rounds: mag_left, mag_spring_N: mag_spring_force(mag_left, mag_cycles),
                dirt: gun.dirt, mag_cycles });
          const tip_dev = (nxt.oal - K.C_CASE_L) * Math.sin(nxt.bullet_tilt_deg * RAD);
          info.tip_dev_mm = tip_dev;
          if (tip_dev > TIP_CAPTURE)
            throw new Stoppage("failure_to_feed", "bullet tip offset at the chamber mouth (nose stub)", tip_dev,
              TIP_CAPTURE, { bullet_tilt_deg: nxt.bullet_tilt_deg, round_defects: nxt.defects, next_serial: nxt.serial, x_mm: x * 1e3 });
          m_fwd += nxt.bullet_g / 1000 + 0.0097;
        }
        if (stripped && x > G.x_rim_contact - STRIP_LEN) F += MU_LIP * mag_spring_force(mag_left, mag_cycles) * (1 + gun.dirt);
        if (stripped && !chambered && x <= G.x_unlocked + CH_LEN) {
          const ch_d = gun.chamber_d_eff(K.CH_P2);
          const delta = nxt.case_shoulder_d - (ch_d - 0.08);
          const tilt_int = Math.max(0.0, 8.0 * Math.sin(nxt.bullet_tilt_deg * RAD) - THROAT_CLEAR);
          const Fch = K_CH * Math.max(0.0, delta) + K_TILT * tilt_int + 3.0 * (1 + 4 * gun.chamber_foul + 6 * gun.dirt);
          F += Fch; info.F_chamber_N = Fch;
        }
        if (x <= G.x_unlocked && !chambered) { chambered = true; m_fwd = mc; }
        if (chambered && x > G.x_free) F += F_LOCK_CAM + F_LOCK_DIRT * gun.dirt;
        const a = F / m_fwd;
        let v_new = v + a * dt;
        let x_new = x + v_new * dt;
        t += dt;
        if (v_new >= 0 && v <= 0 && x_new > 0) {
          const F_static = spring_force(x, gun);
          const resist = F - (-spring_force(x, gun));
          if (resist >= F_static) {
            const where = chambered ? "cam lock-up" : stripped ? "chambering" : "return stroke";
            throw new Stoppage("failure_to_battery", `recoil spring force vs resistance at ${where}`, F_static, resist,
              { x_mm: x * 1e3, where, case_shoulder_d: nxt ? nxt.case_shoulder_d : null, chamber_d: gun.chamber_d_eff(K.CH_P2),
                recoil_spring_loss: gun.recoil_spring_loss(), dirt: gun.dirt, bullet_tilt_deg: nxt ? nxt.bullet_tilt_deg : null,
                round_defects: nxt ? nxt.defects : null });
          }
          v_new = 0.0; x_new = x;
        }
        x = x_new; v = v_new;
        if (push && (++si % 5 === 0)) push(t, x);
        if (x <= G.x_autosear && info.t_autosear === undefined) info.t_autosear = t;
        if (x <= 0.0) { x = 0.0; info.v_battery = v; break; }
        if (t - tf0 > 1.0) throw new Stoppage("failure_to_battery", "return stroke timeout", x * 1e3, 0.0, { x_mm: x * 1e3 });
      }
      if (push) push(t, 0);
      info.t_battery = t; info.t0 = t0;
      info.chambered = chambered && fed;
      info.t_cycle_to_autosear = info.t_autosear;
      return info;
    } catch (e) {
      if (push) push(t, x);
      if (e instanceof Stoppage) { e.info = info; e.t_end = t - t0; }
      throw e;
    }
  }

  return { C: AKC, G, K, DEFECTS, PRIMER_E50_J, PRIMER_LOG_SD, CHARGE_G, MIN_INDENT, PRIMER_DELAY, COOKOFF_C, COOKOFF_TAU,
    N_MAGS, V_EJECT_MIN, TIP_CAPTURE, nominalRound, makeRound, fire, strike, cycle, GunState, Stoppage, spring_force };
})();

// ===================================================================================== MAKAROV CLAUDE
export const MAK = (() => {
  const V = MKC.V, GEO = MKC.GEO, CAL = MKC.CAL, MM = 1e-3;
  const NOMINAL_CHARGE_G = 0.25, NOMINAL_BULLET_G = 6.1, E_PRIMER_J = 0.016, CONTAM_GAIN = 9.0;
  const GAMMA = 1.24, ALPHA = 1.0e-3, RHO_P = 1600.0, N_EXP = 0.82, CHI = 1.06, LAM = -0.057;
  const SHOT_START_PA = 30e6, PHI_K = 1.15, CASE_GRIP = 0.25, PRIMER_P = 5e6;
  const SLIDE_KG = MKC.SLIDE_KG, CASE_KG = MKC.CASE_KG, HAMMER_COCK_WORK_J = MKC.HAMMER_COCK_WORK_J;

  // ---- Round (sim/ammo.py) with its derived physical quantities
  class Round {
    constructor(o) { Object.assign(this, o); }
    get primer_threshold_j() { return E_PRIMER_J / Math.max(this.primer_mix_ratio, 1e-3) ** 2 * Math.exp(CONTAM_GAIN * this.primer_contam); }
    get impetus_factor() { return 1.0 - 0.045 * this.moisture_pct; }
    get burn_factor() { return Math.max(1.0 - 0.14 * this.moisture_pct, 0.05); }
    get nose_offset_mm() { return (25.0 - 18.1) * Math.tan(this.tilt_deg * RAD) + 2.4 * this.handling_mm; }
    get bulge_mm() { return this.case_dia_dev_mm + 0.35 * this.handling_mm; }
    get rim_damage() { return Math.min(0.6, 0.5 * this.handling_mm); }
    copy(kw = {}) { return new Round({ ...this, ...kw }); }
  }
  const nominalRound = (rid = -1) => new Round({ rid, box: -1, charge_g: NOMINAL_CHARGE_G, moisture_pct: 0, bullet_g: NOMINAL_BULLET_G,
    shot_start_mpa: 30.0, primer_mix_ratio: 1.0, primer_contam: 0.0, lacquer: 1.0, case_dia_dev_mm: 0.0, handling_mm: 0.0, tilt_deg: 0.0 });

  // lot profiles: "surplus" is sim/ammo.py verbatim; "fresh" is an ASSUMED new-production lot (drier storage,
  // cleaner primers, less handling damage) - only the storage/handling distributions differ.
  const PROFILES = {
    surplus: { moistMed: 0.25, moistSig: 1.05, contam: 0.02, handK: 0.22, handS: 0.18, tiltK: 0.6, tiltS: 0.9 },
    fresh: { moistMed: 0.05, moistSig: 0.5, contam: 0.005, handK: 0.22, handS: 0.05, tiltK: 0.6, tiltS: 0.5 },
  };
  class AmmoSupply {
    constructor(rng, profile = "surplus", n_lots = 3) {
      this.rng = rng; this.P = PROFILES[profile]; const r = rng;
      this.lots = []; for (let i = 0; i < n_lots; i++) this.lots.push({ charge_bias: r.normal(0, 0.006), mix_bias: r.normal(0, 0.02), lacq: r.lognormal(0, 0.08) });
      this.box = -1; this.left = 0; this.rid = 0; this.box_moist = 0; this.lot = this.lots[0];
    }
    _newBox() {
      const r = this.rng; this.box += 1; this.left = 16;
      this.lot = this.lots[r.integers(this.lots.length)];
      this.box_moist = r.lognormal(Math.log(this.P.moistMed), this.P.moistSig);
    }
    next() {
      if (this.left === 0) this._newBox();
      const r = this.rng, P = this.P; this.left -= 1; this.rid += 1; const lot = this.lot;
      const moist = this.box_moist * r.lognormal(0, 0.15);
      return new Round({ rid: this.rid, box: this.box,
        charge_g: NOMINAL_CHARGE_G * (1 + lot.charge_bias + 0.012 * r.stdNormal()), moisture_pct: moist,
        bullet_g: NOMINAL_BULLET_G + 0.03 * r.stdNormal(), shot_start_mpa: 30.0 + 3.0 * r.stdNormal(),
        primer_mix_ratio: 1.0 + lot.mix_bias + 0.05 * r.stdNormal(), primer_contam: r.exponential(P.contam) + 0.045 * moist,
        lacquer: lot.lacq * r.lognormal(0, 0.22), case_dia_dev_mm: 0.012 * r.stdNormal(),
        handling_mm: r.gamma(P.handK, P.handS), tilt_deg: r.gamma(P.tiltK, P.tiltS) });
    }
  }

  // ---- gun state (sim/gunstate.py)
  class GunState {
    constructor(o = {}) { Object.assign(this, { rounds_total: 6000, fouling: 0.02, dirt: 0.0 }, o); }
    get recoil_set_mm() { return 7.5 * (1 - Math.exp(-this.rounds_total / 4500.0)); }
    get recoil_rate_loss() { return 0.04 * (1 - Math.exp(-this.rounds_total / 6000.0)); }
    get mainspring_loss() { return 0.10 * (1 - Math.exp(-this.rounds_total / 6000.0)); }
    get chamber_dia_loss_mm() { return 0.055 * this.fouling + 0.035 * this.dirt; }
    get pin_drag_n() { return 2.5 * this.fouling + 7.0 * this.dirt; }
    case_stick_n(lacquer) { return (15.0 + 110.0 * this.fouling ** 1.5 + 130.0 * this.dirt) * lacquer; }
    after_shot(rnd) { this.rounds_total += 1; this.fouling = Math.min(1.0, this.fouling + (1.0 / 600.0) * (0.7 + 0.3 * rnd.lacquer + 2.0 * rnd.moisture_pct / 10)); }
    copy(kw = {}) { return new GunState({ rounds_total: this.rounds_total, fouling: this.fouling, dirt: this.dirt, ...kw }); }
  }

  // ---- mechanics (sim/mechanics.py)
  class RecoilSpring {
    constructor(set_mm = 0, rate_loss = 0) { this.set_mm = set_mm; this.rate_loss = rate_loss; }
    get rate() { const Gm = V.shear_modulus_gpa * 1e9, d = V.rs_wire * MM, D = V.rs_mean_d * MM, n = V.rs_active; return Gm * d ** 4 / (8 * D ** 3 * n) * (1 - this.rate_loss); }
    force(x) { const comp = (V.rs_free_len - this.set_mm - V.rs_installed_len) * MM + x; return this.rate * Math.max(comp, 0.0); }
  }
  const T0 = V.ms_hammer_torque_down, TC = V.ms_hammer_torque_cocked, THETA_C = MKC.theta_c, THETA_TRIP = MKC.theta_trip;
  const torque = (th, loss) => (T0 + (TC - T0) * th / THETA_C) * (1 - loss);
  const storedEnergy = (th, loss) => { const k = (TC - T0) / THETA_C; return (T0 * th + 0.5 * k * th * th) * (1 - loss); };
  function firingPinEnergy(E_h, pin_drag_n) {
    const M = MKC.I_h / MKC.r_strike ** 2, m = V.firing_pin_mass_g * 1e-3, e = 0.30;
    const vh = Math.sqrt(2 * E_h / M), vp = (1 + e) * M * vh / (M + m);
    return Math.max(0.5 * m * vp * vp - pin_drag_n * 1.2e-3, 0.0);
  }
  // hammer fall time (lock time) from the same hammer inertia and leaf-spring torque (not in the Python; DERIVED here)
  function lockTime(th0, loss) {
    let th = th0, w = 0, t = 0; const dt = 1e-6;
    while (th > 0 && t < 0.05) { w += dt * torque(th, loss) / MKC.I_h; th -= dt * w; t += dt; }
    return t;
  }

  function shoot(charge_kg, bullet_kg, impetus, burn_B, slide_mass, spring_preload_n, spring_rate_npm,
    shot_start_pa = SHOT_START_PA, opt = {}) {
    const dt = opt.dt || 4e-7, rec = opt.record;
    const A = GEO.A, V0 = GEO.V0, Lt = GEO.travel, Ac = GEO.Ac, w = charge_kg, m = bullet_kg;
    const case_grip = CASE_GRIP, bore_drag = 1.0;
    const phi = PHI_K * bore_drag + w / (3 * m), th = GAMMA - 1;
    let z = 0, x = 0, vb = 0, X = 0, Vs = 0, t = 0, pmax = 0, moving = false, P = 0, psi = 0, step = 0;
    const trace = [], slideT = [];
    while (x < Lt) {
      psi = z < 1 ? Math.min(CHI * z * (1 + LAM * z), 1.0) : 1.0;
      const free = V0 + A * x + Ac * X - (w / RHO_P) * (1 - psi) - ALPHA * w * psi;
      P = (impetus * w * psi - th * (0.5 * phi * m * vb * vb + 0.5 * slide_mass * Vs * Vs)) / free;
      P = Math.max(P, 0.0);
      pmax = Math.max(pmax, P);
      if (!moving && P * A >= shot_start_pa * A) moving = true;
      const ab = moving ? P * A / (phi * m) : 0.0;
      const Fs = P * Ac * (1 - case_grip) - (spring_preload_n + spring_rate_npm * X);
      const As = (Fs > 0 || Vs > 0) ? Math.max(Fs, 0.0) / slide_mass : 0.0;
      const dz = z < 1 ? burn_B * Math.pow(Math.max(P, PRIMER_P), N_EXP) : 0.0;
      const zm = Math.min(z + 0.5 * dt * dz, 1.0), vbm = vb + 0.5 * dt * ab, xm = x + 0.5 * dt * vb;
      const psim = Math.min(CHI * zm * (1 + LAM * zm), 1.0), Vsm = Vs + 0.5 * dt * As, Xm = X + 0.5 * dt * Vs;
      const freem = V0 + A * xm + Ac * Xm - (w / RHO_P) * (1 - psim) - ALPHA * w * psim;
      const Pm = Math.max((impetus * w * psim - th * (0.5 * phi * m * vbm * vbm + 0.5 * slide_mass * Vsm * Vsm)) / freem, 0.0);
      const abm = moving ? Pm * A / (phi * m) : 0.0;
      const Fsm = Pm * Ac * (1 - case_grip) - (spring_preload_n + spring_rate_npm * Xm);
      const Asm = (Fsm > 0 || Vsm > 0) ? Math.max(Fsm, 0.0) / slide_mass : 0.0;
      z = z < 1 ? Math.min(z + dt * burn_B * Math.pow(Math.max(Pm, PRIMER_P), N_EXP), 1.0) : 1.0;
      x += dt * vbm; vb += dt * abm; X += dt * Vsm; Vs += dt * Asm; t += dt;
      if (rec && (step++ % 10 === 0)) { trace.push([t, P]); slideT.push([t, X]); }
      if (t > 5e-3) return { mv: vb, pmax, t_exit: null, slide_v: Vs, slide_x: X, t_end: t, trace, slideT, squib: true, psi_exit: psi };
    }
    const t_exit = t, mv = vb;
    const psi_exit = Math.min(CHI * z * (1 + LAM * z), 1.0);
    const Vol = V0 + A * Lt + Ac * X - ALPHA * w * psi_exit;
    let mg = w * psi_exit, rho = mg / Vol;
    const Kc = P / Math.pow(rho, GAMMA);
    const Gam = Math.sqrt(GAMMA) * Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1)));
    const dt2 = 2e-6;
    while (P > 0.5e6 && t < t_exit + 4e-3) {
      rho = mg / Vol; P = Kc * Math.pow(rho, GAMMA);
      mg = Math.max(mg - dt2 * Gam * A * Math.sqrt(P * rho), 0.0);
      const Fs = P * Ac * (1 - case_grip) - (spring_preload_n + spring_rate_npm * X);
      Vs += dt2 * Fs / slide_mass; X += dt2 * Vs; t += dt2;
      if (rec && (step++ % 4 === 0)) { trace.push([t, P]); slideT.push([t, X]); }
    }
    return { mv, pmax, t_exit, slide_v: Vs, slide_x: X, t_end: t, trace, slideT, squib: false, psi_exit };
  }

  function slideCycle(state0, { slide_mass, case_mass, spring, dirt, case_stick_n, claw_n, mag_rounds, round_fit, hammer_work_j, rec }) {
    const dt = 5e-6;
    let x = state0.x, vs = state0.v, t = 0.0;
    const x_case = V.case_len * MM, x_ej = -V.ejector_z * MM, x_max_geom = V.slide_travel * MM;
    const x_feed = MKC.x_feed, x_lock = 30.5 * MM, x_cock = 12.0 * MM;
    const rail_f = 2.0 + 25.0 * dirt;
    const ev = [];
    let case_on_face = true, case_in_chamber = true, extracted = false, ejected = false, v_at_ej = null, x_max = x;
    let m_tot = slide_mass + case_mass, step = 0;
    while (vs > 0) {
      let F = -spring.force(x) - rail_f;
      if (x < x_cock) F -= hammer_work_j / x_cock;
      if (case_on_face && case_in_chamber) {
        const need = case_stick_n + case_mass * Math.abs(F / m_tot);
        if (need > claw_n) { case_on_face = false; m_tot = slide_mass; ev.push(["extractor_slip", { x_mm: x * 1e3, case_stick_n, claw_n }]); }
        if (x >= x_case) { case_in_chamber = false; extracted = true; }
      }
      if (case_on_face && !case_in_chamber && !ejected && x >= x_ej) { ejected = true; v_at_ej = vs; case_on_face = false; m_tot = slide_mass; }
      vs += dt * F / m_tot; x += dt * vs; t += dt;
      if (x >= x_max_geom) { x = x_max_geom; vs = -V.frame_stop_restitution * vs; ev.push(["frame_stop", { v_mps: -vs / V.frame_stop_restitution }]); }
      x_max = Math.max(x_max, x);
      if (rec && (step++ % 20 === 0)) rec.push([t, x]);
      if (t > 0.1) break;
    }
    const out = { x_max_mm: x_max * 1e3, extracted, ejected, v_at_ejector: v_at_ej, x_feed_mm: x_feed * 1e3, x_ej_mm: x_ej * 1e3, events: ev, case_on_face };
    const locked = mag_rounds === 0 && x_max >= x_lock;
    if (locked) { if (rec) rec.push([t, x_lock]); Object.assign(out, { t_cycle: t, in_battery: false, locked_open: true, fed: false, x_final_mm: x_lock * 1e3 }); return out; }
    const fed = x_max >= x_feed && mag_rounds > 0;
    out.fed = fed;
    vs = Math.min(vs, 0.0); m_tot = slide_mass;
    let stub = false;
    const nose_x = x_feed - 6.5 * MM, chamber_entry = x_case, k_fit = 3000.0 / MM;
    for (;;) {
      let F = spring.force(x) - (vs < 0 ? rail_f : 0.0);
      if (fed) {
        if (x > nose_x) {
          const fm = V.mag_spring_n_one + (V.mag_spring_n_full - V.mag_spring_n_one) * (mag_rounds - 1) / 7;
          F -= V.feed_mu * fm;
        }
        if (Math.abs(round_fit.nose_offset_mm) > V.ramp_window_mm && x <= nose_x) {
          stub = true; vs = 0.0;
          ev.push(["nose_stub", { nose_offset_mm: round_fit.nose_offset_mm, window_mm: V.ramp_window_mm, x_mm: x * 1e3 }]);
          break;
        }
        if (x < chamber_entry) {
          const interf = Math.max(round_fit.chamber_interference_mm, 0.0) * MM * (chamber_entry - x) / chamber_entry;
          F -= k_fit * interf + 3.0;
        }
        if (x < 1.0 * MM) F -= V.extractor_snap_n;
      }
      vs -= dt * F / m_tot; x += dt * vs; t += dt;
      if (rec && (step++ % 20 === 0)) rec.push([t, Math.max(x, 0)]);
      if (x <= 0.0) { x = 0.0; break; }
      if (vs >= 0 && F <= 0) break;
      if (t > 0.2) break;
    }
    if (rec) rec.push([t, x]);
    Object.assign(out, { t_cycle: t, x_final_mm: x * 1e3, in_battery: x * 1e3 <= V.disconnector_window_mm, nose_stub: stub, locked_open: false });
    return out;
  }

  const chamberInterferenceMm = (rnd, gun) => rnd.bulge_mm + 0.02 * rnd.lacquer + gun.chamber_dia_loss_mm - (V.chamber_rear_dia - V.case_base_dia);

  // ---- one shot end to end (sim/pistol.py shot)
  function shot(rnd, next_rnd, gun, mode = "SA", mag_after = 7, opt = {}) {
    const loss = gun.mainspring_loss;
    const th0 = mode === "SA" ? THETA_C : THETA_TRIP;
    const E_h = storedEnergy(th0, loss) - storedEnergy(0.0, loss);
    const res = { rid: rnd.rid, mode, mag_after };
    const E_fp = firingPinEnergy(E_h, gun.pin_drag_n);
    Object.assign(res, { hammer_j: E_h, firing_pin_j: E_fp, primer_threshold_j: rnd.primer_threshold_j });
    if (opt.record) res.t_lock = lockTime(th0, loss);
    if (E_fp < rnd.primer_threshold_j) {
      Object.assign(res, { outcome: "misfire", cause: "failure to fire", detail: { rule: "firing-pin energy < primer threshold",
        delivered_j: E_fp, threshold_j: rnd.primer_threshold_j, primer_mix_ratio: rnd.primer_mix_ratio, primer_contam: rnd.primer_contam,
        mainspring_loss: gun.mainspring_loss, pin_drag_n: gun.pin_drag_n } });
      return res;
    }
    const spring = new RecoilSpring(gun.recoil_set_mm, gun.recoil_rate_loss);
    const b = shoot(rnd.charge_g * 1e-3, rnd.bullet_g * 1e-3, CAL.impetus_J_per_kg * rnd.impetus_factor, CAL.burn_B * rnd.burn_factor,
      SLIDE_KG + CASE_KG, spring.force(0.0), spring.rate, rnd.shot_start_mpa * 1e6, { record: opt.record });
    Object.assign(res, { mv: b.mv, pmax_mpa: b.pmax / 1e6, t_exit_ms: (b.t_exit || 0) * 1e3, slide_v_gas: b.slide_v,
      slide_x_gas_mm: b.slide_x * 1e3, gas_ms: b.t_end * 1e3 });
    if (opt.record) { res.trace = b.trace; res.slideT = b.slideT.slice(); }
    if (b.squib) { Object.assign(res, { outcome: "squib", cause: "bullet lodged", detail: { rule: "bullet did not exit", mv: b.mv } }); return res; }
    const fit = { nose_offset_mm: next_rnd ? next_rnd.nose_offset_mm : 0.0, chamber_interference_mm: next_rnd ? chamberInterferenceMm(next_rnd, gun) : -1.0 };
    const claw = V.extractor_claw_n * (1 - rnd.rim_damage);
    const stick = gun.case_stick_n(rnd.lacquer) * (1 + Math.max(chamberInterferenceMm(rnd, gun), 0) / 0.15);
    const rec = opt.record ? [] : null;
    const cyc = slideCycle({ x: b.slide_x, v: b.slide_v }, { slide_mass: SLIDE_KG, case_mass: CASE_KG, spring, dirt: gun.dirt,
      case_stick_n: stick, claw_n: claw, mag_rounds: next_rnd ? mag_after : 0, round_fit: fit, hammer_work_j: HAMMER_COCK_WORK_J, rec });
    if (rec) for (const [tt, xx] of rec) res.slideT.push([tt + b.t_end, xx]);
    const t_total = b.t_end + cyc.t_cycle;
    Object.assign(res, { x_max_mm: cyc.x_max_mm, v_at_ejector: cyc.v_at_ejector, cycle_ms: t_total * 1e3, x_final_mm: cyc.x_final_mm, ejected: cyc.ejected });
    const common = { slide_v0: b.slide_v, x_max_mm: cyc.x_max_mm, charge_g: rnd.charge_g, moisture_pct: rnd.moisture_pct, mv: b.mv,
      fouling: gun.fouling, dirt: gun.dirt, recoil_set_mm: gun.recoil_set_mm };
    const slipped = cyc.events.filter((e) => e[0] === "extractor_slip");
    if (slipped.length) { Object.assign(res, { outcome: "stoppage", cause: "failure to extract", detail: { rule: "case grip in chamber > extractor claw capacity", case_stick_n: stick, claw_n: claw, lacquer: rnd.lacquer, ...common } }); return res; }
    if (!cyc.extracted) { Object.assign(res, { outcome: "stoppage", cause: "failure to extract (short stroke)", detail: { rule: "slide travel < case length", x_case_mm: V.case_len, ...common } }); return res; }
    if (!cyc.ejected) { Object.assign(res, { outcome: "stoppage", cause: "failure to eject (short stroke)", detail: { rule: "slide travel < ejector position", x_ej_mm: cyc.x_ej_mm, ...common } }); return res; }
    if (cyc.v_at_ejector < V.eject_min_mps) { Object.assign(res, { outcome: "stoppage", cause: "failure to eject (stovepipe)", detail: { rule: "slide speed at ejector < minimum to clear the port", v_at_ejector: cyc.v_at_ejector, v_min: V.eject_min_mps, ...common } }); return res; }
    if (cyc.locked_open) { Object.assign(res, { outcome: "locked_open", cause: null }); return res; }
    if (next_rnd != null && !cyc.fed) { Object.assign(res, { outcome: "stoppage", cause: "failure to feed (short stroke)", detail: { rule: "slide travel < top-round rim position + catch", x_feed_mm: cyc.x_feed_mm, ...common } }); return res; }
    if (cyc.nose_stub) { Object.assign(res, { outcome: "stoppage", cause: "failure to feed (nose stub, deformed round)", detail: { rule: "bullet-nose offset > feed-ramp window", nose_offset_mm: fit.nose_offset_mm, window_mm: V.ramp_window_mm, tilt_deg: next_rnd.tilt_deg, handling_mm: next_rnd.handling_mm, ...common } }); return res; }
    if (!cyc.in_battery) { Object.assign(res, { outcome: "stoppage", cause: "out of battery", detail: { rule: "slide stopped > disconnector window short of battery", x_final_mm: cyc.x_final_mm, window_mm: V.disconnector_window_mm, spring_force_n: spring.force(cyc.x_final_mm * 1e-3), interference_mm: fit.chamber_interference_mm, ...common } }); return res; }
    Object.assign(res, { outcome: "ok", cause: null });
    return res;
  }

  // ---- cause tracing (sim/pistol.py trace_causes): which factor restored to nominal makes the shot run clean
  const FACTORS = {
    "primer": (r, n, g) => [r.copy({ primer_mix_ratio: 1.0, primer_contam: 0.0 }), n, g],
    "powder (charge/moisture)": (r, n, g) => [r.copy({ charge_g: 0.25, moisture_pct: 0.0 }), n, g],
    "deformed next round": (r, n, g) => [r, n ? n.copy({ handling_mm: 0.0, tilt_deg: 0.0, case_dia_dev_mm: 0.0 }) : n, g],
    "case lacquer / rim": (r, n, g) => [r.copy({ lacquer: 1.0, handling_mm: 0.0 }), n, g],
    "fouling": (r, n, g) => [r, n, g.copy({ fouling: 0.02 })],
    "dirt": (r, n, g) => [r, n, g.copy({ dirt: 0.0 })],
    "spring fatigue": (r, n, g) => [r, n, g.copy({ rounds_total: 0 })],
  };
  function traceCauses(rnd, next_rnd, gun, mode, mag_after) {
    const suff = [];
    for (const [name, fx] of Object.entries(FACTORS)) {
      const [r2, n2, g2] = fx(rnd, next_rnd, gun);
      const o = shot(r2, n2, g2, mode, mag_after);
      if (o.outcome === "ok" || o.outcome === "locked_open") suff.push(name);
    }
    if (suff.length) return suff;
    const names = Object.keys(FACTORS);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      let [r2, n2, g2] = FACTORS[names[i]](rnd, next_rnd, gun);
      [r2, n2, g2] = FACTORS[names[j]](r2, n2, g2);
      const o = shot(r2, n2, g2, mode, mag_after);
      if (o.outcome === "ok" || o.outcome === "locked_open") suff.push(`${names[i]} + ${names[j]}`);
    }
    return suff;
  }

  return { C: MKC, V, Round, nominalRound, AmmoSupply, GunState, RecoilSpring, shoot, slideCycle, shot, traceCauses,
    chamberInterferenceMm, lockTime, THETA_C, THETA_TRIP, E_PRIMER_J, PROFILES };
})();

// ===================================================================== exterior ballistics (approximate)
// Standard G7 drag function (Cd vs Mach). Point-mass trajectory, standard sea-level air, no wind.
const G7 = [[0, .1198], [.05, .1197], [.1, .1196], [.15, .1194], [.2, .1193], [.25, .1194], [.3, .1194], [.35, .1194], [.4, .1193],
  [.45, .1193], [.5, .1194], [.55, .1193], [.6, .1194], [.65, .1197], [.7, .1202], [.725, .1207], [.75, .1215], [.775, .1226],
  [.8, .1242], [.825, .1266], [.85, .1306], [.875, .1368], [.9, .1464], [.925, .166], [.95, .2054], [.975, .2993], [1, .3803],
  [1.025, .4015], [1.05, .4043], [1.075, .4034], [1.1, .4014], [1.125, .3987], [1.15, .3955], [1.2, .3884], [1.25, .381],
  [1.3, .3732], [1.35, .3657], [1.4, .358], [1.5, .344], [1.55, .3376], [1.6, .3315], [1.65, .326], [1.7, .3209], [1.75, .316],
  [1.8, .3117], [1.85, .3078], [1.9, .3042], [1.95, .301], [2, .298], [2.1, .2922], [2.2, .2864], [2.3, .2807], [2.4, .2752],
  [2.5, .2697], [3, .2453], [4, .2084], [5, .1825]];
function cdG7(M) {
  if (M <= 0) return G7[0][1];
  for (let i = 1; i < G7.length; i++) if (M <= G7[i][0]) { const [m0, c0] = G7[i - 1], [m1, c1] = G7[i]; return c0 + (c1 - c0) * (M - m0) / (m1 - m0); }
  return G7[G7.length - 1][1];
}
export const EXT = {
  AK: { bc_g7: 0.138, zero_m: 100, sight_h: 0.048, nominal_mv: 715, disp_moa: 1.0, label: "7.62x39 M43, G7 BC ~0.138 (approx.)" },
  MAK: { bc_g7: 0.06, zero_m: 25, sight_h: 0.017, nominal_mv: 315, disp_moa: 2.0, label: "9x18 57-N-181S, G7 BC ~0.06 (approx.)" },
  // drop of the bullet below the line of sight at `range` for a launch angle `ang` (rad, from the line of sight)
  path(mv, bc, sight_h, ang, range) {
    const rho = 1.225, a0 = 340.3, BCsi = bc * 703.07, g = 9.80665, dt = 1e-4;
    let x = 0, y = -sight_h, vx = mv * Math.cos(ang), vy = mv * Math.sin(ang), t = 0;
    while (x < range && t < 5) {
      const v = Math.hypot(vx, vy), dec = rho * v * v * cdG7(v / a0) * Math.PI / (8 * BCsi);
      vx -= dec * (vx / v) * dt; vy -= (dec * (vy / v) + g) * dt; x += vx * dt; y += vy * dt; t += dt;
    }
    return { y, t, v: Math.hypot(vx, vy) };
  },
  zeroAngle(spec) {
    let lo = -0.01, hi = 0.02;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (EXT.path(spec.nominal_mv, spec.bc_g7, spec.sight_h, mid, spec.zero_m).y < 0) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  },
};
export { fmt };

// ================================================================ range sessions (operator logic of run.py / campaign.py)
const DEFECT_WORDS = {
  primer_compound_missing: () => "dud primer (no priming compound in the cup)",
  primer_contaminated: (r) => `oil/moisture-contaminated primer (needs ${fmt(r.primer_e_ign, 2)} J to ignite)`,
  short_powder_charge: (r) => `light powder charge ${fmt(r.charge_g, 2)} g (nominal 1.60 g)`,
  degraded_powder: (r) => `degraded powder burning slow (burn factor ${fmt(r.burn_factor, 3)})`,
  dented_case: (r) => `dented case (shoulder ${fmt(r.case_shoulder_d, 2)} mm vs 10.04 mm)`,
  bent_round: (r) => `bent round (bullet tilted ${fmt(r.bullet_tilt_deg, 1)} deg in the neck)`,
  bullet_setback: (r) => `bullet set back into the case (OAL ${fmt(r.oal, 2)} mm vs 55.80 mm)`,
  corroded_case: (r) => `corroded case (wall friction ${fmt(r.case_mu, 2)}, rim strength ${fmt(r.rim_strength * 100, 0)} %)`,
};
const AK_COND = {
  clean: {},
  dirty: { bore_foul: 0.4, chamber_foul: 0.6, port_foul: 0.6, carrier_foul: 0.6 },
  sandy: { bore_foul: 0.2, chamber_foul: 0.2, port_foul: 0.2, carrier_foul: 0.2, dirt: 0.6 },
};
const MAK_COND = { clean: { fouling: 0.02, dirt: 0 }, dirty: { fouling: 0.6, dirt: 0 }, sandy: { fouling: 0.2, dirt: 0.5 } };

function akRoundWords(r) { return r.defects.map((d) => DEFECT_WORDS[d](r)); }
function akGunWords(kind, gun) {
  const w = [];
  const loss = 1 - gun.hammer_spring_factor();
  const rel = {
    failure_to_fire: [["hammer", 0.02], ["dirt", 0.05], ["carrier_foul", 0.25]],
    failure_to_extract: [["chamber_foul", 0.25], ["dirt", 0.05], ["port_foul", 0.25]],
    failure_to_eject: [["port_foul", 0.25], ["carrier_foul", 0.25], ["dirt", 0.05], ["chamber_foul", 0.25]],
    failure_to_feed: [["dirt", 0.05], ["port_foul", 0.25], ["recoil", 0.02]],
    failure_to_battery: [["chamber_foul", 0.25], ["dirt", 0.05], ["recoil", 0.02], ["carrier_foul", 0.25]],
    squib_bullet_lodged: [["bore_foul", 0.25]],
  }[kind] || [];
  const val = { hammer: loss, recoil: gun.recoil_spring_loss(), dirt: gun.dirt, chamber_foul: gun.chamber_foul,
    port_foul: gun.port_foul, carrier_foul: gun.carrier_foul, bore_foul: gun.bore_foul };
  const words = { hammer: (v) => `tired hammer spring (-${fmt(v * 100, 1)} %)`, recoil: (v) => `recoil spring set ${fmt(v * 100, 1)} %`,
    dirt: (v) => `sand in the action (grit index ${fmt(v, 2)})`, chamber_foul: (v) => `carbon in the chamber (index ${fmt(v, 2)})`,
    port_foul: (v) => `carbon in the gas port (index ${fmt(v, 2)})`, carrier_foul: (v) => `fouled carrier/piston (index ${fmt(v, 2)})`,
    bore_foul: (v) => `fouled bore (index ${fmt(v, 2)})` };
  for (const [k, thr] of rel) if (val[k] >= thr) w.push(words[k](val[k]));
  return w;
}

export class AKSession {
  constructor({ seed, cond = "clean", lot = "surplus" }) {
    this.gunName = "AK Claude"; this.cap = 30; this.seed = seed; this.cond = cond; this.lot = lot;
    this.rng = new RNG(seed); this.serial = 0; this.defectScale = lot === "fresh" ? 0.1 : 1;
    this.gun = new AK.GunState({ ...AK_COND[cond] });
    this.mag = []; this.chamber = null; this.jam = null; this.magNo = 0; this.magLoads = new Array(AK.N_MAGS).fill(0);
    this.fired = 0; this.clock = 0; this.chamberedAt = 0; this.pulls = 0;
  }
  newRound() { this.serial += 1; return AK.makeRound(this.rng, this.serial, this.defectScale); }
  get magCycles() { return this.magNo ? this.magLoads[(this.magNo - 1) % AK.N_MAGS] : 0; }
  reload() {
    const rounds = []; for (let i = 0; i < this.cap; i++) rounds.push(this.newRound());
    this.mag = rounds; this.magLoads[this.magNo % AK.N_MAGS] += 1; this.magNo += 1;
    let racked = false;
    if (!this.chamber && !this.jam) { this.chamber = this.mag.shift(); this.chamberedAt = this.clock; racked = true; }
    return { racked };
  }
  advance(dt) { if (dt > 0) { this.clock += dt; this.gun.cool(dt); } }
  fire() {
    if (this.jam) return { type: "blocked", text: "Stoppage: clear it first (CLEAR JAM)." };
    if (!this.chamber) return { type: "click", text: "Click - empty chamber. Reload." };
    this.pulls += 1;
    const rnd = this.chamber, gun = this.gun;
    const dwell = Math.max(1e-4, this.clock - this.chamberedAt);
    const t_p = gun.barrel_c - (gun.barrel_c - gun.ambient_c) * Math.exp(-dwell / AK.COOKOFF_TAU);
    const cooked = t_p >= AK.COOKOFF_C;
    const [t_lock, e_pin, indent] = AK.strike(rnd, gun);
    gun.hammer_spring_cycles += 1;
    const ev = { gun: "AK", round: rnd, t_lock, e_pin, indent, powder_c: t_p, cooked, magBefore: this.mag.length };
    if (!cooked && (indent < AK.MIN_INDENT || e_pin < rnd.primer_e_ign)) {
      ev.type = "stoppage"; ev.kind = "failure_to_fire";
      const causes = akRoundWords(rnd);
      const z = Number.isFinite(rnd.primer_e_ign) ? Math.log(rnd.primer_e_ign / AK.PRIMER_E50_J) / AK.PRIMER_LOG_SD : Infinity;
      if (!rnd.defects.length && z > 2.5) causes.push(`hard primer (needs ${fmt(rnd.primer_e_ign, 3)} J, ${fmt(z, 1)} SD above the lot median)`);
      causes.push(...akGunWords("failure_to_fire", gun));
      ev.text = indent < AK.MIN_INDENT
        ? `${causes.join(" + ") || `primer seated ${fmt(rnd.primer_seat, 2)} mm below flush`} -> firing-pin indent ${fmt(indent, 2)} mm < ${AK.MIN_INDENT} mm needed -> misfire (failure to fire)`
        : `${causes.join(" + ") || "primer sensitivity at the tail of the lot"} -> firing pin delivered ${fmt(e_pin, 3)} J, ${Number.isFinite(rnd.primer_e_ign) ? `primer needs ${fmt(rnd.primer_e_ign, 3)} J` : "primer cannot ignite at any energy"} -> misfire (failure to fire)`;
      this.jam = { kind: ev.kind, round: rnd, text: ev.text, eject: `live round #${rnd.serial} with ${causes[0] || "an unfired primer"}` };
      return ev;
    }
    const bal = AK.fire(rnd, gun.bore_foul, t_p, { keepTrace: true });
    this.fired += 1; gun.after_shot(bal.charge);
    Object.assign(ev, { mv: bal.mv, pmax: bal.pmax_breech, bal });
    if (bal.lodged) {
      const causes = akRoundWords(rnd);
      if (Math.abs(rnd.charge_g - AK.CHARGE_G[0]) > 3 * AK.CHARGE_G[1] && !rnd.defects.includes("short_powder_charge")) causes.push(`powder charge ${fmt(rnd.charge_g, 3)} g`);
      causes.push(...akGunWords("squib_bullet_lodged", gun));
      ev.type = "stoppage"; ev.kind = "squib_bullet_lodged";
      ev.text = `${causes.join(" + ") || "too little gas"} -> bullet stopped in the bore at ${fmt((bal.x_lodged || 0) * 1e3, 0)} mm of ${fmt(bal.travel * 1e3, 0)} mm -> squib, bullet lodged (bore must be rodded out before another shot)`;
      this.jam = { kind: ev.kind, round: rnd, text: ev.text, eject: `bullet of round #${rnd.serial} rodded out of the bore, empty case ejected` };
      return ev;
    }
    const nxt = this.mag.length ? this.mag[0] : null;
    const rec = [];
    try {
      const info = AK.cycle(rnd, bal, nxt, this.mag.length, gun, this.magCycles, rec);
      gun.recoil_spring_cycles += 1;
      ev.type = "ok"; ev.info = info; ev.xt = rec;
      ev.cyc = info.t_autosear + t_lock + AK.PRIMER_DELAY;
      ev.fed = !!nxt;
      if (nxt) { this.chamber = this.mag.shift(); this.chamberedAt = this.clock + info.t_battery; } else this.chamber = null;
      ev.text = nxt ? "" : "Last round fired - bolt closed on an empty chamber.";
      return ev;
    } catch (s) {
      if (!(s instanceof AK.Stoppage)) throw s;
      gun.recoil_spring_cycles += 1;
      ev.type = "stoppage"; ev.kind = s.kind; ev.stop = s; ev.xt = rec; ev.info = s.info;
      const d = s.detail, roundCauses = akRoundWords(rnd);
      if (Math.abs(rnd.charge_g - AK.CHARGE_G[0]) > 3 * AK.CHARGE_G[1] && !rnd.defects.includes("short_powder_charge"))
        roundCauses.push(`${rnd.charge_g < AK.CHARGE_G[0] ? "light" : "heavy"} powder charge ${fmt(rnd.charge_g, 3)} g`);
      const gunCauses = akGunWords(s.kind, gun);
      const nextCauses = nxt ? akRoundWords(nxt).map((w) => `next round #${nxt.serial}: ${w}`) : [];
      let text, eject;
      const all = (arr) => arr.join(" + ");
      if (s.kind === "failure_to_extract" && d.short_stroke) {
        text = `${all([...roundCauses, ...gunCauses]) || "weak gas impulse"} -> port pressure too low -> carrier travelled ${fmt(s.value, 1)} mm < ${fmt(s.limit, 1)} mm to unlock the bolt -> failure to extract (short stroke)`;
        eject = `fired case of round #${rnd.serial} pulled from the chamber`;
      } else if (s.kind === "failure_to_extract") {
        text = `${all([...roundCauses, ...gunCauses]) || `case stuck after ${fmt(d.pmax_MPa, 0)} MPa`} -> case gripped the chamber: extraction force ${fmt(s.value, 0)} N > rim/extractor strength ${fmt(s.limit, 0)} N -> extractor tore off the rim, failure to extract`;
        eject = `case of round #${rnd.serial} pried out of the chamber (rim torn by the extractor)`;
      } else if (s.kind === "failure_to_eject" && d.short_stroke) {
        text = `${all([...roundCauses, ...gunCauses]) || "weak gas impulse"} -> carrier stopped at ${fmt(s.value, 1)} mm, short of the ejector at ${fmt(s.limit, 1)} mm -> failure to eject`;
        eject = `fired case of round #${rnd.serial} caught in the action`;
      } else if (s.kind === "failure_to_eject") {
        text = `${all([...roundCauses, ...gunCauses]) || "weak gas impulse"} -> bolt reached the ejector at ${fmt(s.value, 2)} m/s < ${fmt(s.limit, 1)} m/s -> case not thrown clear (stovepipe), failure to eject`;
        eject = `stovepiped case of round #${rnd.serial}`;
      } else if (s.kind === "failure_to_feed" && d.short_stroke) {
        text = `${all([...roundCauses, ...gunCauses]) || "weak gas impulse"} -> port pressure too low -> carrier short-stroked (travel ${fmt(s.value, 1)} mm < ${fmt(s.limit, 1)} mm needed to get behind the next rim) -> failure to feed`;
        eject = `fired case ejected; next round #${nxt.serial} stripped by hand`;
      } else if (s.kind === "failure_to_feed" && s.quantity.startsWith("magazine")) {
        text = `${all(gunCauses) || "magazine spring"} -> stack rose in ${fmt(s.value, 1)} ms but the bolt was back in ${fmt(s.limit, 1)} ms -> bolt rode over the next round, failure to feed`;
        eject = `next round #${nxt.serial} re-seated in the magazine`;
      } else if (s.kind === "failure_to_feed") {
        text = `${all(nextCauses) || `next round #${nxt.serial} tilted ${fmt(nxt.bullet_tilt_deg, 1)} deg`} -> bullet tip ${fmt(s.value, 2)} mm off the chamber mouth (capture ${fmt(s.limit, 1)} mm) -> nose stub, failure to feed`;
        eject = `round #${nxt.serial} (${akRoundWords(nxt).join(", ") || "tilted bullet"})`;
      } else {
        text = `${all([...nextCauses, ...gunCauses]) || `next round #${nxt ? nxt.serial : "?"}`} -> resistance ${fmt(s.limit, 0)} N at ${d.where || "the return stroke"} beat the recoil spring ${fmt(s.value, 0)} N -> bolt stopped ${fmt(d.x_mm, 1)} mm out of battery, failure to go into battery`;
        eject = nxt ? `round #${nxt.serial} (${akRoundWords(nxt).join(", ") || `shoulder ${fmt(nxt.case_shoulder_d, 3)} mm`})` : "nothing";
      }
      ev.text = text;
      this.jam = { kind: s.kind, round: rnd, next: nxt, text, eject, dropNext: s.kind === "failure_to_feed" || s.kind === "failure_to_battery" };
      return ev;
    }
  }
  clearJam() {
    if (!this.jam) return null;
    const j = this.jam; this.jam = null;
    if (j.dropNext && this.mag.length) this.mag.shift();
    this.chamber = this.mag.length ? this.mag.shift() : null;
    this.chamberedAt = this.clock;
    return { ...j, chambered: !!this.chamber };
  }
  forceDud() {
    if (!this.chamber) return false;
    const r = { ...this.chamber, defects: [...this.chamber.defects, "primer_compound_missing"], primer_e_ign: Infinity };
    this.chamber = r; return true;
  }
  status() {
    return { mag: this.mag.length, cap: this.cap, chambered: !!this.chamber, jam: this.jam ? this.jam.kind : null,
      barrel_c: this.gun.barrel_c, hammer: "cocked", locked: false };
  }
}

const MAK_FACTOR_WORDS = {
  "primer": (r) => `primer (priming mix ${fmt(r.primer_mix_ratio * 100, 0)} % of nominal, contamination ${fmt(r.primer_contam, 3)} -> ${r.primer_threshold_j > 5 ? "cannot ignite" : `needs ${fmt(r.primer_threshold_j * 1000, 1)} mJ`})`,
  "powder (charge/moisture)": (r) => `powder (charge ${fmt(r.charge_g, 3)} g, moisture ${fmt(r.moisture_pct, 2)} %)`,
  "deformed next round": (r, n) => n ? `deformed next round #${n.rid} (nose offset ${fmt(n.nose_offset_mm, 2)} mm, tilt ${fmt(n.tilt_deg, 1)} deg, dent ${fmt(n.handling_mm, 2)} mm, case bulge ${fmt(n.bulge_mm, 3)} mm)` : "next round",
  "case lacquer / rim": (r) => `case lacquer stick x${fmt(r.lacquer, 2)}, rim damage ${fmt(r.rim_damage * 100, 0)} %`,
  "fouling": (r, n, g) => `carbon fouling (index ${fmt(g.fouling, 2)})`,
  "dirt": (r, n, g) => `grit in the action (index ${fmt(g.dirt, 2)})`,
  "spring fatigue": (r, n, g) => `spring fatigue (${g.rounds_total} rounds: recoil spring set ${fmt(g.recoil_set_mm, 1)} mm, mainspring -${fmt(g.mainspring_loss * 100, 1)} %)`,
};

export class MakSession {
  constructor({ seed, cond = "clean", lot = "surplus" }) {
    this.gunName = "Makarov Claude"; this.cap = 8; this.seed = seed; this.cond = cond; this.lot = lot;
    this.rng = new RNG(seed); this.ammo = new MAK.AmmoSupply(this.rng, lot);
    this.gun = new MAK.GunState({ ...MAK_COND[cond] });
    this.mag = []; this.chamber = null; this.jam = null; this.hammer = "down"; this.locked = false; this.fired = 0; this.pulls = 0;
  }
  reload() {
    this.mag = []; for (let i = 0; i < this.cap; i++) this.mag.push(this.ammo.next());
    let racked = false;
    if (!this.chamber && !this.jam) {
      this.chamber = this.mag.shift(); racked = true;
      this.hammer = "down";     // carried decocked: the first shot is double action
      this.locked = false;
    }
    return { racked };
  }
  advance() {}
  fire() {
    if (this.jam) return { type: "blocked", text: "Stoppage: clear it first (CLEAR JAM)." };
    if (this.locked) return { type: "click", text: "Slide locked open on an empty magazine. Reload." };
    if (!this.chamber) { this.hammer = "down"; return { type: "click", text: "Click - empty chamber. Reload." }; }
    this.pulls += 1;
    const mode = this.hammer === "cocked" ? "SA" : "DA";
    const rnd = this.chamber, nxt = this.mag.length ? this.mag[0] : null, gun = this.gun;
    const snap = gun.copy();
    const r = MAK.shot(rnd, nxt, gun, mode, this.mag.length, { record: true });
    const ev = { gun: "MAK", round: rnd, mode, t_lock: r.t_lock, res: r, mv: r.mv, pmax: r.pmax_mpa != null ? r.pmax_mpa * 1e6 : null,
      xt: r.slideT, magBefore: this.mag.length };
    this.hammer = "down";
    if (r.outcome === "misfire") {
      const fixes = MAK.traceCauses(rnd, nxt, snap, mode, this.mag.length);
      ev.type = "stoppage"; ev.kind = "failure to fire"; ev.fixes = fixes;
      ev.text = `${this._why(fixes, rnd, nxt, snap)} -> firing pin delivered ${fmt(r.firing_pin_j * 1000, 1)} mJ (${mode}), ${r.primer_threshold_j > 5 ? "primer has no working priming mix" : `primer needs ${fmt(r.primer_threshold_j * 1000, 1)} mJ`} -> misfire (failure to fire)`;
      this.jam = { kind: ev.kind, text: ev.text, eject: `live round #${rnd.rid} (primer mix ${fmt(rnd.primer_mix_ratio * 100, 0)} %, contamination ${fmt(rnd.primer_contam, 3)})` };
      return ev;
    }
    this.fired += 1; gun.after_shot(rnd);
    if (r.outcome === "ok") {
      ev.type = "ok"; this.chamber = this.mag.shift(); this.hammer = "cocked"; ev.text = ""; return ev;
    }
    if (r.outcome === "locked_open") {
      ev.type = "ok"; ev.lockedOpen = true; this.chamber = null; this.locked = true; this.hammer = "cocked";
      ev.text = "Last round fired - slide locked open on the empty magazine."; return ev;
    }
    const fixes = MAK.traceCauses(rnd, nxt, snap, mode, this.mag.length);
    ev.type = "stoppage"; ev.kind = r.cause; ev.fixes = fixes; const d = r.detail;
    const why = this._why(fixes, rnd, nxt, snap);
    let text, eject, dropNext = false;
    switch (r.cause) {
      case "bullet lodged": text = `${why} -> bullet did not leave the 93.5 mm bore -> squib, bullet lodged (bore must be rodded out)`; eject = `bullet of round #${rnd.rid} rodded out, case ejected`; break;
      case "failure to extract": text = `${why} -> case grip in the chamber ${fmt(d.case_stick_n, 0)} N > extractor claw ${fmt(d.claw_n, 0)} N -> claw slipped off the rim, failure to extract`; eject = `case of round #${rnd.rid} left in the chamber, picked out`; break;
      case "failure to extract (short stroke)": text = `${why} -> slide travelled ${fmt(d.x_max_mm, 1)} mm < case length ${fmt(d.x_case_mm, 1)} mm -> failure to extract (short stroke)`; eject = `case of round #${rnd.rid}`; break;
      case "failure to eject (short stroke)": text = `${why} -> slide travelled ${fmt(d.x_max_mm, 1)} mm, short of the ejector at ${fmt(d.x_ej_mm, 1)} mm -> failure to eject`; eject = `case of round #${rnd.rid} on the breech face`; break;
      case "failure to eject (stovepipe)": text = `${why} -> slide hit the ejector at ${fmt(d.v_at_ejector, 2)} m/s < ${fmt(d.v_min, 1)} m/s -> case not thrown clear (stovepipe)`; eject = `stovepiped case of round #${rnd.rid}`; break;
      case "failure to feed (short stroke)": text = `${why} -> slide travelled ${fmt(d.x_max_mm, 1)} mm < ${fmt(d.x_feed_mm, 1)} mm to get behind the top round -> failure to feed`; eject = "fired case; next round stripped by hand"; break;
      case "failure to feed (nose stub, deformed round)": text = `${why} -> bullet nose ${fmt(d.nose_offset_mm, 2)} mm off line > feed-ramp window ${fmt(d.window_mm, 2)} mm -> nose stub, failure to feed`; eject = `round #${nxt.rid} (nose offset ${fmt(nxt.nose_offset_mm, 2)} mm)`; dropNext = true; break;
      default: text = `${why} -> slide stopped ${fmt(d.x_final_mm, 2)} mm short of battery (> ${fmt(d.window_mm, 1)} mm disconnector window; chamber interference ${fmt(d.interference_mm, 3)} mm) -> out of battery`; eject = nxt ? `round #${nxt.rid} (case bulge ${fmt(nxt.bulge_mm, 3)} mm)` : "nothing"; dropNext = true;
    }
    ev.text = text;
    this.jam = { kind: r.cause, text, eject, dropNext };
    return ev;
  }
  _why(fixes, rnd, nxt, g) {
    if (!fixes.length) return "combined spread of round and gun (no single factor restored makes it run)";
    return fixes.map((f) => f.split(" + ").map((p) => MAK_FACTOR_WORDS[p](rnd, nxt, g)).join(" together with ")).join(" OR ");
  }
  clearJam() {
    if (!this.jam) return null;
    const j = this.jam; this.jam = null;
    if (j.dropNext && this.mag.length) this.mag.shift();
    this.chamber = this.mag.length ? this.mag.shift() : null;
    this.hammer = "cocked";                    // rack: the slide cocks the hammer -> single action
    if (!this.chamber) this.locked = true;     // empty magazine: the slide stop catches it
    return { ...j, chambered: !!this.chamber };
  }
  forceDud() { if (!this.chamber) return false; this.chamber = this.chamber.copy({ primer_mix_ratio: 0.0 }); return true; }
  status() {
    return { mag: this.mag.length, cap: this.cap, chambered: !!this.chamber, jam: this.jam ? this.jam.kind : null,
      hammer: this.hammer, locked: this.locked };
  }
}
