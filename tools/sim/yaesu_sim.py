#!/usr/bin/env python3
"""
Yaesu CAT simulator (FTX-1, FTDX10) on a virtual serial port.

Opens a pty in raw mode and answers CAT commands like the radio, so the
server and the page can be tested without a transceiver. Python 3,
standard library only.

    python3 tools/sim/yaesu_sim.py --model ftx1   --link /tmp/yaesu-sim
    python3 tools/sim/yaesu_sim.py --model ftdx10 --link /tmp/yaesu-sim
    CAT_DEVICE=/tmp/yaesu-sim npm run dev

Options:
    --head field|spa1   FTX-1 power head (PC1xxx 0.5-10 W / PC2xxx 5-100 W)
    --refuse-bs         answer "?" to BS (like some FTX-1 firmware)
    --verbose           print every command

Not a complete radio: it keeps what the drivers set and returns it,
simulates S-meter, TX meters, tuner and (FTX-1) memory channels.
"""

import argparse
import os
import pty
import random
import select
import sys
import time
import tty

MODES = "123456789ABCDEFHI"

BAND_FREQ = {
    "00": (1_840_000, "1"), "01": (3_700_000, "1"), "02": (5_357_000, "2"), "03": (7_100_000, "1"),
    "04": (10_120_000, "3"), "05": (14_200_000, "2"), "06": (18_130_000, "2"), "07": (21_250_000, "2"),
    "08": (24_950_000, "2"), "09": (28_500_000, "2"), "10": (50_150_000, "2"),
    "12": (118_100_000, "5"), "13": (145_500_000, "4"), "14": (433_500_000, "4"),
}

IDS = {"ftx1": "0840", "ftdx10": "0761", "ft710": "0800"}


