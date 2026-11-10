#!/usr/bin/env bash
#
# YAESU-REMOTE - install / update on a Raspberry Pi (Zero 2 W, 3, 4, 5)
#
# Raspberry Pi OS Lite (Bookworm or newer, NetworkManager), 32 or 64 bit.
# Run from a checkout of the repository:
#
#   sudo apt install -y git
#   git clone -b feature/server-core https://github.com/cgraf63/YAESU-REMOTE.git
#   cd YAESU-REMOTE
#   sudo ./scripts/install.sh
#
# Running it again updates the installation (git pull first).
#
# What it does:
#   - packages: Node.js 22 (official build), alsa-utils, avahi, i2c-tools
#   - user "yaesu" (groups dialout, audio, i2c), no login
#   - code to /opt/yaesu-remote, build, data in /var/lib/yaesu-remote
#   - hostname yaesu-remote  ->  http://yaesu-remote.local
#   - I2C on (OLED), Wi-Fi country if none is set
#   - systemd: yaesu-remote (port 80), yaesu-remote-oled
#   - polkit: user yaesu may manage Wi-Fi (no sudo)
#   - setup network YAESU-REMOTE / yaesu-remote stored (lowest priority)
#
# Options:
#   --hostname NAME   other hostname (default yaesu-remote)
#   --country CC      Wi-Fi country if none is set (default CH)
#   --oled-driver D   ssd1306 (0.96", default) or sh1106 (1.3")
#   --no-oled         do not install the OLED service
#   --port N          HTTP port (default 80)
#   --dry-run         only show what would be done

set -euo pipefail

APP=yaesu-remote
USER_NAME=yaesu
TARGET=/opt/yaesu-remote
DATA=/var/lib/yaesu-remote
NODE_MAJOR=22

HOSTNAME_NEW=yaesu-remote
COUNTRY=CH
OLED=1
OLED_DRIVER=ssd1306
PORT=80
DRY=0

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --hostname) HOSTNAME_NEW="$2"; shift 2 ;;
        --country) COUNTRY="${2^^}"; shift 2 ;;
        --oled-driver) OLED_DRIVER="$2"; shift 2 ;;
        --no-oled) OLED=0; shift ;;
        --port) PORT="$2"; shift 2 ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

# ---------------------------------------------------------------------

BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; OFF=$'\e[0m'

step() { echo; echo "${BOLD}==> $*${OFF}"; }
ok()   { echo "    ${GREEN}✓${OFF} $*"; }
warn() { echo "    ${YELLOW}!${OFF} $*"; }
die()  { echo "${RED}ERROR:${OFF} $*" >&2; exit 1; }

# run a command, or only print it with --dry-run
run() {
    if [ "$DRY" = 1 ]; then
        echo "    [dry-run] $*"
    else
        "$@"
    fi
}

# write a file (content from stdin)
put() {
    local path="$1" mode="${2:-0644}"
    if [ "$DRY" = 1 ]; then
        echo "    [dry-run] write $path"
        cat > /dev/null
    else
        install -m "$mode" /dev/stdin "$path"
    fi
}

# ---------------------------------------------------------------------

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "please run with sudo: sudo $0"
[ -f "$SRC/package.json" ] && grep -q '"name": "yaesu-remote"' "$SRC/package.json" || die "run the script from the YAESU-REMOTE checkout"
[[ "$OLED_DRIVER" =~ ^(ssd1306|sh1106)$ ]] || die "--oled-driver: ssd1306 or sh1106"
[[ "$HOSTNAME_NEW" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "--hostname: lower case letters, digits and -"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port: number"

echo "${BOLD}YAESU-REMOTE install${OFF}  (source: $SRC)"
[ "$DRY" = 1 ] && echo "${YELLOW}dry run - nothing is changed${OFF}"

# ---------------------------------------------------------------------
step "System"

if [ -r /etc/os-release ]; then
    . /etc/os-release
    ok "${PRETTY_NAME:-$ID}"
fi

if ! command -v nmcli > /dev/null || ! systemctl is-active --quiet NetworkManager 2> /dev/null; then
    if [ "$DRY" = 1 ]; then
        warn "NetworkManager not running here (dry run, continuing)"
    else
        die "NetworkManager is not running. Raspberry Pi OS Bookworm or newer is needed (it uses NetworkManager)."
    fi
else
    ok "NetworkManager running"
fi

ARCH="$(uname -m)"
case "$ARCH" in
    aarch64|arm64) NODE_ARCH=arm64 ;;
    armv7l|armv8l) NODE_ARCH=armv7l ;;
    x86_64) NODE_ARCH=x64 ;;
    *) die "unsupported CPU: $ARCH (armv6 Pi Zero / Zero W are too old)" ;;
