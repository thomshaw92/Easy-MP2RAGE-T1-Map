# Easy-MP2RAGE-T1-Map

B1-corrected T1 mapping from MP2RAGE, at 3T and 7T. The B1 source is either a
SA2RAGE scan or a generic Siemens B1 map (e.g. a tfl B1 map at 3T). Python port
of the T1-mapping parts of Marques'
[MP2RAGE-related-scripts](https://github.com/JosePMarques/MP2RAGE-related-scripts).

## Install

```bash
pip install -e .        # add ".[qc]" for the QC figure
```

numpy, scipy, nibabel and pydicom install automatically. `dcm2niix` is only
needed for DICOM input.

## Run

Point it at the scan folders (DICOM) or dcm2niix NIfTI files (with their `.json`
sidecars), in any order. Series roles and sequence timing are read from the
headers, including field strength.

With a SA2RAGE B1 scan (typically 7T):

```bash
easy-mp2rage-t1map -i INV1 INV2 UNI SA2RAGE -o out --qc
```

With a generic Siemens B1 map instead of SA2RAGE (typically 3T):

```bash
easy-mp2rage-t1map -i INV1 INV2 UNI -o out --b1-map B1MAP --b1-map-type tfl
```

UNI plus one B1 source (SA2RAGE, `--b1-map`, or a tfl flip-angle map passed in
`-i`) are required. INV2 (brain mask) and INV1 are used if present. A tfl map
given alongside SA2RAGE is used as a B1 cross-check. `easy-mp2rage-t1map -h`
lists all options.

## Output

```
out/t1map/<sub>_T1map.nii.gz     B1-corrected T1 in ms   <- main output
    b1map/<sub>_B1map.nii.gz     relative B1 (1.0 = nominal)
    <sub>_parameters.json        every value used
```

## Check against your protocol

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

## Notes

- Use the plain UNI rather than UNI-DEN if you have it. The denoised UNI can
  leave holes (CSF, vessels) where the B1 fit does not converge; those voxels
  are left as 0, or use `--fallback-uncorrected` to fill them with the
  uncorrected T1.
- Research code, no warranty. Sanity-check the maps and the parameters.

## License

GPL-3.0-or-later. Please cite Marques 2010 (NeuroImage), Marques & Gruetter 2013
(PLoS ONE) and Eggenschwiler 2012 (MRM); see `CITATION.cff`.
