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
# Running it again updates the installation (git pull first); the
# options of the first run are kept (/etc/yaesu-remote/install.conf).
# Later updates also from the browser: UPDATE page (scripts/update.sh).
#
# What it does:
#   - packages: Node.js 22 (official build), alsa-utils, avahi, i2c-tools
#   - user "yaesu" (groups dialout, audio, i2c), no login
#   - code to /opt/yaesu-remote (git checkout, for updates), build,
#     data in /var/lib/yaesu-remote
#   - hostname yaesu-remote  ->  http://yaesu-remote.local
#   - I2C on (OLED), Wi-Fi country if none is set
#   - Pi Zero / Zero 2 W: USB at full speed (dwc_otg.speed=1) - the radio's
#     internal USB hub otherwise drops out every minute or so
#   - systemd: yaesu-remote (port 80), yaesu-remote-oled,
#     yaesu-remote-update@ (software update from the page)
#   - polkit: user yaesu may manage Wi-Fi and start the update (no sudo)
#   - yaesu-remote-boot at every boot: USB full speed on the Zero, swap with
#     little RAM, Wi-Fi country, service access (yaesu-access.txt)
#   - setup network YAESU-REMOTE / yaesu-remote stored (lowest priority)
#
# Options:
#   --hostname NAME   other hostname (default yaesu-remote)
#   --country CC      Wi-Fi country if none is set (default CH)
#   --oled-driver D   ssd1306 (0.96", default) or sh1106 (1.3")
#   --no-oled         do not install the OLED service
#   --port N          HTTP port (default 80)
#   --no-usb-fullspeed  Pi Zero: keep USB at high speed
#   --setup-hotspot   own setup Wi-Fi "YAESU-REMOTE-Setup" when the box has
#                     no network for some minutes (captive page)
#   --image           build the ready-made SD card image (chroot): nothing
#                     is started, Pi-specific steps run at the first boot
#   --update          used by scripts/update.sh: build and restart in
#                     /opt/yaesu-remote, packages only if missing
#   --dry-run         only show what would be done

set -euo pipefail

APP=yaesu-remote
USER_NAME=yaesu
TARGET=/opt/yaesu-remote
DATA=/var/lib/yaesu-remote
NODE_MAJOR=22
CONF=/etc/yaesu-remote/install.conf

HOSTNAME_NEW=yaesu-remote
COUNTRY=CH
OLED=1
OLED_DRIVER=ssd1306
PORT=80
DRY=0
USB_FULLSPEED=1
REBOOT=0
UPDATE=0
IMAGE=0
SETUP_HOTSPOT=0

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# options of the first run (hostname, port, OLED ...) - given options win
if [ -r "$CONF" ]; then
    # shellcheck disable=SC1090
    . "$CONF"
fi

while [ $# -gt 0 ]; do
    case "$1" in
        --hostname) HOSTNAME_NEW="$2"; shift 2 ;;
        --country) COUNTRY="${2^^}"; shift 2 ;;
        --oled-driver) OLED_DRIVER="$2"; shift 2 ;;
        --no-oled) OLED=0; shift ;;
        --port) PORT="$2"; shift 2 ;;
        --dry-run) DRY=1; shift ;;
        --no-usb-fullspeed) USB_FULLSPEED=0; shift ;;
        --update) UPDATE=1; shift ;;
        --image) IMAGE=1; shift ;;
        --setup-hotspot) SETUP_HOTSPOT=1; shift ;;
        --no-setup-hotspot) SETUP_HOTSPOT=0; shift ;;
        -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
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

