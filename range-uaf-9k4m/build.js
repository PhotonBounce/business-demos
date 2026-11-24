// build.js -- Phase 3 of the owner's 19 Nov order ("bring all funcitons in here"): the Godot range's BUILD MODE and NPC minds, light enough for phones.
// From members/cloud-claude-work/arena/design/FORTIFICATION-PROTOTYPE.md (mudel-master): foxhole 60 s, sandbag wall 90 s, small bunker 300 s at one worker,
// staged (marked / dug / revetted / roofed / camouflaged), materials drawn from a supply crate stage by stage ("waiting: need N" when short), and
// structures that stop the range's projectiles (they have HP and can be destroyed). NPCs (the page's NPC toggle) dig in by themselves when shells land
// near them, lose morale under fire, and may surrender with a white flag (2.5x as likely for the Russian side, the owner's ruling); Take captive +100,
// a round on a surrendering soldier -200. APPROXIMATE: box collision, simple shapes, a one-number morale model.
const DEFS = {
  foxhole: { name: "Foxhole", time: 60, hp: 600, size: [2.4, 2.4], stages: [["marked", 0.05, {}], ["dug", 0.83, { sandbags: 4 }], ["camouflaged", 1, { nets: 1 }]] },
  wall: { name: "Sandbag wall", time: 90, hp: 900, size: [0.7, 4.2], stages: [["marked", 0.05, {}], ["revetted", 1, { sandbags: 24 }]] },
  bunker: { name: "Small bunker", time: 300, hp: 2600, size: [3.4, 4.4], stages: [["marked", 0.03, {}], ["dug", 0.33, {}], ["revetted", 0.6, { timber: 12 }], ["roofed", 0.9, { timber: 8, sandbags: 20 }], ["camouflaged", 1, { nets: 1 }]] },
};
const CRATE_FULL = { sandbags: 60, timber: 24, nets: 3 };
const DMG = { bullet: 3, kinetic_small: 30, he_small: 45, kinetic: 400, heat: 350, he: 420, rocket_he: 600 };

