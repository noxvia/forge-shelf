# Forge Shelf

A self-hosted catalogue for 3D print files. Import models, view them in the browser,
keep track of what you've printed — and slice and send jobs to your printers without
leaving the app.

Supports **Bambu Lab printers in LAN mode** (filament) and **Elegoo / Anycubic resin
printers speaking SDCP**.

---

## What it does

**Catalogue.** Drag STL, 3MF, OBJ, sliced files, reference images and notes into a
model. Files stream straight to disk, so a 500 MB mesh uploads without eating RAM.
Triangle count, bounding box and volume are computed on upload.

**View.** A three.js viewer with orbit, wireframe and a build-plate grid. The same
viewer generates library thumbnails — one click captures the current view, which
avoids shipping a headless GL stack in the container.

**Organise.** Tags, favourites, full-text search across names, designers, filenames
and tags, and a "print-ready" filter for models that already have machine files.

**Slice.** In-app, in the background:

| Technology | Pipeline |
|---|---|
| Filament | OrcaSlicer CLI → `.gcode.3mf` |
| Resin | PrusaSlicer SLA CLI → `.sl1` → UVtools → `.ctb` / `.goo` |

**Print.** Upload and start a job on a real printer, then watch layer progress, ETA
and temperatures. Pause, resume and stop from the jobs page.

---

## Quick start

Either way, start here:

```bash
git clone https://github.com/YOUR-USERNAME/forge-shelf.git
cd forge-shelf
cp .env.example .env
```

Edit `.env` — at minimum set `POSTGRES_PASSWORD` and `APP_SECRET`:

```bash
openssl rand -hex 32
```

### Option A — pull a prebuilt image (recommended)

GitHub Actions builds and publishes to GHCR on every push to `main`. The host just
pulls; no slicer downloads, no build.

Set `IMAGE` in `.env`:

```bash
IMAGE=ghcr.io/YOUR-USERNAME/YOUR-REPO:latest
```

Then:

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

Two tags are published:

| Tag | Contents | Platforms |
|---|---|---|
| `latest` | Full — includes OrcaSlicer, PrusaSlicer, UVtools (~2.5 GB) | `amd64` |
| `slim` | No slicers; catalogue and send pre-sliced files (~400 MB) | `amd64`, `arm64` |

`latest` is amd64 only because all three slicers ship exclusively as x86_64
AppImages — there is nothing to install on arm64. Raspberry Pi and Apple Silicon
hosts want `slim`.

> **No login needed.** Packages published by Actions inherit the repository's
> visibility, so on a public repo the image pulls anonymously — verified against
> the live registry. If you later make the repo private the package follows it,
> and hosts will then need `docker login ghcr.io` with a token carrying
> `read:packages`.

### Option A2 — one file, no checkout

If you'd rather not clone anything on the server:

```bash
curl -O https://raw.githubusercontent.com/noxvia/forge-shelf/main/docker-compose.standalone.yml
```

Edit the three `CHANGEME` values, then:

```bash
docker compose -f docker-compose.standalone.yml up -d
```

Credentials live in that file instead of a `.env`, so keep it `chmod 600`. Data
goes to named Docker volumes rather than a bind mount — the file header has the
backup command.

### Option B — build from source on the host

```bash
docker compose up -d --build
```

The first build downloads the slicers, so expect it to take a while. For a small,
fast image without slicing:

```bash
docker compose build --build-arg INSTALL_SLICERS=false
```

Open <http://localhost:8770>.

### Updating

```bash
./scripts/deploy.sh          # option B: git pull, rebuild, restart
./scripts/deploy.sh --pull   # option A: git pull, pull image, restart
```

Both wait for the health endpoint and dump logs if it doesn't come up.

---

## Setting up printers

