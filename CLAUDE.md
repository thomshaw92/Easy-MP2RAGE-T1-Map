# Easy MP2RAGE T1 Map

In-browser MP2RAGE T1 mapping, B1 correction, and UNI denoising. The whole pipeline
runs client-side: a Rust numeric core compiled to WebAssembly, a framework-free JS UI,
and a self-contained slice viewer. No upload, no backend.

## Repository shape
- `crates/mp2rage-core`  pure Rust maths (ndarray), unit-tested, no I/O or wasm deps
- `crates/mp2rage-cli`   native CLI over the core (validation and batch); NIfTI I/O
- `crates/mp2rage-wasm`  wasm-bindgen bindings (thin) that expose the core to JS
- `crates/mp2rage-dicom` DICOM helpers
- `mp2rage_t1/`          the reference Python package, kept as the parity oracle
- `web/`                 index.html + js/{app,worker,nifti,bids,zip}.js; `web/wasm/` is generated
- `tools/`               gen_golden.py, phantom/, golden/

## Build and test
- Rust: run `source ~/.cargo/env` first (cargo is not on PATH). Then
  `cargo test -p mp2rage-core -p mp2rage-cli`.
- WASM: `web/wasm/` is gitignored and must be rebuilt after ANY Rust change. The README
  points to `tools/build_wasm.sh`, which is not present; build manually:
  `wasm-pack build crates/mp2rage-wasm --target web --release --out-dir crates/mp2rage-wasm/pkg`
  then copy `mp2rage_wasm.js`, `mp2rage_wasm_bg.wasm`, `mp2rage_wasm.d.ts` into `web/wasm/`.
- Web parity: `node web/test/e2e_node.mjs` (expect worst |diff| ~1.5e-4 ms, round-trip 0).
- BIDS indexer: `node web/test/bids_test.mjs` (55 assertions).
- Serve locally: `cd web && python3 -m http.server 8000`.

## Conventions (apply to every change)
- No em dashes or en dashes anywhere (page, docs, comments, code). Plain hyphens and commas.
- No marketing or "AI" tone in user-facing copy. Plain and direct.
- The repository contains ZERO subject data (PHI). Keep real data outside the repo and
  gitignore aggressively.
- Never commit or push. Draft a commit message when asked; the user runs git.
- Scope privacy claims to the data: "your images never leave your browser". The page loads
  GA4 (anonymous page views only); disclose it honestly.

## Building a similar tool
The `porting-neuro-tools-to-browser-wasm` skill is the full playbook (architecture, parity
gotchas, BIDS mode, docked viewer, download flow, deploy, review discipline).
