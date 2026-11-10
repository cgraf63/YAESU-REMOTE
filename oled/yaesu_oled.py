#!/usr/bin/env python3
"""
YAESU-REMOTE - status on a small I2C OLED (128 x 64)

0.96" modules (SSD1306) and 1.3" modules (SH1106), I2C address 0x3C.
Python 3 standard library only: the display is driven directly through
/dev/i2c-1 (no luma, no Pillow, nothing to install).

    +----------------------------+
    |        YAESU-REMOTE        |   title (yellow band on two-color modules)
    |  FTX-1               (*)   |   radio, rotating node logo = Pi is running
    |  14.074.000 DATA-U         |   frequency + mode of the active side
    |  ~ HB9OM-HOME         ...l |   Wi-Fi network + signal
    |    192.168.1.23            |   address of the box
    +----------------------------+

Data from the YAESU-REMOTE server (GET /api/display, once a second).
The logo keeps turning even when the server is not reachable: then the
Pi runs, but the server does not.

    python3 oled/yaesu_oled.py                     # SSD1306 on /dev/i2c-1, server http://127.0.0.1
    python3 oled/yaesu_oled.py --driver sh1106     # 1.3" module
    python3 oled/yaesu_oled.py --png preview.png   # one frame as picture (no display needed)
    python3 oled/yaesu_oled.py --demo --png x.png  # with demo data

Wiring (Pi header): VCC pin 1 (3.3 V), GND pin 6, SDA pin 3, SCL pin 5.
I2C must be on: raspi-config nonint do_i2c 0 (the install script does it).
"""

import argparse
import fcntl
import json
import os
import signal
import struct
import sys
import time
import urllib.request
import zlib

WIDTH, HEIGHT = 128, 64
I2C_SLAVE = 0x0703


# ======================================================================
# 4 x 7 pixel font (same style as the SHACK-SERVER display)
# ======================================================================

