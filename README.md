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

```bash
git clone https://github.com/YOUR-USERNAME/forge-shelf.git
cd forge-shelf
cp .env.example .env
```

Edit `.env` — at minimum set `POSTGRES_PASSWORD` and `APP_SECRET`:

```bash
openssl rand -hex 32
```

Then bring it up:

```bash
docker compose up -d --build
```

The first build downloads OrcaSlicer, PrusaSlicer and UVtools, so expect it to take
a while and produce a ~2.5 GB image. Open <http://localhost:8770>.

For a small, fast image without slicing (catalogue plus sending pre-sliced files):

```bash
docker compose build --build-arg INSTALL_SLICERS=false
```

### Updating

```bash
./scripts/deploy.sh
```

Pulls, rebuilds, restarts, and waits for the health endpoint. That's the whole
deploy loop.

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

**Filament profiles** are OrcaSlicer JSON, split into machine / process / filament.
The reliable way to build one: set the print up in OrcaSlicer, export those three
presets, and paste them into a profile.

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

**Slicer release URLs move.** The Dockerfile pins specific AppImage releases and
*warns instead of failing* when one 404s, because a dead URL shouldn't block a
catalogue-only deploy. The System page tells you what's actually installed.

**There is no authentication.** Anyone who can reach the port has full control of
your library and your printers. Put it behind a reverse proxy with auth, or keep it
on a trusted network.

**Mesh stats are best-effort.** STL, 3MF and OBJ are parsed for triangles, bounding
box and volume. STEP, SCAD and native CAD formats catalogue fine but report no
statistics, and volume is only meaningful for a closed mesh.
