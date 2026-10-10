# Patchbay

A homelab start page styled after the Teenage Engineering EP-series, with
two switchable colourways (`ko` and `riddim`). It reads live data from
[Pangolin](https://github.com/fosrl/pangolin) (the reverse-tunnel platform
that fronts the homelab) and shows quicklink tiles for every service, with
uptime pings, optional TrueNAS telemetry (CPU, memory, pool, uptime), and
optional Jellyfin widgets (continue watching, up next, now playing).

Node 20+, zero npm dependencies (only Node built-ins and global `fetch`),
vanilla JS/HTML/CSS on the frontend, no build step. Everything runs on
Node 20+; the TrueNAS telemetry widget needs Node 22+ (it uses the
built-in `WebSocket` global, which Node 20 doesn't have) — on Node 20 that
one widget shows a clean "needs Node 22 or newer" message instead of data,
and the rest of the app is unaffected.

**Uptime is checked entirely by your browser. Favicons split the work: the
server DISCOVERS where the icon is, by reading each service's own HTML, and
your BROWSER fetches the actual image.** Both halves are split on purpose,
because neither side can do the whole job alone:

- Your browser can reach private services (through the Pangolin client, or
  on the LAN, often via Pangolin's own magic DNS) — but it can't read their
  HTML cross-origin (CORS), so it can't discover a declared icon on its
  own. Guessing a path instead of reading the markup doesn't work either:
  real apps commonly declare a content-hashed filename at a path that only
  exists after a redirect (Jellyfin, for example, 302s `/` to `/web/` and
  declares its icon relative to that — `/favicon.ico` at the root 404s).
- The server can read HTML freely (no CORS server-side), and tries each
  resource's internal LAN address (`destination`/`destinationPort`) first,
  falling back to its public URL if that doesn't produce anything.

Once the server has found the icon's path, it hands the browser a URL
rooted at the resource's **public** hostname — not the internal address it
may have used to discover it, which would be meaningless to your browser —
so the browser fetches the real image itself and gets ordinary HTTP
caching for free, no byte-proxying or image cache on the server at all.

The server's only other outbound requests are to the Pangolin API (to sync
resources and sites) and one HTML `GET` per service to discover its icon.
It never proxies an arbitrary URL — the icon endpoint takes a resource
*key*, looks it up in its own Pangolin snapshot, and derives the fetch
target itself; a request-supplied URL never reaches `fetch()`.

## Features

- Fetches fresh data from Pangolin when you open the dashboard, then
  reuses that snapshot for up to 5 minutes before fetching again — there
  is no background polling, the app is a start page, not a daemon. New
  resources land in a "New from Pangolin" tray until you file them into a
  group.
- Pangolin labels suggest a group placement in the tray (`+ MEDIA` /
  `→ MEDIA`) — click to place one, or "PLACE ALL SUGGESTED" for every
  labelled item at once. Nothing moves on its own.
- Drag-and-drop groups and tiles (edit mode).
- Manual link tiles for anything outside Pangolin.
- Press `/` anywhere to fuzzy-search and jump to a service.
- Uptime is checked by the browser on page load, and again whenever you
  press the CHECK chip — never on a timer. Each service is pinged twice,
  sequentially, and the panel shows the average latency. A service with no
  checkable URL, or one that's plain-http on an https page (mixed content —
  the browser would block the check, not the service), reads as unknown
  rather than a false down.
  **Private-resource hostnames only resolve through your Pangolin
  connection.** With the client connected, a check measures the real
  service. With it disconnected, the same hostname resolves to Pangolin's
  public edge instead, which still answers — so the tile can read UP for a
  service you genuinely can't reach. This can't be detected from a
  `no-cors` response, so it isn't; know it going in, and reconnect before
  trusting a run of green tiles for anything private.
