"""Deploy the X-COM battlescape server to xcom.evanbooth.com on the gemmarius droplet.

Mirrors the gc.evanbooth.com pattern (see ~/Documents/ai/hosting/AGENTS.md): an isolated system
user, a pinned Bun runtime, releases/<timestamp> with a `current` symlink, a hardened systemd unit,
an nginx vhost that proxies HTTP + WebSockets to 127.0.0.1:4320, and a certbot webroot certificate.

Usage (explicit go-ahead required):
    bun run build
    python deploy/deploy-xcom.py --deploy --credentials <google-oauth-web-client.json>   # first deploy
    python deploy/deploy-xcom.py --deploy                                                  # later: keeps the server's secrets

The game data (GAME_DIR) is uploaded once to /opt/xcom/gamedata and only re-sent with --upload-gamedata.
No credentials are printed.
"""
from __future__ import annotations

import argparse
import io
import json
import shlex
import sys
import tarfile
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
HOST = "xcom.evanbooth.com"
BASE = "/opt/xcom"
PORT = 4320
BUN_VERSION = "1.3.14"
HELPERS = Path.home() / "Documents/ai/focus/assistant"
sys.path.insert(0, str(HELPERS))
from ssh_access import load_access  # noqa: E402

HTTP = f"""server {{
    listen 80;
    listen [::]:80;
    server_name {HOST};
    access_log off;
    location ^~ /.well-known/acme-challenge/ {{
        root /var/lib/xcom-acme;
        default_type text/plain;
        try_files $uri =404;
    }}
    location / {{ return 301 https://{HOST}$request_uri; }}
}}
"""

PROXY = f"""proxy_pass http://127.0.0.1:{PORT};
        proxy_http_version 1.1;
        proxy_set_header Host {HOST};
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $xcom_connection_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_buffering off;"""

NGINX = f"""# X-COM battlescape: every request (including game data) goes through the Bun server, which checks the session.
map $http_upgrade $xcom_connection_upgrade {{
    default upgrade;
    ''      close;
}}
{HTTP}
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {HOST};
    charset utf-8;
    ssl_certificate /etc/letsencrypt/live/{HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{HOST}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    # OAuth codes travel in query strings; keep them out of logs.
    access_log off;
    error_log /var/log/nginx/{HOST}.error.log crit;
    client_max_body_size 256k;
    location / {{
        {PROXY}
    }}
}}
"""

SERVICE = f"""[Unit]
Description=X-COM battlescape multiplayer server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xcom
Group=xcom
WorkingDirectory={BASE}/current
EnvironmentFile=/etc/xcom/environment
ExecStart={BASE}/runtime/bun run {BASE}/current/server/index.ts
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/xcom
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
MemoryMax=1G

[Install]
WantedBy=multi-user.target
"""

RELEASE_FILES = ["package.json", "bun.lock", "tsconfig.json", "server", "shared", "client/index.html", "client/style.css", "dist"]


