'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BP = require('../plotter.js');

function close(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected}, got ${actual}`);
}

// A geometry that exercises everything: crossing angle, offset pump, tilted and stretched view.
const SKEW = { angle: 22, dx: 0.8, dy: -0.5, dz: 3, azimuth: 35, elevation: -12, stretch: 2.5 };

test('rings sit on the requested intensity contour of the overlap.js beams', () => {
  for (const relative of [false, true]) {
    const p = BP.withDefaults(SKEW);
    for (const b of BP.beams(p)) {
      for (const s of [-b.half, -3.1, 0, 7.4, b.half]) {
        const peak = relative ? b.field(BP.beamPoint(b, s, 0, 0)) : 1;
        for (const f of [0.08, 0.3, 0.77]) {
          const r = BP.ringRadius(b, s, f, relative);
          if (r === 0) {
            assert.ok(b.field(BP.beamPoint(b, s, 0, 0)) <= f, `${b.key} s=${s} f=${f}: no ring, so the slice peak is below f`);
            continue;
          }
          for (const t of [0, 1.3, 2.9, 4.4]) close(b.field(BP.beamPoint(b, s, r, t)) / peak, f, 1e-9, `${b.key} s=${s} f=${f}`);
        }
      }
    }
  }
});

test('the 1/e² outline ring is w(s) and absolute rings vanish where the beam is too weak', () => {
  const p = BP.withDefaults({});
  for (const b of BP.beams(p)) {
    for (const s of [0, 5, b.half]) close(BP.ringRadius(b, s, Math.exp(-2), true), b.width(s), 1e-12, b.key);
    // At s = 3 z_R the on-axis intensity is 10% of the focal peak.
    assert.equal(BP.ringRadius(b, 3 * b.zR, 0.11, false), 0);
    assert.ok(BP.ringRadius(b, 3 * b.zR, 0.09, false) > 0);
  }
});

test('the envelope is tangent to every slice outline ring (silhouette of the 1/e² surface)', () => {
  for (const view of [SKEW, { angle: 15 }, { angle: 40, azimuth: 60, elevation: 30, stretch: 1 }]) {
    const p = BP.withDefaults(view);
    const cam = BP.camera(p);
    for (const b of BP.beams(p)) {
      const n = 400;
      const lines = BP.envelope(b, cam, n);
      assert.equal(lines.length, 2, 'two outline lines');
      for (const line of lines) {
        assert.equal(line.length, n + 1);
        for (let i = 40; i < n; i += 40) {
          // Slice at the same depth as envelope sample i; the ring must touch the tangent line
          // there and stay on one side of it.
          const s = -b.half + (2 * b.half * i) / n;
          const Q = line[i];
          const tx = line[i + 1][0] - line[i - 1][0], ty = line[i + 1][1] - line[i - 1][1];
          const len = Math.hypot(tx, ty);
          const nx = -ty / len, ny = tx / len;
          let lo = Infinity, hi = -Infinity;
          for (let k = 0; k < 2000; k++) {
            const q = cam.project(BP.beamPoint(b, s, b.width(s), (2 * Math.PI * k) / 2000));
            const d = (q[0] - Q[0]) * nx + (q[1] - Q[1]) * ny;
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
          }
          const size = hi - lo;
          assert.ok(Math.min(-lo, hi) < 1e-4 * size, `${b.key} s=${s}: ring crosses the envelope (${lo}, ${hi})`);
        }
      }
    }
  }
});

test('minorAxis is the narrow semi-axis of the projected unit ring', () => {
  const p = BP.withDefaults(SKEW);
  const cam = BP.camera(p);
  for (const b of BP.beams(p)) {
    let min = Infinity;
    for (let k = 0; k < 20000; k++) {
      const t = (2 * Math.PI * k) / 20000;
      const q = cam.project([0, 1, 2].map((i) => Math.cos(t) * b.u[i] + Math.sin(t) * b.v[i]));
      min = Math.min(min, Math.hypot(q[0], q[1]));
    }
    close(BP.minorAxis(b, cam), min, 1e-6, b.key);
  }
});

test('keepRings keeps rings at least one pitch apart on the narrow axis', () => {
  const rings = [10, 9.9, 9.5, 8, 7.95, 3, 0.4, 0.1].map((r) => ({ r }));
  const kept = BP.keepRings(rings, 0.5, 0.25).map((x) => x.r);
  assert.deepEqual(kept, [10, 9.5, 8, 3, 0.4]);
  for (let i = 1; i < kept.length; i++) assert.ok((kept[i - 1] - kept[i]) * 0.5 >= 0.25 - 1e-12);
  assert.deepEqual(BP.keepRings(rings, 0.5, 2).map((x) => x.r), [10, 3]);
});

test('every candidate ring is drawn or counted as skipped', () => {
  for (const over of [{}, { scale: 'slice', levels: 7 }, { spacing: 'log', pitch: 0.6 }, { pitch: 0.01 }]) {
    const d = BP.build(over);
    const p = d.params;
    for (const b of BP.beams(p)) {
      let candidates = 0;
      for (const s of BP.sliceDepths(b)) {
        candidates += p.outline ? 1 : 0;
        for (const f of d.levels) if (BP.ringRadius(b, s, f, p.scale === 'slice') > 0) candidates++;
      }
      const st = d.stats[b.key];
      assert.equal(st.rings + st.dropped, candidates, JSON.stringify(over));
      assert.equal(st.strokes, st.rings + (p.envelope ? 2 : 0) + st.panel);
    }
  }
  // Rings far apart are never skipped.
  const loose = BP.build({ levels: 3, pitch: 0.05 });
  assert.equal(loose.stats.probe.dropped + loose.stats.pump.dropped, 0);
});

test('the drawing fills the paper inside the margin and stays registered across layers', () => {
  for (const paper of [{ w: 210, h: 148, margin: 12 }, { w: 210, h: 297, margin: 5 }]) {
    const d = BP.build({ paper, ticks: false });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const key of BP.KEYS) for (const pts of d.layers[key]) for (const [x, y] of pts) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const m = paper.margin;
    assert.ok(x0 >= m - 1e-6 && x1 <= paper.w - m + 1e-6 && y0 >= m - 1e-6 && y1 <= paper.h - m + 1e-6);
    // Fitted: touches the margin on one axis, centred on both.
    assert.ok(Math.abs(x0 - m) < 0.05 || Math.abs(y0 - m) < 0.05);
    close((x0 + x1) / 2, paper.w / 2, 0.05);
    close((y0 + y1) / 2, paper.h / 2, 0.05);
  }
});

test('corner ticks give both layers the same bounding box', () => {
  const d = BP.build({ ticks: true, dz: 10, dx: 3 });
  const box = (key) => {
    let b = [Infinity, -Infinity, Infinity, -Infinity];
    for (const pts of d.layers[key]) for (const [x, y] of pts) b = [Math.min(b[0], x), Math.max(b[1], x), Math.min(b[2], y), Math.max(b[3], y)];
    return b;
  };
  assert.deepEqual(box('probe'), box('pump'));
});

test('stroke ordering keeps every stroke and shortens pen-up travel', () => {
  const d = BP.build({});
  const raw = BP.build({}).layers.probe.slice().reverse();
  const start = [105, 148];
  const ordered = BP.orderStrokes(raw, start);
  assert.equal(ordered.length, raw.length);
  const key = (pts) => {
    const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    const body = (closed ? pts.slice(0, -1) : pts).map((q) => q.join(',')).sort();
    return (closed ? 'c:' : 'o:') + body.join(' ');
  };
  assert.deepEqual(ordered.map(key).sort(), raw.map(key).sort());
  for (const pts of ordered) if (key(pts).startsWith('c:')) assert.deepEqual(pts[0], pts[pts.length - 1]);
  shuffle(raw);
  assert.ok(BP.strokeStats(ordered, start).travel <= BP.strokeStats(raw, start).travel);
  assert.ok(Math.abs(BP.strokeStats(ordered, start).drawn - d.stats.probe.drawn) < 1e-6);
});

function shuffle(a) {
  let seed = 7;
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
}

test('simplify keeps the ends and stays within its tolerance', () => {
  const pts = [];
  for (let i = 0; i <= 500; i++) pts.push([i / 10, Math.sin(i / 25) * 3]);
  const out = BP.simplify(pts, 0.01);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
  assert.ok(out.length < pts.length / 3);
  for (const q of pts) {
    let best = Infinity;
    for (let i = 1; i < out.length; i++) {
      const [ax, ay] = out[i - 1], [bx, by] = out[i];
      const t = Math.max(0, Math.min(1, ((q[0] - ax) * (bx - ax) + (q[1] - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      best = Math.min(best, Math.hypot(q[0] - ax - t * (bx - ax), q[1] - ay - t * (by - ay)));
    }
    assert.ok(best <= 0.01 + 1e-12);
  }
});

test('2PA signal is the pump × probe overlap; 1PA holds the same area', () => {
  // Matched collinear beams: ∫ I_pump·I_probe dx dy ∝ 1/w(z)², a Lorentzian of half-width z_R.
  const p = BP.withDefaults({ angle: 0, pump: { lambda: 800, w0: 1.5 }, probe: { lambda: 800, w0: 1.5, half: 30 } });
  const sig = BP.signals(p);
  const zR = BP.beams(p)[0].zR;
  sig.z.forEach((z, i) => close(sig.twoPA[i], 1 / (1 + (z / zR) ** 2), 1e-9, `z=${z}`));
  // Crossed beams focused together: the overlap is symmetric about the focus and peaks there.
  for (const angle of [15, 35]) {
    const s = BP.signals(BP.withDefaults({ angle }));
    const n = s.z.length - 1;
    for (let i = 0; i <= n; i++) close(s.twoPA[i], s.twoPA[n - i], 1e-9);
    close(s.twoPA[n / 2], 1, 1e-12);
    let area = 0;
    for (let i = 1; i <= n; i++) area += 0.5 * (s.twoPA[i - 1] + s.twoPA[i]) * (s.z[i] - s.z[i - 1]);
    close(s.onePA * (s.z[n] - s.z[0]), area, 1e-9);
    assert.ok(s.onePA > 0 && s.onePA < 1);
  }
  // A steeper crossing confines the 2PA signal to a shorter stretch of the probe.
  assert.ok(BP.signals(BP.withDefaults({ angle: 35 })).onePA < BP.signals(BP.withDefaults({ angle: 15 })).onePA);
});

test('the signal panel sits under the beams with a line at every probe slice', () => {
  const on = BP.build({});
  const off = BP.build({ signals: false });
  assert.equal(off.signals, null);
  for (const key of BP.KEYS) {
    assert.equal(off.stats[key].panel, 0);
    assert.ok(on.stats[key].panel > 0);
    assert.equal(on.stats[key].rings + on.stats[key].dropped, off.stats[key].rings + off.stats[key].dropped);
  }
  // The z axis is the lowest long horizontal probe line (the 1PA line sits above it).
  const flat = on.layers.probe.filter((pts) => pts.length === 2 && pts[0][1] === pts[1][1] && Math.abs(pts[1][0] - pts[0][0]) > 50);
  assert.equal(flat.length, 2, 'z axis and 1PA line');
  const yb = Math.max(...flat.map((pts) => pts[0][1]));
  // One vertical line per probe slice, from just below the axis up through the panel.
  const lines = on.layers.probe.filter((pts) => pts.length === 2 && pts[0][0] === pts[1][0] && Math.abs(pts[1][1] - pts[0][1]) > 5);
  assert.equal(lines.length, on.params.probe.slices);
  for (const pts of lines) close(Math.max(pts[0][1], pts[1][1]), yb + 1, 1e-9);
  // Every line lines up with the centre of a probe ring above the panel.
  const centres = on.layers.probe
    .filter((pts) => pts.length > 8 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1])
    .map((pts) => (Math.min(...pts.map((q) => q[0])) + Math.max(...pts.map((q) => q[0]))) / 2);
  for (const pts of lines) assert.ok(centres.some((c) => Math.abs(c - pts[0][0]) < 0.05), `line at ${pts[0][0]}`);
  // The "z axis" label is the only ink below the axis apart from the line ends.
  const below = on.layers.probe.filter((pts) => pts.every((q) => q[1] > yb + 1.5));
  assert.equal(below.length, BP.text('z axis', 0, 0, 3).length);
  // All of the beam drawing lies above the panel.
  const rings = on.layers.pump.concat(on.layers.probe).filter((pts) => pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] && pts.length > 8);
  for (const pts of rings) for (const q of pts) assert.ok(q[1] < yb - on.params.panel + 2);
});

// What strek's svg2gcode.py and web app need: width/height in mm matching the viewBox (1 unit =
// 1 mm), strokes as polylines, and no transforms or shapes a pen file would plot by accident.
test('pen SVGs are plain millimetre polylines that strek reads', () => {
  const d = BP.build({ ticks: true });
  const heads = [];
  for (const key of BP.KEYS) {
    const svg = BP.toSVG(d, key);
    const head = svg.match(/<svg [^>]*>/)[0];
    heads.push(head);
    assert.match(head, /width="210mm" height="148mm" viewBox="0 0 210 148"/);
    assert.doesNotMatch(svg, /transform=/);
    assert.doesNotMatch(svg, /<(path|rect|circle|ellipse|line|polygon|text|image|use)[\s>]/);
    const lines = [...svg.matchAll(/<polyline points="([^"]*)"\/>/g)].map((m) => m[1]);
    assert.equal(lines.length, d.layers[key].length);
    for (const l of lines) {
      const nums = l.split(/[ ,]/).map(Number);
      assert.ok(nums.length >= 4 && nums.length % 2 === 0 && nums.every(Number.isFinite));
      for (let i = 0; i < nums.length; i += 2) assert.ok(nums[i] >= 0 && nums[i] <= 210 && nums[i + 1] >= 0 && nums[i + 1] <= 148);
    }
    assert.equal((svg.match(/<g /g) || []).length, 1, 'one pen per file');
  }
  assert.equal(heads[0], heads[1], 'both files share the page and viewBox');
  assert.match(BP.toSVG(d, BP.KEYS, { background: '#fff' }), /<rect /, 'only the preview gets a background');
});

test('the command-line script writes one SVG per pen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beamplot-'));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'plot-svg.js'), '--out', dir, '--name', 't', '--set', 'angle=30', '--set', 'pump.w0=2']);
  for (const key of BP.KEYS) assert.match(fs.readFileSync(path.join(dir, `t-${key}.svg`), 'utf8'), /θ = 30°/);
  assert.match(fs.readFileSync(path.join(dir, 't-pump.svg'), 'utf8'), /pump w₀ = 2 µm/);
  fs.rmSync(dir, { recursive: true });
});
