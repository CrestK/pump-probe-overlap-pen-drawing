/* Beam Overlap Drawing: page controller. Geometry lives in plotter.js, the beam model in overlap.js. */
(function () {
  'use strict';

  const BP = window.BeamPlot;
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------------ state

  const PAPERS = { a5: [210, 148], a4cut: [210, 200], a4: [210, 297] };
  const SHARED = ['paper', 'pen', 'pitch', 'ticks', 'signals', 'panel', 'hatch']; // kept when a setup is picked

  const PRESETS = [
    { label: 'Tight focus, 15°', set: {} },
    { label: 'Wide crossing, 35°', set: { angle: 35, probe: { half: 14 }, pump: { half: 14 } } },
    { label: 'Pump focus offset', set: { dx: 1.5, dz: 8 } },
    { label: 'Collinear, matched', set: { angle: 0, pump: { w0: 1.5 }, elevation: 14 } },
    { label: 'Same rings in every slice', set: { scale: 'slice', levels: 6 } },
    { label: 'Log contours', set: { spacing: 'log', levels: 9 } },
  ];

  let state = BP.withDefaults({});
  const ink = clone(BP.COLORS);
  const ui = { zoom: '1', paper: 'a5' };

  // Beams handed over in the URL hash by the focal-overlap page (or any link built the same way).
  function fromOverlapPage() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.has('angle')) return false;
    const n = (k, d) => (isFinite(parseFloat(h.get(k))) ? parseFloat(h.get(k)) : d);
    const L = n('L', 1000);
    const half = clamp(L / 2, 1, 20000);
    const set = {
      probe: { lambda: n('rl', 800), w0: n('rw', 25), half, slices: 11 },
      pump: { lambda: n('pl', 800), w0: n('pw', 60), half, slices: 11 },
      angle: n('angle', 0), dx: n('dx', 0), dy: n('dy', 0), dz: n('dz', 0),
    };
    // Lab beams are long and thin on paper: stretch them across so the ends of the drawn
    // range are about a fifth as wide as it is long.
    const p = BP.withDefaults(set);
    const wEnd = Math.max(...BP.beams(p).map((b) => b.width(b.half)));
    set.stretch = Number(Math.max(1, (0.19 * half) / wEnd).toPrecision(2));
    state = BP.withDefaults(set);
    $('#from-page').hidden = false;
    $('#from-page').textContent = `Beams taken from the overlap page, drawn over the sample (±${sig(half)} µm). ` +
      `The transverse scale is stretched ×${set.stretch} so the beams read on paper.`;
    return true;
  }

  // ------------------------------------------------------------- formatting

  const minus = (s) => s.replace(/^-/, '−');
  function sig(v, n) {
    n = n || 3;
    if (!isFinite(v)) return '–';
    if (v === 0) return '0';
    const d = clamp(n - 1 - Math.floor(Math.log10(Math.abs(v))), 0, 6);
    return minus(v.toFixed(d));
  }
  const fmtLen = (um) => (Math.abs(um) >= 1000 ? sig(um / 1000) + ' mm' : sig(um) + ' µm');
  function fmtInput(v) {
    if (!isFinite(v)) return '';
    return String(Number(Math.abs(v) < 1e-9 ? 0 : v.toPrecision(4)));
  }
  const fmtMeters = (mm) => (mm >= 1000 ? sig(mm / 1000) + ' m' : sig(mm) + ' mm');
  const fmtMinutes = (s) => (s < 60 ? '< 1 min' : '≈ ' + Math.round(s / 60) + ' min');
  const fmtPct = (f) => (f * 100 >= 10 ? Math.round(f * 100) : sig(f * 100, 2)) + '%';

  // --------------------------------------------------------------- controls

  const CTL = {
    'probe.lambda': { label: 'Wavelength λ', unit: 'nm', min: 250, max: 2000, step: 1, hint: 'sets z_R' },
    'probe.w0': { label: 'Waist w₀', unit: 'µm', min: 0.5, max: 1000, log: true, hint: '1/e² radius at focus' },
    'probe.half': { label: 'Drawn range ±', unit: 'µm', min: 1, max: 20000, log: true, hint: 'each way from the focus' },
    'probe.slices': { label: 'Slices', unit: '', min: 1, max: 31, step: 1, hint: 'contour planes across the beam' },
    'pump.lambda': { label: 'Wavelength λ', unit: 'nm', min: 250, max: 2000, step: 1, hint: 'sets z_R' },
    'pump.w0': { label: 'Waist w₀', unit: 'µm', min: 0.5, max: 1000, log: true, hint: '1/e² radius at focus' },
    'pump.half': { label: 'Drawn range ±', unit: 'µm', min: 1, max: 20000, log: true, hint: 'each way from the focus' },
    'pump.slices': { label: 'Slices', unit: '', min: 1, max: 31, step: 1, hint: 'contour planes across the beam' },
    angle: { label: 'Crossing angle θ', unit: '°', min: 0, max: 60, step: 0.1, hint: 'between the beam axes' },
    dx: { label: 'Δx', unit: 'µm', dynamic: true, hint: 'transverse, in the crossing plane' },
    dy: { label: 'Δy', unit: 'µm', dynamic: true, hint: 'transverse, out of the plane' },
    dz: { label: 'Δz', unit: 'µm', dynamic: true, hint: 'along the probe' },
    levels: { label: 'Contour rings', unit: 'per slice', min: 0, max: 30, step: 1, hint: 'besides the 1/e² ring' },
    pitch: { label: 'Least ring spacing', unit: 'mm', min: 0.05, max: 2, step: 0.05, hint: 'below the line width, rings shade' },
    azimuth: { label: 'Turn', unit: '°', min: 0, max: 80, step: 1, hint: 'about the vertical; opens the slices' },
    elevation: { label: 'Tilt', unit: '°', min: -60, max: 60, step: 1, hint: 'out of the crossing plane' },
    stretch: { label: 'Transverse stretch', unit: '×', min: 1, max: 100, log: true, hint: '1 = true proportions' },
    'paper.w': { label: 'Width', unit: 'mm', min: 40, max: 400, step: 1, hint: 'sheet' },
    'paper.h': { label: 'Height', unit: 'mm', min: 40, max: 400, step: 1, hint: 'sheet' },
    'paper.margin': { label: 'Margin', unit: 'mm', min: 0, max: 60, step: 1, hint: 'kept clear on every side' },
    pen: { label: 'Line width', unit: 'mm', min: 0.1, max: 2, step: 0.05, hint: 'Stabilo Point 88: 0.4' },
    panel: { label: 'Panel height', unit: 'mm', min: 12, max: 60, step: 1, hint: 'under the beams' },
    hatch: { label: 'Shading under 2PA', unit: 'mm', min: 0, max: 3, step: 0.05, hint: 'line spacing; 0 = none' },
  };
  const controls = {};

  function getPath(key) {
    const [a, b] = key.split('.');
    return b ? state[a][b] : state[a];
  }
  function setPath(key, v) {
    const [a, b] = key.split('.');
    if (b) state[a][b] = v;
    else state[a] = v;
  }
  function toSlider(c, v) {
    if (c.spec.log) return (1000 * Math.log(v / c.min)) / Math.log(c.max / c.min);
    return (1000 * (v - c.min)) / (c.max - c.min);
  }
  function fromSlider(c, s) {
    let v = c.spec.log ? c.min * Math.pow(c.max / c.min, s / 1000) : c.min + ((c.max - c.min) * s) / 1000;
    if (c.spec.step) v = Math.round(v / c.spec.step) * c.spec.step;
    else v = Number(v.toPrecision(c.spec.dynamic ? 4 : 3));
    return Number(v.toPrecision(10));
  }

  function buildControls() {
    document.querySelectorAll('[data-ctl]').forEach((host) => {
      const key = host.dataset.ctl;
      const spec = CTL[key];
      const id = 'c-' + key.replace('.', '-');
      host.className = 'ctl';
      host.innerHTML =
        `<div class="ctl-top"><label for="${id}">${spec.label}</label><span class="ctl-hint">${spec.hint}</span></div>` +
        `<div class="ctl-row"><input type="range" id="${id}-r" min="0" max="1000" step="1" aria-label="${spec.label}">` +
        `<div class="num"><input type="number" id="${id}" step="any" inputmode="decimal"><span class="unit">${spec.unit}</span></div></div>`;
      const c = {
        key, spec, host,
        range: host.querySelector('input[type=range]'),
        num: host.querySelector('input[type=number]'),
        min: spec.min, max: spec.max,
      };
      c.range.addEventListener('input', () => setValue(key, fromSlider(c, +c.range.value)));
      c.num.addEventListener('change', () => {
        const v = parseFloat(c.num.value);
        if (isFinite(v)) setValue(key, v, true);
        else syncControl(c);
      });
      controls[key] = c;
    });
  }

  function setValue(key, v, typed) {
    const c = controls[key];
    v = c.spec.dynamic ? clamp(v, -1e5, 1e5) : clamp(v, c.spec.min, c.spec.max);
    if (c.spec.step === 1) v = Math.round(v);
    setPath(key, v);
    if (key === 'paper.w' || key === 'paper.h') ui.paper = 'custom';
    if (typed) syncControl(c, true);
    changed();
  }

  function syncControl(c, force) {
    const v = getPath(c.key);
    c.range.value = String(clamp(toSlider(c, v), 0, 1000));
    if (force || document.activeElement !== c.num) c.num.value = fmtInput(v);
  }

  // Offsets get slider ranges that cover the drawn beams.
  function updateRanges() {
    const ends = BP.beams(state).map((b) => b.width(b.half));
    const rx = Number((4 * Math.max(...ends)).toPrecision(2));
    const rz = Number(Math.max(state.probe.half, state.pump.half).toPrecision(2));
    for (const [key, r] of [['dx', rx], ['dy', rx], ['dz', rz]]) {
      const c = controls[key];
      c.min = -r;
      c.max = r;
    }
  }

  const setSeg = (sel, v) => document.querySelectorAll(`${sel} button`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v)));

  function syncAll() {
    Object.values(controls).forEach((c) => syncControl(c));
    setSeg('#scale', state.scale);
    setSeg('#spacing', state.spacing);
    setSeg('#zoom', ui.zoom);
    $('#outline').checked = state.outline;
    $('#envelope').checked = state.envelope;
    $('#ticks').checked = state.ticks;
    $('#signals').checked = state.signals;
    for (const key of ['panel', 'hatch']) {
      controls[key].range.disabled = !state.signals;
      controls[key].num.disabled = !state.signals;
    }
    $('#paper').value = ui.paper;
    $('#probe-color').value = ink.probe;
    $('#pump-color').value = ink.pump;
    for (const key of BP.KEYS) {
      $(`#${key}-swatch`).style.background = ink[key];
      $(`#${key}-swatch-2`).style.background = ink[key];
    }
    $('#scale-desc').textContent = state.scale === 'absolute'
      ? 'Every ring is the same intensity everywhere, so the ring count tracks the beam: many where it is bright, none where it has spread below the lowest level.'
      : 'Rings at fixed fractions of each slice’s own peak: every slice shows the same profile, scaled with the beam width w(s).';
  }

  // ------------------------------------------------------------- scheduling

  let raf = 0;
  let drawing = null;
  function changed() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    drawing = BP.build(state);
    updateRanges();
    syncAll();
    render(drawing);
  }

  // ----------------------------------------------------------------- render

  function render(d) {
    // Pump first, so the preview stacks the inks the way they plot with the lighter pen first.
    const svg = BP.toSVG(d, ['pump', 'probe'], { colors: ink, background: '#ffffff' }).replace(/^<\?xml[^>]*>\s*/, '');
    const view = $('#paper-view');
    view.innerHTML = svg;
    view.dataset.zoom = ui.zoom;

    for (const b of BP.beams(state)) {
      const range = b.half / b.zR;
      $(`#${b.key}-derived`).textContent = `z_R = ${fmtLen(b.zR)}, drawn ±${sig(range, 2)} z_R · w at the ends = ${fmtLen(b.width(b.half))}`;
    }
    const lv = d.levels;
    $('#levels-derived').textContent = lv.length
      ? `Rings at ${lv.map(fmtPct).join(', ')} of the ${state.scale === 'absolute' ? 'focal' : 'slice'} peak`
      : 'No contour rings: only the 1/e² outlines';

    const skipped = d.stats.probe.dropped + d.stats.pump.dropped;
    $('#facts').innerHTML =
      `Drawing <b>${Math.round(d.size.w)} × ${Math.round(d.size.h)} mm</b> on a ${d.paper.w} × ${d.paper.h} mm sheet · ` +
      `<b>${sig(d.scale)} mm</b> per µm along the beams` +
      (state.stretch !== 1 ? ` (×${sig(state.stretch)} across them)` : '') +
      ` · total <b>${fmtMinutes(d.stats.probe.seconds + d.stats.pump.seconds)}</b> to plot` +
      (skipped ? ` · ${skipped} ring${skipped === 1 ? '' : 's'} skipped, closer than ${state.pitch} mm` : '');

    for (const key of BP.KEYS) {
      const st = d.stats[key];
      $(`#${key}-stats`).innerHTML =
        `<dt>Strokes</dt><dd>${st.strokes}</dd>` +
        `<dt>Rings</dt><dd>${st.rings}${st.dropped ? ` (+${st.dropped} skipped)` : ''}</dd>` +
        `<dt>Ink</dt><dd>${fmtMeters(st.drawn)}</dd>` +
        `<dt>Pen-up travel</dt><dd>${fmtMeters(st.travel)}</dd>` +
        `<dt>Plot time</dt><dd>${fmtMinutes(st.seconds)}</dd>`;
    }
  }

  function download(key) {
    if (!drawing) return;
    const blob = new Blob([BP.toSVG(drawing, key, { colors: ink })], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `beam-overlap-${key}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ----------------------------------------------------------------- events

  function applyPreset(set) {
    const keep = {};
    for (const k of SHARED) keep[k] = clone(state[k]);
    state = BP.withDefaults(Object.assign(clone(set), keep));
    $('#from-page').hidden = true;
    changed();
  }

  function bindInteractions() {
    const chips = $('#presets');
    PRESETS.forEach((pr) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = pr.label;
      b.addEventListener('click', () => applyPreset(pr.set));
      chips.appendChild(b);
    });
    const seg = (sel, fn) => $(sel).addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-v]');
      if (!b) return;
      fn(b.dataset.v);
      changed();
    });
    seg('#scale', (v) => { state.scale = v; });
    seg('#spacing', (v) => { state.spacing = v; });
    seg('#zoom', (v) => { ui.zoom = v; });
    for (const id of ['outline', 'envelope', 'ticks', 'signals']) {
      $('#' + id).addEventListener('change', (ev) => { state[id] = ev.target.checked; changed(); });
    }
    $('#paper').addEventListener('change', (ev) => {
      ui.paper = ev.target.value;
      if (PAPERS[ui.paper]) [state.paper.w, state.paper.h] = PAPERS[ui.paper];
      changed();
    });
    for (const key of BP.KEYS) {
      $(`#${key}-color`).addEventListener('input', (ev) => { ink[key] = ev.target.value; changed(); });
    }
    document.querySelectorAll('[data-download]').forEach((b) => b.addEventListener('click', () => download(b.dataset.download)));
  }

  // ------------------------------------------------------------------- boot

  buildControls();
  bindInteractions();
  fromOverlapPage();
  changed();
})();
