# Easy MP2RAGE T1 Map

Quantitative **T1 mapping from MP2RAGE**, B1-corrected, at 3T and 7T — in your
browser or from the command line.

### ➡ Web app: <https://thomshaw92.github.io/Easy-MP2RAGE-T1-Map/>

Drag in your DICOM folders or NIfTI files, assign roles, and it computes a
B1-corrected T1 map **entirely in your browser**. Nothing is uploaded — there is
no server — so it is safe for identifiable data (you can even run it offline).
Outputs download as NIfTI, plus a derived DICOM series for the T1 map.

## What it does

- **T1 map** — B1-corrected quantitative T1 (ms) from MP2RAGE, using either a
  **SA2RAGE** scan or a generic **Siemens B1 map** (e.g. a tfl / `TB1TFL`
  flip-angle map) as the B1⁺ transmit-field source. A B1 map with a smaller
  field-of-view than the MP2RAGE can be smoothly extended to cover the whole
  brain (B1⁺ is spatially smooth, so a low-order polynomial fills the gaps).
- **SA2RAGE → B1 map** — just the relative B1 map.
- **UNI denoising** — MP2RAGE UNI → UNI-DEN (O'Brien robust combination), which
  removes the salt-and-pepper background.

## What it's based on

The maths is a port of the T1-mapping parts of José Marques'
[MP2RAGE-related-scripts](https://github.com/JosePMarques/MP2RAGE-related-scripts):

- MP2RAGE T1 lookup and B1 correction — Marques et al. 2010, *NeuroImage*.
- SA2RAGE B1 mapping — Eggenschwiler et al. 2012, *MRM* (Marques & Gruetter 2013).
- UNI denoising ("robust combination") — O'Brien et al. 2014, *PLoS ONE*.

There are three implementations in this repo, and the numeric core is validated
to be bit-for-bit / machine-precision identical across them (see
`crates/mp2rage-cli/tests` and `tools/gen_golden.py`):

- `mp2rage_t1/` — the reference **Python** package and CLI.
- `crates/` — a pure-**Rust** port (`mp2rage-core`), a native CLI
  (`mp2rage-cli`), and a **WebAssembly** build (`mp2rage-wasm`).
- `web/` — the static **in-browser app** (the Rust core compiled to WASM).

## Command line (Python)

```bash
pip install -e .        # add ".[qc]" for the QC figure
```

numpy, scipy, nibabel and pydicom install automatically. `dcm2niix` is only
needed for DICOM input. Point it at the scan folders (DICOM) or dcm2niix NIfTI
files (with their `.json` sidecars), in any order — roles and timing are read
from the headers, including field strength.

```bash
# SA2RAGE B1 source (typically 7T)
easy-mp2rage-t1map -i INV1 INV2 UNI SA2RAGE -o out --qc

# generic Siemens B1 map instead of SA2RAGE (typically 3T)
easy-mp2rage-t1map -i INV1 INV2 UNI -o out --b1-map B1MAP --b1-map-type tfl
```

UNI plus one B1 source (SA2RAGE, `--b1-map`, or a tfl flip-angle map passed in
`-i`) are required. INV2 (brain mask) and INV1 are used if present.
`easy-mp2rage-t1map -h` lists all options.

Output:

```
out/t1map/<sub>_T1map.nii.gz     B1-corrected T1 in ms   <- main output
    b1map/<sub>_B1map.nii.gz     relative B1 (1.0 = nominal)
    <sub>_parameters.json        every value used
```

### Check against your protocol

- `--trflash` — MP2RAGE GRE readout TR (echo spacing). Not stored in DICOM;
  default 7.0 ms (±1 ms ≈ ±40 ms in T1).
- SA2RAGE outer TR, 2nd delay and 2nd flip angle are not reliably in the header.
  Header-derived defaults are used; override with `--sa2rage-tr`,
  `--sa2rage-td2`, `--sa2rage-fa`.
- Field strength is auto-detected and sets the SA2RAGE average-T1 (1.2 s at
  ≤3T, 1.5 s at 7T). Override with `--b0` / `--sa2rage-avgt1`.
- With `--b1-map`, set `--b1-map-type` to how it stores B1: `tfl` (Siemens
  flip-angle map, value = flip°×10, prep angle `--b1-ref-angle` default 80),
  `percent` (100 = nominal) or `relative` (1.0 = nominal).

## Command line (Rust)

```bash
cargo run -p mp2rage-cli --release -- \
  --uni UNI.nii.gz --inv2 INV2.nii.gz --b1-map B1.nii.gz \
  --b1-map-type tfl --b1-extend-fov --out out
```

## Notes

- **DICOM tips.** A Siemens tfl B1 map (`TB1TFL`) exports *two* series — an
  anatomical reference and the **flip-angle map**. Only the flip-angle map (the
  `FLIP ANGLE MAP` / "famp" one) is the B1 map. Prefer the distortion-corrected
  (`DIS2D`/`DIS3D`) MP2RAGE images over the non-corrected `_ND` versions. The web
  app flags both of these for you.
- Use the plain UNI rather than UNI-DEN as the input to correction if you have
  it. Voxels where the B1 fit does not converge are left as 0.
- Research code, no warranty. Sanity-check the maps and the parameters.

## Deploying / self-hosting

The web app is a static site (Rust → WASM); GitHub Pages builds and publishes it
automatically. See [`docs/DEPLOY.md`](docs/DEPLOY.md).

## License

GPL-3.0-or-later. Please cite Marques 2010 (NeuroImage), Marques & Gruetter 2013
(PLoS ONE), Eggenschwiler 2012 (MRM) and O'Brien 2014 (PLoS ONE); see
`CITATION.cff`.
