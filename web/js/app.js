// Easy MP2RAGE T1 Map — in-browser controller.
// Parses NIfTI in JS (nifti.js), runs the WASM core in a Web Worker, previews
// with NiiVue, and offers client-side downloads. No data ever leaves the tab.
import { readNifti, writeNiftiF32, writeNiftiGz } from './nifti.js';

const $ = (s) => document.querySelector(s);
const logEl = $('#log');
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };

// ---- parameter specs -------------------------------------------------------
const MP_SPEC = [
  ['tr', 'TR (s)', 4.3, 5.0, 0.001], ['ti1', 'TI1 (s)', 0.840, 0.700, 0.001],
  ['ti2', 'TI2 (s)', 2.370, 2.500, 0.001], ['fa1', 'flip 1 (°)', 5, 4, 0.1],
  ['fa2', 'flip 2 (°)', 6, 5, 0.1], ['nz1', 'NZslices 1', 64, 64, 1],
  ['nz2', 'NZslices 2', 128, 128, 1], ['trflash', 'TRFLASH (s)', 0.007, 0.0067, 0.0001],
  ['inveff', 'inversion eff.', 0.96, 0.96, 0.01],
];
const SA_SPEC = [
  ['tr', 'TR (s)', 2.4, 2.4, 0.001], ['ti1', 'TD1 (s)', 0.150, 0.150, 0.001],
  ['ti2', 'TD2 (s)', 1.500, 1.500, 0.001], ['fa1', 'flip 1 (°)', 6, 6, 0.1],
  ['fa2', 'flip 2 (°)', 6, 6, 0.1], ['nz1', 'NZslices 1', 24, 24, 1],
  ['nz2', 'NZslices 2', 24, 24, 1], ['trflash', 'TRFLASH (s)', 0.005, 0.005, 0.0001],
  ['avgt1', 'average T1 (s)', 1.5, 1.2, 0.05],
];
const B1_SPEC = [
  ['type', 'map type', 'tfl', 'tfl'], ['refangle', 'ref flip (°)', 80, 80, 1],
];

function buildForm(grid, spec, prefix) {
  grid.innerHTML = '';
  for (const [id, label, d7] of spec) {
    const f = document.createElement('div'); f.className = 'field';
    const lab = document.createElement('label'); lab.textContent = label;
    let inp;
    if (id === 'type') {
      inp = document.createElement('select');
      for (const t of ['tfl', 'percent', 'relative']) { const o = document.createElement('option'); o.value = o.textContent = t; inp.appendChild(o); }
      inp.value = d7;
    } else {
      inp = document.createElement('input'); inp.type = 'number'; inp.value = d7;
      inp.step = spec.find((s) => s[0] === id)[4] ?? 'any';
    }
    inp.id = `${prefix}_${id}`;
    f.appendChild(lab); f.appendChild(inp); grid.appendChild(f);
  }
}
function applyPreset(which) {
  const idx = which === '3T' ? 3 : 2;
  for (const [id, , , d3] of MP_SPEC) { const e = $(`#mp_${id}`); if (e) e.value = which === '3T' ? d3 : MP_SPEC.find(s => s[0] === id)[2]; }
  for (const [id, , , d3] of SA_SPEC) { const e = $(`#sa_${id}`); if (e) e.value = which === '3T' ? d3 : SA_SPEC.find(s => s[0] === id)[2]; }
  $('#paramSource').textContent = which + ' preset';
}
buildForm($('#mpGrid'), MP_SPEC, 'mp');
buildForm($('#saGrid'), SA_SPEC, 'sa');
buildForm($('#b1Grid'), B1_SPEC, 'b1');
document.querySelectorAll('.presets button').forEach((b) => b.onclick = () => applyPreset(b.dataset.preset));

const num = (id) => parseFloat($(id).value);
const mpParams = () => [num('#mp_tr'), num('#mp_ti1'), num('#mp_ti2'), num('#mp_fa1'), num('#mp_fa2'), num('#mp_nz1'), num('#mp_nz2'), num('#mp_trflash'), num('#mp_inveff')];
const saParams = () => [num('#sa_tr'), num('#sa_ti1'), num('#sa_ti2'), num('#sa_fa1'), num('#sa_fa2'), num('#sa_nz1'), num('#sa_nz2'), num('#sa_trflash'), num('#sa_avgt1')];

