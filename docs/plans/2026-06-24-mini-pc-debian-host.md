# Mini PC → Debian 13 headless Node.js host

## Context

A mini PC (Intel Atom **x5-Z8350** / Cherry Trail, **2 GB RAM**, **32 GB eMMC**) currently runs Windows 10 Home 32-bit. Windows alone saturates the 2 GB RAM at idle, leaving nothing for workloads. Goal: repurpose the box as an always-on headless server hosting `mountain-project` (Node.js) plus future Node.js projects, reachable from the internet.

Decisions locked with the user:
- **Distro:** Debian 13 (trixie) minimal, terminal-only (no desktop).
- **Disk:** wipe Windows entirely.
- **Exposure:** reachable from the internet → needs firewall + reverse proxy + HTTPS + SSH hardening.

### Hardware reality (drives the whole plan)
- CPU is **64-bit capable**, but Cherry Trail firmware is **32-bit UEFI only** (no legacy BIOS). A stock 64-bit installer USB will **not boot** without a `bootia32.efi` shim.
- Must still run a **64-bit OS** — modern Node.js ships no 32-bit Linux binaries. CPU supports it; only the bootloader needs the 32-bit shim.
- Onboard **wifi is SDIO (Broadcom/Realtek)** → unreliable on Linux. **Use ethernet, ignore wifi.**
- Cherry Trail can hang on deep C-states → fallback kernel param `intel_idle.max_cstate=1`.

### Resource budget (why it fits)
Debian headless idle ~150 MB + Caddy ~15 MB + Node app ~50–150 MB + Postgres ~80–150 MB. With **zram** (compressed RAM swap) this lives comfortably in 2 GB. The one real risk is heavy `npm install`/build steps OOM-ing → build off-box (see Phase 7).

### Database & app fit (verified against the code)
Inspected `db.ts`, `server.ts`, `agent/search-query.ts`, the import scripts, and `CLAUDE.md`:
- **Stack:** Fastify v5 + `pg` Pool → PostgreSQL + PostGIS. DB `mountain_db`, user `mountain_worker`, **port 5433** in `.env`; server on `:3000`.
- **Schema:** `pois` (Point), `trails` (LineString), `via_ferrata` (LineString), `admin_areas` ((Multi)Polygon), `ai_description_cache` (JSONB, 48h TTL). All **SRID 4326**, GIST-indexed geom.
- **Dataset is tiny:** source GeoJSON ~1 MB POIs + ~1 MB ferrata; real DB = tens of MB, low-hundreds even if grown to the whole Alps. **Fits entirely in RAM page cache → fast.**
- **Queries are light + indexed:** bbox `ST_Intersects(geom, ST_MakeEnvelope(...))`, point-in-polygon `ST_Intersects` vs `admin_areas`, `ST_AsGeoJSON`, `ST_Centroid/ST_Collect`. **No raster, no pgRouting, no topology, no heavy Buffer/Union.** Route-finding is client-side Dijkstra in a web worker — not the DB.
- **Single user;** writes happen only during one-off import scripts, not the request path → **eMMC wear negligible**.
- **Runtime is light:** scraping via Cheerio + native HTTP (Playwright is tests-only, no headless browser at runtime); AI uses **external** APIs (Groq/Gemini/OpenRouter), no local LLM. Prod deps are pure-JS (`pg`, `cheerio`) → **no node-gyp/native compile** on the box.

**Conclusion:** PostgreSQL + PostGIS run comfortably here, growth included. The real load is the **build/test toolchain** (Vite 8, Vitest, Playwright, tsc) → keep it OFF the box (Phase 7).

---

## Immediate target: `npm run dev` on the box (LAN-only)
First goal is just the project running in **dev mode** — Vite on `:5173` + Fastify on `:3000` — reachable privately, no internet exposure.
- Do **Phases 0–6**, with two tweaks for dev: in Phase 4 bump `zram-size = ram * 0.9` and the swapfile to `2G` (dev is RAM-hungry); in Phase 5 run a **full** `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` (dev needs `vite`/`tsx`), **not** `--omit=dev`, and skip the systemd unit.
- Then `npm run dev` on the box. View from the laptop via SSH tunnel: `ssh -L 5173:localhost:5173 -L 3000:localhost:3000 dani@<box-ip>` → open `http://localhost:5173`.
- **Skip Phases 7–8** (production build + remote exposure) for now.
- ⚠️ 2 GB is tight for dev mode (two Node procs + Postgres); zram makes it fit, first Vite compile is slow. If it crawls, move to the lighter production path (Phase 7: build off-box → `node dist/server.js`).

---

## Phase 0 — Pre-flight
- Back up anything wanted off the box; install **wipes the disk**. Windows product key not needed (abandoning it).
- Plug in **ethernet**. Have a monitor + USB keyboard for the install step only (headless after).

