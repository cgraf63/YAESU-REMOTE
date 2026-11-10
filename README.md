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

## Run

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
| Audio device | `AUDIO_DEVICE` | `plughw:CARD=CODEC,DEV=0` (USB sound card of the radio) |
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

## OLED status display (optional)

A 0.96" I2C OLED (SSD1306, 128 × 64; 1.3" SH1106 works too) shows the radio with frequency and mode (model inverted while transmitting), the Wi-Fi network with signal, the IP address and a turning logo – as long as it turns, the Pi is running. Without Wi-Fi it shows the setup hotspot name.

Wiring: VCC → pin 1 (3.3 V), GND → pin 6, SDA → pin 3, SCL → pin 5. `oled/yaesu_oled.py` uses the Python standard library only (I2C directly via `/dev/i2c-1`); service: `system/yaesu-remote-oled.service`. Preview without a display: `python3 oled/yaesu_oled.py --demo --png preview.png`.

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
| `GET /api/display` | everything the OLED shows (radio, frequency, Wi-Fi, IP) |
| `WS /audio`, `WS /audio-tx` | RX / TX audio, 48 kHz, 16 bit, mono |

## Roadmap

1. ~~Slim server, FTX-1 + FTDX10 drivers, detection, adaptive page~~
2. FT-710 driver (CAT manual + Hamlib)
3. ~~Wi-Fi setup in the browser (no hotspot on the Pi): setup network, `wifi.txt`, ordered networks, fallback, ntfy~~ – test on the Zero 2 W pending
4. HTTPS (browser microphone for TX), Opus audio for mobile use
5. SD card image for the Zero 2 W