VERSION="$(grep -o '"version": *"[^"]*"' "$SRC/package.json" | grep -o '[0-9][0-9.]*' || true)"
echo "${BOLD}YAESU-REMOTE $( [ "$UPDATE" = 1 ] && echo update || echo install )${OFF}  (source: $SRC, version ${VERSION:-?})"
[ "$DRY" = 1 ] && echo "${YELLOW}dry run - nothing is changed${OFF}"

# ---------------------------------------------------------------------
step "System"

if [ -r /etc/os-release ]; then
    . /etc/os-release
    ok "${PRETTY_NAME:-$ID}"
fi

if ! command -v nmcli > /dev/null || ! systemctl is-active --quiet NetworkManager 2> /dev/null; then
    if [ "$DRY" = 1 ] || [ "$IMAGE" = 1 ]; then
        warn "NetworkManager not running here (image / dry run, continuing)"
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

PACKAGES="git curl ca-certificates xz-utils alsa-utils avahi-daemon i2c-tools python3 rsync polkitd"
# update: apt only if something is missing (saves minutes on the Zero)
MISSING=0
for p in $PACKAGES; do
    dpkg -s "$p" > /dev/null 2>&1 || MISSING=1
done
if [ "$UPDATE" = 1 ] && [ "$MISSING" = 0 ]; then
    ok "packages present"
else
    run apt-get update -qq
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $PACKAGES > /dev/null
    ok "git, alsa-utils, avahi-daemon, i2c-tools, python3, rsync, polkitd"
fi

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
if [ "$SRC" = "$TARGET" ]; then
    # update.sh: the new code is already here (git reset)
    ok "code in place ($(git -C "$TARGET" rev-parse --short HEAD 2> /dev/null || echo "no git"))"
else
    # with .git: the box updates itself later (UPDATE page)
    run rsync -a --delete \
        --exclude node_modules --exclude dist --exclude data --exclude .local-types \
        --exclude '__pycache__' "$SRC/" "$TARGET/"
    ok "copied"
fi
if [ -d "$SRC/.git" ]; then
    ok "git checkout - updates from the UPDATE page"
else
    warn "no git checkout ($SRC) - the UPDATE page will not work; install from a git clone"
fi

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

CURRENT_HOST="$(cat /etc/hostname 2> /dev/null || hostname)"
if [ "$IMAGE" = 1 ]; then
    # chroot: no hostnamectl
    echo "$HOSTNAME_NEW" | put /etc/hostname
    if grep -q '^127\.0\.1\.1' /etc/hosts; then
        run sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_NEW/" /etc/hosts
    elif [ "$DRY" = 1 ]; then
        echo "    [dry-run] add 127.0.1.1 $HOSTNAME_NEW to /etc/hosts"
    else
        printf '127.0.1.1\t%s\n' "$HOSTNAME_NEW" >> /etc/hosts
    fi
    ok "$HOSTNAME_NEW (image)"
elif [ "$CURRENT_HOST" = "$HOSTNAME_NEW" ]; then
    ok "already set"
else
    REBOOT=1
    run hostnamectl set-hostname "$HOSTNAME_NEW"
    if grep -q '^127\.0\.1\.1' /etc/hosts; then
        run sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_NEW/" /etc/hosts
    else
        [ "$DRY" = 1 ] && echo "    [dry-run] add 127.0.1.1 $HOSTNAME_NEW to /etc/hosts" || printf '127.0.1.1\t%s\n' "$HOSTNAME_NEW" >> /etc/hosts
    fi
    ok "$CURRENT_HOST -> $HOSTNAME_NEW"
fi
if [ "$IMAGE" = 1 ]; then
    run systemctl enable avahi-daemon > /dev/null 2>&1 || warn "avahi-daemon could not be enabled"
else
    run systemctl enable --now avahi-daemon > /dev/null 2>&1 || warn "avahi-daemon could not be started"
fi
ok "http://$HOSTNAME_NEW.local"

# ---------------------------------------------------------------------
step "I2C and Wi-Fi country"

if [ "$IMAGE" = 1 ]; then
    # chroot: straight into config.txt / modules; the Wi-Fi country is
    # set at the first boot (scripts/boot.sh)
    if [ "$DRY" = 1 ]; then
        echo "    [dry-run] dtparam=i2c_arm=on in config.txt, i2c-dev in /etc/modules"
    else
        for boot in /boot/firmware /boot; do
            if [ -f "$boot/config.txt" ]; then
                grep -q '^dtparam=i2c_arm=on' "$boot/config.txt" || echo 'dtparam=i2c_arm=on' >> "$boot/config.txt"
                break
            fi
        done
        grep -qx 'i2c-dev' /etc/modules 2> /dev/null || echo 'i2c-dev' >> /etc/modules
    fi
    ok "I2C on (image), Wi-Fi country $COUNTRY at the first boot"
elif command -v raspi-config > /dev/null; then
    if [ "$(raspi-config nonint get_i2c 2> /dev/null || echo 1)" != 0 ]; then
        REBOOT=1
        run raspi-config nonint do_i2c 0
    fi
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
step "USB"

# Pi Zero / Zero 2 W (dwc_otg): full-speed devices behind the radio's
# high-speed hub (CAT bridge, sound card) make the whole hub drop out
# now and then. At full speed (12 Mbit/s, plenty for CAT and audio) the
# problem is gone. Not on the Pi 3: its Ethernet hangs on the same bus.
MODEL="$( { tr -d '\0' < /proc/device-tree/model; } 2> /dev/null || echo unknown)"
CMDLINE=""
for f in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    [ -f "$f" ] && { CMDLINE="$f"; break; }
done

if [ "$IMAGE" = 1 ]; then
    ok "image: set at the first boot on a Pi Zero (yaesu-remote-boot)"
elif [[ "$MODEL" != *"Pi Zero"* ]]; then
    ok "$MODEL: nothing to do"
elif [ "$USB_FULLSPEED" = 0 ]; then
    warn "$MODEL: USB full speed skipped (--no-usb-fullspeed)"
elif [ -z "$CMDLINE" ]; then
    warn "cmdline.txt not found - add dwc_otg.speed=1 yourself"
elif grep -qw 'dwc_otg.speed=1' "$CMDLINE"; then
    ok "$MODEL: USB full speed already set"
else
    REBOOT=1
    run cp "$CMDLINE" "$CMDLINE.yaesu-remote.bak"
    run sed -i '1 s/[[:space:]]*$/ dwc_otg.speed=1/' "$CMDLINE"
    ok "$MODEL: USB full speed (dwc_otg.speed=1 in $CMDLINE, backup .yaesu-remote.bak)"
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
ok "polkit rule: $USER_NAME may manage Wi-Fi and start the update"

put /etc/systemd/system/yaesu-remote-update@.service < "$SRC/system/yaesu-remote-update@.service"
ok "yaesu-remote-update@.service (software update)"

put /etc/systemd/system/yaesu-remote-boot.service < "$SRC/system/yaesu-remote-boot.service"
ok "yaesu-remote-boot.service (USB, swap, Wi-Fi country, service access)"

# own setup Wi-Fi: captive page (every name -> the box) and the switch
# in config.json of the server
if [ "$SETUP_HOTSPOT" = 1 ]; then
    run mkdir -p /etc/NetworkManager/dnsmasq-shared.d
    echo "address=/#/10.42.0.1" | put /etc/NetworkManager/dnsmasq-shared.d/yaesu-remote-captive.conf
else
    run rm -f /etc/NetworkManager/dnsmasq-shared.d/yaesu-remote-captive.conf
fi
if [ "$DRY" = 1 ]; then
    echo "    [dry-run] wifi.hotspot=$SETUP_HOTSPOT in $DATA/config.json"
else
    "$NODE_BIN" -e '
        const fs = require("fs"); const f = process.argv[1];
        let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
        c.wifi = { ...(c.wifi || {}), hotspot: process.argv[2] === "1" };
        fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");' "$DATA/config.json" "$SETUP_HOTSPOT"
    chown "$USER_NAME:$USER_NAME" "$DATA/config.json"
fi
ok "setup Wi-Fi YAESU-REMOTE-Setup when offline: $( [ "$SETUP_HOTSPOT" = 1 ] && echo on || echo off)"

# options for the next run / update
run mkdir -p "$(dirname "$CONF")"
printf '%s\n' \
    "# YAESU-REMOTE install options (written by scripts/install.sh)" \
    "HOSTNAME_NEW=$HOSTNAME_NEW" "COUNTRY=$COUNTRY" "OLED=$OLED" \
    "OLED_DRIVER=$OLED_DRIVER" "PORT=$PORT" "USB_FULLSPEED=$USB_FULLSPEED" \
    "SETUP_HOTSPOT=$SETUP_HOTSPOT" | put "$CONF"
ok "options saved ($CONF)"

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

if [ "$IMAGE" = 1 ]; then
    # the customer starts with the setup assistant (routes/setup.ts)
    echo '{ "pending": true }' | put "$DATA/setup.json"
    run chown "$USER_NAME:$USER_NAME" "$DATA/setup.json"
    ok "setup assistant on the first visit"
    # chroot: only enabled, they start on the first boot
    run systemctl enable yaesu-remote yaesu-remote-boot > /dev/null
    if [ "$OLED" = 1 ]; then
        run systemctl enable yaesu-remote-oled > /dev/null
    fi
    ok "enabled (start at the first boot)"
else
    run systemctl daemon-reload
    run systemctl restart polkit 2> /dev/null || true
    run systemctl enable yaesu-remote yaesu-remote-boot > /dev/null 2>&1
    run systemctl restart yaesu-remote
    if [ "$OLED" = 1 ]; then
        run systemctl enable yaesu-remote-oled > /dev/null 2>&1
        run systemctl restart yaesu-remote-oled
    else
        run systemctl disable --now yaesu-remote-oled > /dev/null 2>&1 || true
    fi
    ok "started"
fi

# ---------------------------------------------------------------------
step "Check"

if [ "$DRY" = 1 ]; then
    echo "    [dry-run] wait for http://127.0.0.1:$PORT/api/status"
elif [ "$IMAGE" = 1 ]; then
    ok "image: the server starts at the first boot"
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
if [ "$IMAGE" = 1 ]; then
    echo "${GREEN}${BOLD}YAESU-REMOTE is in the image.${OFF}"
    exit 0
fi
echo "${GREEN}${BOLD}YAESU-REMOTE is $( [ "$UPDATE" = 1 ] && echo updated || echo installed ).${OFF}"
echo "  Remote:  http://$HOSTNAME_NEW.local$P   ${IP:+or http://$IP$P}"
echo "  Wi-Fi:   http://$HOSTNAME_NEW.local$P/wifi.html"
echo "  Logs:    journalctl -u yaesu-remote -f"
[ "$OLED" = 1 ] && echo "  OLED:    journalctl -u yaesu-remote-oled -f   (I2C becomes active after a reboot)"
[ "$REBOOT" = 1 ] && echo "  ${YELLOW}Please reboot now (hostname / I2C / USB settings): sudo reboot${OFF}"
echo