export function installBuild(A) {
  const THREE = A.THREE, $ = A.$, S = A.S, CLOCK = A.CLOCK, root = A.root;
  const B = { list: [], crate: { ...CRATE_FULL }, fast: false, arm: null, score: 0, ghost: null, events: [] };
  const grp = new THREE.Group(); grp.name = "build"; root.add(grp);
  const M = (c, r = 0.95) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0 });
  const dirt = M(0x6e5a3e), bagM = M(0x9a8a60), logM = M(0x5a4128), netM = new THREE.MeshStandardMaterial({ color: 0x4f6038, roughness: 1, transparent: true, opacity: 0.85, side: THREE.DoubleSide }), holeM = M(0x1d150d, 1);
  const box = (w, h, d, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.castShadow = true; o.receiveShadow = true; return o; };
  // the supply crate, 25 m out on the left of the firing line
  const crate = box(1.2, 0.8, 0.8, M(0x4f5a3a, 0.9)); grp.add(crate);
  const crateLabel = box(1.21, 0.12, 0.81, M(0xd8d0b0)); crate.add(crateLabel);
  function gy() { return A.groundY(); }
  function placeStatic() { crate.position.set(25, gy() + 0.4, -14); }

  // ---------------------------------------------------------------- a structure: geometry that grows with its stage progress
  function make(type, x, z, rot) {
    const D = DEFS[type], g = new THREE.Group(); g.position.set(x, gy(), z); g.rotation.y = rot || 0; grp.add(g);
    const s = { type, D, g, x, z, prog: 0, stage: 0, hp: D.hp, dead: false, wait: null, paid: new Set(), box: new THREE.Box3(), started: CLOCK.t, parts: {} };
    const mark = new THREE.Mesh(new THREE.RingGeometry(Math.max(D.size[0], D.size[1]) * 0.55, Math.max(D.size[0], D.size[1]) * 0.6, 24), new THREE.MeshBasicMaterial({ color: 0xffffff })); mark.rotation.x = -Math.PI / 2; mark.position.y = 0.03; g.add(mark); s.parts.mark = mark;
    if (type === "foxhole") {
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20), holeM); hole.rotation.x = -Math.PI / 2; hole.position.y = 0.025; g.add(hole); s.parts.hole = hole;
      const par = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.32, 6, 18), dirt); par.rotation.x = Math.PI / 2; par.scale.set(1, 1, 0.01); g.add(par); s.parts.par = par;
      const net = new THREE.Mesh(new THREE.CircleGeometry(1.25, 14), netM); net.rotation.x = -Math.PI / 2; net.position.y = 0.42; net.visible = false; g.add(net); s.parts.net = net;
    } else if (type === "wall") {
      s.parts.rows = []; for (let r = 0; r < 6; r++) { const row = new THREE.Group(); for (let i = 0; i < 6; i++) { const b = box(0.58, 0.19, 0.66, bagM); b.position.set(0, 0.1 + r * 0.2, -1.75 + i * 0.7 + (r % 2 ? 0.35 : 0)); if (i === 5 && r % 2) continue; row.add(b); } row.visible = false; g.add(row); s.parts.rows.push(row); }
    } else {
      const pit = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 4.2), holeM); pit.rotation.x = -Math.PI / 2; pit.position.y = 0.025; g.add(pit); s.parts.pit = pit;
      s.parts.walls = []; for (const [w, d, px, pz] of [[0.3, 4.2, 1.6, 0], [0.3, 4.2, -1.6, 0], [3.2, 0.3, 0, 2.05], [3.2, 0.3, 0, -2.05]]) { const wl = box(w, 1.3, d, logM); wl.position.set(px, 0.65, pz); wl.scale.y = 0.01; g.add(wl); s.parts.walls.push(wl); }
      const slit = box(0.32, 0.18, 1.6, holeM); slit.position.set(1.62, 1.05, 0); slit.visible = false; g.add(slit); s.parts.slit = slit;
      const roof = box(3.6, 0.5, 4.6, dirt); roof.position.y = 1.55; roof.scale.y = 0.01; roof.visible = false; g.add(roof); s.parts.roof = roof;
      const net = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 5.2), netM); net.rotation.x = -Math.PI / 2; net.position.y = 1.83; net.visible = false; g.add(net); s.parts.net = net;
    }
    B.list.push(s); A.extraBoxes.push(s); pose(s); return s;
  }
  function pose(s) {   // geometry and the collision box from the progress (protection grows with the stage, spec 1.3)
    const P = s.parts, u = s.prog, D = s.D; let h = 0;
    if (s.type === "foxhole") { const dig = Math.min(1, u / 0.83); P.par.scale.z = Math.max(0.01, dig); P.par.position.y = 0.32 * dig - 0.05; P.hole.material = holeM; P.net.visible = u >= 0.999 && !s.dead; h = 0.6 * dig; }
    else if (s.type === "wall") { const rows = Math.round(Math.min(1, u) * 6); P.rows.forEach((r, i) => { r.visible = i < rows; }); h = rows * 0.2; }
    else { const rv = Math.max(0, Math.min(1, (u - 0.33) / 0.27)), rf = Math.max(0, Math.min(1, (u - 0.6) / 0.3)); for (const w of P.walls) { w.scale.y = Math.max(0.01, rv); w.position.y = 0.65 * rv; } P.slit.visible = rv >= 1; P.roof.visible = rf > 0; P.roof.scale.y = Math.max(0.01, rf); P.roof.position.y = 1.3 + 0.25 * rf; P.net.visible = u >= 0.999 && !s.dead; h = rv * 1.3 + rf * 0.5; }
    P.mark.visible = u < 0.06;
    if (s.dead) h *= 0.5;   // a destroyed structure keeps half its height
    s.g.updateMatrixWorld(true);
    const hw = D.size[0] / 2, hd = D.size[1] / 2, c = Math.cos(s.g.rotation.y), sn = Math.sin(s.g.rotation.y), ex = Math.abs(c * hw) + Math.abs(sn * hd), ez = Math.abs(sn * hw) + Math.abs(c * hd);
    if (h > 0.05) { s.box.min.set(s.x - ex, gy(), s.z - ez); s.box.max.set(s.x + ex, gy() + h, s.z + ez); } else s.box.makeEmpty();
  }
  function canPlace(type, x, z) {
    const D = DEFS[type], r = Math.max(D.size[0], D.size[1]) / 2 + 0.5;
    if (x < 12 || x > 320 || Math.abs(z) > 45) return "Outside the dig pad (12-320 m out, 45 m either side)";
    if (Math.hypot(x - crate.position.x, z - crate.position.z) < r + 1) return "Overlaps the supply crate";
    for (const s of B.list) { const rs = Math.max(s.D.size[0], s.D.size[1]) / 2 + 0.5; if (Math.hypot(x - s.x, z - s.z) < r + rs) return "Overlaps the " + s.D.name.toLowerCase(); }
    for (const t of A.targets()) if (Math.abs(x - t.d) < 6 + r && Math.abs(z - t.z) < 6 + r) return "Overlaps a target";
    return null;
  }
  function place(type, x, z, rot = 0) {
    const why = canPlace(type, x, z); if (why) { A.msg("Cannot build here: " + why + ".", true); return why; }
    const s = make(type, x, z, rot); B.events.push({ e: "placed", type, t: CLOCK.t });
    A.msg(`${s.D.name} marked out ${x.toFixed(0)} m downrange. Real build time ${s.D.time} s at one worker${B.fast ? " (shown x10 fast)" : ""}.`); render(); return s;
  }
  function need(s, mats) { const short = []; for (const [k, n] of Object.entries(mats)) if ((B.crate[k] || 0) < n) short.push(`${n - (B.crate[k] || 0)} ${k}`); return short; }
  function step(dt) {
    let any = false;
    for (const s of B.list) {
      if (s.dead || s.prog >= 1) continue;
      const st = s.D.stages[s.stage];
      if (!s.paid.has(s.stage)) { const sh = need(s, st[2]); if (sh.length) { if (s.wait !== sh.join(", ")) { s.wait = sh.join(", "); render(); } continue; } for (const [k, n] of Object.entries(st[2])) B.crate[k] -= n; s.paid.add(s.stage); s.wait = null; }
      s.prog = Math.min(st[1], s.prog + dt * (B.fast ? 10 : 1) / s.D.time);
      if (s.prog >= st[1] - 1e-9 && s.stage < s.D.stages.length - 1) { s.stage++; B.events.push({ e: "stage", type: s.type, stage: s.D.stages[s.stage - 1][0], t: CLOCK.t }); }
      if (s.prog >= 1) { B.events.push({ e: "done", type: s.type, t: CLOCK.t }); A.toast(`${s.D.name} finished.`); }
      pose(s); any = true;
    }
    return any;
  }
  // a round that stops in a structure (vehfire's hit test found its box): damage, and a destroyed structure slumps
  A.onStructureHit = (s, p, a) => {
    if (!s || s.dead) return; const n = s.npc; if (n) return;   // the NPCs' own holes are cosmetic
    s.hp -= DMG[a.fx] || 10 * (a.cal / 10);
    B.events.push({ e: "hit", type: s.type, hp: s.hp, t: CLOCK.t });
    if (s.hp <= 0) { s.dead = true; s.g.scale.y = 0.5; for (const k of ["net", "slit"]) if (s.parts[k]) s.parts[k].visible = false; pose(s); A.toast(`${s.D.name} destroyed.`); }
    render();
  };

  // ---------------------------------------------------------------- NPC minds on the page's NPC toggle: dig in under fire, surrender with a white flag
  const flagGeo = new THREE.PlaneGeometry(0.55, 0.38), poleGeo = new THREE.CylinderGeometry(0.012, 0.012, 1.6, 6), flagM = new THREE.MeshStandardMaterial({ color: 0xf4f4ee, side: THREE.DoubleSide, roughness: 0.9 });
  const mind = new Map();
  function npcState(n) {
    let m = mind.get(n); if (m) return m;
    m = { morale: 1, loyalty: n.key === "ru" ? 0.45 : 0.9, dig: 0, digging: false, surrendered: false, captive: false, hole: null, flag: null, underFireAt: -1e9 };
    mind.set(n, m); return m;
  }
  A.onImpact = (p, a, kind) => {
    const N = A.NPC; if (!N || !N.on || !N.ready) return;
    for (const n of N.list) {
      const m = npcState(n); if (m.captive) continue;
      const d = Math.hypot(p.x - n.holder.position.x, p.z - n.holder.position.z);
      if (m.surrendered && d < 3) { B.score -= 200; B.events.push({ e: "shot_surrendered", npc: n.key, t: CLOCK.t }); A.toast(`A round on a surrendering soldier: -200 (score ${B.score}).`); continue; }
      if (d > 70) continue;
      const big = !!a.heR || a.fx === "heat" || a.fx === "kinetic", hit = (big ? 0.32 : 0.05) * Math.max(0, 1 - d / 70) * (m.dig >= 1 ? 0.35 : 1);
      m.morale = Math.max(0, m.morale - hit); m.underFireAt = CLOCK.t;
      if (!m.digging && m.dig < 1 && !m.surrendered) { m.digging = true; B.events.push({ e: "npc_dig", npc: n.key, t: CLOCK.t }); A.toast(`The ${n.key === "ru" ? "Russian" : "Ukrainian"} private starts digging in.`); }
      if (!m.surrendered && m.morale < 0.2 && Math.random() < (n.key === "ru" ? 0.5 : 0.2) * (1.5 - m.loyalty)) surrender(n, m);
    }
  };
  function surrender(n, m) {
    m.surrendered = true; m.digging = false; B.events.push({ e: "surrender", npc: n.key, t: CLOCK.t });
    const f = new THREE.Group(), pole = new THREE.Mesh(poleGeo, M(0x6b5236)); pole.position.y = 2.1; const cloth = new THREE.Mesh(flagGeo, flagM); cloth.position.set(0.28, 2.7, 0); f.add(pole, cloth); f.name = "white_flag"; n.holder.add(f); m.flag = f;
    try { if (n.acts.idle) { n.acts.idle.reset().play(); if (n.acts.aim) n.acts.aim.stop(); n.state = "idle"; } } catch {}
    A.toast(`The ${n.key === "ru" ? "Russian" : "Ukrainian"} private surrenders: white flag up. "Take captive" scores +100.`); render();
  }
  function captive() {
    const N = A.NPC; let k = 0; if (!N || !N.ready) return 0;
    for (const n of N.list) { const m = npcState(n); if (m.surrendered && !m.captive) { m.captive = true; n.holder.visible = false; if (m.hole) m.hole.visible = false; B.score += 100; k++; B.events.push({ e: "captive", npc: n.key, t: CLOCK.t }); } }
    A.toast(k ? `Taken captive: ${k} (+${100 * k}). Score ${B.score}.` : "Nobody is surrendering."); render(); return k;
  }
  function stepNpc(dt) {
    const N = A.NPC; if (!N || !N.ready) return false; let any = false;
    for (const n of N.list) {
      const m = npcState(n);
      if (!N.on || m.captive) continue;
      if (CLOCK.t - m.underFireAt > 8 * S.speed && m.morale < 1 && !m.surrendered) m.morale = Math.min(1, m.morale + dt * 0.01);   // safe for a while: morale slowly returns
      if (m.digging && m.dig < 1) {
        if (!m.hole) { m.hole = new THREE.Group(); const h = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), holeM); h.rotation.x = -Math.PI / 2; h.position.y = 0.03; const sp = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), dirt); sp.position.set(0.9, 0, 0); sp.scale.y = 0.01; m.hole.add(h, sp); m.hole.userData.spoil = sp; grp.add(m.hole); }
        m.dig = Math.min(1, m.dig + dt * (B.fast ? 10 : 1) / 25 * (m.morale < 0.4 ? 0.7 : 1)); if (m.dig >= 1) { m.digging = false; B.events.push({ e: "npc_dug", npc: n.key, t: CLOCK.t }); }
        any = true;
      }
      if (m.hole) { m.hole.position.set(n.holder.position.x, N.ground + 0.0, n.holder.position.z); m.hole.userData.spoil.scale.y = Math.max(0.01, m.dig * 0.6); m.hole.visible = n.holder.visible && N.on; }
      const sink = m.surrendered ? 0 : 0.95 * m.dig; const y = N.ground - sink; if (Math.abs(n.holder.position.y - y) > 1e-4) { n.holder.position.y = y; any = true; }
      if (m.flag) { m.flag.children[1].rotation.y = 0.3 * Math.sin(CLOCK.t * 5); any = true; }
    }
    return any;
  }

  // ---------------------------------------------------------------- the panel (inside the vehicle-weapons panel) and tap-to-place
  const box2 = document.createElement("div"); box2.className = "vfbuild"; box2.style.cssText = "grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px 12px;border-top:1px solid var(--line);padding-top:8px";
  box2.innerHTML = `<label class="ctl"><span>Build</span><select id="bdType">${Object.entries(DEFS).map(([k, d]) => `<option value="${k}">${d.name} (${d.time} s)</option>`).join("")}</select></label>
    <div class="vfrow"><button type="button" id="bdPlace">Place: tap the ground</button><button type="button" id="bdQuick">Place 60 m out</button></div>
    <div class="vfrow"><button type="button" id="bdCrate">Restock crate</button><button type="button" id="bdCaptive">Take captive</button></div>
    <label class="ctl chk"><input type="checkbox" id="bdFast"> Build time x10</label>
    <p class="vfinfo" id="bdInfo" role="status" aria-live="polite"></p>`;
  A.panel.appendChild(box2);
  $("bdFast").addEventListener("change", () => { B.fast = $("bdFast").checked; });
  $("bdCrate").addEventListener("click", () => { B.crate = { ...CRATE_FULL }; B.events.push({ e: "restock", t: CLOCK.t }); A.msg("Supply crate restocked: 60 sandbags, 24 timber, 3 nets."); render(); });
  $("bdCaptive").addEventListener("click", () => captive());
  $("bdQuick").addEventListener("click", () => { const t = $("bdType").value; for (let i = 0; i < 12; i++) { const z = -30 + (i % 7) * 10, x = 60 + Math.floor(i / 7) * 12; if (!canPlace(t, x, z)) { place(t, x, z); return; } } A.msg("No free plot 60 m out.", true); });
  $("bdPlace").addEventListener("click", () => { B.arm = $("bdType").value; A.msg(`Tap the ground where the ${DEFS[B.arm].name.toLowerCase()} goes (Esc cancels).`); });
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitV = new THREE.Vector3(); let down = null;
  document.addEventListener("pointerdown", (e) => { if (B.arm && e.target.tagName === "CANVAS" && e.target.closest("#vwrap")) down = { x: e.clientX, y: e.clientY, t: e.target }; }, true);
  document.addEventListener("pointerup", (e) => {
    if (!B.arm || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { down = null; return; }
    const r = down.t.getBoundingClientRect(); down = null; ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, A.camera); plane.constant = -gy(); if (!ray.ray.intersectPlane(plane, hitV)) { A.msg("Tap on the ground.", true); return; }
    const t = B.arm, res = place(t, hitV.x, hitV.z); if (typeof res !== "string") B.arm = null;
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && B.arm) { B.arm = null; A.msg("Placing cancelled."); } });
  let lastHtml = "";
  function render() {
    const c = B.crate, parts = B.list.map((s) => { const st = s.D.stages[Math.min(s.stage, s.D.stages.length - 1)]; const left = (1 - s.prog) * s.D.time / (B.fast ? 10 : 1);
      return `${s.D.name} ${s.dead ? "DESTROYED" : s.prog >= 1 ? "done" : s.wait ? "waiting: need " + s.wait : `${Math.round(s.prog * 100)}% ${s.prog < 0.05 ? "marked" : st[0]} · ${left.toFixed(0)} s left`}${s.dead ? "" : ` · HP ${Math.max(0, Math.round(s.hp))}`}`; });
    const N = A.NPC, npc = N && N.ready && N.on ? N.list.map((n) => { const m = npcState(n); return `${n.key.toUpperCase()} ${m.captive ? "captive" : m.surrendered ? "SURRENDERED (white flag)" : m.dig >= 1 ? "dug in" : m.digging ? `digging ${Math.round(m.dig * 100)}%` : "standing"} · morale ${Math.round(m.morale * 100)}%`; }).join(" · ") : "NPCs off (toolbar NPCs button)";
    const html = `Crate: ${c.sandbags} sandbags, ${c.timber} timber, ${c.nets} net${c.nets === 1 ? "" : "s"} · score ${B.score}<br>${parts.join("<br>") || "Nothing built yet."}<br>${npc}`;
    if (html !== lastHtml) { $("bdInfo").innerHTML = html; lastHtml = html; }
  }
  let acc = 0;
  return {
    reset: () => { placeStatic(); for (const s of B.list) pose(s); },
    step: (dt) => { const a = step(dt), b = stepNpc(dt); acc += dt; if (acc > 0.25 / Math.max(1, S.speed) || a) { acc = 0; render(); } return a || b; },
    api: { place, canPlace, captive, state: () => ({ list: B.list.map((s) => ({ type: s.type, prog: +s.prog.toFixed(3), stage: s.D.stages[s.stage][0], hp: s.hp, dead: s.dead, wait: s.wait, h: s.box.isEmpty() ? 0 : +(s.box.max.y - s.box.min.y).toFixed(2) })), crate: { ...B.crate }, score: B.score, events: B.events.slice(-40),
      npc: A.NPC && A.NPC.ready ? A.NPC.list.map((n) => { const m = npcState(n); return { key: n.key, morale: +m.morale.toFixed(2), dig: +m.dig.toFixed(2), digging: m.digging, surrendered: m.surrendered, captive: m.captive, y: +n.holder.position.y.toFixed(2), flag: !!m.flag, w: n.holder.getWorldPosition(new A.THREE.Vector3()).toArray().map((v) => +v.toFixed(2)) }; }) : null }),
      setFast: (f) => { B.fast = f; $("bdFast").checked = f; }, restock: () => $("bdCrate").click(), surrenderNow: (k) => { const n = A.NPC.list.find((x) => x.key === k); if (n) surrender(n, npcState(n)); } },
  };
}