## Phase 1 — Build install media (on another PC)
- Download the Debian 13 netinst — firmware is **built into the standard image** since Debian 12 (no special "firmware" ISO anymore): `debian-13.5.0-amd64-netinst.iso` from `cdimage.debian.org/debian-cd/current/amd64/iso-cd/`.
- Flash to USB with **Rufus** (ISO mode) or balenaEtcher.
- **Add the 32-bit shim:** obtain `bootia32.efi` (32-bit GRUB) — e.g. `grubia32.efi` extracted from a Debian **i386** netinst `EFI/boot/`, or a prebuilt one — and copy it to the USB at **`EFI/BOOT/bootia32.efi`**. This is what lets the 32-bit firmware launch the 64-bit installer.

## Phase 2 — Firmware setup
- Boot into firmware (usually `Esc` / `Del` / `F2` at power-on).
- **Disable Secure Boot.** Set USB as first boot device. Save & exit.

## Phase 3 — Install Debian (minimal, headless target)
- Boot USB → GRUB (via bootia32) → installer. Pick standard text install.
- Locale/keyboard → network: **ethernet, DHCP**.
- Hostname e.g. `mountainpi`, domain blank. Set root password + create non-root user.
- **Partitioning:** Guided → **use entire disk** (wipes Windows). Target the eMMC (`/dev/mmcblk0`). Layout: small EFI System Partition (FAT32) + single **ext4** root. No big swap partition (zram handles it).
- **tasksel — critical:** uncheck everything **except** `SSH server` and `standard system utilities`. **No desktop environment.** This is what keeps it terminal-only and tiny.
- GRUB: install to disk. Under 32-bit UEFI the installer auto-selects `grub-efi-ia32` — confirm it proceeds (this is the expected path, not an error).
- Reboot, remove USB.

## Phase 4 — Base config (now over SSH)
- Get the IP from the router (or the console), then from laptop: `ssh user@<ip>`.
- `sudo apt update && sudo apt full-upgrade`.
- **Stable address:** set a DHCP reservation on the router for the box's MAC (needed for port-forwarding later).
- **eMMC longevity:** add `noatime` to the root mount in `/etc/fstab`.
- **zram** (big win on 2 GB):
  ```
  sudo apt install systemd-zram-generator
  # /etc/systemd/zram-generator.conf
  [zram0]
  zram-size = ram * 0.75
  compression-algorithm = zstd
  ```
- **Small disk swap fallback** + low swappiness:
  ```
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile   # add to /etc/fstab
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
  ```
- If random freezes: add `intel_idle.max_cstate=1` to `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, then `sudo update-grub`.
- Auto security updates: `sudo apt install unattended-upgrades`.

## Phase 5 — SSH hardening (internet-exposed)
- From laptop: `ssh-keygen` (if none) → `ssh-copy-id user@<ip>`. Confirm key login works **before** disabling passwords.
- `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers <user>` (optional non-default `Port`). `sudo systemctl restart ssh` — keep current session open and test a new one to avoid lockout.
- `sudo apt install fail2ban` (default jail protects SSH).

## Phase 6 — PostgreSQL + PostGIS
- Install (Debian 13 main ships PostgreSQL 17; PGDG repo also available if you need a specific major to match dev):
  ```
  sudo apt install -y postgresql-17 postgresql-17-postgis-3
  ```
- Create role + db + extension:
  ```
  sudo -u postgres psql -c "CREATE ROLE mountain_worker LOGIN PASSWORD 'mountain_secret_123';"
  sudo -u postgres createdb -O mountain_worker mountain_db
  sudo -u postgres psql -d mountain_db -c "CREATE EXTENSION IF NOT EXISTS postgis;"
  ```
- **Port:** `.env` expects **5433**. Either set `port = 5433` in `/etc/postgresql/17/main/postgresql.conf`, or simpler set `DB_PORT=5432` in `.env`. Keep `.env` and cluster in sync.
- **Light tuning** (tiny DB fits in cache — this is mostly about not over-reserving RAM). In `postgresql.conf`:
  ```
  shared_buffers = 256MB
  effective_cache_size = 768MB
  work_mem = 8MB
  maintenance_work_mem = 96MB
  max_connections = 20
  random_page_cost = 1.2          # flash storage
  jit = off
  max_parallel_workers_per_gather = 1
  wal_compression = on
  synchronous_commit = off        # optional: faster writes on eMMC, risks last txn on power-loss
  ```
  PgBouncer not needed (single user) — just keep the `pg` pool small. `sudo systemctl restart postgresql`.
- **Load data (one-time):** the import scripts run via `tsx` (a dev tool) — install it once on the box (`sudo npm i -g tsx`), then `npm run migrate:ai`, `migrate:search`, `import:areas`, `import:pois` (loads the committed `public/data` GeoJSON; `fetch:data` first only to refresh), `fetch:trails`, `import:ferrata`, `backfill:elevation`. Overpass-bound, data tiny.
- Confirm GIST indexes exist on `pois.geom` and `trails.geom` (scripts create them for `via_ferrata` + `admin_areas`; verify pois/trails). Trivial at this size, cheap insurance.

## Phase 7 — Build off-box, deploy mountain-project
- **On the laptop** (NOT the 2 GB box — Vite 8 + Vitest + Playwright + tsc are too heavy): `npm ci`, `npm run typecheck`, `npm run test`, `npm run build` (→ `dist/server.js` + `dist/public`).
- **On the box:** install Node 22 LTS, then ship + install prod deps only:
  ```
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git
  # copy from laptop: dist/, public/, package.json, package-lock.json, ai-agent-conf/, scripts/, db.ts, .env (DB creds + AI keys)
  npm ci --omit=dev      # fastify, @fastify/static, pg, cheerio, dompurify, dotenv, @google/generative-ai — all pure-JS
  ```
- App binds to **`127.0.0.1:3000`** (only the proxy/tailnet reaches it). systemd unit `/etc/systemd/system/mountain-project.service`:
  ```
  [Unit]
  After=network.target postgresql.service
  Wants=postgresql.service
  [Service]
  WorkingDirectory=/home/<user>/mountain-project
  EnvironmentFile=/home/<user>/mountain-project/.env
  ExecStart=/usr/bin/node dist/server.js
  Restart=always
  User=<user>
  Environment=NODE_ENV=production
  [Install]
  WantedBy=multi-user.target
  ```
  `sudo systemctl enable --now mountain-project`.
- **`.env` keys needed:** `DB_*` (point at local PG), `GROQ_API_KEY` (required), optional `GEMINI_API_KEY` / `OPENROUTER_API_KEY` / `YOUTUBE_API_KEY` / `REDDIT_*`.
- **Future projects:** one systemd unit each on its own localhost port; Caddy/Tailscale routes to them.

## Phase 8 — Remote access (auth is mandatory here)
⚠️ **The app has no authentication and its AI endpoints cost quota** (`/api/ai/research`, `/api/search/smart` call Groq/Gemini/OpenRouter). Wide-open public exposure = anyone can drain your LLM credits. Pick one:

**Option A — Tailscale (recommended for a personal tool):**
- `curl -fsSL https://tailscale.com/install.sh | sh` on the box + your phone/laptop. Reach it privately over the tailnet (e.g. `http://mountainpi:3000` via MagicDNS). **No port-forward, no public exposure, encrypted.** Skip DuckDNS/Caddy/port-forward entirely.

