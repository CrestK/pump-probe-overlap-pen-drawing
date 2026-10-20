'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../overlap.js');

function params(over) {
  return Object.assign({
    mode: '2pa',
    angle: 0,
    L: 1000,
    T1: Infinity,
    pump: { lambda: 800, w0: 60, fwhm: 60 },
    probe: { lambda: 530, w0: 25, fwhm: 50 },
  }, over);
}

function close(actual, expected, rel, msg) {
  const err = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);
  assert.ok(err <= rel, `${msg || ''} expected ${expected}, got ${actual} (rel. error ${err.toExponential(2)})`);
}

// Direct quadrature over x and z (y analytic, which is exact), with the pump width evaluated
// at every point. Used to check the per-slice analytic x-integration and its approximations.
function bruteForce(M, dx, dy, dz, delay, nx, nz) {
  const L2 = M.L / 2;
  const wrMax = F.probeWidth(M, L2);
  const X = 4.5 * wrMax;
  const sc = Math.sqrt(M.sc2);
  let S = 0;
  for (let j = 0; j <= nz; j++) {
    const z = -L2 + (2 * L2 * j) / nz;
    const wz = j === 0 || j === nz ? 0.5 : 1;
    const wr2 = F.probeWidth(M, z) ** 2;
    const a = 2 / wr2;
    let row = 0;
    for (let i = 0; i <= nx; i++) {
      const x = -X + (2 * X * i) / nx;
      const wx = i === 0 || i === nx ? 0.5 : 1;
      const Xp = x - dx;
      const Zp = z - dz;
      const s = Xp * M.sin + Zp * M.cos;
      const r = Xp * M.cos - Zp * M.sin;
      const wp2 = F.pumpWidth(M, s) ** 2;
      const b = (2 * M.m) / wp2;
      const pump = Math.pow(M.w0p2 / wp2, M.m) * Math.exp(-b * r * r);
      const probe = (2 / (Math.PI * wr2)) * Math.exp(-a * x * x);
      const gy = Math.sqrt(Math.PI / (a + b)) * Math.exp((-a * b) / (a + b) * dy * dy);
      const tau = delay + z / F.C - (x * M.sin + z * M.cos) / F.C;
      row += wx * pump * probe * gy * F.kernel(M, tau, sc);
    }
    S += wz * row * ((2 * X) / nx);
  }
  return S * (M.L / nz);
}

test('collinear, no diffraction: closed-form overlap', () => {
  // A tiny wavelength makes the Rayleigh ranges effectively infinite.
  const base = { pump: { lambda: 1e-3, w0: 60, fwhm: 60 }, probe: { lambda: 1e-3, w0: 25, fwhm: 50 } };
  const spatial = 60 ** 2 / (60 ** 2 + 25 ** 2);

  const M2 = F.createModel(params(Object.assign({ mode: '2pa' }, base)));
  close(F.signal(M2, 0, 0, 0, 0) / M2.L, spatial * 60 / Math.hypot(60, 50), 1e-6, '2PA');

  const Mta = F.createModel(params(Object.assign({ mode: 'ta' }, base)));
  close(F.signal(Mta, 0, 0, 0, 5000) / Mta.L, spatial, 1e-6, 'TA plateau');

  const Mta2 = F.createModel(params(Object.assign({ mode: 'ta2' }, base)));
  close(F.signal(Mta2, 0, 0, 0, 5000) / Mta2.L, (60 ** 2 / 2) / (60 ** 2 / 2 + 25 ** 2), 1e-6, '2P-TA plateau');

  // Transverse offset of a collinear pump: Gaussian fall-off with the summed widths.
  const d = 40;
  close(F.signal(M2, d, 0, 0, 0) / F.signal(M2, 0, 0, 0, 0),
    Math.exp(-2 * d * d / (60 ** 2 + 25 ** 2)), 1e-6, 'x offset');
  close(F.signal(M2, 0, d, 0, 0) / F.signal(M2, 0, 0, 0, 0),
    Math.exp(-2 * d * d / (60 ** 2 + 25 ** 2)), 1e-6, 'y offset');
  // Delay: Gaussian cross-correlation.
  const sc = Math.sqrt(M2.sc2);
  close(F.signal(M2, 0, 0, 0, 70) / F.signal(M2, 0, 0, 0, 0), Math.exp(-0.5 * (70 / sc) ** 2), 1e-6, 'delay');
});

