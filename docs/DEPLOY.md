# Deploying the web app

The app is a static, 100%-client-side site (Rust core compiled to WebAssembly).
It's published to **GitHub Pages** by the `Deploy to GitHub Pages` Action, which
builds the WASM and uploads `web/`. Single-threaded + SIMD, so **no COOP/COEP
headers are needed** — it runs on plain GitHub Pages.

## One-time setup (you — needs the GitHub UI)

1. **Push** these files to `main` (includes `.github/workflows/deploy-pages.yml`).
2. In the repo, go to **Settings → Pages → Build and deployment** and set
   **Source = "GitHub Actions"**. (That's the only click; you do *not* pick a branch.)
3. The push in step 1 triggers the deploy. To run it by hand instead: **Actions**
   tab → **Deploy to GitHub Pages** → **Run workflow**.

Your site will be at:

```
https://thomshaw92.github.io/Easy-MP2RAGE-T1-Map/
```

Every later push to `main` re-deploys automatically. `CI` (tests + WASM build +
the headless data-path check) runs on every push/PR.

## How the deploy works

`build` job: install Rust + `wasm-pack` → `tools/build_wasm.sh` (builds the WASM
into `web/wasm/`) → upload `web/` as the Pages artifact. `deploy` job publishes it.
All asset paths are relative, so the `/Easy-MP2RAGE-T1-Map/` project-site base path
works with no extra config.

## NeuroDesk subdomain + listing (you — needs NeuroDesk maintainers)

To get a `easy-mp2rage-t1map.neurodesk.org`-style URL and a spot on the NeuroDesk
applications page (like qsmbly.neurodesk.org):

1. Confirm the GitHub Pages site above is live and working.
2. Open an **issue / discussion / PR** on the NeuroDesk web repo
   (start at <https://www.neurodesk.org/> → GitHub) requesting a **subdomain +
   applications-page listing**, and give them the Pages URL. They arrange a DNS
   **CNAME** (`easy-mp2rage-t1map.neurodesk.org → thomshaw92.github.io`).
3. Once the CNAME exists, add a file `web/CNAME` containing just the domain
   (e.g. `easy-mp2rage-t1map.neurodesk.org`) and push — the deploy will serve it
   there — then tick **Enforce HTTPS** in Settings → Pages. (Ping me and I'll add
   the `web/CNAME` file once you have the domain.)

Deploying to `<owner>.github.io` first (fully functional) and adding the subdomain
later is the recommended order — don't block launch on the subdomain.

## Notes

- No runtime CDN dependencies (CSP-safe); the viewer is a self-contained canvas.
- Nothing about the deploy changes the privacy model — all image processing still
  happens in the visitor's browser; the static host never sees any data.