FONT = {
    "A": ["0110", "1001", "1001", "1111", "1001", "1001", "1001"],
    "B": ["1110", "1001", "1001", "1110", "1001", "1001", "1110"],
    "C": ["0111", "1000", "1000", "1000", "1000", "1000", "0111"],
    "D": ["1110", "1001", "1001", "1001", "1001", "1001", "1110"],
    "E": ["1111", "1000", "1000", "1110", "1000", "1000", "1111"],
    "F": ["1111", "1000", "1000", "1110", "1000", "1000", "1000"],
    "G": ["0111", "1000", "1000", "1011", "1001", "1001", "0111"],
    "H": ["1001", "1001", "1001", "1111", "1001", "1001", "1001"],
    "I": ["111", "010", "010", "010", "010", "010", "111"],
    "J": ["0001", "0001", "0001", "0001", "0001", "1001", "0110"],
    "K": ["1001", "1010", "1100", "1100", "1010", "1001", "1001"],
    "L": ["1000", "1000", "1000", "1000", "1000", "1000", "1111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["1001", "1101", "1101", "1011", "1011", "1001", "1001"],
    "O": ["0110", "1001", "1001", "1001", "1001", "1001", "0110"],
    "P": ["1110", "1001", "1001", "1110", "1000", "1000", "1000"],
    "Q": ["0110", "1001", "1001", "1001", "1011", "1010", "0101"],
    "R": ["1110", "1001", "1001", "1110", "1010", "1001", "1001"],
    "S": ["0111", "1000", "1000", "0110", "0001", "0001", "1110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["1001", "1001", "1001", "1001", "1001", "1001", "0110"],
    "V": ["1001", "1001", "1001", "1001", "1001", "0110", "0110"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "X": ["1001", "1001", "0110", "0110", "0110", "1001", "1001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["1111", "0001", "0010", "0110", "0100", "1000", "1111"],
    "0": ["0110", "1001", "1011", "1101", "1001", "1001", "0110"],
    "1": ["010", "110", "010", "010", "010", "010", "111"],
    "2": ["0110", "1001", "0001", "0010", "0100", "1000", "1111"],
    "3": ["1110", "0001", "0001", "0110", "0001", "0001", "1110"],
    "4": ["0010", "0110", "1010", "1010", "1111", "0010", "0010"],
    "5": ["1111", "1000", "1110", "0001", "0001", "1001", "0110"],
    "6": ["0110", "1000", "1000", "1110", "1001", "1001", "0110"],
    "7": ["1111", "0001", "0010", "0010", "0100", "0100", "0100"],
    "8": ["0110", "1001", "1001", "0110", "1001", "1001", "0110"],
    "9": ["0110", "1001", "1001", "0111", "0001", "0001", "0110"],
    " ": ["000", "000", "000", "000", "000", "000", "000"],
    ".": ["0", "0", "0", "0", "0", "0", "1"],
    ",": ["0", "0", "0", "0", "0", "1", "1"],
    ":": ["0", "0", "1", "0", "0", "1", "0"],
    "-": ["0000", "0000", "0000", "1111", "0000", "0000", "0000"],
    "_": ["0000", "0000", "0000", "0000", "0000", "0000", "1111"],
    "+": ["000", "000", "010", "111", "010", "000", "000"],
    "=": ["0000", "0000", "1111", "0000", "1111", "0000", "0000"],
    "/": ["0001", "0001", "0010", "0010", "0100", "0100", "1000"],
    "%": ["1001", "0001", "0010", "0110", "0100", "1000", "1001"],
    "(": ["01", "10", "10", "10", "10", "10", "01"],
    ")": ["10", "01", "01", "01", "01", "01", "10"],
    ">": ["000", "100", "010", "001", "010", "100", "000"],
    "<": ["000", "001", "010", "100", "010", "001", "000"],
    "!": ["1", "1", "1", "1", "1", "0", "1"],
    "?": ["0110", "1001", "0001", "0010", "0100", "0000", "0100"],
    "'": ["1", "1", "0", "0", "0", "0", "0"],
    "#": ["01010", "11111", "01010", "01010", "11111", "01010", "00000"],
    "*": ["0000", "1001", "0110", "1111", "0110", "1001", "0000"],
    "&": ["0100", "1010", "1010", "0100", "1011", "1010", "0101"],
}


# ======================================================================
# Frame buffer (1 bit, page layout like the controller: 8 rows per byte)
# ======================================================================

class Frame:

    def __init__(self):
        self.buf = bytearray(WIDTH * HEIGHT // 8)

    def pixel(self, x, y, on=True):
        if 0 <= x < WIDTH and 0 <= y < HEIGHT:
            i = (y // 8) * WIDTH + x
            if on:
                self.buf[i] |= 1 << (y % 8)
            else:
                self.buf[i] &= ~(1 << (y % 8)) & 0xFF

    def get(self, x, y):
        return bool(self.buf[(y // 8) * WIDTH + x] & (1 << (y % 8)))

    def rect(self, x0, y0, x1, y1, fill=False, on=True):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if fill or y in (y0, y1) or x in (x0, x1):
                    self.pixel(x, y, on)

    def hline(self, x0, x1, y, step=1):
        for x in range(x0, x1 + 1, step):
            self.pixel(x, y)

    def line(self, x0, y0, x1, y1):
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.pixel(x0, y0)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def disc(self, cx, cy, r, on=True):
        for y in range(-r, r + 1):
            for x in range(-r, r + 1):
                if x * x + y * y <= r * r + r // 2:
                    self.pixel(cx + x, cy + y, on)

    def text(self, s, x, y, scale=1, on=True):
        """draws s, returns the x after the last character"""
        for ch in s.upper():
            glyph = FONT.get(ch, FONT["?"])
            for row, bits in enumerate(glyph):
                for col, bit in enumerate(bits):
                    if bit == "1":
                        for dy in range(scale):
                            for dx in range(scale):
                                self.pixel(x + col * scale + dx, y + row * scale + dy, on)
            x += (len(glyph[0]) + 1) * scale
        return x


def text_width(s, scale=1):
    if not s:
        return 0
    return sum((len(FONT.get(ch, FONT["?"])[0]) + 1) * scale for ch in s.upper()) - scale


def fit(s, width, scale=1):
    """cut s so that it fits into width pixels (with .. at the end)"""
    s = s.upper()
    if text_width(s, scale) <= width:
        return s
    while s and text_width(s + "..", scale) > width:
        s = s[:-1]
    return s + ".."


# ======================================================================
# Screen
# ======================================================================

def format_frequency(hz):
    hz = int(hz or 0)
    if hz <= 0:
        return ""
    mhz, rest = divmod(hz, 1_000_000)
    khz, h = divmod(rest, 1000)
    return f"{mhz}.{khz:03d}.{h:03d}"


def draw_logo(f, cx, cy, active):
    """8 nodes around a center, one of them bigger - turns like on the SHACK-SERVER"""
    nodes = [(0, -9), (6, -6), (9, 0), (6, 6), (0, 9), (-6, 6), (-9, 0), (-6, -6)]
    for dx, dy in nodes:
        f.line(cx, cy, cx + dx, cy + dy)
    f.disc(cx, cy, 3)
    f.pixel(cx, cy, False)
    for i, (dx, dy) in enumerate(nodes):
        f.disc(cx + dx, cy + dy, 2 if i == active else 1)


def draw_wifi_icon(f, x, y):
    """7 x 7 Wi-Fi symbol"""
    for px, py in [(1, 1), (2, 0), (3, 0), (4, 0), (5, 1), (0, 2), (6, 2),
                   (2, 3), (3, 2), (4, 3), (3, 5), (2, 6), (3, 6), (4, 6)]:
        f.pixel(x + px, y + py)


def draw_bars(f, x, y, signal):
    lit = 4 if signal >= 75 else 3 if signal >= 50 else 2 if signal >= 25 else 1 if signal > 0 else 0
    for i in range(4):
        h = 2 + i * 2
        x0 = x + i * 3
        f.rect(x0, y + 7 - h, x0 + 1, y + 6, fill=i < lit)
        if i >= lit:
            f.rect(x0, y + 6, x0 + 1, y + 6, fill=True)


def render(data, tick, shift=0):
    """data = /api/display answer or None (server not reachable)"""

    f = Frame()
    x0 = 2 + shift   # burn-in protection: the content moves by one pixel now and then

    # --- title (rows 0-15: yellow band on two-color modules)
    title = "YAESU-REMOTE"
    f.text(title, (WIDTH - text_width(title, 2)) // 2 + shift, 1, 2)

    # --- logo: proves that the Pi runs
    draw_logo(f, 114 + shift, 28, tick % 8)

    dots = "." * (tick // 3 % 4)

    if data is None:
        f.text("SERVER", x0, 19, 2)
        f.text("STARTING" + dots, x0, 36)
        f.text(fit("NO CONNECTION", 100), x0, 48)
        return f

    radio = data.get("radio", {})
    wifi = data.get("wifi", {})

    # --- radio
    state = radio.get("state")
    if state == "connected":
        model = fit(radio.get("model", ""), 96, 2)
        if radio.get("tx"):
            # transmitting: model inverted
            w = text_width(model, 2)
            f.rect(x0 - 2, 18, x0 + w + 1, 33, fill=True)
            f.text(model, x0, 19, 2, on=False)
        else:
            f.text(model, x0, 19, 2)
        if radio.get("alive"):
            freq = format_frequency(radio.get("frequency"))
            line = f"{freq} {radio.get('mode', '')}".strip() if freq else "..."
            if radio.get("split"):
                line = fit(line, 82) + " S"
            f.text(fit(line, 100), x0, 37)
        else:
            f.text("NO ANSWER" + dots, x0, 37)
    elif state == "unsupported":
        f.text(fit(radio.get("model") or "RADIO", 96, 2), x0, 19, 2)
        f.text("NOT SUPPORTED", x0, 37)
    else:
        f.text("NO RADIO", x0, 19, 2)
        f.text("SEARCHING" + dots, x0, 37)

    # --- separator
    f.hline(x0, 125, 46, 2)

    # --- Wi-Fi
    draw_wifi_icon(f, x0, 48)
    if wifi.get("switching"):
        f.text(fit("> " + wifi["switching"], 110), x0 + 10, 48)
        f.text("SWITCHING" + dots, x0 + 10, 57)
    elif wifi.get("ip"):
        if wifi.get("ssid"):
            f.text(fit(wifi["ssid"], 98), x0 + 10, 48)
            draw_bars(f, 115, 48, wifi.get("signal", 0))
        else:
            f.text("WIRED", x0 + 10, 48)
        f.text(wifi["ip"], x0 + 10, 57)
    elif wifi.get("available"):
        # no network: show how to get in
        f.text("NO WIFI - HOTSPOT", x0 + 10, 48)
        f.text(fit(wifi.get("setupSsid", "YAESU-REMOTE"), 112), x0 + 10, 57)
    else:
        f.text("NO NETWORK", x0 + 10, 48)

    return f


def render_message(lines):
    f = Frame()
    f.text("YAESU-REMOTE", (WIDTH - text_width("YAESU-REMOTE", 2)) // 2, 1, 2)
    for i, line in enumerate(lines):
        f.text(fit(line, 124), (WIDTH - text_width(fit(line, 124))) // 2, 26 + i * 12)
    return f


# ======================================================================
# Display (I2C)
# ======================================================================

class Oled:

    def __init__(self, bus, address, driver, contrast, flip):
        self.driver = driver
        self.offset = 2 if driver == "sh1106" else 0
        self.fd = os.open(f"/dev/i2c-{bus}", os.O_RDWR)
        fcntl.ioctl(self.fd, I2C_SLAVE, address)
        self.shown = [None] * 8
        seg, com = (0xA0, 0xC0) if flip else (0xA1, 0xC8)
        if driver == "sh1106":
            init = [0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0xAD, 0x8B, seg, com,
                    0xDA, 0x12, 0x81, contrast, 0xD9, 0x22, 0xDB, 0x35, 0xA4, 0xA6, 0xAF]
        else:
            init = [0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x02, seg, com,
                    0xDA, 0x12, 0x81, contrast, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0x2E, 0xAF]
        self.command(*init)

    def command(self, *cmds):
        os.write(self.fd, bytes([0x00, *cmds]))

    def show(self, frame):
        """sends only the pages (8-row bands) that changed"""
        for page in range(8):
            data = bytes(frame.buf[page * WIDTH:(page + 1) * WIDTH])
            if self.shown[page] == data:
                continue
            col = self.offset
            self.command(0xB0 + page, 0x00 | (col & 0x0F), 0x10 | (col >> 4))
            for i in range(0, WIDTH, 32):
                os.write(self.fd, bytes([0x40]) + data[i:i + 32])
            self.shown[page] = data

    def off(self):
        try:
            self.command(0xAE)
        except OSError:
            pass

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass


# ======================================================================
# PNG preview (standard library: zlib)
# ======================================================================

def save_png(frame, path, scale=4):
    """two-color module look: rows 0-15 yellow, the rest blue"""
    w, h = WIDTH * scale + 2 * scale * 2, HEIGHT * scale + 2 * scale * 2
    pad = scale * 2
    rows = []
    for py in range(h):
        row = bytearray([0])
        for px in range(w):
            x, y = (px - pad) // scale, (py - pad) // scale
            if 0 <= x < WIDTH and 0 <= y < HEIGHT and frame.get(x, y):
                row += bytes((255, 214, 64) if y < 16 else (90, 190, 255))
            else:
                row += bytes((8, 10, 14))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


# ======================================================================
# Main loop
# ======================================================================

DEMO = {
    "radio": {"state": "connected", "model": "FTX-1", "alive": True, "frequency": 14074000, "mode": "DATA-U", "tx": False, "split": False},
    "wifi": {"available": True, "ssid": "HB9OM-Home", "ip": "192.168.1.23", "signal": 78, "switching": "", "setupSsid": "YAESU-REMOTE"},
}


def fetch(url):
    try:
        with urllib.request.urlopen(f"{url}/api/display", timeout=2) as response:
            return json.loads(response.read().decode())
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("YAESU_URL", "http://127.0.0.1"), help="YAESU-REMOTE server")
    ap.add_argument("--driver", choices=["ssd1306", "sh1106"], default=os.environ.get("OLED_DRIVER", "ssd1306"))
    ap.add_argument("--bus", type=int, default=int(os.environ.get("OLED_BUS", "1")))
    ap.add_argument("--address", type=lambda v: int(v, 0), default=int(os.environ.get("OLED_ADDRESS", "0x3C"), 0))
    ap.add_argument("--contrast", type=int, default=int(os.environ.get("OLED_CONTRAST", "128")))
    ap.add_argument("--flip", action="store_true", default=os.environ.get("OLED_FLIP") == "1", help="rotate 180 degrees")
    ap.add_argument("--png", help="write one frame as PNG and exit")
    ap.add_argument("--demo", action="store_true", help="demo data instead of the server")
    args = ap.parse_args()

    if args.png:
        data = DEMO if args.demo else fetch(args.url)
        save_png(render(data, 0), args.png)
        print(args.png)
        return

    oled = None
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    tick = 0
    data = None
    last_fetch = 0.0
    last_error = ""

    while running:

        if oled is None:
            try:
                oled = Oled(args.bus, args.address, args.driver, max(0, min(255, args.contrast)), args.flip)
                print(f"OLED: {args.driver} on /dev/i2c-{args.bus} @ 0x{args.address:02X}", flush=True)
                last_error = ""
            except OSError as error:
                if str(error) != last_error:
                    print(f"OLED: not found ({error}) - retrying every 10 s", flush=True)
                    last_error = str(error)
                oled = None
                time.sleep(10)
                continue

        now = time.time()
        if now - last_fetch >= 1.0:
            data = DEMO if args.demo else fetch(args.url)
            last_fetch = now

        # one pixel to the side every 5 minutes against burn-in
        shift = int(now // 300) % 2

        try:
            oled.show(render(data, tick, shift))
        except OSError as error:
            print(f"OLED: write failed ({error}) - reconnecting", flush=True)
            oled.close()
            oled = None
            continue

        tick += 1
        time.sleep(0.2)

    if oled:
        try:
            oled.show(render_message(["STOPPED"]))
            time.sleep(0.5)
        except OSError:
            pass
        oled.off()
        oled.close()


if __name__ == "__main__":
    sys.exit(main())