- Favicons: for Pangolin resources, the server reads the service's own HTML
  for its declared icon (`apple-touch-icon` preferred, then the largest
  declared size, falling back to `/favicon.ico` only if nothing is declared
  at all), trying the resource's internal address first and its public URL
  second — but only *discovers* the URL; your browser fetches the actual
  image. The discovered URL is cached on disk (not the image bytes) — a
  real hit for 7 days, a "no icon here" negative for 24h so it doesn't
  re-crawl a service's HTML on every load. Manual links are a deliberate
  exception: there's no Pangolin entry for the server to safely resolve a
  target from, so those still use a plain client-side `favicon.ico` guess
  — a browser-side `<img>` request, not server-side fetching of an
  arbitrary user-supplied URL. Either way, a missing icon just falls back
  to the service's monogram.
- Widgets you place on the grid yourself: Jellyfin continue watching and
  up next (a slider of VHS cassettes), Jellyfin now playing (hidden when
  nothing plays), and TrueNAS telemetry (needs Node 22+, see above).
- "Add link" flow for manual links (anything outside Pangolin). The
  dashboard never writes to Pangolin — new Pangolin resources are added in
  the Pangolin UI and show up here automatically on the next sync.
- All Pangolin/Jellyfin credentials are configured from a settings page in
  the running app — there is no config file to hand-edit and no restart
  needed after a change.

## First-run setup

1. Start the app (see "Run it" below). With nothing configured yet it
   still starts cleanly — you'll see a setup prompt instead of a crash.
2. Open the dashboard in a browser and go to **Settings**.
3. Follow "Enable the Pangolin Integration API" and "Create an org API
   key" below, then paste the API URL, org ID, and API key into the
   settings page and save.
4. Use the "Test connection" button on the settings page to confirm the
   credentials work before leaving the page.

Settings are stored in `$DATA_DIR/settings.json` (mode `0600`, never
committed to git). The Pangolin/Jellyfin API keys are never sent back to
the browser — the settings page only ever shows the last 4 characters of a
saved key, and re-saving the form without touching the key field keeps the
existing key.

## 1. Enable the Pangolin Integration API

On the VPS running Pangolin, edit `config.yml`:

```yaml
flags:
  enable_integration_api: true
server:
  integration_port: 3003
```

Add a router in Traefik's `dynamic_config.yml` so the API is reachable from
outside the Docker network:

```yaml
http:
  routers:
    api:
      rule: "Host(`api.<your-domain>`)"
      service: pangolin-api
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
  services:
    pangolin-api:
      loadBalancer:
        servers:
          - url: "http://pangolin:3003"
```

Restart the stack:

```bash
docker compose down && docker compose up -d
```

The API is now at `https://api.<your-domain>/v1`, with Swagger docs at
`https://api.<your-domain>/v1/docs`.

## 2. Create an org API key

In the Pangolin UI: **Org settings → API Keys → Create key**. Create an
**Organization** key here, not a root key.

The dashboard only ever reads from Pangolin — it never creates or modifies
anything there. Grant the key exactly three permissions, at Organization
scope:
- **Site → List Sites**
- **Resource → List Resources**
- **Resource → List Site Resources**

Do not use "Allow All Permissions", and do not use a root key. The key
must be read-only and scoped to just those three permissions.

To add a new service, add it in the Pangolin dashboard as usual — it then
appears here automatically on the next sync, landing in the "New from
Pangolin" tray until you file it into a group.

## 3. Configure the dashboard

Open the settings page in the running app and fill in:

- **Pangolin API URL**: `https://api.<your-domain>/v1`
- **Org ID**: your Pangolin org ID
- **API key**: the key from step 2

Leave the Jellyfin fields blank unless you want the Jellyfin widgets.

Only `PORT` and `DATA_DIR` need to be set for the app to run at all — a
page served on a given port can't be the thing that changes that port,
and the settings file can't record its own location (see "Run it"
below). Pangolin/Jellyfin credentials can optionally be seeded via
environment variables on first boot too (see "Environment variables"
below), but the settings page is where you manage them day to day —
once `settings.json` exists, the file always wins.

## Private-resource icon discovery

