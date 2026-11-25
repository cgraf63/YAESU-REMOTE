#!/usr/bin/env python3
"""
YAESU-REMOTE quick start (one A4 page): from the ready-made image to the
remote. Layout after the SHACK-SERVER quick start.

    python3 docs/quickstart/quickstart.py
        -> docs/quickstart/YAESU-REMOTE_Kurzanleitung_DE.pdf
           docs/quickstart/YAESU-REMOTE_QuickStart_EN.pdf

Needs: Python package playwright + Chromium (python -m playwright
install chromium); font "Inter" if installed (else Helvetica / Arial).
Text in TEXT, layout in CSS - both languages from one template.
"""

import html
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

PRODUCT = "YAESU-REMOTE"
HOST = "yaesu-remote"
URL = "github.com/cgraf63/YAESU-REMOTE"

TEXT = {
    "de": {
        "file": "YAESU-REMOTE_Kurzanleitung_DE.pdf",
        "title": "Kurzanleitung",
        "subtitle": "Yaesu FTX-1 / FTDX10 im Browser – in 10 Minuten bereit",
        "need_title": "Du brauchst",
        "need": [
            "<b>Raspberry Pi Zero 2 W</b> (auch Pi 3 / 4 / 5)",
            "<b>microSD-Karte</b> ab 8 GB, am besten A1 / A2",
            "<b>Netzteil</b> 5 V / 2,5 A Micro-USB für den Zero 2 W",
            "<b>USB-Kabel</b> vom Transceiver zum Pi – am Zero 2 W mit <b>Micro-USB-OTG</b>-Kabel oder -Adapter",
            "das Image <b>yaesu-remote-x.y.z-arm64.img.xz</b>",
            "ein <b>Handy</b> für die WLAN-Einrichtung",
        ],
        "oled_title": "OLED anschliessen (optional)",
        "oled_side": "SD-Karte",
        "oled_rows": [("VCC", "Pin 1", "3,3 V"), ("SDA", "Pin 3", "GPIO 2"),
                      ("SCL", "Pin 5", "GPIO 3"), ("GND", "Pin 6", "Masse")],
        "oled_note": "0,96\" SSD1306, I2C. Nur bei ausgeschaltetem Pi anschliessen; Beschriftung am "
                     "Modul beachten (oft GND, VCC, SCL, SDA).",
        "steps": [
            ("Karte schreiben",
             "<b>Raspberry Pi Imager</b> öffnen → Modell wählen → Betriebssystem: "
             "<b>Eigenes Image verwenden</b> → die <b>.img.xz</b> wählen → Speicher → <b>Schreiben</b>. "
             "Keine Anpassungen nötig (WLAN, Benutzer) – das macht die Box selbst."),
            ("Anschliessen und einschalten",
             "Karte in den Pi, Transceiver an die Buchse <b>USB</b> des Zero 2 W (nicht PWR) und einschalten, "
             "dann den Pi mit Strom versorgen. Der erste Start dauert 2–3 Minuten (ein Zero startet einmal neu)."),
            ("WLAN",
             "<b>Handy-Hotspot:</b> Name <b>YAESU-REMOTE</b>, Passwort <b>yaesu-remote</b> "
             "(2,4 GHz, iPhone: „Kompatibilität maximieren“) – die Box verbindet sich von selbst.<br>"
             "<b>Ohne Hotspot:</b> nach 3 Minuten erscheint das WLAN <b>YAESU-REMOTE-Setup</b>. Mit dem Handy "
             "verbinden, die WLAN-Seite öffnet sich (sonst <b>http://10.42.0.1</b>): eigenes WLAN, Passwort, "
             "<b>connect now</b>."),
            ("YAESU-REMOTE öffnen",
             "Im Browser (PC, Tablet oder Handy im selben Netz):"
             "<span class='url'>http://yaesu-remote.local</span>"
             "Der <b>Assistent</b> fragt weitere WLANs ab, auf Wunsch eine Handy-Nachricht mit der "
             "Adresse (ntfy), und zeigt, ob der Transceiver gefunden ist."),
            ("Fertig – und immer aktuell",
             "Display, Frequenz, Bänder, Modi, Leistung und Audio des Transceivers im Browser. Neue Version: oben rechts "
             "wird <b>UPDATE</b> gelb – anklicken, <b>INSTALL</b>, nach etwa einer Minute fertig."),
        ],
        "help_title": "Wenn etwas nicht klappt",
        "help": [
            ("yaesu-remote.local geht nicht (oft bei Android)",
             "IP-Adresse vom OLED, aus dem Router oder der Hotspot-Liste des Handys: "
             "<b>http://&lt;IP&gt;</b>. Bequemer: ntfy im Assistenten."),
            ("Setup-WLAN kommt wieder",
             "Passwort falsch oder Netz ausser Reichweite – nochmals verbinden und neu eingeben."),
            ("Transceiver wird nicht gefunden",
             "Eingeschaltet? USB-Datenkabel, am Zero an der Buchse <b>USB</b>? Die Box findet FTX-1 und FTDX10 selbst."),
            ("Service-Zugang (SSH)",
             "Datei <b>yaesu-access.txt</b> mit <i>user=admin</i> und <i>password=…</i> auf die Partition "
             "<b>bootfs</b> der Karte legen – wird beim Start gelesen und gelöscht."),
        ],
        "more": "Mehr:",
    },
    "en": {
        "file": "YAESU-REMOTE_QuickStart_EN.pdf",
        "title": "Quick start",
        "subtitle": "Yaesu FTX-1 / FTDX10 in the browser – ready in 10 minutes",
        "need_title": "You need",
        "need": [
            "<b>Raspberry Pi Zero 2 W</b> (also Pi 3 / 4 / 5)",
            "<b>microSD card</b> 8 GB or more, ideally A1 / A2",
            "<b>Power supply</b> 5 V / 2.5 A micro-USB for the Zero 2 W",
            "<b>USB cable</b> from the transceiver to the Pi – on the Zero 2 W with a <b>micro-USB OTG</b> cable or adapter",
            "the image <b>yaesu-remote-x.y.z-arm64.img.xz</b>",
            "a <b>phone</b> for the Wi-Fi setup",
        ],
        "oled_title": "Connect the OLED (optional)",
        "oled_side": "SD card",
        "oled_rows": [("VCC", "pin 1", "3.3 V"), ("SDA", "pin 3", "GPIO 2"),
                      ("SCL", "pin 5", "GPIO 3"), ("GND", "pin 6", "ground")],
        "oled_note": "0.96\" SSD1306, I2C. Connect only with the Pi switched off; mind the labels "
                     "on the module (often GND, VCC, SCL, SDA).",
        "steps": [
            ("Write the card",
             "Open the <b>Raspberry Pi Imager</b> → choose the model → operating system: "
             "<b>Use custom</b> → choose the <b>.img.xz</b> → storage → <b>Write</b>. "
             "No customisation (Wi-Fi, user) needed – the box does that itself."),
            ("Connect and power on",
             "Card into the Pi, transceiver to the <b>USB</b> socket of the Zero 2 W (not PWR) and switch it on, "
             "then power the Pi. The first start takes 2–3 minutes (a Zero restarts once)."),
            ("Wi-Fi",
             "<b>Phone hotspot:</b> name <b>YAESU-REMOTE</b>, password <b>yaesu-remote</b> "
             "(2.4 GHz, iPhone: “Maximise Compatibility”) – the box joins it by itself.<br>"
             "<b>Without a hotspot:</b> after 3 minutes the Wi-Fi <b>YAESU-REMOTE-Setup</b> appears. Join it "
             "with your phone, the Wi-Fi page opens (otherwise <b>http://10.42.0.1</b>): your Wi-Fi, password, "
             "<b>connect now</b>."),
            ("Open YAESU-REMOTE",
             "In a browser (PC, tablet or phone in the same network):"
             "<span class='url'>http://yaesu-remote.local</span>"
             "The <b>assistant</b> asks for more Wi-Fi networks, optionally a phone message with the "
             "address (ntfy), and shows whether the transceiver is found."),
            ("Done – and always up to date",
             "Display, frequency, bands, modes, power and audio of the transceiver in the browser. New version: "
             "<b>UPDATE</b> turns yellow at the top right – click it, <b>INSTALL</b>, done in about a minute."),
        ],
        "help_title": "If something does not work",
        "help": [
            ("yaesu-remote.local does not open (often on Android)",
             "IP address from the OLED, your router or the phone's hotspot list: "
             "<b>http://&lt;IP&gt;</b>. Easier: ntfy in the assistant."),
            ("The setup Wi-Fi comes back",
             "Wrong password or network out of range – join again and enter it once more."),
            ("Transceiver not found",
             "Switched on? USB data cable, on the Zero in the <b>USB</b> socket? The box finds FTX-1 and FTDX10 by itself."),
            ("Service access (SSH)",
             "Put a file <b>yaesu-access.txt</b> with <i>user=admin</i> and <i>password=…</i> on the "
             "<b>bootfs</b> partition of the card – read at boot and deleted."),
        ],
        "more": "More:",
    },
}

