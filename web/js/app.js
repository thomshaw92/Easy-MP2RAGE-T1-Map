// Easy MP2RAGE T1 Map — in-browser controller.
// Parses NIfTI in JS (nifti.js), runs the WASM core in a Web Worker, previews
// with NiiVue, and offers client-side downloads. No data ever leaves the tab.
import { readNifti, writeNiftiF32, writeNiftiGz } from './nifti.js';
import { zipStore } from './zip.js';
import initWasm, { parse_dicom_series, write_dicom_t1 } from '../wasm/mp2rage_wasm.js';

let wasmReady;
function ensureWasm() {
  if (!wasmReady) wasmReady = initWasm(new URL('../wasm/mp2rage_wasm_bg.wasm', import.meta.url));
  return wasmReady;
}

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
  for (const [id, , , d3] of MP_SPEC) { const e = $(`#mp_${id}`); if (e) e.value = which === '3T' ? d3 : MP_SPEC.find(s => s[0] === id)[2]; }
  for (const [id, , , d3] of SA_SPEC) { const e = $(`#sa_${id}`); if (e) e.value = which === '3T' ? d3 : SA_SPEC.find(s => s[0] === id)[2]; }
  $('#paramSrcNote').textContent = which + ' preset';
  $('#paramSource').value = 'manual';
}
buildForm($('#mpGrid'), MP_SPEC, 'mp');
buildForm($('#saGrid'), SA_SPEC, 'sa');
buildForm($('#b1Grid'), B1_SPEC, 'b1');
document.querySelectorAll('.presetbtn').forEach((b) => b.onclick = () => applyPreset(b.dataset.preset));

const num = (id) => parseFloat($(id).value);
const mpParams = () => [num('#mp_tr'), num('#mp_ti1'), num('#mp_ti2'), num('#mp_fa1'), num('#mp_fa2'), num('#mp_nz1'), num('#mp_nz2'), num('#mp_trflash'), num('#mp_inveff')];
const saParams = () => [num('#sa_tr'), num('#sa_ti1'), num('#sa_ti2'), num('#sa_fa1'), num('#sa_fa2'), num('#sa_nz1'), num('#sa_nz2'), num('#sa_trflash'), num('#sa_avgt1')];

// ---- file ingest -----------------------------------------------------------
const ROLES = ['(ignore)', 'UNI', 'INV1', 'INV2', 'SA2RAGE', 'B1 map'];
const state = { files: [], jsons: [] };

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
      try {
        const js = JSON.parse(new TextDecoder().decode(buf));
        state.jsons.push({ name: file.name, json: js });
        if ($('#paramSource').value === 'json') applySidecar(file.name, js);
        log(`sidecar: ${file.name}`);
      } catch (e) { log(`could not parse ${file.name}: ${e}`); }
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
  $('#paramSrcNote').textContent = 'from sidecars';
}

