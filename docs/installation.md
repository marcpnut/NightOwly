# Installation and rollout

## Current server deployment

StreamCinema is running inside the existing Debian 13 LXC **190** at `10.42.0.86`. It runs as the `streamcinema` system user under systemd service `streamcinema.service`; application files are in `/opt/streamcinema/app`. PostgreSQL remains bound to loopback in the same container and the service connects to the existing `streamcinema` database. The old importer files under `/opt/streamcinema` were preserved.

The CT was inspected before deployment: 2 vCPU, 4 GB RAM, 32 GB disk, automatic startup. A compressed pre-deployment database dump is at `/var/backups/streamcinema/streamcinema-pre-app.dump`. No Proxmox host networking or firewall settings were changed. The API and web app are reachable on the private LAN at `http://10.42.0.86:8080`; the database is not exposed to the LAN. The running API has been checked over LAN for health, static assets, authenticated movie pages, and detail with multiple stream choices. Real catalog counts remain unchanged.

The API token and credential encryption key stay in the protected `/etc/streamcinema.env` file; the TV no longer needs the API token. This website account is independent of the Xtream account; configure the Xtream server URL, username, and password under Settings → Xtream provider. The NightOwl account password is stored as a salted scrypt hash, while provider credentials are encrypted. Account login issues a device-bound session that lasts 30 days while in use and does not fetch catalog lists. The Database page shows active catalog counts and can start a manual M3U comparison. A scheduled comparison runs nightly at 03:00 Europe/Amsterdam. It adds only missing provider IDs, enriches only new movies and affected series, and removes its private temporary playlist when finished. “What’s New” displays all additions from successful imports over the past seven days. The TMDB token can be entered in Settings and is encrypted in `sc_tmdb_settings`. No bulk TMDB metadata requests are run. The Nano and C9 have not been connected or changed.

## Existing container details

CT 190 is unprivileged, has gateway `10.42.0.1`, DNS `10.42.0.10`, and uses Debian 13. Node.js 20 and PostgreSQL are installed natively. Docker is not used inside the LXC.

## Server configuration

For a new installation, the Compose file is in `deployment/`; the current CT 190 installation uses the native systemd unit `deployment/streamcinema.service` and the already existing protected environment file.

For a separate Compose installation, set `BIND_IP` only after firewall review; the sample defaults to loopback. Keep `CREDENTIAL_KEY` securely backed up because it is required to decrypt provider settings and the stored TMDB token. Do not commit `.env`.

For the CT 190 installation, the API starts through systemd and uses PostgreSQL over the local Unix socket. Review service output with `systemctl status streamcinema` and `journalctl -u streamcinema`. Check `/api/v1/health` from a LAN client.

TMDB metadata is fetched on first title or season open. The Settings form stores the read access token encrypted in `sc_tmdb_settings`; no bulk metadata enrichment is performed. TMDB requires its approved logo and attribution notice in the app credits.

The API is HTTP behind Nginx Proxy Manager at `10.42.0.60`; public clients use `https://[redacted]` with its Let's Encrypt certificate and Force SSL. Keep the upstream at `http://10.42.0.86:8080` inside the LAN, and do not expose port 8080 directly through the router.

## TV package

Run `pnpm install`, `pnpm build`, then `pnpm package:webos` in the project folder. The client package ID is `com.streamcinema.iptv`; installing it will not replace the existing app. Before a development install, confirm the Nano's currently installed packages, save its relevant app data, and verify the webOS package manager and a working removal/rollback path. Do not deploy to the C9 until its connection details and deployment authorization are available.

On first launch, create a NightOwl account. Add the Xtream provider details under Settings → Xtream provider. The client creates a per-TV identifier and a Default profile, then stores only the session token in browser storage. Test Home, category pages, details, episodes, live, playback, subtitles, audio, Back, and progress on the Nano before considering the C9. If any stream fails, inspect its format and TV codec support without modifying the Netflix installation.
