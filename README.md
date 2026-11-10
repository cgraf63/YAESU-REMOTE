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

## Test without a radio

`tools/sim/yaesu_sim.py` simulates an FTX-1 or FTDX10 on a virtual serial port (Python 3, standard library only):

```sh
python3 tools/sim/yaesu_sim.py --model ftx1 --link /tmp/yaesu-sim      # or --model ftdx10
CAT_DEVICE=/tmp/yaesu-sim AUDIO=off npm run dev
```

Options: `--head spa1` (FTX-1 with SPA-1), `--refuse-bs` (BS answered with `?`, tests the band fallback), `--verbose`.

## API

| | |
|---|---|
| `GET /api/status` | server and detection status |
| `GET /api/radio` | state (409 while no radio is connected) |
| `GET /api/radio/profile` | what the radio can do, CTCSS / DCS tables |
| `POST /api/radio/control` | `{ control, value }` |
| `GET /api/radio/memories`, `POST …/store`, `POST …/rename` | memory channels (FTX-1) |
| `WS /audio`, `WS /audio-tx` | RX / TX audio, 48 kHz, 16 bit, mono |

## Roadmap

1. ~~Slim server, FTX-1 + FTDX10 drivers, detection, adaptive page~~
2. FT-710 driver (CAT manual + Hamlib)
3. Wi-Fi setup with NetworkManager: hotspot `YAESU-REMOTE-Setup`, then `yaesu-remote.local`, hotspot again when the Wi-Fi is gone
4. HTTPS (browser microphone for TX), Opus audio for mobile use
5. SD card image for the Zero 2 W