esac
ok "CPU $ARCH"

# ---------------------------------------------------------------------
step "Packages"

run apt-get update -qq
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    git curl ca-certificates xz-utils alsa-utils avahi-daemon i2c-tools python3 rsync polkitd > /dev/null
ok "git, alsa-utils, avahi-daemon, i2c-tools, python3, rsync, polkitd"

NODE_OK=0
if command -v node > /dev/null; then
    NODE_VER="$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || echo 0)"
    [ "$NODE_VER" -ge "$NODE_MAJOR" ] && NODE_OK=1
fi

if [ "$NODE_OK" = 1 ]; then
    ok "Node.js $(node -v) present"
else
    # official build from nodejs.org, checked against SHASUMS256.txt
    BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    if [ "$DRY" = 1 ]; then
        echo "    [dry-run] download $BASE/node-v${NODE_MAJOR}.*-linux-${NODE_ARCH}.tar.xz to /usr/local"
    else
        TMP="$(mktemp -d)"
        curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
        FILE="$(grep -o "node-v[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
        [ -n "$FILE" ] || die "no Node.js $NODE_MAJOR build for linux-$NODE_ARCH"
        curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
        (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node.js download: checksum wrong"
        tar -xJf "$TMP/$FILE" -C /usr/local --strip-components=1 --no-same-owner \
            --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/include' --exclude='*/share/doc'
        rm -rf "$TMP"
        hash -r
    fi
    ok "Node.js $( [ "$DRY" = 1 ] && echo "$NODE_MAJOR (dry run)" || node -v) installed in /usr/local"
fi

NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
NPM_BIN="$(command -v npm || echo /usr/local/bin/npm)"

# ---------------------------------------------------------------------
step "User $USER_NAME"

if id "$USER_NAME" > /dev/null 2>&1; then
    ok "exists"
else
    run useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
    ok "created"
fi
for g in dialout audio i2c; do
    getent group "$g" > /dev/null || run groupadd --system "$g"
done
run usermod -aG dialout,audio,i2c "$USER_NAME"
ok "groups dialout (CAT), audio (sound card), i2c (OLED)"

# ---------------------------------------------------------------------
step "Code -> $TARGET"

run mkdir -p "$TARGET" "$DATA"
run rsync -a --delete \
    --exclude .git --exclude node_modules --exclude dist --exclude data --exclude .local-types \
    --exclude '__pycache__' "$SRC/" "$TARGET/"
ok "copied"

# build as root in the target, dev tools removed afterwards
if [ "$DRY" = 1 ]; then
    echo "    [dry-run] npm install, npm run build, npm prune --omit=dev"
else
    cd "$TARGET"
    export PATH="$(dirname "$NODE_BIN"):$PATH"
    "$NPM_BIN" install --no-audit --no-fund --loglevel=error
    "$NPM_BIN" run build --silent
    "$NPM_BIN" prune --omit=dev --no-audit --no-fund --loglevel=error
    cd - > /dev/null
fi
ok "built (dist/)"

run chown -R root:root "$TARGET"
run chown -R "$USER_NAME:$USER_NAME" "$DATA"
run chmod 0750 "$DATA"

# ---------------------------------------------------------------------
step "Hostname $HOSTNAME_NEW"

CURRENT_HOST="$(hostname)"
if [ "$CURRENT_HOST" = "$HOSTNAME_NEW" ]; then
    ok "already set"
else
    run hostnamectl set-hostname "$HOSTNAME_NEW"
    if grep -q '^127\.0\.1\.1' /etc/hosts; then
        run sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_NEW/" /etc/hosts
    else
        [ "$DRY" = 1 ] && echo "    [dry-run] add 127.0.1.1 $HOSTNAME_NEW to /etc/hosts" || printf '127.0.1.1\t%s\n' "$HOSTNAME_NEW" >> /etc/hosts
    fi
    ok "$CURRENT_HOST -> $HOSTNAME_NEW"
fi
run systemctl enable --now avahi-daemon > /dev/null 2>&1 || warn "avahi-daemon could not be started"
ok "http://$HOSTNAME_NEW.local"

# ---------------------------------------------------------------------
step "I2C and Wi-Fi country"

if command -v raspi-config > /dev/null; then
    run raspi-config nonint do_i2c 0
    ok "I2C on"
    WC="$(raspi-config nonint get_wifi_country 2> /dev/null || true)"
    if [ -z "$WC" ]; then
        run raspi-config nonint do_wifi_country "$COUNTRY"
        ok "Wi-Fi country $COUNTRY"
    else
        ok "Wi-Fi country $WC (kept)"
    fi
else
    warn "raspi-config not found (not a Raspberry Pi OS?) - enable I2C yourself"
fi

# ---------------------------------------------------------------------
step "Services"

NODE_ESC="${NODE_BIN//\//\\/}"

sed -e "s/\/usr\/bin\/node/$NODE_ESC/g" \
    -e "s/^Environment=PORT=.*/Environment=PORT=$PORT/" \
    "$SRC/system/yaesu-remote.service" | put /etc/systemd/system/yaesu-remote.service
ok "yaesu-remote.service (port $PORT)"

run mkdir -p /etc/polkit-1/rules.d
put /etc/polkit-1/rules.d/50-yaesu-remote.rules < "$SRC/system/50-yaesu-remote.rules"
ok "polkit rule: $USER_NAME may manage Wi-Fi"

if [ "$OLED" = 1 ]; then
    URL="http://127.0.0.1$( [ "$PORT" = 80 ] || echo ":$PORT")"
    sed -e "s/^Environment=OLED_DRIVER=.*/Environment=OLED_DRIVER=$OLED_DRIVER/" \
        -e "s#^Environment=YAESU_URL=.*#Environment=YAESU_URL=$URL#" \
        "$SRC/system/yaesu-remote-oled.service" | put /etc/systemd/system/yaesu-remote-oled.service
    ok "yaesu-remote-oled.service ($OLED_DRIVER)"
fi

# wifi.txt example on the boot drive
for boot in /boot/firmware /boot; do
    if [ -d "$boot" ] && [ -f "$boot/config.txt" ]; then
        put "$boot/wifi.txt.example" < "$SRC/system/wifi.txt.example"
        ok "$boot/wifi.txt.example"
        break
    fi
done

run systemctl daemon-reload
run systemctl restart polkit 2> /dev/null || true
run systemctl enable yaesu-remote > /dev/null 2>&1
run systemctl restart yaesu-remote
if [ "$OLED" = 1 ]; then
    run systemctl enable yaesu-remote-oled > /dev/null 2>&1
    run systemctl restart yaesu-remote-oled
else
    run systemctl disable --now yaesu-remote-oled > /dev/null 2>&1 || true
fi
ok "started"

# ---------------------------------------------------------------------
step "Check"

if [ "$DRY" = 1 ]; then
    echo "    [dry-run] wait for http://127.0.0.1:$PORT/api/status"
else
    UP=0
    for _ in $(seq 1 30); do
        if curl -fs "http://127.0.0.1:$PORT/api/status" > /dev/null; then UP=1; break; fi
        sleep 1
    done
    if [ "$UP" = 1 ]; then
        ok "server answers"
        if nmcli -t -f NAME connection show | grep -qx 'yaesu-remote-setup'; then
            ok "setup network YAESU-REMOTE stored"
        else
            warn "setup network not found - see: journalctl -u yaesu-remote"
        fi
    else
        warn "server does not answer yet - see: journalctl -u yaesu-remote -e"
    fi
fi

IP="$(hostname -I 2> /dev/null | awk '{print $1}')"
P="$( [ "$PORT" = 80 ] || echo ":$PORT")"

echo
echo "${GREEN}${BOLD}YAESU-REMOTE is installed.${OFF}"
echo "  Remote:  http://$HOSTNAME_NEW.local$P   ${IP:+or http://$IP$P}"
echo "  Wi-Fi:   http://$HOSTNAME_NEW.local$P/wifi.html"
echo "  Logs:    journalctl -u yaesu-remote -f"
[ "$OLED" = 1 ] && echo "  OLED:    journalctl -u yaesu-remote-oled -f   (I2C becomes active after a reboot)"
[ "$CURRENT_HOST" != "$HOSTNAME_NEW" ] && echo "  ${YELLOW}Reboot recommended (new hostname, I2C): sudo reboot${OFF}"
echo