CSS = """
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #1c2530;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; width: 210mm; height: 297mm; position: relative; overflow: hidden; }
.head { background: #0b0d10; color: #e8f1f8; padding: 10mm 14mm 7mm; display: flex; align-items: center; gap: 7mm; }
.head .logo { width: 22mm; height: 22mm; flex: none; }
.head .logo svg { width: 100%; height: 100%; }
.head .brand { font-size: 9pt; letter-spacing: 3px; color: #2aa8ff; font-weight: 700; }
.head h1 { margin: 1mm 0 1.5mm; font-size: 25pt; color: #fff; letter-spacing: -0.3px; }
.head p { margin: 0; font-size: 11pt; color: #9fb0bf; }
.main { padding: 7mm 14mm 0; display: grid; grid-template-columns: 1fr 58mm; gap: 8mm; }
.steps { display: grid; gap: 3.2mm; align-content: start; }
.step { display: grid; grid-template-columns: 10mm 1fr; gap: 4mm; }
.num { width: 10mm; height: 10mm; border-radius: 50%; background: #1f7fc4; color: #fff;
       font-weight: 800; font-size: 13pt; display: flex; align-items: center; justify-content: center; }
.step h2 { margin: 0.8mm 0 1mm; font-size: 12pt; color: #155f94; }
.step p { margin: 0; font-size: 9pt; line-height: 1.45; }
.url { display: block; margin: 1.6mm 0; padding: 1.8mm 3.5mm; border-radius: 2mm; background: #0b0d10;
       color: #2aa8ff; font-weight: 700; font-size: 12pt; letter-spacing: .2px; }
.side { display: grid; gap: 4mm; align-content: start; }
.box { background: #f1f5f9; border: 1px solid #d3dde6; border-radius: 3mm; padding: 4mm 4.5mm; }
.box h3 { margin: 0 0 2.5mm; font-size: 10.5pt; color: #155f94; text-transform: uppercase; letter-spacing: 1px; }
.box ul { margin: 0; padding-left: 4mm; font-size: 8.6pt; line-height: 1.45; }
.box li { margin-bottom: 1.2mm; }
.oled svg { display: block; width: 100%; height: auto; margin: 0 0 2mm; }
.oled table { width: 100%; border-collapse: collapse; font-size: 8.2pt; margin-bottom: 1.5mm; }
.oled td { padding: .35mm 1mm; border-bottom: 1px solid rgba(0,0,0,.08); white-space: nowrap; }
.oled td:first-child { font-weight: 800; width: 15mm; }
.oled td:last-child { color: #5d6b78; }
.oled .dot { display: inline-block; width: 2.4mm; height: 2.4mm; border-radius: 50%; margin-right: 1.2mm; vertical-align: -0.2mm; }
.oled p { margin: 0; font-size: 7.8pt; line-height: 1.4; color: #3a4652; }
.help { margin: 5mm 14mm 0; border-top: 2px solid #1f7fc4; padding-top: 4mm; }
.help h3 { margin: 0 0 3mm; font-size: 11pt; color: #155f94; }
.help-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5mm 8mm; font-size: 8.3pt; line-height: 1.4; }
.help-grid b.t { display: block; color: #1c2530; margin-bottom: .5mm; }
.foot { position: absolute; left: 14mm; right: 14mm; bottom: 8mm; display: flex; justify-content: space-between;
        font-size: 8pt; color: #5d6b78; border-top: 1px solid #d3dde6; padding-top: 3mm; }
.foot .link { color: #1f7fc4; font-weight: 600; }
"""


