/*
 * Pen-plotter drawing of two crossed Gaussian beams: a 3-D contour plot.
 *
 * Each beam is drawn as its 1/e² envelope (the outline of the w(s) surface as the camera sees
 * it) plus slices across its axis. Each slice holds the beam's transverse intensity contours as
 * concentric rings, so you can follow the intensity along the beam: rings crowd into the focus
 * and thin out where the beam spreads. The beam model (axes, waists, Rayleigh ranges) is the one
 * in overlap.js. Units: µm in the scene, mm on paper.
 *
 * The result is one set of polylines per beam (one pen each), fitted to the paper and ordered to
 * keep pen-up travel short. toSVG writes a layer as a plain-polyline SVG in millimetres, which
 * plotter tools such as strek read directly.
 *
 * Works as a browser global (window.BeamPlot, after overlap.js) and as a CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./overlap.js'));
  else root.BeamPlot = factory(root.FocalOverlap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (F) {
  'use strict';

  const DEG = Math.PI / 180;
  const E2 = Math.exp(-2);
  const KEYS = ['probe', 'pump'];
  const COLORS = { probe: '#1b1b1b', pump: '#0b8a3e' };

  const DEFAULTS = {
    probe: { lambda: 800, w0: 1.5, half: 18, slices: 11 }, // half: drawn ±range along the beam, µm
    pump: { lambda: 800, w0: 1.6, half: 18, slices: 11 },
    angle: 15, // crossing angle θ, deg
    dx: 0, // pump focus offset from the probe focus, µm
    dy: 0,
    dz: 0,
    levels: 12, // contour rings per slice (besides the 1/e² outline)
    spacing: 'linear', // 'linear': k/(n+1) of the peak; 'log': exp(−2k/(n+1)), even steps in r²
    scale: 'absolute', // 'absolute': fractions of the focal peak; 'slice': of each slice's own peak
    outline: true, // the 1/e² ring on every slice
    envelope: true, // the 1/e² outline along the beam
    azimuth: 28, // camera turned about the vertical (x) axis, deg; 0 looks straight at the crossing plane
    elevation: 8, // camera raised out of the crossing plane, deg
    stretch: 1, // transverse (x, y) exaggeration; 1 = true proportions
    paper: { w: 210, h: 148, margin: 12 }, // mm (A5 landscape)
    pen: 0.4, // line width, mm (Stabilo Point 88)
    pitch: 0.25, // least centre-to-centre spacing of neighbouring rings, mm; below the pen
    // width the rings overlap and shade the bright core
    ticks: false, // corner ticks in every layer, so separately plotted layers still register
    signals: true, // 1PA and 2PA signal along z, in a panel under the beams
    panel: 24, // height of that panel, mm
    hatch: 0.7, // spacing of the shading under the 2PA curve, mm; 0 = none
  };

  function withDefaults(p) {
    const out = JSON.parse(JSON.stringify(DEFAULTS));
    for (const k in p || {}) {
      if (p[k] && typeof p[k] === 'object' && out[k] && typeof out[k] === 'object') Object.assign(out[k], p[k]);
      else if (p[k] !== undefined) out[k] = p[k];
    }
    return out;
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Contour levels as fractions of the peak, lowest intensity (largest ring) last.
  function levelFractions(p) {
    const n = Math.max(0, Math.round(p.levels));
    const out = [];
    for (let k = 1; k <= n; k++) out.push(p.spacing === 'log' ? Math.exp(-2 * k / (n + 1)) : k / (n + 1));
    return out;
  }

  // The two beams in the overlap.js frame: the probe runs along +z from the origin; the pump
  // runs in the x–z plane at θ, focused at (dx, dy, dz). (u, v, a) is a right-handed frame with
  // a along the beam; `field` is the peak-normalised intensity (1 at the focus).
  function beams(p) {
    const M = F.createModel({
      mode: '2pa', angle: p.angle, L: 1, T1: Infinity,
      pump: { lambda: p.pump.lambda, w0: p.pump.w0, fwhm: 1 },
      probe: { lambda: p.probe.lambda, w0: p.probe.w0, fwhm: 1 },
    });
    return [
      {
        key: 'probe', half: p.probe.half, slices: Math.max(1, Math.round(p.probe.slices)),
        c: [0, 0, 0], a: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], w0: p.probe.w0, zR: M.zRr,
        width: (s) => F.probeWidth(M, s),
        field: (q) => F.probeSpatial(M, q[0], q[1], q[2]),
      },
      {
        key: 'pump', half: p.pump.half, slices: Math.max(1, Math.round(p.pump.slices)),
        c: [p.dx, p.dy, p.dz], a: [M.sin, 0, M.cos], u: [M.cos, 0, -M.sin], v: [0, 1, 0], w0: p.pump.w0, zR: M.zRp,
        width: (s) => F.pumpWidth(M, s),
        field: (q) => F.pumpSpatial(M, q[0], q[1], q[2], p.dx, p.dy, p.dz),
      },
    ];
  }

  // Point at depth s along the beam, distance r from its axis, at angle t around it.
  function beamPoint(b, s, r, t) {
    const ct = Math.cos(t), st = Math.sin(t);
    return [0, 1, 2].map((i) => b.c[i] + s * b.a[i] + r * (ct * b.u[i] + st * b.v[i]));
  }

  // Radius where the beam at depth s falls to the fraction f of its focal peak (or of the
  // slice's own peak when `relative`); 0 if it never gets that bright there.
  function ringRadius(b, s, f, relative) {
    const w = b.width(s);
    const peak = relative ? 1 : (b.w0 * b.w0) / (w * w);
    return peak > f ? w * Math.sqrt(0.5 * Math.log(peak / f)) : 0;
  }

  // Orthographic camera. At azimuth = elevation = 0 it looks straight at the crossing plane
  // (z to the right, x up). Azimuth turns it about x so the slices open into ellipses;
  // elevation lifts it out of the plane. `stretch` scales x and y before projecting.
  function camera(p) {
    const sa = Math.sin(p.azimuth * DEG), ca = Math.cos(p.azimuth * DEG);
    const se = Math.sin(p.elevation * DEG), ce = Math.cos(p.elevation * DEG);
    const R = [0, sa, ca]; // screen right
    const U = [ce, -se * ca, se * sa]; // screen up
    const V = [se, ce * ca, -ce * sa]; // toward the viewer
    const E = p.stretch > 0 ? p.stretch : 1;
    return {
      R, U, V, E,
      // Scene point (µm) to screen (x right, y down), in stretched µm.
      project(q) {
        const x = q[0] * E, y = q[1] * E, z = q[2];
        return [x * R[0] + y * R[1] + z * R[2], -(x * U[0] + y * U[1] + z * U[2])];
      },
      // The view direction pulled back through the stretch: a surface turns edge-on to the
      // camera where its (unstretched) normal is perpendicular to this.
      D: [V[0], V[1], V[2] * E],
    };
  }

  // Smallest semi-axis of the screen ellipse that a unit ring across beam b projects to.
  // Concentric rings in one slice are scaled copies, so their closest approach is the
  // difference in radius times this.
  function minorAxis(b, cam) {
    const pu = cam.project(b.u), pv = cam.project(b.v);
    const S = pu[0] * pu[0] + pu[1] * pu[1] + pv[0] * pv[0] + pv[1] * pv[1];
    const det = Math.abs(pu[0] * pv[1] - pu[1] * pv[0]);
    const big = Math.sqrt(0.5 * (S + Math.sqrt(Math.max(0, S * S - 4 * det * det))));
    return big > 0 ? det / big : 0;
  }

  // The beam's 1/e² outline as the camera sees it: the lines where the surface r = w(s) turns
  // edge-on. With N = e_r − w′(s)·a, that is cos(t − ψ)·|(u·D, v·D)| = w′(s)·(a·D). Each side is
  // split where the camera looks down the beam and the outline vanishes.
  function envelope(b, cam, n) {
    n = n || 400;
    const D = cam.D;
    const A = dot(b.u, D), B = dot(b.v, D), G = dot(b.a, D);
    const R0 = Math.hypot(A, B), psi = Math.atan2(B, A);
    const out = [];
    const cur = [[], []];
    const flush = () => {
      for (let j = 0; j < 2; j++) {
        if (cur[j].length > 1) out.push(cur[j]);
        cur[j] = [];
      }
    };
    for (let i = 0; i <= n; i++) {
      const s = -b.half + (2 * b.half * i) / n;
      const w = b.width(s);
      const dw = (b.w0 * b.w0 * s) / (b.zR * b.zR * w);
      const c = R0 > 1e-12 ? (dw * G) / R0 : Infinity;
      if (!(Math.abs(c) <= 1)) { flush(); continue; }
      const da = Math.acos(c);
      cur[0].push(cam.project(beamPoint(b, s, w, psi + da)));
      cur[1].push(cam.project(beamPoint(b, s, w, psi - da)));
    }
    flush();
    return out;
  }

  function sliceDepths(b) {
    if (b.slices === 1) return [0];
    const out = [];
    for (let k = 0; k < b.slices; k++) out.push(-b.half + (2 * b.half * k) / (b.slices - 1));
    return out;
  }

  /**
   * Signal generated per unit depth along the probe, for the panel under the beams. 2PA (a pump
   * and a probe photon absorbed together) goes as ∫ I_pump·I_probe dx dy: the local overlap from
   * overlap.js, with pulses long next to the walk-off across the crossing. 1PA goes as ∫ I dx dy,
   * the beam power, which is the same at every depth. The 1PA level is set so that both curves
   * hold the same area (the same total signal), so they compare where the signal comes from.
   * Returns { z (µm), twoPA (peak 1), onePA (level) }.
   */
  function signals(p, n) {
    n = n || 300;
    const M = F.createModel({
      mode: '2pa', angle: p.angle, L: 2 * p.probe.half, T1: Infinity,
      pump: { lambda: p.pump.lambda, w0: p.pump.w0, fwhm: 1e6 },
      probe: { lambda: p.probe.lambda, w0: p.probe.w0, fwhm: 1e6 },
    });
    const z = [], f = [];
    for (let i = 0; i <= n; i++) {
      z.push(-p.probe.half + (2 * p.probe.half * i) / n);
      f.push(F.slice(M, z[i], p.dx, p.dy, p.dz, 0));
    }
    const peak = Math.max(...f);
    const twoPA = f.map((v) => (peak > 0 ? v / peak : 0));
    let area = 0;
    for (let i = 1; i <= n; i++) area += 0.5 * (twoPA[i - 1] + twoPA[i]) * (z[i] - z[i - 1]);
    return { z, twoPA, onePA: area / (2 * p.probe.half) };
  }

  // Single-stroke glyphs for the panel labels, in a 0.6 × 1 cell (y down).
  const GLYPHS = {
    1: [[[0.1, 0.22], [0.36, 0], [0.36, 1]], [[0.1, 1], [0.6, 1]]],
    2: [[[0.04, 0.24], [0.12, 0.08], [0.3, 0], [0.48, 0.06], [0.56, 0.22], [0.52, 0.38], [0.04, 1], [0.6, 1]]],
    P: [[[0, 1], [0, 0], [0.38, 0], [0.53, 0.07], [0.58, 0.25], [0.53, 0.43], [0.38, 0.5], [0, 0.5]]],
    A: [[[0, 1], [0.3, 0], [0.6, 1]], [[0.1, 0.66], [0.5, 0.66]]],
    a: [[[0.55, 0.45], [0.55, 1]], [[0.55, 0.62], [0.45, 0.49], [0.3, 0.45], [0.13, 0.5], [0.04, 0.64], [0.02, 0.76],
      [0.06, 0.88], [0.17, 0.98], [0.3, 1], [0.45, 0.96], [0.55, 0.85]]],
    i: [[[0.3, 0.45], [0.3, 1]], [[0.3, 0.22], [0.3, 0.27]]],
    s: [[[0.53, 0.52], [0.42, 0.46], [0.25, 0.45], [0.1, 0.5], [0.06, 0.6], [0.12, 0.69], [0.3, 0.73], [0.47, 0.78],
      [0.54, 0.88], [0.48, 0.97], [0.32, 1], [0.14, 0.98], [0.03, 0.91]]],
    x: [[[0.05, 0.45], [0.55, 1]], [[0.55, 0.45], [0.05, 1]]],
    z: [[[0.05, 0.45], [0.55, 0.45], [0.05, 1], [0.55, 1]]],
  };
  const textWidth = (str, h) => (str.length ? (0.8 * (str.length - 1) + 0.6) * h : 0);
  function text(str, x, top, h) {
    const out = [];
    [...str].forEach((ch, i) => {
      for (const g of GLYPHS[ch] || []) out.push(g.map(([u, v]) => [x + (0.8 * i + u) * h, top + v * h]));
    });
    return out;
  }

  // The signal panel in mm. X(z) places a probe depth under the beam drawing, `slices` are the
  // probe's slice depths, `box` is the beams' extent on paper ([left, right]), and the panel
  // spans `top` to `top + P`. The z axis with its label, a line up through the panel at every
  // probe slice, and the 1PA line with its label go to the probe pen; the 2PA curve, its
  // shading and its label go to the pump pen.
  function signalPanel(sig, X, slices, box, top, P, p) {
    const LH = 3; // label height
    const yb = top + P - LH - 1.8; // z axis, with its label underneath
    const hc = yb - (top + LH + 1.5); // height of the 2PA peak
    const probe = [], pump = [];

    const xa = X(sig.z[0]), xb = X(sig.z[sig.z.length - 1]);
    probe.push([[xa, yb], [xb, yb]]);
    for (const s of slices) probe.push([[X(s), yb + 1], [X(s), yb - hc]]);
    const wz = textWidth('z axis', LH);
    probe.push(...text('z axis', (xa + xb - wz) / 2, yb + 1.8, LH));

    const y1 = yb - sig.onePA * hc;
    probe.push([[xa, y1], [xb, y1]]);
    const w = textWidth('1PA', LH);
    const lx = xb + 1.5 + w <= box[1] ? xb + 1.5 : xa - 1.5 - w >= box[0] ? xa - 1.5 - w : xb - 1 - w;
    probe.push(...text('1PA', lx, lx === xb - 1 - w ? y1 - 1 - LH : y1 - LH / 2, LH));

    // 2PA curve, left out where it lies on the axis.
    const pts = sig.z.map((z, i) => [X(z), yb - sig.twoPA[i] * hc]);
    let run = [];
    pts.forEach((q, i) => {
      if (sig.twoPA[i] * hc >= 0.05) run.push(q);
      else if (run.length) { if (run.length > 1) pump.push(simplify(run, 0.01)); run = []; }
    });
    if (run.length > 1) pump.push(simplify(run, 0.01));

    // Shading: vertical strokes every `hatch` mm, joined into zigzags along the curve and the
    // axis so each patch is one pen-down stroke.
    if (p.hatch > 0) {
      const ys = (x) => {
        let i = 1;
        while (i < pts.length - 1 && pts[i][0] < x) i++;
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        return bx === ax ? ay : ay + ((by - ay) * (x - ax)) / (bx - ax);
      };
      let zig = [], up = true;
      for (let x = xa + p.hatch / 2; x <= xb; x += p.hatch) {
        const y = ys(x);
        if (yb - y < Math.max(0.6, p.pen)) {
          if (zig.length > 2) pump.push(zig);
          zig = [];
          continue;
        }
        zig.push(...(up ? [[x, yb], [x, y]] : [[x, y], [x, yb]]));
        up = !up;
      }
      if (zig.length > 2) pump.push(zig);
    }

    let ip = 0;
    sig.twoPA.forEach((v, i) => { if (v > sig.twoPA[ip]) ip = i; });
    const w2 = textWidth('2PA', LH);
    const tx = Math.min(Math.max(pts[ip][0] - w2 / 2, xa), xb - w2);
    pump.push(...text('2PA', tx, yb - hc - 1.2 - LH, LH));
    return { probe, pump };
  }

  // Ramer–Douglas–Peucker, tolerance in the points' units.
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      const ax = pts[i0][0], ay = pts[i0][1];
      const dx = pts[i1][0] - ax, dy = pts[i1][1] - ay;
      const len2 = dx * dx + dy * dy;
      let best = 0, bi = -1;
      for (let i = i0 + 1; i < i1; i++) {
        let ex = pts[i][0] - ax, ey = pts[i][1] - ay;
        if (len2 > 0) {
          const t = Math.max(0, Math.min(1, (ex * dx + ey * dy) / len2));
          ex -= t * dx;
          ey -= t * dy;
        }
        const d = ex * ex + ey * ey;
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol * tol) {
        keep[bi] = 1;
        stack.push([i0, bi], [bi, i1]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // Rings packed tighter than one pen width overlap and shade the bright core; packed tighter
  // than the pitch they would only pile ink on ink. Walk a slice's rings from the outside in
  // (radii sorted descending) and keep one only if, on the ellipse's narrow axis, it sits at
  // least one pitch inside the last kept ring and half a pitch out from its own centre.
  // `minor` converts a ring radius to its narrow semi-axis on paper.
  function keepRings(rings, minor, pitch) {
    const kept = [];
    let last = Infinity;
    for (const ring of rings) {
      const m = ring.r * minor;
      if (m < pitch / 2 || last - m < pitch) continue;
      kept.push(ring);
      last = m;
    }
    return kept;
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const isClosed = (pts) => pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

  // Greedy nearest-neighbour order to keep pen-up travel short. A closed ring may start at
  // any of its vertices; an open stroke may run either way.
  function orderStrokes(strokes, start) {
    const left = strokes.slice();
    const out = [];
    let pos = start;
    while (left.length) {
      let bi = 0, bj = 0, bd = Infinity;
      for (let i = 0; i < left.length; i++) {
        const pts = left[i];
        if (isClosed(pts)) {
          for (let j = 0; j < pts.length - 1; j++) {
            const d = dist(pos, pts[j]);
            if (d < bd) { bd = d; bi = i; bj = j; }
          }
        } else {
          const d0 = dist(pos, pts[0]), d1 = dist(pos, pts[pts.length - 1]);
          if (d0 < bd) { bd = d0; bi = i; bj = 0; }
          if (d1 < bd) { bd = d1; bi = i; bj = -1; }
        }
      }
      let pts = left.splice(bi, 1)[0];
      if (bj === -1) pts = pts.slice().reverse();
      else if (bj > 0) pts = pts.slice(bj, pts.length - 1).concat(pts.slice(0, bj), [pts[bj]]);
      out.push(pts);
      pos = pts[pts.length - 1];
    }
    return out;
  }

  // Pen-down and pen-up lengths (mm) for strokes plotted in order from `start`.
  function strokeStats(strokes, start) {
    let drawn = 0, travel = 0, pos = start;
    for (const pts of strokes) {
      travel += dist(pos, pts[0]);
      for (let i = 1; i < pts.length; i++) drawn += dist(pts[i - 1], pts[i]);
      pos = pts[pts.length - 1];
    }
    return { strokes: strokes.length, drawn, travel };
  }

  // Rough plot time with strek's default settings: 150 mm/s drawing, 200 mm/s travel, and per
  // stroke a 3 mm pen lift and drop at 15 mm/s plus a 120 ms settle after each.
  function plotSeconds(st) {
    return st.drawn / 150 + st.travel / 200 + st.strokes * (2 * 3 / 15 + 2 * 0.12);
  }

  /**
   * Build the drawing. Returns { params, paper, scale (mm per µm along the beams), size (mm,
   * beams and signal panel), levels (fractions), signals (see signals(), or null), layers: { probe, pump }
   * (ordered polylines, [x, y] in mm, y down), stats: { probe, pump } ({ strokes, drawn, travel,
   * seconds, rings, dropped, panel (strokes in the signal panel) }) }.
   */
  function build(params) {
    const p = withDefaults(params);
    const cam = camera(p);
    const fr = levelFractions(p);
    const relative = p.scale === 'slice';
    const RING_PTS = 180;

    // Scene curves in screen units (stretched µm).
    const scene = beams(p).map((b) => {
      const slices = sliceDepths(b).map((s) => {
        const rings = [];
        if (p.outline) rings.push({ f: E2, r: b.width(s), outline: true });
        for (const f of fr) {
          const r = ringRadius(b, s, f, relative);
          if (r > 0) rings.push({ f, r });
        }
        rings.sort((x, y) => y.r - x.r);
        for (const ring of rings) {
          ring.pts = [];
          for (let i = 0; i < RING_PTS; i++) ring.pts.push(cam.project(beamPoint(b, s, ring.r, (2 * Math.PI * i) / RING_PTS)));
        }
        return { s, rings };
      });
      return { b, m: minorAxis(b, cam), slices, envelope: p.envelope ? envelope(b, cam) : [] };
    });

    // Fit the beams to the paper inside the margin, with the signal panel below them; centre both.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const grow = (q) => {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    };
    for (const B of scene) {
      for (const line of B.envelope) line.forEach(grow);
      for (const sl of B.slices) for (const ring of sl.rings) ring.pts.forEach(grow);
    }
    const W = p.paper.w, H = p.paper.h, mg = p.paper.margin;
    const P = p.signals ? Math.max(12, p.panel) : 0; // panel height
    const G = p.signals ? 6 : 0; // gap above it
    const spanX = Math.max(x1 - x0, 1e-9), spanY = Math.max(y1 - y0, 1e-9);
    const k = Math.max(1e-9, Math.min((W - 2 * mg) / spanX, (H - 2 * mg - P - G) / spanY));
    const ox = (W - k * spanX) / 2 - k * x0, oy = (H - k * spanY - P - G) / 2 - k * y0;
    const toMM = (q) => [ox + k * q[0], oy + k * q[1]];
    const TOL = 0.01; // mm, well under the pen width

    const layers = {};
    const stats = {};
    for (const B of scene) {
      const strokes = B.envelope.map((line) => simplify(line.map(toMM), TOL));
      let rings = 0, dropped = 0;
      for (const sl of B.slices) {
        const kept = keepRings(sl.rings, B.m * k, p.pitch);
        rings += kept.length;
        dropped += sl.rings.length - kept.length;
        for (const ring of kept) {
          const pts = simplify(ring.pts.map(toMM).concat([toMM(ring.pts[0])]), TOL);
          pts[pts.length - 1] = pts[0];
          strokes.push(pts);
        }
      }
      layers[B.b.key] = strokes;
      stats[B.b.key] = { rings, dropped, panel: 0 };
    }

    let sig = null;
    if (p.signals) {
      sig = signals(p);
      const probe = scene[0].b;
      const X = (z) => ox + k * cam.project([0, 0, z])[0];
      const panel = signalPanel(sig, X, sliceDepths(probe), [ox + k * x0, ox + k * x1], oy + k * y1 + G, P, p);
      for (const key of KEYS) {
        layers[key].push(...panel[key]);
        stats[key].panel = panel[key].length;
      }
    }

    // Identical corner ticks in each layer give every layer the same bounding box, so the
    // layers stay registered even when plotted as separate jobs.
    if (p.ticks) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const key of KEYS) for (const pts of layers[key]) for (const q of pts) {
        a0 = Math.min(a0, q[0]); a1 = Math.max(a1, q[0]);
        b0 = Math.min(b0, q[1]); b1 = Math.max(b1, q[1]);
      }
      const off = 2, arm = 4;
      const L = a0 - off, R = a1 + off, T = b0 - off, Bt = b1 + off;
      const ticks = [
        [[L, T + arm], [L, T], [L + arm, T]], [[R - arm, T], [R, T], [R, T + arm]],
        [[R, Bt - arm], [R, Bt], [R - arm, Bt]], [[L + arm, Bt], [L, Bt], [L, Bt - arm]],
      ];
      for (const key of KEYS) layers[key] = layers[key].concat(ticks.map((t) => t.map((q) => q.slice())));
    }

    const start = [W / 2, H]; // strek parks the pen near the front edge of the sheet
    for (const key of KEYS) {
      layers[key] = orderStrokes(layers[key], start);
      Object.assign(stats[key], strokeStats(layers[key], start));
      stats[key].seconds = plotSeconds(stats[key]);
    }

    return {
      params: p,
      paper: { w: W, h: H },
      scale: k,
      size: { w: k * spanX, h: k * spanY + G + P },
      levels: fr,
      signals: sig,
      layers,
      stats,
    };
  }

  const num = (v) => String(Math.round(v * 100) / 100);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /**
   * SVG of one or more layers. Millimetre units (1 user unit = 1 mm), plain polylines, no
   * transforms: one file per pen for plotter tools. opts: { colors: { probe, pump },
   * background (preview only: a paper-coloured rect, which a plotter would draw as a stroke) }.
   */
  function toSVG(d, keys, opts) {
    keys = Array.isArray(keys) ? keys : [keys];
    opts = opts || {};
    const colors = Object.assign({}, COLORS, opts.colors);
    const W = num(d.paper.w), H = num(d.paper.h);
    const p = d.params;
    const what = keys.length === 1 ? `${keys[0]} beam, one pen` : keys.join(' and ') + ' beams';
    const desc = `Crossed Gaussian beams as a 3-D contour plot (${what})` +
      `${p.signals ? ', with the 1PA and 2PA signal along z underneath' : ''}. θ = ${p.angle}°, ` +
      `probe w₀ = ${p.probe.w0} µm at ${p.probe.lambda} nm, pump w₀ = ${p.pump.w0} µm at ${p.pump.lambda} nm. ` +
      `${num(d.scale)} mm per µm. Pen ${p.pen} mm.`;
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
      `<title>Gaussian beam overlap: ${esc(keys.join(' + '))}</title>`,
      `<desc>${esc(desc)}</desc>`,
    ];
    if (opts.background) out.push(`<rect width="${W}" height="${H}" fill="${opts.background}"/>`);
    for (const key of keys) {
      out.push(`<g id="${key}" fill="none" stroke="${colors[key]}" stroke-width="${p.pen}" stroke-linecap="round" stroke-linejoin="round">`);
      for (const pts of d.layers[key]) out.push(`<polyline points="${pts.map((q) => num(q[0]) + ',' + num(q[1])).join(' ')}"/>`);
      out.push('</g>');
    }
    out.push('</svg>', '');
    return out.join('\n');
  }

  return {
    DEFAULTS,
    COLORS,
    KEYS,
    withDefaults,
    levelFractions,
    signals,
    text,
    beams,
    beamPoint,
    ringRadius,
    camera,
    minorAxis,
    envelope,
    sliceDepths,
    simplify,
    keepRings,
    orderStrokes,
    strokeStats,
    build,
    toSVG,
  };
});