Pangolin reports a private resource's internal address relative to its
Newt connector's own host. For a host-networked Newt (the normal setup)
that's `127.0.0.1` — correct from Newt's point of view, but meaningless
inside a bridge-networked Docker container, where `127.0.0.1` is the
container itself. Left alone, icon discovery against private resources
will silently find nothing under bridge networking — every tile falls
back to its monogram, and it looks identical to "no icon available,"
which makes it hard to diagnose. Fix it one of two ways:

- Set the `INTERNAL_HOST` environment variable to your NAS/host's LAN
  address (e.g. `192.0.2.10`), so a loopback destination gets rewritten to
  something the container can actually reach, or
- Run the container with `network_mode: host` (see `docker-compose.yml`),
  so `127.0.0.1` already means the right thing.

To tell "unreachable" apart from "genuinely has no icon" (both are a quiet
404 to the browser), hit `/api/icon?key=<resource key>&debug=1` — it
bypasses the cache and returns the candidate base URLs tried, whether each
page fetch succeeded, the `<link>` tags parsed, and which one was chosen.

## Run it

### With Docker (recommended)

The image is built by GitHub Actions, not locally. `.github/workflows/docker.yml`
runs on every push to `main` and on version tags (`v*`), and publishes to
GitHub Container Registry (GHCR). Only `linux/amd64` images are published
(this targets TrueNAS SCALE, which is x86-64) — it will not pull on a
Raspberry Pi or other ARM host as-is; the workflow file has a comment
explaining how to add `arm64` back if you need it.

1. Every push to `main` runs the workflow and publishes
   `ghcr.io/martijnvanonz/pb-1:latest` (plus branch- and semver-tagged
   variants if you push a `vX.Y.Z` tag). The image name is the
   repository path lowercased, because GHCR rejects uppercase.
2. By default a new GHCR package is **private**. Either:
   - make it public: on GitHub, go to the package page (under your profile
     or org → **Packages** → `pb-1`) → **Package settings** →
     **Change visibility** → Public, or
   - keep it private and give your host a registry credential: a GHCR pull
     secret / registry credential using a GitHub personal access token with
     `read:packages` scope.
3. **If you fork:** your image is `ghcr.io/<your-user>/<your-repo>`
   lowercased. Change `docker-compose.yml`'s `image:` line to match (a
   mismatch makes the pull 404), and the `org.opencontainers.image.source`
   label in the `Dockerfile` (cosmetic, but keeps the metadata honest).
4. **Create the data directory and hand it to the container's user —
   before your first `docker compose up -d`:**

   ```bash
   mkdir -p ./data && chown 1000:1000 ./data
   ```

   This is not optional decoration. The container runs as uid 1000 (a
   dedicated, unprivileged user baked into the image — not your own host
   account; `docker-compose.yml` also states this explicitly via a
   `user: "1000:1000"` line, so the uid is visible right next to the
   volume instead of buried in the Dockerfile). Docker creates a fresh
   bind-mounted directory owned by root. Skip the `chown` and the app
   can't write to `/data`: the container will not come up. If you're
   deploying outside this repo's checkout, point the compose file's
   `./data:/data` line at real storage on your host first, then `chown`
   that path instead.

   If plain `chown` fails with "Operation not permitted" (common if your
   shell user can't take ownership of an arbitrary uid — e.g. Docker
   Desktop on macOS, or a non-root SSH session), run it through a
   throwaway container instead, which always has the needed privilege:

   ```bash
   docker run --rm -v "$(pwd)/data:/data" alpine chown 1000:1000 /data
   ```

   If you do miss this step, the app fails clearly instead of crashing
   with a stack trace — it prints something like this to
   `docker compose logs`, then exits without binding the port:

   ```
   Patchbay could not create or access its data directory.
     Directory : /data
     Running as: uid 1000
     Error     : EACCES
   ```

   Run the `chown` command above against the host directory mounted to
   `/data`, then start the container again.
5. `docker compose up -d`