Add printers by IP on the **Printers** page. **Scan network** also works, but only
when discovery traffic can reach your LAN — see [networking](#networking).

### Bambu Lab

Needs three things from the printer itself:

1. **LAN Only Mode** enabled — *Settings → Network*
2. **Serial number** — *Settings → Device*. This addresses the MQTT topics; without
   it nothing works.
3. **LAN Access Code** — *Settings → Network*. Stored AES-256-GCM encrypted under
   `APP_SECRET` and never sent back to the browser.

Under the hood: MQTT over TLS on 8883 for commands and status, implicit FTPS on 990
to upload the `.gcode.3mf`.

### Resin (SDCP)

Only needs an IP address. Network discovery fills in the mainboard ID automatically;
otherwise copy it from the printer's network info screen.

Confirmed protocol on the Mars 4 / Saturn 4 generation and several Anycubic ChiTu
boards. Older Mars 3 and Photon hardware predates SDCP and will not respond.

> **SDCP has no authentication.** Anything on the network can drive these printers.
> That is the protocol's design, not a gap in this app — keep resin printers on a
> network you trust.

---

## Slicer profiles

Two seeded starting points ship in the box: a Bambu X1C filament profile and 50 µm
resin profiles for the Mars 4 Ultra and Saturn 4 Ultra. Treat them as starting
points, not tuned settings.

**Filament profiles** name OrcaSlicer presets — `Bambu Lab X1 Carbon 0.4 nozzle`,
`0.20mm Standard @BBL X1C`, `Bambu PLA Basic @BBL X1C` — exactly as they appear in
OrcaSlicer. The adapter hands Orca its own bundled vendor files, whose inherit
chains resolve correctly.

A stub that merely `inherits` a preset by name does *not* work: Orca loads it and
then rejects the combination with "The selected printer is not compatible with
the process preset", because compatibility is matched on printer identity the
stub doesn't carry. To customise, export a complete preset from the OrcaSlicer
GUI and paste that JSON in — the adapter accepts a preset name or full JSON.

### Resin: what's automated and what isn't

| | |
|---|---|
| Auto support points and trees | ✅ pillar or branching |
| Pad / raft, elephant-foot compensation | ✅ |
| Hollowing with wall thickness | ✅ per model |
| Orientation (tilt X/Y), scale | ✅ per model |
| Exposure and layer height | ✅ per model |
| **Drain holes** | ❌ **PrusaSlicer can only place these in its GUI** |
| Manual support placement / enforcers | ❌ GUI-only |
| Auto-orientation | ❌ doesn't exist for SLA |

Profiles set the baseline; the **Resin options** panel on a model overrides any of
it for that one slice, so hollowing a single miniature doesn't mean cloning a
profile. Untouched controls inherit from the profile rather than forcing a default.

> **Hollowing without drain holes traps uncured resin.** A sealed shell can
> suction against the FEP and burst. The app warns when you enable it. Add drain
> holes in a mesh editor (Blender, Lychee, ChiTuBox) before uploading, or print
> solid.

**Resin profiles** are PrusaSlicer INI in SLA mode. Display resolution, panel
dimensions and exposure times all live in the machine config — PrusaSlicer has no
vendor presets for Elegoo or Anycubic hardware, so every value has to be explicit.
UVtools then converts the `.sl1` to your printer's format, carrying exposure settings
across verbatim. If prints come out over- or under-exposed, that's the profile.

Check the **System** page to confirm which slicer binaries actually made it into
your image.

---

## Networking

Direct connections to printers by IP work fine in the default bridge network.

Automatic **discovery** does not — it uses UDP broadcast and SSDP multicast, neither
of which crosses Docker's bridge. If you want the scan button to work, on a Linux
host:

```bash
# point DATABASE_URL at 127.0.0.1 in .env first
docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d
```

Adding printers by IP always works and needs none of this.

---

## Architecture

```
web     Next.js 14 App Router — UI and REST API
worker  long-running Node process: runs slices, dispatches
        prints, polls printer status
db      Postgres 16
./data  models, thumbnails and slice output (bind mount)
```

Queueing is done in Postgres rather than Redis. The volumes here are a handful of
tasks a day, and one fewer moving part is worth more than throughput. Slices and
print dispatch are claimed atomically, so the worker can be restarted mid-queue
without double-running anything; tasks interrupted by a restart are failed
explicitly rather than left hanging.

### Local development

```bash
docker compose -f docker-compose.dev.yml up -d   # just Postgres
npm install
npx prisma db push
npm run dev          # web, on :3000
npm run dev:worker   # worker, separate terminal
```

Slicing in dev needs the binaries on your machine; point `ORCA_BIN`, `PRUSA_BIN` and
`UVTOOLS_BIN` at them, or skip it and work on the catalogue.

Schema changes are applied with `prisma db push` rather than a migration history —
appropriate for a single-tenant self-hosted app, and it refuses to run rather than
destroy data if a change would be lossy.

---

## Honest limitations

**The printer protocols are reverse-engineered.** Neither Bambu's LAN API nor SDCP is
a supported public interface. Both work today across the hardware they were built
against; a firmware update can break either without warning. The Bambu print command
in particular carries a URL scheme that varies by model and firmware — if a print
uploads but won't start, that constant in `src/lib/printers/bambu.ts` is the first
thing to change, and the alternatives are listed in a comment right there.

**Slicer release URLs move, and this already bit once.** The first published
image contained no working slicers at all: two pinned AppImage URLs had 404'd and
the build only warned, so a 3 GB image shipped that silently could not slice.
The build now *fails* when `INSTALL_SLICERS=true` and any binary is missing, and
verifies each one is executable before the image is tagged. If a build goes red
on a download step, override the matching `*_URL` build arg.

**PrusaSlicer comes from Debian, not upstream.** Prusa no longer publishes Linux
AppImages on GitHub, so the SLA path uses Debian's `prusa-slicer` package
(2.9.2 on trixie). The seeded resin profiles deliberately omit
`sla_archive_format`: SL1 is the default output and UVtools converts from there
regardless.

**The image is built on Debian trixie, not bookworm.** OrcaSlicer 2.4.2 is
compiled against Ubuntu 24.04 and needs glibc 2.38+; bookworm's 2.36 makes the
binary refuse to start. Trixie's 2.41 runs it and brings a much newer
PrusaSlicer along with it.

**There is no authentication.** Anyone who can reach the port has full control of
your library and your printers. Put it behind a reverse proxy with auth, or keep it
on a trusted network.

**Mesh stats are best-effort.** STL, 3MF and OBJ are parsed for triangles, bounding
box and volume. STEP, SCAD and native CAD formats catalogue fine but report no
statistics, and volume is only meaningful for a closed mesh.