class Radio:

    def __init__(self, model, head, refuse_bs):
        self.model = model
        self.ftx1 = model == "ftx1"
        self.head = head
        self.refuse_bs = refuse_bs
        # sides: 0 = MAIN / VFO A, 1 = SUB / VFO B
        self.freq = [14_074_000, 145_500_000 if self.ftx1 else 7_074_000]
        self.mode = ["C", "4" if self.ftx1 else "C"]
        self.active = 0          # VS
        self.txside = 0          # FT (FTX-1)
        self.split = 0           # ST (FTDX10)
        self.tx = 0
        self.tune_until = 0.0
        self.tuner = 1
        self.power = 5.0 if head == "field" else 50
        if not self.ftx1:
            self.power = 100
        self.smeter = [100.0, 60.0]
        # generic registers: key -> value
        self.reg = {}
        self.mem_mode = [False, False]
        self.mem_ch = [1, 1]
        self.memories = {}
        if self.ftx1:
            self.memories = {
                1: {"freq": 145_500_000, "mode": "4", "tone": 0, "shift": 0, "name": "CALL 2M"},
                2: {"freq": 438_950_000, "mode": "4", "tone": 1, "shift": 2, "name": "HB9F RPT"},
                5: {"freq": 14_074_000, "mode": "C", "tone": 0, "shift": 0, "name": "FT8 20M"},
            }
        self.defaults()

    def defaults(self):
        sides = "01" if self.ftx1 else "0"
        for p in sides:
            self.reg.update({
                f"AG{p}": "080", f"RG{p}": "255", f"SQ{p}": "000", f"SH{p}": "000",
                f"IS{p}": "0+0000", f"NA{p}": "0", f"BP{p}0": "000", f"BP{p}1": "150",
                f"BC{p}": "0", f"CO{p}0": "0000", f"CO{p}1": "1500", f"CO{p}2": "0000",
                f"CO{p}3": "0025", f"RL{p}": "00" if self.ftx1 else "05", f"NL{p}": "000" if self.ftx1 else "005",
                f"GT{p}": "6" if self.ftx1 else "4", f"OS{p}": "0", f"CT{p}": "0",
                f"CN{p}0": "012", f"CN{p}1": "000",
            })
        self.reg.update({
            "PR0": "1", "PR1": "1", "RA0": "0", "PA0": "0", "PA1": "0", "PA2": "0",
            "MG": "050", "KS": "022", "BI": "0", "ML1": "030", "PS": "1",
            "KM1": "CQ CQ DE HB9OM HB9OM K", "KM2": "TU 5NN", "KM3": "", "KM4": "", "KM5": "QRZ?",
        })
        if not self.ftx1:
            self.reg.update({"NR0": "0", "NB0": "0", "RF0": "7"})

    # ---------------------------------------------------------------

    def tick(self):
        for p in (0, 1):
            self.smeter[p] = max(20, min(220, self.smeter[p] + random.uniform(-12, 12)))
        if self.tune_until and time.time() > self.tune_until:
            self.tune_until = 0

    def info(self, p, prefix):
        """IF / OI answer"""
        tone_ct = int(self.reg.get(f"CT{p if self.ftx1 else 0}", "0"))
        if self.ftx1:
            # IF P8: 1 = CTCSS ENC/DEC, 2 = CTCSS ENC (CT: 1 ENC, 2 TSQ)
            tone = {0: 0, 1: 2, 2: 1, 3: 3}.get(tone_ct, 0)
            shift = self.reg.get(f"OS{p}", "0")
            memflag = "1" if self.mem_mode[p] else "0"
            return f"{prefix}{self.mem_ch[p]:05d}{self.freq[p]:09d}+000000{self.mode[p]}{memflag}{tone}00{shift};"
        shift = self.reg.get("OS0", "0") if p == self.active else "0"
        tone = tone_ct if p == self.active else 0
        return f"{prefix}000{self.freq[p]:09d}+000000{self.mode[p]}0{tone}00{shift};"

    def rm(self, n):
        if n == "1":
            v = 0 if self.tx else int(self.smeter[self.active])
        elif not self.tx:
            v = 0
        elif n == "5":
            maxw = 10 if (self.ftx1 and self.head == "field") else 100
            v = int(min(255, self.power / maxw * 230))
        elif n == "6":
            v = 28
        elif n == "4":
            v = 50
        elif n == "3":
            v = 40
        elif n == "7":
            v = 120 if self.tx else 20
        elif n == "8":
            v = 190
        else:
            v = 0
        return f"RM{n}{v:03d}000;"

    def ac(self):
        if self.ftx1:
            return "AC103;" if self.tune_until else "AC100;"
        return "AC002;" if self.tune_until else f"AC00{self.tuner};"

    # ---------------------------------------------------------------

    def handle(self, cmd):
        """one command without ';' -> answer string ('' = none)"""

        if len(cmd) < 2:
            return "?;"
        c, body = cmd[:2], cmd[2:]

        if c == "ID" and not body:
            return f"ID{IDS[self.model]};"

        if c in ("FA", "FB"):
            p = 0 if c == "FA" else 1
            if not body:
                return f"{c}{self.freq[p]:09d};"
            if len(body) == 9 and body.isdigit():
                self.freq[p] = int(body)
                self.mem_mode[p] = False
                return ""
            return "?;"

        if c in ("IF", "OI") and not body:
            return self.info(0 if c == "IF" else 1, c)

        if c == "MD":
            if len(body) == 1:
                return f"MD{body}{self.mode[int(body)]};"
            if len(body) == 2 and body[1] in MODES:
                self.mode[int(body[0])] = body[1]
                return ""
            return "?;"

        if c == "SM" and len(body) == 1:
            p = int(body)
            v = 0 if (self.tx and p == self.txside) else int(self.smeter[p])
            if not self.ftx1 and p != 0:
                return "?;"
            return f"SM{p}{v:03d};"

        if c == "RM" and len(body) == 1:
            return self.rm(body)

        if c == "TX":
            if not body:
                return f"TX{self.tx};"
            self.tx = 1 if body in ("1", "2") else 0
            return ""

        if c == "VS":
            if not body:
                return f"VS{self.active};"
            self.active = int(body)
            if self.ftx1:
                self.txside = self.active
            return ""

        if c == "FT" and self.ftx1:
            if not body:
                return f"FT{self.txside};"
            self.txside = int(body)
            return ""

        if c == "ST":
            if self.ftx1:
                return "ST0;" if not body else ""
            if not body:
                return f"ST{self.split};"
            self.split = 1 if body != "0" else 0
            return ""

        if c == "PC":
            if not body:
                if self.ftx1:
                    if self.head == "spa1":
                        return f"PC2{int(self.power):03d};"
                    w = self.power
                    return f"PC1{int(w):03d};" if w == int(w) else f"PC1{w:.1f};"
                return f"PC{int(self.power):03d};"
            try:
                self.power = float(body[1:]) if self.ftx1 else float(body)
            except ValueError:
                return "?;"
            return ""

        if c == "AC":
            if not body:
                return self.ac()
            if body in ("103", "002", "123"):
                self.tune_until = time.time() + 2.5
            elif body.endswith("0"):
                self.tune_until = 0
                if not self.ftx1:
                    self.tuner = 0
            elif body == "001":
                self.tuner = 1
            return ""

        if c == "BS":
            if self.refuse_bs:
                return "?;"
            code = body[1:] if self.ftx1 else body
            p = int(body[0]) if self.ftx1 else self.active
            if code in BAND_FREQ:
                self.freq[p], self.mode[p] = BAND_FREQ[code]
                return ""
            return "?;"

        if c == "AB" and not body:
            self.freq[1], self.mode[1] = self.freq[0], self.mode[0]
            return ""
        if c == "BA" and not body:
            self.freq[0], self.mode[0] = self.freq[1], self.mode[1]
            return ""
        if c == "SV" and not body:
            self.freq.reverse()
            self.mode.reverse()
            return ""

        if c == "KY":
            return ""

        if c == "PS":
            if not body:
                return "PS1;"
            return ""

        if c in ("CF", "QI", "QR"):
            return ""

        if self.ftx1:
            answer = self.memory(c, body)
            if answer is not None:
                return answer

        return self.register(c, body)

    def memory(self, c, body):
        """FTX-1 memory commands, None = not a memory command"""

        if c == "MR" and len(body) == 5:
            m = self.memories.get(int(body))
            if not m:
                return "?;"
            tone = {0: 0, 1: 2, 2: 1, 3: 3}.get(m["tone"], 0)  # MR P8: 1 TSQ, 2 ENC, 3 DCS
            return f"MR{body}{m['freq']:09d}+000000{m['mode']}1{tone}00{m['shift']};"

        if c == "MT":
            ch = int(body[:5]) if len(body) >= 5 and body[:5].isdigit() else 0
            if len(body) == 5:
                m = self.memories.get(ch)
                return f"MT{body}{(m['name'] if m else '').ljust(12)};" if m else "?;"
            if len(body) == 17 and ch in self.memories:
                self.memories[ch]["name"] = body[5:].strip()
                return ""
            return "?;"

        if c == "MC":
            if len(body) == 1:
                p = int(body)
                return f"MC{p}{self.mem_ch[p]:05d};"
            if len(body) == 6:
                p, ch = int(body[0]), int(body[1:])
                self.mem_ch[p] = ch
                m = self.memories.get(ch)
                if p == 0:
                    if not m:
                        return "?;"
                    self.mem_mode[0] = True
                    self.freq[0], self.mode[0] = m["freq"], m["mode"]
                    self.reg["OS0"] = str(m["shift"])
                    self.reg["CT0"] = str(m["tone"])
                return ""
            return "?;"

        if c == "VM":
            if len(body) == 1:
                p = int(body)
                return f"VM{p}{'11' if self.mem_mode[p] else '00'};"
            if len(body) == 3:
                self.mem_mode[int(body[0])] = body[1:] == "11"
                return ""
            return "?;"

        if c == "BM" and not body:
            ch = self.mem_ch[1]
            old = self.memories.get(ch, {}).get("name", "")
            self.memories[ch] = {
                "freq": self.freq[1], "mode": self.mode[1], "tone": int(self.reg.get("CT1", "0")),
                "shift": int(self.reg.get("OS1", "0")), "name": old,
            }
            return ""

        if c == "CH" and body in ("0", "1"):
            used = sorted(self.memories)
            if self.mem_mode[0] and used:
                cur = self.mem_ch[0]
                nxt = [x for x in used if (x > cur if body == "0" else x < cur)]
                ch = (nxt[0] if body == "0" else nxt[-1]) if nxt else (used[0] if body == "0" else used[-1])
                return self.memory("MC", f"0{ch:05d}") or ""
            return ""

        return None

    # selector length (characters after the command that address the setting)
    SELECTOR = {
        "AG": 1, "RG": 1, "SQ": 1, "SH": 1, "IS": 1, "NA": 1, "BP": 2, "BC": 1, "CO": 2,
        "RL": 1, "NL": 1, "NR": 1, "NB": 1, "GT": 1, "PR": 1, "RA": 1, "PA": 1, "RF": 1,
        "MG": 0, "KS": 0, "BI": 0, "ML": 1, "OS": 1, "CT": 1, "CN": 2, "KM": 1,
    }

    def register(self, c, body):
        sel = self.SELECTOR.get(c)
        if sel is None or len(body) < sel:
            return "?;"
        key = c + body[:sel]
        if len(body) == sel:
            if key not in self.reg:
                return "?;"
            return f"{key}{self.reg[key]};"
        value = body[sel:]
        if c == "SH" and not self.ftx1:
            value = value[-3:]
        self.reg[key] = value
        return ""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", choices=sorted(IDS), default="ftx1")
    ap.add_argument("--head", choices=["field", "spa1"], default="field")
    ap.add_argument("--refuse-bs", action="store_true")
    ap.add_argument("--link", default="", help="create a symlink to the pty, e.g. /tmp/yaesu-sim")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if args.model == "ft710":
        print("ft710: answers ID only like an FTDX10 for now", file=sys.stderr)

    master, slave = pty.openpty()
    tty.setraw(slave)
    path = os.ttyname(slave)

    if args.link:
        try:
            os.unlink(args.link)
        except FileNotFoundError:
            pass
        os.symlink(path, args.link)

    radio = Radio("ftdx10" if args.model == "ft710" else args.model, args.head, args.refuse_bs)
    radio.model = args.model
    print(f"{args.model.upper()} simulator on {path}" + (f" ({args.link})" if args.link else ""), flush=True)

    buffer = b""
    last_tick = 0.0

    try:
        while True:
            ready, _, _ = select.select([master], [], [], 0.1)
            now = time.time()
            if now - last_tick > 0.2:
                radio.tick()
                last_tick = now
            if not ready:
                continue
            try:
                data = os.read(master, 4096)
            except OSError:
                time.sleep(0.1)
                continue
            buffer += data
            while b";" in buffer:
                raw, buffer = buffer.split(b";", 1)
                cmd = raw.decode("latin1").lstrip("\r\n ")
                if not cmd:
                    continue
                answer = radio.handle(cmd)
                if args.verbose:
                    print(f"> {cmd};  < {answer}", flush=True)
                if answer:
                    os.write(master, answer.encode("latin1"))
    except KeyboardInterrupt:
        pass
    finally:
        if args.link:
            try:
                os.unlink(args.link)
            except OSError:
                pass


if __name__ == "__main__":
    main()