function reloadFromJsons() {
  if (!state.jsons.length) { log('no JSON sidecars loaded — drop the .json files too'); return; }
  for (const j of state.jsons) applySidecar(j.name, j.json);
  $('#paramSource').value = 'json';
  log(`reloaded MP2RAGE parameters from ${state.jsons.length} sidecar(s)`);
}
$('#reloadJson').onclick = reloadFromJsons;
$('#paramSource').onchange = () => {
  const v = $('#paramSource').value;
  if (v === 'json') reloadFromJsons();
  else $('#paramSrcNote').textContent = v === 'dicom' ? 'from DICOM headers' : 'manual';
};

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
  // JSON sidecar rows
  for (const [i, j] of state.jsons.entries()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>📄 ${j.name}</td><td class="dim">JSON</td><td class="dim">parameters (matched by name)</td>`;
    const del = document.createElement('td');
    const b = document.createElement('button'); b.className = 'secondary'; b.textContent = '✕'; b.style.padding = '2px 9px';
    b.onclick = () => { state.jsons.splice(i, 1); renderTable(); };
    del.appendChild(b); tr.appendChild(del);
    tb.appendChild(tr);
  }
  $('#filetable').classList.toggle('hidden', state.files.length === 0 && state.jsons.length === 0);
}

function byRole(r) { return state.files.find((f) => f.role === r); }

function refreshRunState() {
  const uni = byRole('UNI'), inv1 = byRole('INV1'), inv2 = byRole('INV2'), sa = byRole('SA2RAGE'), b1 = byRole('B1 map');
  const task = $('#taskSel').value;
  $('#regField').style.display = task === 'denoise' ? '' : 'none';
  let ok = false, status = '', mode = null, label = 'Compute';
  if (task === 'denoise') {
    ok = !!(uni && inv1 && inv2);
    label = 'Denoise UNI';
    status = ok ? 'Ready: robust-combination denoising (UNI + INV1 + INV2).' : 'Denoise needs UNI, INV1 and INV2.';
    $('#saBlock').classList.add('hidden'); $('#b1Block').classList.add('hidden');
  } else if (task === 'b1only') {
    mode = 'sa2rage';
    ok = !!(uni && inv2 && sa);
    label = 'Compute B1 map';
    status = ok ? 'Ready: relative B1 map from SA2RAGE.' : 'SA2RAGE → B1 needs UNI, INV2 and SA2RAGE.';
    $('#saBlock').classList.remove('hidden'); $('#b1Block').classList.add('hidden');
  } else {
    mode = sa ? 'sa2rage' : (b1 ? 'b1map' : null);
    ok = !!(uni && mode);
    label = 'Compute T1 map';
    $('#saBlock').classList.toggle('hidden', mode === 'b1map');
    $('#b1Block').classList.toggle('hidden', mode !== 'b1map');
    status = ok
      ? `Ready: ${mode === 'sa2rage' ? 'SA2RAGE' : 'B1-map'} correction${inv2 ? '' : ' (no INV2 → mask from UNI)'}.`
      : 'Need a UNI and a B1 source (SA2RAGE or B1 map).';
  }
  $('#run').disabled = !ok;
  $('#run').textContent = label;
  $('#status').textContent = status;
  return { uni, inv1, inv2, sa, b1, mode, task };
}
$('#taskSel').onchange = refreshRunState;

// ---- DICOM folders --------------------------------------------------------
const getFile = (entry) => new Promise((res) => entry.file(res));

// recursively collect File objects under a directory entry (readEntries is batched)
function collectFiles(dirEntry) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const files = [];
    const pump = () => reader.readEntries(async (batch) => {
      if (!batch.length) { resolve(files); return; }
      for (const e of batch) {
        if (e.isFile) files.push(await getFile(e));
        else if (e.isDirectory) files.push(...await collectFiles(e));
      }
      pump();
    }, () => resolve(files));
  });
}

async function addDicomFolder(name, files) {
  if (!files.length) return;
  log(`reading DICOM folder "${name}" (${files.length} files) …`);
  await ensureWasm();
  const bufs = await Promise.all(files.map((f) => f.arrayBuffer()));
  const total = bufs.reduce((a, b) => a + b.byteLength, 0);
  const concat = new Uint8Array(total), offsets = new Uint32Array(bufs.length + 1);
  let o = 0;
  bufs.forEach((b, i) => { offsets[i] = o; concat.set(new Uint8Array(b), o); o += b.byteLength; });
  offsets[bufs.length] = o;
  let v;
  try { v = parse_dicom_series(concat, offsets); }
  catch (e) { log(`  ${name}: ${e}`); return; }
  const dims = Array.from(v.dims);
  state.files.push({ name, dims, affine: v.affine, data: v.data, role: v.role, dicom: true, src: { concat, offsets } });
  log(`  ${name} → [${dims.join('×')}] role ${v.role}`);
  const params = Array.from(v.params);
  if (params.length === 7) {
    ['mp_tr', 'mp_ti1', 'mp_ti2', 'mp_fa1', 'mp_fa2', 'mp_nz1', 'mp_nz2'].forEach((id, i) => {
      const el = $('#' + id); if (el) el.value = +params[i].toFixed(4);
    });
    $('#paramSrcNote').textContent = 'from DICOM header';
    $('#paramSource').value = 'dicom';
    log('  auto-filled MP2RAGE parameters from the DICOM ASCCONV header');
  }
  renderTable(); refreshRunState();
}

async function handleDrop(e) {
  const dt = e.dataTransfer;
  const entries = dt.items ? [...dt.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean) : [];
  if (!entries.length) { if (dt.files?.length) await addFiles(dt.files); return; }
  const niftis = [], loose = [], folders = [];
  for (const en of entries) {
    if (en.isDirectory) folders.push(en);
    else if (en.isFile) {
      const f = await getFile(en);
      (/\.(nii(\.gz)?|json)$/i.test(f.name) ? niftis : loose).push(f);
    }
  }
  if (niftis.length) await addFiles(niftis);
  if (loose.length) await addDicomFolder('(dropped files)', loose);
  for (const dir of folders) await addDicomFolder(dir.name, await collectFiles(dir));
}

// drag & drop
const drop = $('#drop');
drop.onclick = () => $('#file').click();
$('#file').onchange = (e) => addFiles(e.target.files);
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', handleDrop);

// folder picker (reliable DICOM import): groups the selected files by their
// containing directory, so picking one series folder OR a parent of several works.
async function addPickedFolders(fileList) {
  const groups = {};
  for (const f of [...fileList]) {
    const rel = f.webkitRelativePath || f.name;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(folder)';
    (groups[dir] ||= []).push(f);
  }
  for (const [dir, fs] of Object.entries(groups)) {
    const niftis = fs.filter((f) => /\.(nii(\.gz)?|json)$/i.test(f.name));
    const dcm = fs.filter((f) => !/\.(nii(\.gz)?|json)$/i.test(f.name));
    if (niftis.length) await addFiles(niftis);
    if (dcm.length) await addDicomFolder(dir.split('/').pop() || dir, dcm);
  }
}
$('#pickFolder').onclick = () => $('#folder').click();
$('#folder').onchange = (e) => addPickedFolders(e.target.files);

// ---- run -------------------------------------------------------------------
let worker;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}

const outputs = {}; // key -> {data, dims, affine, label, range, cmap}

$('#run').onclick = async () => {
  const { uni, inv1, inv2, sa, b1, mode, task } = refreshRunState();
  if ($('#run').disabled || !uni) return;
  $('#run').disabled = true;
  $('#progress').style.display = 'block'; setProgress(5);
  const t0 = performance.now();
  const dims = uni.dims.slice(0, 3);
  const w = getWorker();
  outputs.uni = { data: uni.data.slice(), dims, affine: uni.affine, label: 'UNI (input)', range: [0, 4095], cmap: 'gray' };

  if (task === 'denoise') {
    log('\n▶ denoise (robust combination) …');
    const msg = { mode: 'denoise', uni: uni.data, inv1: inv1.data, inv2: inv2.data, dims: Uint32Array.from(dims), reg: num('#reg') };
    w.onmessage = (e) => onResult(e.data, uni, task, mode, t0);
    setProgress(15);
    try { w.postMessage(msg, [uni.data.buffer, inv1.data.buffer, inv2.data.buffer]); }
    catch (err) { log('worker post failed: ' + err); $('#run').disabled = false; }
    return;
  }

  log(`\n▶ ${task === 'b1only' ? 'SA2RAGE → B1 map' : mode + ' correction'} …`);
  const inv2Data = inv2 ? inv2.data : uni.data;
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
  w.onmessage = (e) => onResult(e.data, uni, task, mode, t0);
  setProgress(15);
  try { w.postMessage(msg, transfer.filter(Boolean)); }
  catch (err) { log('worker post failed: ' + err); $('#run').disabled = false; }
};

function setProgress(p) { $('#progress > div').style.width = p + '%'; }

function setupViews(list) {
  const sel = $('#viewSel');
  sel.innerHTML = '';
  for (const [val, label] of list) { const o = document.createElement('option'); o.value = val; o.textContent = label; sel.appendChild(o); }
  sel.value = list[0][0];
}

async function onResult(res, uni, task, mode, t0) {
  if (res.type === 'error') { log('✖ ' + res.message); $('#run').disabled = false; setProgress(0); return; }
  if (res.type === 'progress') { setProgress(res.pct); return; }
  if (res.type !== 'result') return;
  setProgress(80);
  const dims = uni.dims.slice(0, 3), aff = uni.affine;
  for (const k of ['t1', 't1u', 'b1', 'unic']) delete outputs[k];
  let views;
  if (task === 'denoise') {
    outputs.unic = { data: res.denoised, dims, affine: aff, label: 'UNI-DEN (denoised)', range: [0, 4095], cmap: 'gray' };
    views = [['unic', 'UNI-DEN (denoised)'], ['uni', 'UNI (input)']];
  } else {
    outputs.t1 = { data: res.t1, dims, affine: aff, label: 'T1 corrected (ms)', range: [500, 2600], cmap: 'viridis' };
    outputs.t1u = { data: res.t1_uncorr, dims, affine: aff, label: 'T1 uncorrected (ms)', range: [500, 2600], cmap: 'viridis' };
    outputs.b1 = { data: res.b1, dims, affine: aff, label: 'B1 (relative)', range: [0.5, 1.3], cmap: 'plasma' };
    outputs.unic = { data: res.uni_corr, dims, affine: aff, label: 'UNI corrected', range: [0, 4095], cmap: 'gray' };
    views = task === 'b1only'
      ? [['b1', 'B1 (relative)'], ['uni', 'UNI (input)']]
      : [['t1', 'T1 corrected (ms)'], ['t1u', 'T1 uncorrected (ms)'], ['b1', 'B1 (relative)'], ['uni', 'UNI (input)']];
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  log(`✔ done in ${secs}s (wasm ${res.ms?.toFixed(0)} ms)`);
  setProgress(100);
  setupViews(views);
  await buildDownloads(task, mode, uni);
  $('#viewerWrap').style.display = 'block';
  showView($('#viewSel').value);
  $('#run').disabled = false;
  setTimeout(() => { $('#progress').style.display = 'none'; setProgress(0); }, 800);
}

// ---- downloads -------------------------------------------------------------
async function buildDownloads(task, mode, uni) {
  const dd = $('#downloads'); dd.innerHTML = '';
  const b1name = mode === 'sa2rage' ? 'B1map_from_SA2RAGE.nii.gz' : 'B1map.nii.gz';
  const items = task === 'denoise'
    ? [['unic', 'UNI_denoised.nii.gz']]
    : task === 'b1only'
      ? [['b1', b1name]]
      : [['t1', 'T1map.nii.gz'], ['b1', b1name], ['t1u', 'T1map_uncorrected.nii.gz'], ['unic', 'UNI_b1corrected.nii.gz']];
  const bundle = []; // {name, data:Uint8Array} for the "download all" zip
  for (const [key, fname] of items) {
    const o = outputs[key]; if (!o) continue;
    const gz = await writeNiftiGz(o.data, o.dims, o.affine);
    addLink(dd, new Blob([gz], { type: 'application/gzip' }), fname);
    bundle.push({ name: fname, data: gz });
  }
  // derived DICOM T1 series — only for the T1 task when the UNI input was a DICOM folder
  if (task === 't1' && uni && uni.src && outputs.t1) {
    try {
      await ensureWasm();
      const dims = Uint32Array.from(uni.dims.slice(0, 3));
      const salt = String(Date.now()).slice(-9);
      const dout = write_dicom_t1(uni.src.concat, uni.src.offsets, outputs.t1.data, dims, salt);
      const data = dout.data, offs = dout.offsets, files = [];
      for (let i = 0; i < offs.length - 1; i++)
        files.push({ name: `T1map_${String(i + 1).padStart(4, '0')}.dcm`, data: data.subarray(offs[i], offs[i + 1]) });
      addLink(dd, new Blob([zipStore(files)], { type: 'application/zip' }), 'T1map_DICOM.zip');
      for (const f of files) bundle.push({ name: `T1map_DICOM/${f.name}`, data: f.data });
      log(`  DICOM: derived ${files.length}-slice T1 series ready (.zip)`);
    } catch (e) { log('DICOM export skipped: ' + e); }
  }
  const prov = {
    software: 'easy-mp2rage-t1map (wasm)', task, mode,
    mp2rage: mpParams(), sa2rage: mode === 'sa2rage' ? saParams() : undefined,
    b1_map_type: mode === 'b1map' ? $('#b1_type').value : undefined,
    note: 'Computed entirely in-browser; no data uploaded.',
  };
  const provBytes = new TextEncoder().encode(JSON.stringify(prov, null, 2));
  addLink(dd, new Blob([provBytes], { type: 'application/json' }), 'parameters.json');
  bundle.push({ name: 'parameters.json', data: provBytes });
  // "download all" — one zip of every derivative, shown first and highlighted
  if (bundle.length > 1) {
    const a = addLink(dd, new Blob([zipStore(bundle)], { type: 'application/zip' }), 'all_derivatives.zip');
    a.textContent = '⬇ Download all (.zip)';
    a.style.fontWeight = '700';
    a.style.borderColor = 'var(--accent)';
    dd.insertBefore(a, dd.firstChild);
  }
}
function addLink(parent, blob, fname) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.textContent = '⬇ ' + fname;
  parent.appendChild(a);
  return a;
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

function histSmooth(data, rlo, rhi, nb) {
  const bins = new Float64Array(nb);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v > rlo && v < rhi) bins[Math.min(nb - 1, ((v - rlo) / (rhi - rlo) * nb) | 0)]++;
  }
  return bins.map((_, b) => (bins[Math.max(0, b - 1)] + 2 * bins[b] + bins[Math.min(nb - 1, b + 1)]) / 4);
}

function drawHistogram(o) {
  const c = $('#hist'); const ctx = c.getContext('2d');
  const W = c.width = (c.clientWidth || 800), H = c.height = 132;
  ctx.clearRect(0, 0, W, H);
  const isT1 = o.label.startsWith('T1');
  const rlo = isT1 ? 400 : o.range[0], rhi = isT1 ? 3200 : o.range[1];
  const nb = 150;
  const pad = 20, top = 18;
  ctx.font = '11px -apple-system,sans-serif';

  // For T1 views, overlay uncorrected (pre) and B1-corrected (post).
  const series = (isT1 && outputs.t1 && outputs.t1u)
    ? [{ data: outputs.t1u.data, color: '#f0b03a', fill: false, label: 'uncorrected' },
       { data: outputs.t1.data, color: '#5aa2ff', fill: true, label: 'B1-corrected' }]
    : [{ data: o.data, color: '#5aa2ff', fill: true, label: o.label }];
  const S = series.map((s) => ({ ...s, sm: histSmooth(s.data, rlo, rhi, nb) }));
  let maxc = 0; for (const s of S) for (const v of s.sm) maxc = Math.max(maxc, v);
  if (maxc === 0) { ctx.fillStyle = '#93a1b0'; ctx.fillText('no data in range', 12, H / 2); return; }
  const xOf = (t) => pad + (t - rlo) / (rhi - rlo) * (W - pad - 8);
  const binT1 = (b) => rlo + (b + 0.5) / nb * (rhi - rlo);

  for (const s of S) {
    ctx.beginPath();
    for (let b = 0; b < nb; b++) {
      const x = xOf(binT1(b)), y = H - pad - (s.sm[b] / maxc) * (H - pad - top);
      b === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    if (s.fill) {
      ctx.lineTo(xOf(binT1(nb - 1)), H - pad); ctx.lineTo(xOf(binT1(0)), H - pad); ctx.closePath();
      ctx.fillStyle = s.color + 'cc'; ctx.fill();
    } else {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.stroke();
    }
  }

  ctx.fillStyle = '#93a1b0';
  ctx.fillText(isT1 ? 'T1 histogram (brain)' : `${o.label} — brain histogram`, pad, 12);
  ctx.fillText(String(Math.round(rlo)), pad, H - 5);
  ctx.textAlign = 'right'; ctx.fillText(String(Math.round(rhi)), W - 5, H - 5); ctx.textAlign = 'left';

  // legend (top-right)
  let lx = W - 8;
  for (const s of [...S].reverse()) {
    ctx.textAlign = 'right'; ctx.fillStyle = s.color; ctx.fillText(s.label, lx, 12);
    lx -= ctx.measureText(s.label).width + 22;
    ctx.fillRect(lx + 6, 4, 10, 8);
  }
  ctx.textAlign = 'left';

  if (!isT1) return;
  // WM/GM peaks from the corrected (post) distribution
  const post = S[S.length - 1].sm;
  const peakIn = (lo, hi) => {
    let bi = -1, bc = -1;
    for (let b = 0; b < nb; b++) { const t = binT1(b); if (t >= lo && t <= hi && post[b] > bc) { bc = post[b]; bi = b; } }
    return bi < 0 ? null : binT1(bi);
  };
  for (const [t, lab, col] of [[peakIn(900, 1700), 'WM', '#7cd6ff'], [peakIn(1700, 2600), 'GM', '#ffd479']]) {
    if (!t) continue;
    const x = xOf(t);
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, H - pad); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.fillText(`${lab} ~${Math.round(t)}`, Math.min(x + 4, W - 74), top + 6);
  }
}

function showView(key) {
  const o = outputs[key];
  if (!o) return;
  curKey = key;
  $('#viewStat').textContent = `${o.label} · ${o.dims.join('×')} · window [${o.range[0]}, ${o.range[1]}]`;
  drawSlices(o);
  drawHistogram(o);
}
$('#viewSel').onchange = () => showView($('#viewSel').value);
$('#cmapSel').onchange = () => showView(curKey);
$('#slice').oninput = () => { const o = outputs[curKey]; if (o) drawSlices(o); };

refreshRunState();
log('Ready. Drop files or DICOM folders, pick a task, and Compute. Everything runs locally.');
