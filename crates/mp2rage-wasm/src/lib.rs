//! WebAssembly bindings for the MP2RAGE T1-mapping core.
//!
//! The browser (NiiVue) parses NIfTI/DICOM in JS and hands the core flat
//! `Float32Array`s in on-disk NIfTI order (first index fastest). We rebuild
//! `ndarray` volumes, run the shared `mp2rage_core::pipeline`, and return flat
//! arrays. The heavy work runs in a Web Worker so the UI stays responsive.
//!
//! Volume layout (all flat arrays): index = i + nx*(j + ny*k); a 4D SA2RAGE
//! image stacks the two volumes with t slowest (t*nx*ny*nz + ...).

use ndarray::Array3;
use wasm_bindgen::prelude::*;

use mp2rage_core::dicom;
use mp2rage_core::model::{Mp2rageParams, Sa2rageParams};
use mp2rage_core::pipeline::{run_b1map, run_sa2rage};
use mp2rage_core::Affine;

fn arr3(data: &[f32], nx: usize, ny: usize, nz: usize) -> Array3<f64> {
    Array3::from_shape_fn((nx, ny, nz), |(i, j, k)| data[i + nx * (j + ny * k)] as f64)
}
fn arr3_component(data: &[f32], nx: usize, ny: usize, nz: usize, t: usize) -> Array3<f64> {
    let plane = nx * ny * nz;
    Array3::from_shape_fn((nx, ny, nz), |(i, j, k)| data[t * plane + i + nx * (j + ny * k)] as f64)
}
fn flat_ifast(a: &Array3<f64>) -> Vec<f32> {
    let (nx, ny, nz) = a.dim();
    let mut v = vec![0f32; nx * ny * nz];
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                v[i + nx * (j + ny * k)] = a[[i, j, k]] as f32;
            }
        }
    }
    v
}
fn aff(a: &[f32]) -> Affine {
    let mut m = [[0f64; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            m[r][c] = a[r * 4 + c] as f64;
        }
    }
    m
}
fn mp_params(p: &[f64]) -> Mp2rageParams {
    Mp2rageParams { tr: p[0], tis: (p[1], p[2]), flip: (p[3], p[4]), nz: (p[5], p[6]), flash_tr: p[7], inv_eff: p[8] }
}
fn sa_params(p: &[f64]) -> Sa2rageParams {
    Sa2rageParams { tr: p[0], tis: (p[1], p[2]), flip: (p[3], p[4]), nz: (p[5], p[6]), flash_tr: p[7], average_t1: p[8] }
}

/// Result of a correction — flat volumes (i fastest) in the MP2RAGE grid.
#[wasm_bindgen]
pub struct T1Result {
    t1: Vec<f32>,
    b1: Vec<f32>,
    uni_corr: Vec<f32>,
    t1_uncorr: Vec<f32>,
    dims: Vec<u32>,
}

#[wasm_bindgen]
impl T1Result {
    /// B1-corrected T1 (ms).
    #[wasm_bindgen(getter)]
    pub fn t1(&self) -> Vec<f32> {
        self.t1.clone()
    }
    /// Relative B1 map on the MP2RAGE grid.
    #[wasm_bindgen(getter)]
    pub fn b1(&self) -> Vec<f32> {
        self.b1.clone()
    }
    /// B1-corrected UNI (0..4095).
    #[wasm_bindgen(getter)]
    pub fn uni_corr(&self) -> Vec<f32> {
        self.uni_corr.clone()
    }
    /// Uncorrected T1 (ms).
    #[wasm_bindgen(getter)]
    pub fn t1_uncorr(&self) -> Vec<f32> {
        self.t1_uncorr.clone()
    }
    /// Output dims [nx, ny, nz].
    #[wasm_bindgen(getter)]
    pub fn dims(&self) -> Vec<u32> {
        self.dims.clone()
    }
}

/// B1-corrected T1 from MP2RAGE UNI + INV2 + SA2RAGE (2-volume) source.
///
/// `dims`/`sa_dims` are `[nx,ny,nz]`; affines are row-major 4x4 (len 16);
/// `mp` = [TR,TI1,TI2,FA1,FA2,NZ1,NZ2,TRFLASH,invEff];
/// `sa` params = [TR,TI1,TI2,FA1,FA2,NZ1,NZ2,TRFLASH,avgT1].
#[wasm_bindgen]
pub fn t1map_sa2rage(
    uni: &[f32],
    inv2: &[f32],
    sa: &[f32],
    dims: &[u32],
    uni_aff: &[f32],
    sa_dims: &[u32],
    sa_aff: &[f32],
    mp: &[f64],
    sa_p: &[f64],
) -> T1Result {
    let (nx, ny, nz) = (dims[0] as usize, dims[1] as usize, dims[2] as usize);
    let (sx, sy, sz) = (sa_dims[0] as usize, sa_dims[1] as usize, sa_dims[2] as usize);
    let out = run_sa2rage(
        &arr3(uni, nx, ny, nz),
        &arr3(inv2, nx, ny, nz),
        &arr3_component(sa, sx, sy, sz, 0),
        &arr3_component(sa, sx, sy, sz, 1),
        &aff(uni_aff),
        &aff(sa_aff),
        &mp_params(mp),
        &sa_params(sa_p),
    );
    T1Result {
        t1: flat_ifast(&out.t1_corr),
        b1: flat_ifast(&out.b1),
        uni_corr: flat_ifast(&out.uni_corr),
        t1_uncorr: flat_ifast(&out.t1_uncorr),
        dims: vec![nx as u32, ny as u32, nz as u32],
    }
}

