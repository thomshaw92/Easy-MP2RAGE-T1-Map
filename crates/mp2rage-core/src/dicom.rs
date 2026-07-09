//! Minimal DICOM reader for uncompressed Siemens MP2RAGE/SA2RAGE series
//! (Explicit or Implicit VR Little Endian, single-frame). Pure Rust, std-only,
//! so it compiles to WASM. Compressed transfer syntaxes are rejected (route via
//! dcm2niix). Also parses the Siemens CSA/ASCCONV protocol for sequence params.

use std::collections::HashMap;

fn u16le(b: &[u8], o: usize) -> u16 { u16::from_le_bytes([b[o], b[o + 1]]) }
fn u32le(b: &[u8], o: usize) -> u32 { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }

/// One parsed DICOM instance (the fields we need).
#[derive(Default, Clone)]
pub struct DicomFile {
    pub rows: usize,
    pub cols: usize,
    pub bits: u16,
    pub pixel_rep: u16,
    pub pixels: Vec<f64>, // rows*cols, rescaled
    pub ipp: [f64; 3],
    pub iop: [f64; 6],
    pub pixel_spacing: [f64; 2], // [row, col]
    pub slice_thickness: f64,
    pub instance: i32,
    pub echo: i32,
    pub acquisition: i32,
    pub series_number: i32,
    pub series_uid: String,
    pub series_desc: String,
    pub image_type: Vec<String>,
    pub scanning_seq: String,
    pub inversion_time: f64, // ms
    pub flip_angle: f64,
    pub repetition_time: f64, // ms
    pub field_strength: f64,
    pub ascconv: HashMap<String, String>,
}

const VR_LONG: [&[u8; 2]; 8] = [b"OB", b"OW", b"OF", b"SQ", b"UT", b"UN", b"UC", b"UR"];

fn ascii(b: &[u8]) -> String {
    String::from_utf8_lossy(b).trim_matches(|c: char| c == '\0' || c == ' ').to_string()
}
fn ds(b: &[u8]) -> f64 { ascii(b).parse().unwrap_or(0.0) }
fn ds_multi(b: &[u8]) -> Vec<f64> { ascii(b).split('\\').filter_map(|s| s.trim().parse().ok()).collect() }

