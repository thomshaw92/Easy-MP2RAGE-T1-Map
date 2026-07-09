// Web Worker: runs the MP2RAGE T1-mapping WASM core off the UI thread.
// The main thread parses NIfTI/DICOM (via NiiVue) and posts flat typed arrays;
// results are posted back with transferable ArrayBuffers (zero-copy).
//
// The .wasm is built by `wasm-pack build --target web` and copied to web/wasm/.
import init, { t1map_sa2rage, t1map_b1, version } from '../wasm/mp2rage_wasm.js';

const ready = init(new URL('../wasm/mp2rage_wasm_bg.wasm', import.meta.url));

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    await ready;
    if (msg.type === 'ping') {
      self.postMessage({ type: 'ready', version: version() });
      return;
    }
    self.postMessage({ type: 'progress', stage: 'computing', pct: 5 });
    const t0 = performance.now();

    let res;
    if (msg.mode === 'sa2rage') {
      res = t1map_sa2rage(
        msg.uni, msg.inv2, msg.sa,
        msg.dims, msg.uniAff, msg.saDims, msg.saAff,
        msg.mp, msg.saP,
      );
    } else if (msg.mode === 'b1map') {
      res = t1map_b1(
        msg.uni, msg.inv2, msg.b1,
        msg.dims, msg.uniAff, msg.b1Dims, msg.b1Aff,
        msg.kind, msg.refAngle, msg.mp,
      );
    } else {
      throw new Error(`unknown mode: ${msg.mode}`);
    }

    const out = {
      type: 'result',
      t1: res.t1,
      b1: res.b1,
      uni_corr: res.uni_corr,
      t1_uncorr: res.t1_uncorr,
      dims: res.dims,
      ms: performance.now() - t0,
    };
    self.postMessage(out, [out.t1.buffer, out.b1.buffer, out.uni_corr.buffer, out.t1_uncorr.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
  }
};