PIN_COLOURS = {"VCC": "#d4372c", "SDA": "#2f7fd8", "SCL": "#e0a800", "GND": "#1c2530"}


def oled_box(t: dict) -> str:
    """the first six pins of the Pi header (top view, pin 1 at the SD card end) and the table"""

    used = {1: "VCC", 3: "SDA", 5: "SCL", 6: "GND"}
    pins = []
    for n in range(1, 7):
        col = (n - 1) // 2
        x = 62 + col * 22
        y = 30 if n % 2 else 10           # odd pins: inner row, even pins: board edge
        sig = used.get(n)
        fill = PIN_COLOURS[sig] if sig else "#c3c9cf"
        pins.append(f"<rect x='{x - 7}' y='{y - 7}' width='14' height='14' rx='2' fill='{fill}'/>"
                    f"<text x='{x}' y='{y + 3.5}' font-size='9' font-weight='700' text-anchor='middle' "
                    f"fill='#fff'>{n}</text>")
        if sig:
            ly = 52 if n % 2 else -4
            pins.append(f"<text x='{x}' y='{ly + 2}' font-size='8' font-weight='800' text-anchor='middle' "
                        f"fill='{fill}'>{sig}</text>")
    svg = (f"<svg viewBox='0 -12 140 68' xmlns='http://www.w3.org/2000/svg'>"
           f"<rect x='48' y='-1' width='92' height='42' rx='3' fill='#e9edf1' stroke='#c3c9cf'/>"
           f"<text x='0' y='23' font-size='8' fill='#5d6b78'>◀ {html.escape(t['oled_side'])}</text>"
           f"<text x='122' y='23' font-size='8' fill='#8a96a2'>· · ·</text>"
           + "".join(pins) + "</svg>")
    rows = "".join(
        f"<tr><td><span class='dot' style='background:{PIN_COLOURS[sig]}'></span>{sig}</td>"
        f"<td>{html.escape(pin)}</td><td>{html.escape(what)}</td></tr>"
        for sig, pin, what in t["oled_rows"])
    return (f"<div class='box oled'><h3>{html.escape(t['oled_title'])}</h3>{svg}"
            f"<table>{rows}</table><p>{html.escape(t['oled_note'])}</p></div>")