/// B1-corrected T1 from MP2RAGE UNI + INV2 + a generic B1 map.
/// `kind`: 0 = tfl (flip x10), 1 = percent, 2 = relative.
#[wasm_bindgen]
pub fn t1map_b1(
    uni: &[f32],
    inv2: &[f32],
    b1_map: &[f32],
    dims: &[u32],
    uni_aff: &[f32],
    b1_dims: &[u32],
    b1_aff: &[f32],
    kind: u32,
    ref_angle: f64,
    mp: &[f64],
) -> T1Result {
    let (nx, ny, nz) = (dims[0] as usize, dims[1] as usize, dims[2] as usize);
    let (bx, by, bz) = (b1_dims[0] as usize, b1_dims[1] as usize, b1_dims[2] as usize);
    let kind_s = match kind {
        1 => "percent",
        2 => "relative",
        _ => "tfl",
    };
    let out = run_b1map(
        &arr3(uni, nx, ny, nz),
        &arr3(inv2, nx, ny, nz),
        &arr3(b1_map, bx, by, bz),
        &aff(uni_aff),
        &aff(b1_aff),
        kind_s,
        ref_angle,
        &mp_params(mp),
    );
    T1Result {
        t1: flat_ifast(&out.t1_corr),
        b1: flat_ifast(&out.b1),
        uni_corr: flat_ifast(&out.uni_corr),
        t1_uncorr: flat_ifast(&out.t1_uncorr),
        dims: vec![nx as u32, ny as u32, nz as u32],
    }
}

/// A DICOM series parsed into a volume + geometry + detected role + params.
#[wasm_bindgen]
pub struct DicomVolume {
    data: Vec<f32>,   // i-fastest, length nx*ny*nz*nt
    dims: Vec<u32>,   // [nx, ny, nz, nt]
    affine: Vec<f32>, // row-major 4x4 (RAS)
    role: String,
    params: Vec<f64>, // MP2RAGE [TR,TI1,TI2,FA1,FA2,NZ1,NZ2] or empty
}

#[wasm_bindgen]
impl DicomVolume {
    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<f32> { self.data.clone() }
    #[wasm_bindgen(getter)]
    pub fn dims(&self) -> Vec<u32> { self.dims.clone() }
    #[wasm_bindgen(getter)]
    pub fn affine(&self) -> Vec<f32> { self.affine.clone() }
    #[wasm_bindgen(getter)]
    pub fn role(&self) -> String { self.role.clone() }
    #[wasm_bindgen(getter)]
    pub fn params(&self) -> Vec<f64> { self.params.clone() }
}

/// Parse one DICOM series given all its files concatenated, with `offsets`
/// delimiting each file (length = nfiles + 1, byte offsets into `concat`).
#[wasm_bindgen]
pub fn parse_dicom_series(concat: &[u8], offsets: &[u32]) -> Result<DicomVolume, JsValue> {
    let mut files = Vec::new();
    for w in offsets.windows(2) {
        let (s, e) = (w[0] as usize, w[1] as usize);
        if e <= concat.len() && s < e {
            if let Ok(df) = dicom::parse(&concat[s..e]) {
                files.push(df);
            }
        }
    }
    if files.is_empty() {
        return Err(JsValue::from_str("no readable (uncompressed) DICOM files in this folder"));
    }
    let params = dicom::mp2rage_params(&files[0]).unwrap_or_default();
    let s = dicom::assemble(files).map_err(|e| JsValue::from_str(&e))?;
    let mut affine = Vec::with_capacity(16);
    for r in 0..4 {
        for c in 0..4 {
            affine.push(s.affine[r][c] as f32);
        }
    }
    Ok(DicomVolume {
        data: s.data,
        dims: vec![s.nx as u32, s.ny as u32, s.nz as u32, s.nt as u32],
        affine,
        role: s.role,
        params,
    })
}

/// Library version string (for the UI footer / provenance).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