test('temporal kernels match direct time integration', () => {
  const dt = 0.05;
  const T = 600;
  const grid = [];
  for (let t = -T; t <= T; t += dt) grid.push(t);
  const gauss = (t, s) => Math.exp(-0.5 * (t / s) ** 2) / (Math.sqrt(2 * Math.PI) * s);

  for (const [mode, T1] of [['2pa', Infinity], ['ta', Infinity], ['ta', 80], ['ta2', 150]]) {
    const M = F.createModel(params({ mode, T1, pump: { lambda: 800, w0: 60, fwhm: 70 } }));
    // Pump drive D(t), normalised so that the ideal (probe always at the peak) gives 1.
    const drive = new Float64Array(grid.length);
    if (mode === '2pa') {
      grid.forEach((t, i) => { drive[i] = Math.exp(-0.5 * (t / M.sPu) ** 2); });
    } else {
      const src = t => gauss(t, M.sDrive);
      let acc = 0;
      const decay = Math.exp(-dt * M.invT);
      grid.forEach((t, i) => {
        // Trapezoid step of D(t) = ∫ src(t') exp(-(t - t')/T1) dt'.
        if (i > 0) acc = (acc + 0.5 * dt * src(grid[i - 1])) * decay + 0.5 * dt * src(t);
        drive[i] = acc;
      });
    }
    for (const tau of [-120, -30, 0, 45, 160]) {
      let S = 0;
      grid.forEach((t, i) => { S += drive[i] * gauss(t - tau, M.sPr) * dt; });
      const K = F.kernel(M, tau, Math.sqrt(M.sc2));
      assert.ok(Math.abs(S - K) < 2e-3, `${mode} T1=${T1} tau=${tau}: direct ${S}, kernel ${K}`);
    }
  }
});

test('semi-analytic slices agree with brute-force quadrature', () => {
  const cases = [
    { mode: '2pa', angle: 12, L: 800, pump: { lambda: 800, w0: 40, fwhm: 60 }, probe: { lambda: 530, w0: 20, fwhm: 40 }, off: [15, 10, 30, 20] },
    { mode: '2pa', angle: 35, L: 400, pump: { lambda: 1300, w0: 12, fwhm: 30 }, probe: { lambda: 600, w0: 30, fwhm: 30 }, off: [-8, 5, -40, -10] },
    { mode: 'ta', angle: 20, L: 1500, T1: 300, pump: { lambda: 400, w0: 50, fwhm: 100 }, probe: { lambda: 650, w0: 25, fwhm: 50 }, off: [10, -12, 60, 40] },
    { mode: 'ta2', angle: 6, L: 2000, pump: { lambda: 800, w0: 15, fwhm: 50 }, probe: { lambda: 500, w0: 15, fwhm: 50 }, off: [4, 3, 300, 10] },
    { mode: '2pa', angle: 0, L: 3000, pump: { lambda: 1000, w0: 10, fwhm: 50 }, probe: { lambda: 450, w0: 20, fwhm: 50 }, off: [5, 0, 200, 0] },
  ];
  for (const c of cases) {
    const M = F.createModel(params(c));
    const [dx, dy, dz, delay] = c.off;
    const fast = F.signal(M, dx, dy, dz, delay);
    const slow = bruteForce(M, dx, dy, dz, delay, 500, 3000);
    close(fast, slow, 2e-3, `${c.mode} θ=${c.angle}°`);
  }
});

test('best alignment is a maximum and f_v stays at or below 1', () => {
  for (const mode of ['2pa', 'ta', 'ta2']) {
    const M = F.createModel(params({ mode, angle: 15, T1: mode === 'ta' ? 200 : Infinity }));
    const best = F.bestAlignment(M);
    for (let k = 0; k < 40; k++) {
      const dx = best.dx + (Math.random() - 0.5) * 30;
      const dy = (Math.random() - 0.5) * 30;
      const dz = best.dz + (Math.random() - 0.5) * 300;
      const delay = best.delay + (Math.random() - 0.5) * 120;
      const S = F.signal(M, dx, dy, dz, delay);
      assert.ok(S <= best.S * (1 + 1e-4), `${mode}: S ${S} exceeds best ${best.S}`);
    }
  }
});

test('symmetries: ±dy and, for 2PA at the centre, ±delay', () => {
  const M = F.createModel(params({ angle: 18 }));
  close(F.signal(M, 10, 22, 0, 30), F.signal(M, 10, -22, 0, 30), 1e-12, 'dy mirror');
  close(F.signal(M, 0, 0, 0, 55), F.signal(M, 0, 0, 0, -55), 1e-6, 'delay mirror');
  const best = F.bestAlignment(M);
  assert.ok(Math.abs(best.delay) < 0.5, `2PA best delay ${best.delay}`);
  assert.ok(Math.abs(best.dx) < 0.5, `2PA best dx ${best.dx}`);
});

test('crossing angle lowers the best achievable overlap', () => {
  let prev = Infinity;
  for (const angle of [0, 5, 10, 20, 40]) {
    const M = F.createModel(params({ angle }));
    const S = F.bestAlignment(M).S;
    assert.ok(S < prev, `angle ${angle}: ${S} should be below ${prev}`);
    prev = S;
  }
});

test('fwhm of a sampled Gaussian', () => {
  const xs = [];
  const ys = [];
  for (let x = -100; x <= 100; x += 0.5) { xs.push(x); ys.push(Math.exp(-0.5 * (x / 20) ** 2)); }
  close(F.fwhm(xs, ys), 20 * 2 * Math.sqrt(2 * Math.LN2), 1e-3);
  assert.equal(F.fwhm([0, 1, 2], [1, 0.9, 0.8]), null);
});