**Option B — Public on the internet (only if you truly need open access):**
- **Dynamic DNS:** free **DuckDNS** subdomain + a systemd timer updating your home IP.
- **Router:** port-forward `80` + `443` → the box's reserved LAN IP.
- **Caddy** (auto Let's Encrypt TLS) **+ basic_auth** so randoms can't hit the AI routes:
  ```
  yourname.duckdns.org {
      basic_auth { you <bcrypt-hash> }   # generate with: caddy hash-password
      reverse_proxy localhost:3000
  }
  ```
  Add a block/subdomain per future app.
- **ufw** firewall:
  ```
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow <ssh-port>/tcp
  sudo ufw allow 80,443/tcp
  sudo ufw enable
  ```
  App port `3000` stays localhost-only (not allowed in ufw). Keep `unattended-upgrades` + `fail2ban` from earlier phases.

## Critical files / configs
- USB `EFI/BOOT/bootia32.efi` — the boot shim (Phase 1).
- `/etc/systemd/zram-generator.conf`, `/etc/fstab` (swap + `noatime`).
- `/etc/ssh/sshd_config`, fail2ban.
- `/etc/postgresql/17/main/postgresql.conf` — PostGIS tuning + port; `mountain_db` with `postgis` extension.
- `/etc/systemd/system/mountain-project.service` (one per app).
- App `.env` (DB creds + AI API keys) + `dist/`/`public/` artifacts shipped from the laptop.
- **Remote access:** Tailscale (Option A) **or** `/etc/caddy/Caddyfile` + DuckDNS updater + router port-forward + DHCP reservation (Option B).

## Verification (end-to-end)
1. `free -h` → zram present, ~1.5 GB+ available at idle.
2. `psql -h localhost -p <port> -U mountain_worker -d mountain_db -c 'SELECT postgis_version();'` → returns a version.
3. `systemctl status postgresql mountain-project` → both `active (running)`; `journalctl -u mountain-project` clean.
4. On the box: `curl 'localhost:3000/api/pois?minLng=9.6&minLat=45.9&maxLng=10.0&maxLat=46.1'` → GeoJSON features (DB + PostGIS query path works).
5. Remote: reach the app over **Tailscale** (`http://mountainpi:3000`) — or, if public, `https://yourname.duckdns.org` prompts for **basic_auth** then loads with a valid TLS cert.
6. `sudo reboot` → Postgres + app **auto-start**, SSH key-login still works.
7. If public: direct `http://<public-ip>:3000` is **refused** (only 80/443 open) and AI routes require auth.