The image has a `HEALTHCHECK`, so `docker ps` shows `healthy` once the
app is actually responding (about 20 seconds) instead of leaving you to
guess — a quick way to confirm step 4 worked. If step 4 was missed, you'll
see the opposite instead: the container restarting on a loop and its
health settling to `unhealthy`, which is your cue to check
`docker compose logs` for the message above.

To update later:

```bash
docker compose pull
docker compose up -d
```

This pulls the newest `:latest` (or whichever tag you're pinned to) and
recreates the container. No rebuild needed — and your data survives,
because `./data:/data` in `docker-compose.yml` is a bind mount to your
own host, not the container's throwaway internal storage. Don't remove
that line: doing so silently wipes your API keys, every group and tile
placement, manual links, and the icon cache on the next update, with no
warning and no error.

Because it's a plain folder, back it up however you already back up
folders on your NAS — a dataset snapshot, `rsync`, whatever you use.

### On TrueNAS SCALE (Install via YAML)

TrueNAS SCALE 24.10 and newer run apps with Docker Compose, so the image
installs as a custom app:

1. Create a dataset for the data, e.g. `/mnt/<pool>/apps/patchbay`.
   TrueNAS runs apps as the built-in `apps` user (uid/gid 568), so use
   `568:568` below, not 1000. Datasets made under the **Appdata** preset
   normally already give `apps` modify rights through an NFS4 ACL, so you
   usually need **no** `chown` at all. Only if the app later logs that it
   cannot write to its data directory, check the dataset's permissions
   (**Datasets → Permissions**) and give the `apps` user and group modify
   access. Do not `chown 1000:1000` here: it replaces the ACL and locks
   the `apps` user out.

2. **Apps → Discover Apps → ⋮ → Install via YAML**, name it `patchbay`,
   and paste this. The `./data` relative path from `docker-compose.yml`
   does not work here; TrueNAS needs the absolute dataset path.

   ```yaml
   services:
     patchbay:
       image: ghcr.io/martijnvanonz/pb-1:latest
       user: "568:568"
       ports:
         - "8288:8288"
       volumes:
         - /mnt/<pool>/apps/patchbay:/data
       environment:
         PORT: "8288"
         DATA_DIR: /data
         # INTERNAL_HOST: 192.0.2.10   # see "Private-resource icon discovery"
       restart: unless-stopped
   ```

3. Open `http://<truenas-ip>:8288/settings.html` and enter your keys.

To update after a new push to `main`, use **Update** on the app (or
stop and start it with "pull image" checked) so TrueNAS fetches the new
`:latest`.

### Calling Jellyfin and TrueNAS from the browser

By default the server calls Jellyfin and TrueNAS itself. That fails when
the app runs where those hosts are only reachable through a client-side
tunnel: for example a container on the NAS with no Pangolin client, whose
calls leave through public DNS and get Pangolin's HTML login page back
(`Unexpected token '<'` for Jellyfin, "Cannot reach TrueNAS"). Your
browser, which does run the Pangolin client, can reach them.

For that case, each of the two settings sections has an opt-in
**Call from browser** checkbox (off by default). When it is on, the page
loads the URL and API key from `/api/browser-credentials` once per page
load and calls the service directly. The widgets look the same; the
server endpoints stay in place for when the box is off.

**Security trade-off:** with the box on, the API key is sent to every
browser that opens the page. Patchbay has no login of its own, so use
this only behind a login (for example Pangolin SSO), and use the least
privileged key you can: for Jellyfin an API token of a **non-admin
user**, for TrueNAS a **READONLY_ADMIN** key. Only services with the box
on are included in `/api/browser-credentials`; with both off it returns
`{}`. Jellyfin must also answer CORS requests for the page's origin with
the `Authorization` header allowed. TrueNAS must accept a WebSocket from
that origin. If the page is served over `https`, the service URLs must be
`https` too.

### Security

Patchbay has no login of its own. Anyone who can reach its port can
view and change settings — including credentials — and rewrite the whole
layout. This is by design: the app is built to sit behind an
authenticating reverse proxy, not to guard itself.

Do not expose this port directly to the internet, and do not expose it on
an untrusted LAN. Put it behind Pangolin (or another reverse proxy) with
authentication in front of it, as described below.

### Publish the dashboard through Pangolin

Once it's running, consider adding the dashboard itself as a **private**
resource in Pangolin instead of exposing its port publicly. That puts it
behind Pangolin's SSO, which is also why the app itself has no
authentication of its own — it assumes it always sits behind Pangolin.

### Local development

Either run it directly with Node:

```bash
PORT=8288 DATA_DIR=./data node src/server.js
```

Or build and run it locally with Docker (this is what
`docker-compose.dev.yml` is for — it builds from source instead of pulling
from GHCR):

```bash
docker compose -f docker-compose.dev.yml up --build
```

Without Pangolin configured, the app still starts and runs — you'll see an
inline setup prompt instead of a crash, and manual links / groups still
work.

## Environment variables

Two are read on every boot:

| Variable   | Meaning                                              | Default |
|------------|-------------------------------------------------------|---------|
| `PORT`     | Port the dashboard listens on inside the container.  | `8288`  |
| `DATA_DIR` | Where `settings.json`, `layout.json`, and the icon cache are stored. | `./data` |

`./data` is the app's own default, for running it bare-metal. The Docker
image overrides it to `/data`, bind-mounted to `./data` on your host by
`docker-compose.yml` — see "With Docker" above — so you don't need to set
it yourself there.

The rest are read exactly once, only to seed `settings.json` the very
first time it's created. Once `settings.json` exists, the file always
wins and these are ignored on every later boot — in practice, just use
the settings page (see "First-run setup" above). They mainly exist for
scripted or infra-as-code deployments:

| Variable          | Meaning                       |
|--------------------|--------------------------------|
| `PANGOLIN_API_URL` | Seeds the Pangolin API URL.   |
| `PANGOLIN_ORG_ID`  | Seeds the Pangolin org ID.    |
| `PANGOLIN_API_KEY` | Seeds the Pangolin API key.   |
| `JELLYFIN_URL`     | Seeds the Jellyfin URL.       |
| `JELLYFIN_API_KEY` | Seeds the Jellyfin API key.   |

One more, optional, purely a workaround for the bridge-networking gotcha
described above (unrelated to the settings seed):

| Variable        | Meaning                                                        | Default |
|-----------------|-----------------------------------------------------------------|---------|
| `INTERNAL_HOST` | LAN address to substitute for `127.0.0.1` when reaching a private resource's internal address for icon discovery. | (unset) |

## Data on disk

All of this lives under `$DATA_DIR`. In Docker, that's the `./data`
bind mount from `docker-compose.yml` — see "With Docker" above — so it
survives an update as long as that line stays in place.

- `$DATA_DIR/settings.json` — Pangolin/Jellyfin/TrueNAS credentials and
  branding, written atomically, mode `0600`.
- `$DATA_DIR/layout.json` — groups, tile placement, hidden tiles, and
  manual links, written atomically.
- `$DATA_DIR/icons/` — discovered Pangolin favicon URLs (not image bytes —
  the server never fetches or stores those), keyed by resource key: a real
  hit for 7 days, a "no icon here" negative for 24h.

Uptime is never cached on disk; the browser re-checks fresh every time you
load the page or press CHECK.

## Licence

AGPL-3.0. In plain terms: anyone may use, modify, and self-host this
dashboard freely. If you run a **modified** version of it as a network
service that other people can reach, you must publish the source of your
modified version to them. See [LICENSE](LICENSE) for the full text.

### Third-party

Two components are vendored under their own licences:

- `public/vendor/embla-carousel.umd.js` — MIT License, Copyright (c) David
  Jerleke. See [public/vendor/embla-carousel.LICENSE](public/vendor/embla-carousel.LICENSE).
- `public/vendor/caveat-bold.woff2` — SIL Open Font License 1.1, Copyright
  2014 The Caveat Project Authors. See
  [public/vendor/caveat.OFL.txt](public/vendor/caveat.OFL.txt).