def page_html(lang: str, logo: str, version: str) -> str:

    t = TEXT[lang]

    steps = "".join(
        f"<div class='step'><div class='num'>{i}</div><div><h2>{html.escape(title)}</h2><p>{body}</p></div></div>"
        for i, (title, body) in enumerate(t["steps"], 1))
    need = "".join(f"<li>{item}</li>" for item in t["need"])
    oled = oled_box(t)
    help_items = "".join(f"<div><b class='t'>{html.escape(title)}</b>{body}</div>" for title, body in t["help"])

    return f"""<!DOCTYPE html><html lang="{lang}"><head><meta charset="utf-8"><style>{CSS}</style></head><body>
<div class="head">
  <div class="logo">{logo}</div>
  <div><div class="brand">{PRODUCT}</div><h1>{html.escape(t['title'])}</h1><p>{html.escape(t['subtitle'])}</p></div>
</div>
<div class="main">
  <div class="steps">{steps}</div>
  <div class="side"><div class="box"><h3>{html.escape(t['need_title'])}</h3><ul>{need}</ul></div>{oled}</div>
</div>
<div class="help"><h3>{html.escape(t['help_title'])}</h3><div class="help-grid">{help_items}</div></div>
<div class="foot">
  <span>{html.escape(t['more'])} <span class="link">{URL}</span></span>
  <span>{PRODUCT}{(' ' + html.escape(version)) if version else ''}</span>
</div>
</body></html>"""


def version() -> str:
    import json
    try:
        return json.loads((REPO / "package.json").read_text())["version"]
    except Exception:
        return ""


def main() -> None:
    from playwright.sync_api import sync_playwright

    logo = (REPO / "src" / "public" / "favicon.svg").read_text()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for lang, t in TEXT.items():
                page = browser.new_page()
                page.set_content(page_html(lang, logo, version()), wait_until="load")
                page.pdf(path=str(HERE / t["file"]), format="A4", print_background=True,
                         margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
                page.close()
                print(f"{lang}: {HERE / t['file']}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