/// Parse the Siemens CSA header text for the ASCCONV protocol (key=value).
fn parse_ascconv(raw: &[u8]) -> HashMap<String, String> {
    let txt = String::from_utf8_lossy(raw);
    let mut out = HashMap::new();
    if let Some(start) = txt.find("ASCCONV BEGIN") {
        let end = txt[start..].find("ASCCONV END").map(|e| start + e).unwrap_or(txt.len());
        for line in txt[start..end].lines() {
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim();
                if !k.is_empty() && !k.starts_with('#') {
                    out.insert(k.to_string(), v.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    out
}

/// Parse one DICOM file's bytes.
pub fn parse(bytes: &[u8]) -> Result<DicomFile, String> {
    let mut pos = 0usize;
    // preamble + "DICM"
    if bytes.len() > 132 && &bytes[128..132] == b"DICM" {
        pos = 132;
    }
    // file-meta group (0002) is always Explicit VR LE; read TransferSyntaxUID
    let mut implicit = false;
    let mut df = DicomFile { pixel_spacing: [1.0, 1.0], slice_thickness: 1.0, ..Default::default() };
    let mut csa = Vec::<u8>::new();

    // helper to read one element header at `pos` for a given VR mode
    let read_elem = |b: &[u8], pos: &mut usize, implicit: bool| -> Option<(u16, u16, [u8; 2], usize)> {
        if *pos + 8 > b.len() { return None; }
        let group = u16le(b, *pos);
        let elem = u16le(b, *pos + 2);
        *pos += 4;
        if implicit && group != 0x0002 {
            let len = u32le(b, *pos) as usize; *pos += 4;
            Some((group, elem, *b"UN", len))
        } else {
            let vr = [b[*pos], b[*pos + 1]]; *pos += 2;
            let len = if VR_LONG.iter().any(|v| *v == &vr) {
                *pos += 2; // reserved
                let l = u32le(b, *pos) as usize; *pos += 4; l
            } else {
                let l = u16le(b, *pos) as usize; *pos += 2; l
            };
            Some((group, elem, vr, len))
        }
    };

    // first pass through file-meta (0002) explicit VR
    while pos < bytes.len() {
        let save = pos;
        let (g, e, vr, len) = match read_elem(bytes, &mut pos, false) { Some(x) => x, None => break };
        if g != 0x0002 { pos = save; break; } // meta group done
        if len == 0xFFFF_FFFF { return Err("undefined-length in meta".into()); }
        if g == 0x0002 && e == 0x0010 {
            let uid = ascii(&bytes[pos..pos + len]);
            if uid == "1.2.840.10008.1.2" { implicit = true; }
            else if uid != "1.2.840.10008.1.2.1" && uid != "1.2.840.10008.1.2.2" {
                return Err(format!("unsupported/compressed transfer syntax {uid}"));
            }
        }
        let _ = vr;
        pos += len;
    }

    // main dataset
    while pos < bytes.len() {
        let (g, e, vr, len) = match read_elem(bytes, &mut pos, implicit) { Some(x) => x, None => break };
        // skip sequences (defined or undefined length)
        if &vr == b"SQ" || len == 0xFFFF_FFFF {
            if len == 0xFFFF_FFFF {
                // walk to sequence delimiter (FFFE,E0DD)
                while pos + 8 <= bytes.len() {
                    let tg = u16le(bytes, pos); let te = u16le(bytes, pos + 2);
                    let il = u32le(bytes, pos + 4) as usize; pos += 8;
                    if tg == 0xFFFE && te == 0xE0DD { break; }
                    if il != 0xFFFF_FFFF { pos += il; }
                }
            } else { pos += len; }
            continue;
        }
        if pos + len > bytes.len() { break; }
        let v = &bytes[pos..pos + len];
        match (g, e) {
            (0x0008, 0x0008) => df.image_type = ascii(v).split('\\').map(|s| s.trim().to_string()).collect(),
            (0x0008, 0x103E) => df.series_desc = ascii(v),
            (0x0018, 0x0020) => df.scanning_seq = ascii(v),
            (0x0018, 0x0050) => df.slice_thickness = ds(v),
            (0x0018, 0x0080) => df.repetition_time = ds(v),
            (0x0018, 0x0082) => df.inversion_time = ds(v),
            (0x0018, 0x0086) => df.echo = ascii(v).parse().unwrap_or(0),
            (0x0018, 0x0087) => df.field_strength = ds(v),
            (0x0018, 0x1314) => df.flip_angle = ds(v),
            (0x0020, 0x000E) => df.series_uid = ascii(v),
            (0x0020, 0x0011) => df.series_number = ascii(v).parse().unwrap_or(0),
            (0x0020, 0x0012) => df.acquisition = ascii(v).parse().unwrap_or(0),
            (0x0020, 0x0013) => df.instance = ascii(v).parse().unwrap_or(0),
            (0x0020, 0x0032) => { let a = ds_multi(v); if a.len() == 3 { df.ipp = [a[0], a[1], a[2]]; } }
            (0x0020, 0x0037) => { let a = ds_multi(v); if a.len() == 6 { df.iop.copy_from_slice(&a); } }
            (0x0028, 0x0010) => df.rows = u16le(v, 0) as usize,
            (0x0028, 0x0011) => df.cols = u16le(v, 0) as usize,
            (0x0028, 0x0030) => { let a = ds_multi(v); if a.len() == 2 { df.pixel_spacing = [a[0], a[1]]; } }
            (0x0028, 0x0100) => df.bits = u16le(v, 0),
            (0x0028, 0x0103) => df.pixel_rep = u16le(v, 0),
            (0x0029, 0x1010) | (0x0029, 0x1020) => csa.extend_from_slice(v),
            (0x7FE0, 0x0010) => {
                let n = df.rows * df.cols;
                let mut px = Vec::with_capacity(n);
                if df.bits == 16 {
                    for i in 0..n {
                        let raw = u16le(v, 2 * i);
                        px.push(if df.pixel_rep == 1 { raw as i16 as f64 } else { raw as f64 });
                    }
                } else {
                    for i in 0..n { px.push(v[i] as f64); }
                }
                df.pixels = px;
                pos += len;
                break; // pixel data is last
            }
            _ => {}
        }
        pos += len;
    }
    if df.pixels.is_empty() { return Err("no pixel data".into()); }
    df.ascconv = parse_ascconv(&csa);
    Ok(df)
}

/// Extract MP2RAGE sequence params from the ASCCONV protocol, in the units the
/// UI form expects: `[TR_s, TI1_s, TI2_s, FA1_deg, FA2_deg, NZ1, NZ2]`.
/// Returns None if the key fields aren't present (e.g. a non-MP2RAGE series).
pub fn mp2rage_params(f: &DicomFile) -> Option<Vec<f64>> {
    let a = &f.ascconv;
    let g = |k: &str| -> Option<f64> {
        let s = a.get(k)?;
        if let Some(h) = s.strip_prefix("0x") {
            return i64::from_str_radix(h, 16).ok().map(|x| x as f64);
        }
        s.parse::<f64>().ok()
    };
    let tr = g("alTR[0]")? / 1e6;
    let ti1 = g("alTI[0]")? / 1e6;
    let ti2 = g("alTI[1]")? / 1e6;
    let fa1 = g("adFlipAngleDegree[0]")?;
    let fa2 = g("adFlipAngleDegree[1]")?;
    let n_sl = g("sKSpace.lImagesPerSlab").or_else(|| g("sKSpace.lPartitions"))?;
    let pf = match g("sKSpace.ucSlicePartialFourier").unwrap_or(16.0) as i64 {
        1 => 0.5, 2 => 0.625, 4 => 0.75, 8 => 0.875, _ => 1.0,
    };
    let acc = g("sPat.lAccelFact3D").unwrap_or(1.0).max(1.0);
    let nz1 = (n_sl * (pf - 0.5) / acc).round();
    let nz2 = (n_sl * 0.5 / acc).round();
    Some(vec![tr, ti1, ti2, fa1, fa2, nz1, nz2])
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Infer the MP2RAGE role from image type / description (matches dicom_io.classify).
pub fn classify(f: &DicomFile) -> String {
    let itype: Vec<String> = f.image_type.iter().map(|s| s.to_uppercase()).collect();
    let desc = format!("{} {}", f.series_desc, f.scanning_seq).to_lowercase();
    if itype.iter().any(|s| s == "FLIP ANGLE MAP") { return "B1 map".into(); }
    if desc.contains("sa2rage") { return "SA2RAGE".into(); }
    if itype.iter().any(|s| s == "UNI") { return "UNI".into(); }
    if f.scanning_seq.contains("IR") && itype.iter().any(|s| s == "M") {
        if desc.contains("inv1") { return "INV1".into(); }
        if desc.contains("inv2") { return "INV2".into(); }
        return "INV2".into();
    }
    "(ignore)".into()
}

/// An assembled DICOM series as a volume (i-fastest flat) + RAS affine.
pub struct Series {
    pub data: Vec<f32>, // len = nx*ny*nz*nt, index i + nx*(j + ny*(k + nz*t))
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    pub nt: usize,
    pub affine: [[f64; 4]; 4],
    pub role: String,
    pub rep: DicomFile,
}

/// Assemble slices (one series) into a volume, sorting by position along the
/// slice normal and separating volumes by echo (SA2RAGE has 2). Builds an RAS
/// affine (LPS negated in x,y, matching nibabel/dcm2niix conventions).
pub fn assemble(files: Vec<DicomFile>) -> Result<Series, String> {
    if files.is_empty() { return Err("empty series".into()); }
    let f0 = &files[0];
    let (nx, ny) = (f0.cols, f0.rows);
    let row = [f0.iop[0], f0.iop[1], f0.iop[2]];
    let col = [f0.iop[3], f0.iop[4], f0.iop[5]];
    let normal = cross(row, col);
    let proj = |f: &DicomFile| f.ipp[0] * normal[0] + f.ipp[1] * normal[1] + f.ipp[2] * normal[2];

    // group by position (rounded projection along the normal)
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<i64, Vec<DicomFile>> = BTreeMap::new();
    for f in files {
        let key = (proj(&f) * 1000.0).round() as i64;
        groups.entry(key).or_default().push(f);
    }
    let nz = groups.len();
    let mut nt = 0usize;
    for g in groups.values() { nt = nt.max(g.len()); }
    let mut data = vec![0f32; nx * ny * nz * nt];
    let rep = groups.values().next().unwrap()[0].clone();
    let mut ipp0 = rep.ipp;
    let mut projs: Vec<f64> = Vec::new();
    for (k, (_, grp)) in groups.iter_mut().enumerate() {
        grp.sort_by(|a, b| a.echo.cmp(&b.echo).then(a.acquisition.cmp(&b.acquisition)).then(a.instance.cmp(&b.instance)));
        if k == 0 { ipp0 = grp[0].ipp; }
        projs.push(grp[0].ipp[0] * normal[0] + grp[0].ipp[1] * normal[1] + grp[0].ipp[2] * normal[2]);
        for (t, f) in grp.iter().enumerate() {
            let base = nx * ny * (k + nz * t);
            for j in 0..ny {
                for i in 0..nx {
                    data[base + i + nx * j] = f.pixels[j * nx + i] as f32;
                }
            }
        }
    }
    let slice_sp = if nz > 1 { (projs[nz - 1] - projs[0]) / (nz as f64 - 1.0) } else { rep.slice_thickness.max(1.0) };
    let cs = rep.pixel_spacing[1]; // column spacing (along row dir / i)
    let rs = rep.pixel_spacing[0]; // row spacing (along col dir / j)
    // LPS affine columns: i->row_cosines*cs, j->col_cosines*rs, k->normal*slice_sp
    let mut a = [
        [row[0] * cs, col[0] * rs, normal[0] * slice_sp, ipp0[0]],
        [row[1] * cs, col[1] * rs, normal[1] * slice_sp, ipp0[1]],
        [row[2] * cs, col[2] * rs, normal[2] * slice_sp, ipp0[2]],
        [0.0, 0.0, 0.0, 1.0],
    ];
    // LPS -> RAS: negate x and y rows
    for c in 0..4 { a[0][c] = -a[0][c]; a[1][c] = -a[1][c]; }
    let role = classify(&rep);
    Ok(Series { data, nx, ny, nz, nt, affine: a, role, rep })
}