// ---- file ingest -----------------------------------------------------------
const ROLES = ['(ignore)', 'UNI', 'INV1', 'INV2', 'SA2RAGE', 'B1 map'];
const state = { files: [] };

function guessRole(name) {
  const n = name.toLowerCase();
  if (/sa2rage|sa2/.test(n)) return 'SA2RAGE';
  if (/b1map|_b1|flip.?angle|tfl/.test(n)) return 'B1 map';
  if (/uni/.test(n)) return 'UNI';
  if (/inv-?2|inv2/.test(n)) return 'INV2';
  if (/inv-?1|inv1/.test(n)) return 'INV1';
  return '(ignore)';
}

async function addFiles(fileList) {
  for (const file of fileList) {
    const lower = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    if (lower.endsWith('.json')) {
      try { applySidecar(file.name, JSON.parse(new TextDecoder().decode(buf))); log(`sidecar: ${file.name}`); }
      catch (e) { log(`could not parse ${file.name}: ${e}`); }
      continue;
    }
    if (!/\.nii(\.gz)?$/.test(lower)) { log(`skipped ${file.name} (not .nii/.nii.gz/.json)`); continue; }
    try {
      const nii = await readNifti(buf);
      const rec = { name: file.name, size: file.size, dims: nii.dims, affine: nii.affine, data: nii.data, role: guessRole(file.name) };
      state.files.push(rec);
      log(`loaded ${file.name}  [${nii.dims.join('×')}]  → ${rec.role}`);
    } catch (e) { log(`failed to read ${file.name}: ${e}`); }
  }
  renderTable(); refreshRunState();
}

function applySidecar(name, js) {
  const n = name.toLowerCase();
  const set = (id, v) => { if (v != null && $(id)) $(id).value = v; };
  if (/inv-?1|inv1/.test(n)) { set('#mp_ti1', js.InversionTime); set('#mp_fa1', js.FlipAngle); }
  if (/inv-?2|inv2/.test(n)) { set('#mp_ti2', js.InversionTime); set('#mp_fa2', js.FlipAngle); }
  if (/mp2rage|uni|inv/.test(n) && js.RepetitionTime) set('#mp_tr', js.RepetitionTime);
  $('#paramSource').textContent = 'from sidecars';
}

