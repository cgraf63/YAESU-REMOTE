# YAESU-REMOTE

Small Wi-Fi box (Raspberry Pi Zero 2 W) for remote control of Yaesu **FTX-1**, **FTDX10** and **FT-710** in the browser. Spin-off of [SHACK-SERVER](https://github.com/cgraf63/SHACK-SERVER).

One page in the FTX-1 design for all radios. The server detects the transceiver (`ID;`) and the page adapts:

| | FTX-1 | FTDX10 | FT-710 |
|---|---|---|---|
| Sides | MAIN / SUB (two receivers) | VFO A / B | VFO A / B |
| Bands | HF, 6 m, 2 m, 70 cm, AIR | HF, 6 m | HF, 6 m |
| Extras | C4FM, FM tone, memory channels | roofing filter, ATT 6/12/18 dB | – |
| Power | 0.5–10 W (field), 5–100 W (SPA-1) | 5–100 W | 5–100 W |
| Status | working | working (simulator; test on the radio pending) | driver follows |

Role tags under the two frequencies: FTX-1 – transmitting side red **TRX**, other side green **RX**. FTDX10 / FT-710 – without split the active VFO shows red **TRX**; in split the active VFO shows green **RX** and the other one red **TX**.

## Install on the Raspberry Pi

Raspberry Pi OS Lite (Bookworm or newer, 32 or 64 bit) on a Zero 2 W, 3, 4 or 5. Write the card with the Raspberry Pi Imager (user, SSH and – if you like – Wi-Fi in its settings), then on the Pi:

```sh
sudo apt install -y git
git clone -b feature/server-core https://github.com/cgraf63/YAESU-REMOTE.git
cd YAESU-REMOTE
sudo ./scripts/install.sh            # options: --oled-driver sh1106, --no-oled, --port 8080, --dry-run
sudo reboot
```

The script installs Node.js 22, creates the user `yaesu`, puts the code as a git checkout into `/opt/yaesu-remote` and builds it there, sets the hostname `yaesu-remote`, turns on I2C and installs the services (`yaesu-remote` on port 80, `yaesu-remote-oled`, `yaesu-remote-update@`) and the polkit rule. The options of the first run are kept in `/etc/yaesu-remote/install.conf`. Later updates: from the browser (below), or `git pull` and the script again.

Radio: USB cable to the Pi's **USB** port (not PWR) – on the Zero 2 W with a micro-USB OTG adapter or cable.

Pi Zero / Zero 2 W: the script adds `dwc_otg.speed=1` to `cmdline.txt` (USB at 12 Mbit/s). Without it the radio's internal USB hub (CAT bridge + sound card) dropped out every 30–60 s on the Zero's USB controller. Skip with `--no-usb-fullspeed`.

Audio: the sound card on the radio's USB hub is found automatically (FTDX10 “CODEC”, FTX-1 C-Media “Device”); set `audio.device` / `AUDIO_DEVICE` to override.

## Run (development)

Node 22. Only runtime dependency: `ws` (audio WebSocket). The serial port is opened directly (`stty` + `/dev/ttyUSB…`), no native modules.

```sh
npm install
npm run dev          # http://localhost:8080
npm run build && npm start
```

Configuration is optional – `data/config.json` or environment:

| Setting | Env | Default |
|---|---|---|
| HTTP port | `PORT` | 8080 |
| CAT device | `CAT_DEVICE` | `auto` (CP2105 interface 00 via `/dev/serial/by-id`, else `ttyUSB*` / `ttyACM*`) |
| CAT baud rate | `CAT_BAUD` | auto: 38400, 115200, 19200, 9600, 4800 |
| Audio device | `AUDIO_DEVICE` | `auto` (sound card on the radio's USB hub) |
| Audio on/off | `AUDIO=off` | on |
| Data directory | `YAESU_DATA` | `./data` |

The box notices when the radio is swapped (other model answers `ID;`, or connection lost for 20 s) and searches again.

## Wi-Fi (no hotspot on the Pi)

The box joins the home router or the phone hotspot. Setup in the browser: **WI-FI** on the remote page (`/wifi.html`).

- **First start:** turn on a phone hotspot `YAESU-REMOTE`, password `yaesu-remote` (2.4 GHz / iPhone “Maximise Compatibility”). The box joins it; open `http://yaesu-remote.local` or the address shown in the phone's hotspot settings.
- **Or** put `wifi.txt` on the boot drive of the SD card (see `system/wifi.txt.example`): `ssid=` / `password=` pairs, best first, optional `country=`. Imported at start, passwords are removed from the file afterwards.
- **Saved networks in order** (NetworkManager autoconnect priority 100, 90, …): the box takes the first one in range. The setup network always stays last (priority −100) and cannot be deleted.
- **Switching** warns first (the page loses the connection). If the new network does not come up within 30 s, the box goes back to the previous one.
- **ntfy:** with a topic set, the box sends “YAESU-REMOTE online – 192.168.x.x” with a link whenever it gets a new address (Android often cannot open `.local` names).

On the Pi: `system/yaesu-remote.service` (systemd, user `yaesu`, imports `wifi.txt` as root before the start) and `system/50-yaesu-remote.rules` (polkit: user `yaesu` may manage NetworkManager, no sudo).

## Software update

The version is shown at the top of the remote page (`v0.2.0`); when a newer one is on GitHub it turns into a yellow **UPDATE 0.2.1** button. The **UPDATE** page (`/update.html`) shows the installed version, the new changes and the log of the last update.

- **Check:** the box asks GitHub (`git fetch`, the branch it was installed from) 3 minutes after the start and then every 12 hours, or with **CHECK NOW**. Only the changes are downloaded.
- **Install:** about a minute – new code (`git reset` to the branch on GitHub), build, restart. The OLED shows **UPDATE**, then the new version. If the new version does not build, the box goes back to the old one. Not possible while the radio transmits.
- **How:** the server (user `yaesu`) only reads the checkout; fetching and installing run as root in `yaesu-remote-update@check` / `@install` (`scripts/update.sh`), which the polkit rule lets it start – nothing else. By hand: `sudo systemctl start yaesu-remote-update@install`, log in `/var/lib/yaesu-remote/update.log`.
- **Version number:** `version` in `package.json` plus the commits after it – `0.2.0` + 3 commits = `0.2.3`. A new `version` (e.g. `0.3.0`) starts counting again.

## OLED status display (optional)

A 0.96" I2C OLED (SSD1306, 128 × 64; 1.3" SH1106 works too) shows the software version for 3 s at the start (and “UPDATED TO …” after an update), then the radio with frequency and mode (model inverted while transmitting), the Wi-Fi network with signal, the IP address and a turning logo – as long as it turns, the Pi is running. Without Wi-Fi it shows the setup hotspot name.

Wiring: VCC → pin 1 (3.3 V), GND → pin 6, SDA → pin 3, SCL → pin 5. `oled/yaesu_oled.py` uses the Python standard library only (I2C directly via `/dev/i2c-1`); service: `system/yaesu-remote-oled.service`. Preview without a display: `python3 oled/yaesu_oled.py --demo --png preview.png` (`--screen version|updated|updating` for the other screens).

## Test without a radio

`tools/sim/yaesu_sim.py` simulates an FTX-1 or FTDX10 on a virtual serial port (Python 3, standard library only):

```sh
python3 tools/sim/yaesu_sim.py --model ftx1 --link /tmp/yaesu-sim      # or --model ftdx10
CAT_DEVICE=/tmp/yaesu-sim AUDIO=off npm run dev
```

Options: `--head spa1` (FTX-1 with SPA-1), `--refuse-bs` (BS answered with `?`, tests the band fallback), `--verbose`.

Wi-Fi page without NetworkManager: `NMCLI=tools/sim/fake_nmcli.py` (state in `/tmp/fake-nmcli.json`: networks in range with their passwords, saved connections). A wrong password makes the switch fail and fall back, like on the Pi.

## API

| | |
|---|---|
| `GET /api/status` | server and detection status |
| `GET /api/radio` | state (409 while no radio is connected) |
| `GET /api/radio/profile` | what the radio can do, CTCSS / DCS tables |
| `POST /api/radio/control` | `{ control, value }` |
| `GET /api/radio/memories`, `POST …/store`, `POST …/rename` | memory channels (FTX-1) |
| `GET /api/wifi`, `…/saved`, `…/scan` | Wi-Fi status, saved networks, networks in range |
| `POST /api/wifi/add`, `…/remove`, `…/order`, `…/connect` | manage networks, switch with fallback |
| `GET/POST /api/wifi/ntfy`, `POST …/ntfy/test` | ntfy message with the address |
| `GET /api/update`, `POST …/check`, `POST …/install` | software version, new commits, install (server restarts) |
| `GET /api/display` | everything the OLED shows (radio, frequency, Wi-Fi, IP, version, update running) |
| `WS /audio`, `WS /audio-tx` | RX / TX audio, 48 kHz, 16 bit, mono |

## Roadmap

1. ~~Slim server, FTX-1 + FTDX10 drivers, detection, adaptive page~~
2. FT-710 driver (CAT manual + Hamlib)
3. ~~Wi-Fi setup in the browser (no hotspot on the Pi): setup network, `wifi.txt`, ordered networks, fallback, ntfy~~ – test on the Zero 2 W pending
4. HTTPS (browser microphone for TX), Opus audio for mobile use
5. ~~Software update from the browser, version on page and OLED~~
6. SD card image for the Zero 2 W
