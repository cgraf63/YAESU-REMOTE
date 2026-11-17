#!/usr/bin/env bash
#
# YAESU-REMOTE - at every boot, as root, before the server
# (yaesu-remote-boot.service). Each part does something only when needed:
#
#   1. Pi Zero / Zero 2 W: USB at full speed (dwc_otg.speed=1 in
#      cmdline.txt) - after adding it, one reboot. Skipped with
#      USB_FULLSPEED=0 in /etc/yaesu-remote/install.conf.
#   2. Less than 1.5 GB RAM (Zero 2 W): 1 GB swap file, so that a
#      software update (npm install + build on the Pi) does not run out
#      of memory.
#   3. Wi-Fi country: if none is set yet, COUNTRY from install.conf.
#   4. Service access without a screen: a file yaesu-access.txt on the
#      boot partition with  user=admin  and  password=...  creates that
#      user (sudo), switches SSH on, and is deleted. The service user
#      "yaesu" is never touched.
#
# On the ready-made image this does what the installer does on a Pi it
# runs on - the image is built without knowing which Pi it will get.

set -u

CONF=/etc/yaesu-remote/install.conf
USB_FULLSPEED=1
COUNTRY=CH
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

BOOT=""
for d in /boot/firmware /boot; do
    [ -f "$d/config.txt" ] && { BOOT="$d"; break; }
done

log() { echo "yaesu-remote-boot: $*"; }


# 1. USB full speed on the Zero ------------------------------------------

MODEL="$( { tr -d '\0' < /proc/device-tree/model; } 2> /dev/null || echo unknown)"
CMDLINE="${BOOT:+$BOOT/cmdline.txt}"

if [[ "$MODEL" == *"Pi Zero"* ]] && [ "$USB_FULLSPEED" != 0 ] && [ -n "$CMDLINE" ] && [ -f "$CMDLINE" ]; then
    if ! grep -qw 'dwc_otg.speed=1' "$CMDLINE"; then
        cp "$CMDLINE" "$CMDLINE.yaesu-remote.bak"
        sed -i '1 s/[[:space:]]*$/ dwc_otg.speed=1/' "$CMDLINE"
        if grep -qw 'dwc_otg.speed=1' "$CMDLINE"; then
            log "$MODEL: USB full speed set - rebooting once"
            sync
            systemctl --no-block reboot
            exit 0
        fi
        log "could not change $CMDLINE"
    fi
fi


# 2. swap for little RAM -------------------------------------------------

SWAPFILE=/var/swap.yaesu-remote
MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"

if [ "${MEM_KB:-0}" -lt 1572864 ]; then
    if ! grep -q "^$SWAPFILE " /etc/fstab; then
        FREE_MB="$(df -Pm /var | awk 'NR==2 {print $4}')"
        if [ "${FREE_MB:-0}" -ge 1536 ]; then
            log "${MEM_KB} kB RAM - creating 1 GB swap ($SWAPFILE)"
            rm -f "$SWAPFILE"
            fallocate -l 1024M "$SWAPFILE" 2> /dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=1024 status=none
            chmod 600 "$SWAPFILE"
            mkswap "$SWAPFILE" > /dev/null
            echo "$SWAPFILE none swap sw,pri=5 0 0" >> /etc/fstab
        else
            log "not enough space for swap (${FREE_MB} MB free)"
        fi
    fi
    if grep -q "^$SWAPFILE " /etc/fstab && ! swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
        swapon "$SWAPFILE" || true
    fi
fi


# 3. Wi-Fi country -------------------------------------------------------

if command -v raspi-config > /dev/null && [ -z "$(raspi-config nonint get_wifi_country 2> /dev/null || true)" ]; then
    raspi-config nonint do_wifi_country "$COUNTRY" > /dev/null 2>&1 && log "Wi-Fi country $COUNTRY"
fi


# 4. service access (yaesu-access.txt) -------------------------------------

FILE=""
[ -n "$BOOT" ] && [ -f "$BOOT/yaesu-access.txt" ] && FILE="$BOOT/yaesu-access.txt"

if [ -n "$FILE" ]; then

    # Windows editors: CRLF, BOM
    CONTENT="$(sed -e 's/\r$//' -e '1s/^\xEF\xBB\xBF//' "$FILE")"
    USER_IN="$(printf '%s\n' "$CONTENT" | sed -n 's/^[[:space:]]*user[[:space:]]*=[[:space:]]*//p' | head -1 | tr -d '[:space:]')"
    PASS_IN="$(printf '%s\n' "$CONTENT" | sed -n 's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//p' | head -1)"
    PASS_IN="${PASS_IN%"${PASS_IN##*[![:space:]]}"}"

    # the file goes in any case: the password does not stay on the card
    shred -u "$FILE" 2> /dev/null || rm -f "$FILE"

    USER_IN="${USER_IN:-admin}"

    if ! [[ "$USER_IN" =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || [ "$USER_IN" = yaesu ] || [ "$USER_IN" = root ]; then
        log "yaesu-access.txt: invalid user name '$USER_IN'"
    elif [ ${#PASS_IN} -lt 6 ]; then
        log "yaesu-access.txt: password too short (at least 6 characters)"
    else
        id "$USER_IN" > /dev/null 2>&1 || useradd --create-home --shell /bin/bash --comment "YAESU-REMOTE service access" "$USER_IN"
        for g in sudo adm dialout audio video plugdev netdev i2c; do
            getent group "$g" > /dev/null && usermod -aG "$g" "$USER_IN"
        done
        printf '%s:%s\n' "$USER_IN" "$PASS_IN" | chpasswd
        systemctl enable --now ssh > /dev/null 2>&1 || true
        log "service access: user $USER_IN, SSH on - ssh $USER_IN@$(hostname).local"
    fi

fi

exit 0