function renderTable() {
  const tb = $('#filetable tbody'); tb.innerHTML = '';
  for (const [i, f] of state.files.entries()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${f.name}</td><td class="dim">${f.dims.join(' × ')}</td>`;
    const roleTd = document.createElement('td');
    const sel = document.createElement('select');
    for (const r of ROLES) { const o = document.createElement('option'); o.value = o.textContent = r; if (r === f.role) o.selected = true; sel.appendChild(o); }
    sel.onchange = () => { f.role = sel.value; refreshRunState(); };
    roleTd.appendChild(sel); tr.appendChild(roleTd);
    const del = document.createElement('td');
    const b = document.createElement('button'); b.className = 'secondary'; b.textContent = '✕'; b.style.padding = '2px 9px';
    b.onclick = () => { state.files.splice(i, 1); renderTable(); refreshRunState(); };
    del.appendChild(b); tr.appendChild(del);
    tb.appendChild(tr);
  }
  $('#filetable').classList.toggle('hidden', state.files.length === 0);
}

function byRole(r) { return state.files.find((f) => f.role === r); }

function refreshRunState() {
  const uni = byRole('UNI'), inv2 = byRole('INV2'), sa = byRole('SA2RAGE'), b1 = byRole('B1 map');
  const mode = sa ? 'sa2rage' : (b1 ? 'b1map' : null);
  $('#saBlock').classList.toggle('hidden', mode === 'b1map');
  $('#b1Block').classList.toggle('hidden', mode !== 'b1map');
  const ok = uni && mode;
  $('#run').disabled = !ok;
  $('#status').textContent = ok
    ? `Ready: ${mode === 'sa2rage' ? 'SA2RAGE' : 'B1-map'} correction${inv2 ? '' : ' (no INV2 → mask from UNI)'}.`
    : 'Need a UNI and a B1 source (SA2RAGE or B1 map).';
  return { uni, inv2, sa, b1, mode };
}

// drag & drop
const drop = $('#drop');
drop.onclick = () => $('#file').click();
$('#file').onchange = (e) => addFiles(e.target.files);
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// ---- run -------------------------------------------------------------------
let worker;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}

const outputs = {}; // key -> {data, dims, affine, label, range, cmap}

$('#run').onclick = async () => {
  const { uni, inv2, sa, b1, mode } = refreshRunState();
  if (!uni || !mode) return;
  $('#run').disabled = true;
  $('#progress').style.display = 'block'; setProgress(5);
  log(`\n▶ ${mode} correction …`);
  const t0 = performance.now();

  // INV2 for masking; if absent, reuse UNI (core derives a mask from it)
  const inv2Data = inv2 ? inv2.data : uni.data;
  const dims = uni.dims.slice(0, 3);
  const msg = { mode, uni: uni.data, inv2: inv2Data, dims: Uint32Array.from(dims), uniAff: uni.affine, mp: Float64Array.from(mpParams()) };

  const transfer = [uni.data.buffer];
  if (inv2) transfer.push(inv2.data.buffer);
  if (mode === 'sa2rage') {
    msg.sa = sa.data; msg.saDims = Uint32Array.from(sa.dims.slice(0, 3)); msg.saAff = sa.affine;
    msg.saP = Float64Array.from(saParams()); transfer.push(sa.data.buffer);
  } else {
    msg.b1 = b1.data; msg.b1Dims = Uint32Array.from(b1.dims.slice(0, 3)); msg.b1Aff = b1.affine;
    msg.kind = { tfl: 0, percent: 1, relative: 2 }[$('#b1_type').value]; msg.refAngle = num('#b1_refangle');
    transfer.push(b1.data.buffer);
  }

  const w = getWorker();
  w.onmessage = (e) => onResult(e.data, uni, mode, t0);
  // keep a copy of UNI/affine for the viewer (buffers get transferred)
  outputs.uni = { data: uni.data.slice(), dims, affine: uni.affine, label: 'UNI', range: [0, 4095], cmap: 'gray' };
  setProgress(15);
  try { w.postMessage(msg, transfer.filter(Boolean)); }
  catch (err) { log('worker post failed: ' + err); $('#run').disabled = false; }
};

function setProgress(p) { $('#progress > div').style.width = p + '%'; }

async function onResult(res, uni, mode, t0) {
  if (res.type === 'error') { log('✖ ' + res.message); $('#run').disabled = false; setProgress(0); return; }
  if (res.type === 'progress') { setProgress(res.pct); return; }
  if (res.type !== 'result') return;
  setProgress(80);
  const dims = uni.dims.slice(0, 3), aff = uni.affine;
  outputs.t1 = { data: res.t1, dims, affine: aff, label: 'T1 corrected (ms)', range: [500, 2600], cmap: 'viridis' };
  outputs.t1u = { data: res.t1_uncorr, dims, affine: aff, label: 'T1 uncorrected (ms)', range: [500, 2600], cmap: 'viridis' };
  outputs.b1 = { data: res.b1, dims, affine: aff, label: 'B1 (relative)', range: [0.5, 1.3], cmap: 'plasma' };
  outputs.unic = { data: res.uni_corr, dims, affine: aff, label: 'UNI corrected', range: [0, 4095], cmap: 'gray' };
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  log(`✔ done in ${secs}s (wasm ${res.ms?.toFixed(0)} ms)`);
  setProgress(100);
  await buildDownloads(mode);
  $('#viewerWrap').style.display = 'block';
  await showView($('#viewSel').value);
  $('#run').disabled = false;
  setTimeout(() => { $('#progress').style.display = 'none'; setProgress(0); }, 800);
}

// ---- downloads -------------------------------------------------------------
async function buildDownloads(mode) {
  const dd = $('#downloads'); dd.innerHTML = '';
  const items = [
    ['t1', 'T1map.nii.gz'], ['b1', 'B1map.nii.gz'],
    ['t1u', 'T1map_uncorrected.nii.gz'], ['unic', 'UNI_b1corrected.nii.gz'],
  ];
  for (const [key, fname] of items) {
    const o = outputs[key]; if (!o) continue;
    const gz = await writeNiftiGz(o.data, o.dims, o.affine);
    addLink(dd, new Blob([gz], { type: 'application/gzip' }), fname);
  }
  const prov = {
    software: 'easy-mp2rage-t1map (wasm)', mode,
    mp2rage: mpParams(), sa2rage: mode === 'sa2rage' ? saParams() : undefined,
    b1_map_type: mode === 'b1map' ? $('#b1_type').value : undefined,
    note: 'Computed entirely in-browser; no data uploaded.',
  };
  addLink(dd, new Blob([JSON.stringify(prov, null, 2)], { type: 'application/json' }), 'parameters.json');
}
function addLink(parent, blob, fname) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.textContent = '⬇ ' + fname;
  parent.appendChild(a);
}

// ---- built-in canvas slice viewer (self-contained, no external deps) -------
function ramp(stops) {
  return (t) => {
    t = Math.max(0, Math.min(1, t));
    const x = t * (stops.length - 1), i = Math.floor(x), f = x - i;
    const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
}
const CMAPS = {
  gray: (t) => [t * 255, t * 255, t * 255],
  hot: (t) => [Math.min(1, 3 * t) * 255, Math.min(1, Math.max(0, 3 * t - 1)) * 255, Math.min(1, Math.max(0, 3 * t - 2)) * 255],
  viridis: ramp([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]),
  plasma: ramp([[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]]),
};
let curKey = 't1';

function drawPlane(canvas, o, plane, idx) {
  const [nx, ny, nz] = o.dims;
  const cmap = CMAPS[$('#cmapSel').value] || CMAPS.gray;
  const [lo, hi] = o.range;
  let w, h, at;
  if (plane === 'ax') { w = nx; h = ny; at = (x, y) => o.data[x + nx * (y + ny * idx)]; }
  else if (plane === 'co') { w = nx; h = nz; at = (x, y) => o.data[x + nx * (idx + ny * y)]; }
  else { w = ny; h = nz; at = (x, y) => o.data[idx + nx * (x + ny * y)]; }
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, h - 1 - y); // flip so superior/posterior is up
      let r = 0, g = 0, b = 0;
      if (v > 0 || lo < 0) { const c = cmap((v - lo) / (hi - lo)); r = c[0]; g = c[1]; b = c[2]; }
      const p = (y * w + x) * 4;
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawSlices(o) {
  const [nx, ny, nz] = o.dims;
  const s = $('#slice');
  s.max = nz - 1;
  if (+s.value > nz - 1) s.value = Math.floor(nz / 2);
  drawPlane($('#cax'), o, 'ax', +s.value);
  drawPlane($('#cco'), o, 'co', Math.floor(ny / 2));
  drawPlane($('#csa'), o, 'sa', Math.floor(nx / 2));
}

function showView(key) {
  curKey = ({ t1: 't1', t1u: 't1u', b1: 'b1', uni: 'uni' })[key] || 't1';
  const o = outputs[curKey];
  if (!o) return;
  $('#viewStat').textContent = `${o.label} · ${o.dims.join('×')} · window [${o.range[0]}, ${o.range[1]}]`;
  drawSlices(o);
}
$('#viewSel').onchange = () => showView($('#viewSel').value);
$('#cmapSel').onchange = () => showView(curKey === 't1u' ? 't1u' : curKey === 'b1' ? 'b1' : curKey === 'uni' ? 'uni' : 't1');
$('#slice').oninput = () => { const o = outputs[curKey]; if (o) drawSlices(o); };

log('Ready. Drop UNI + INV2 + (SA2RAGE or B1 map). Everything runs locally.');