def make_tar(paths: list[Path], base: Path) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in paths:
            tar.add(p, arcname=str(p.relative_to(base)), filter=lambda t: None if "__pycache__" in t.name else t)
    return buf.getvalue()


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--deploy", action="store_true", required=True)
    ap.add_argument("--credentials", help="Google OAuth web client JSON (downloaded from the Cloud console); needed on the first deploy, or to change the secrets")
    ap.add_argument("--upload-gamedata", action="store_true", help="(re)upload the X-COM data folder")
    ap.add_argument("--gamedata", default=str(ROOT / "gamedata"))
    ap.add_argument("--admin-email", action="append", default=[], help="Google account allowed to download match statistics (repeatable)")
    args = ap.parse_args()

    if not (ROOT / "dist" / "main.js").exists():
        raise SystemExit("Run `bun run build` first.")
    env_bytes = None
    if args.credentials:
        creds = json.loads(Path(args.credentials).read_text())
        web = creds.get("web") or creds
        redirect = f"https://{HOST}/auth/google/callback"
        if redirect not in web.get("redirect_uris", [redirect]):
            raise SystemExit(f"The OAuth client doesn't list {redirect} as a redirect URI")
        env = {
            "PORT": str(PORT),
            "PUBLIC_URL": f"https://{HOST}",
            "GOOGLE_CLIENT_ID": web["client_id"],
            "GOOGLE_CLIENT_SECRET": web["client_secret"],
            "DB_PATH": "/var/lib/xcom/xcom.sqlite",
            "GAME_DIR": f"{BASE}/gamedata",
            "DEV_LOGIN": "0",
            "ADMIN_EMAILS": ",".join(args.admin_email),
        }
        if any(c in v for v in env.values() for c in "\n\r\"\\"):
            raise SystemExit("Unexpected characters in configuration")
        env_bytes = "".join(f'{k}="{v}"\n' for k, v in env.items()).encode()

    access = load_access()
    if access["host"] != "167.71.26.113" or access["user"] != "gemmarius":
        raise SystemExit("SSH destination differs from the authorized hosting server")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(access["host"], username=access["user"], password=access["password"], timeout=20, look_for_keys=False, allow_agent=False)
    sftp = client.open_sftp()

    def run(cmd: str, sudo: bool = False, timeout: int = 120) -> str:
        if sudo:
            cmd = "sudo -S -p '' bash -lc " + shlex.quote("set -euo pipefail\n" + cmd)
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        if sudo:
            stdin.write(access["password"] + "\n")
            stdin.flush()
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        if stdout.channel.recv_exit_status():
            raise RuntimeError(f"Remote step failed: {err[-2000:] or out[-2000:]}")
        return out

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    staging = f"/home/gemmarius/.xcom-upload-{stamp}"

    def put(name: str, data: bytes) -> str:
        path = f"{staging}-{name}"
        with sftp.open(path, "wb") as f:
            sftp.chmod(path, 0o600)
            f.set_pipelined(True)
            f.write(data)
        return path

    print("Checking host...", flush=True)
    run("nginx -t", sudo=True)
    run("df -h /", sudo=True)
    first = not run(f"test -e {BASE}/current && echo yes || true", sudo=True).strip()
    if first:
        run(f"! ss -ltnH | awk '{{print $4}}' | grep -q ':{PORT}$'", sudo=True)
    if env_bytes is None and not run("test -s /etc/xcom/environment && echo yes || true", sudo=True).strip():
        raise SystemExit("No secrets on the server yet: pass --credentials")

    print("Uploading release...", flush=True)
    release = put("release.tar.gz", make_tar([ROOT / p for p in RELEASE_FILES], ROOT))
    envp = put("environment", env_bytes) if env_bytes is not None else None
    unit = put("service", SERVICE.encode())
    ngx = put("nginx", NGINX.encode())
    http = put("http", HTTP.encode())
    game = None
    if first or args.upload_gamedata:
        gd = Path(args.gamedata)
        dirs = [gd / d for d in ["GEODATA", "GEOGRAPH", "MAPS", "MUSIC", "ROUTES", "SOUND", "TERRAIN", "UFOGRAPH", "UNITS"] if (gd / d).exists()]
        game = put("gamedata.tar.gz", make_tar(dirs, gd))

    print("Installing...", flush=True)
    run(f"""id xcom >/dev/null 2>&1 || useradd --system --home-dir /var/lib/xcom --shell /usr/sbin/nologin xcom
install -d -m 0755 -o root -g root {BASE} {BASE}/releases {BASE}/runtime
install -d -m 0755 -o root -g root {BASE}/releases/{stamp}
install -d -m 0700 -o xcom -g xcom /var/lib/xcom
install -d -m 0700 -o root -g root /etc/xcom
install -d -m 0755 /var/lib/xcom-acme
tar -xzf {release} -C {BASE}/releases/{stamp}
{f"install -m 0600 -o root -g root {envp} /etc/xcom/environment" if envp else "true"}
if [ ! -x {BASE}/runtime/bun ]; then cp /opt/gc-study/runtime/bun {BASE}/runtime/bun; fi
{BASE}/runtime/bun --version | grep -q '^{BUN_VERSION}$'
cd {BASE}/releases/{stamp} && {BASE}/runtime/bun install --production --frozen-lockfile
""", sudo=True, timeout=600)
    if game:
        run(f"install -d -m 0755 {BASE}/gamedata && tar -xzf {game} -C {BASE}/gamedata && chmod -R a+rX {BASE}/gamedata", sudo=True, timeout=600)

    if first:
        print("First deploy: HTTP vhost + certificate...", flush=True)
        run(f"""install -m 0644 {http} /etc/nginx/sites-available/{HOST}
ln -sf /etc/nginx/sites-available/{HOST} /etc/nginx/sites-enabled/{HOST}
if ! nginx -t; then rm -f /etc/nginx/sites-enabled/{HOST} /etc/nginx/sites-available/{HOST}; exit 1; fi
systemctl reload nginx""", sudo=True)
        run(f"certbot certonly --webroot -w /var/lib/xcom-acme -d {HOST} --non-interactive --agree-tos --register-unsafely-without-email", sudo=True, timeout=300)

    print("Switching to the new release...", flush=True)
    run(f"""cp -a /etc/nginx/sites-available/{HOST} /etc/nginx/sites-available/{HOST}.bak.{stamp} 2>/dev/null || true
install -m 0644 {ngx} /etc/nginx/sites-available/{HOST}
# the box hosts other sites: a config that fails the test never stays in place
if ! nginx -t; then cp -a /etc/nginx/sites-available/{HOST}.bak.{stamp} /etc/nginx/sites-available/{HOST}; exit 1; fi
install -m 0644 {unit} /etc/systemd/system/xcom.service
ln -sfn {BASE}/releases/{stamp} {BASE}/current.new && mv -T {BASE}/current.new {BASE}/current
systemctl daemon-reload
systemctl enable xcom.service
systemctl restart xcom.service
systemctl reload nginx
rm -f {staging}-*
""", sudo=True)
    time.sleep(3)
    print(run(f"curl -fsS http://127.0.0.1:{PORT}/health", sudo=True).strip())
    print(f"Deployed release {stamp} to https://{HOST}")


if __name__ == "__main__":
    main()
