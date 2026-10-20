#!/usr/bin/env node
/*
 * Write the pen-plotter drawing as one SVG per pen (probe, pump), plus a two-colour preview.
 *
 *   node scripts/plot-svg.js                       # defaults → plots/
 *   node scripts/plot-svg.js --out dir --name x    # dir/x-probe.svg, dir/x-pump.svg, dir/x-preview.svg
 *   node scripts/plot-svg.js --set angle=25 --set pump.w0=3 --set levels=8
 *
 * --set takes any key of BeamPlot.DEFAULTS (dotted for nested ones); values are parsed as JSON
 * where possible, so numbers and true/false work as expected.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const BeamPlot = require('../plotter.js');

const args = process.argv.slice(2);
let out = path.join(__dirname, '..', 'plots');
let name = 'beam-overlap';
const params = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') out = args[++i];
  else if (a === '--name') name = args[++i];
  else if (a === '--set') {
    const [key, raw] = args[++i].split('=');
    let v = raw;
    try { v = JSON.parse(raw); } catch (e) { /* keep as string */ }
    const [k1, k2] = key.split('.');
    if (k2) (params[k1] = params[k1] || {})[k2] = v;
    else params[k1] = v;
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(1);
  }
}

const d = BeamPlot.build(params);
fs.mkdirSync(out, { recursive: true });
for (const key of BeamPlot.KEYS) {
  const file = path.join(out, `${name}-${key}.svg`);
  fs.writeFileSync(file, BeamPlot.toSVG(d, key));
  const st = d.stats[key];
  console.log(`${file}: ${st.strokes} strokes, ${(st.drawn / 1000).toFixed(1)} m drawn, ` +
    `${st.rings} rings (${st.dropped} skipped, closer than ${d.params.pitch} mm), ~${Math.max(1, Math.round(st.seconds / 60))} min`);
}
const preview = path.join(out, `${name}-preview.svg`);
fs.writeFileSync(preview, BeamPlot.toSVG(d, ['pump', 'probe'], { background: '#ffffff' })); // lighter ink first
console.log(`${preview}: both pens, for viewing only`);
console.log(`Drawing ${d.size.w.toFixed(0)} × ${d.size.h.toFixed(0)} mm on ${d.paper.w} × ${d.paper.h} mm, ` +
  `${d.scale.toFixed(2)} mm per µm.`);
