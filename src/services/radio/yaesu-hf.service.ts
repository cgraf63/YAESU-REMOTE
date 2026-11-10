import { SerialRadioBase } from "./serial-radio-base.js";
import type { RadioProfile, YaesuRadio } from "./radio.interface.js";
import { FTDX10_CAT } from "./ftdx10/ftdx10.cat.js";
import { YAESU_CTCSS, YAESU_DCS } from "./yaesu-tables.js";


/*
 * Yaesu HF / 50 MHz transceivers with one receiver and VFO A / B:
 * FTDX10 (this driver), FT-710 (planned, own profile).
 *
 * Command strings come from ftdx10.cat.ts (SHACK-SERVER, used on the
 * FTDX10). The state uses the same shape as the FTX-1 driver, so one
 * page serves all radios:
 *
 *   main = VFO A, sub = VFO B
 *   activeSide  VS: the VFO the radio receives on
 *   split       ST1: transmit on the other VFO
 *   txSide      VFO that transmits (active VFO, or the other one in split)
 *
 * One receiver: filter / DSP / gain values belong to the receiver and
 * are reported identically on both sides. The S-meter is shown only on
 * the receiving VFO.
 *
 * FTDX10 specifics:
 *   - FA / FB 9 digits, 30 kHz - 75 MHz
 *   - IF / OI answer 28 characters (3-digit memory channel)
 *   - PC 005-100 W
 *   - RA0 0-3: OFF / 6 / 12 / 18 dB, PA0 0-2: IPO / AMP1 / AMP2
 *   - RF0 roofing: 6 = 12 kHz, 7 = 3 kHz, 9 = 500 Hz
 *   - NB0 / NR0 switch, NL0 000-010, RL0 01-15
 *   - tuner: AC002 start, AC000 off; CW message memory play: KY6..KYA
 *   - CT (tone): 0 off, 1 CTCSS ENC/DEC, 2 CTCSS ENC, 3 DCS
 *     (other order than the FTX-1; the page uses the FTX-1 numbering)
 */


export interface HfModelInfo {
    name: "FTDX10" | "FT-710";
    id: string;
    maxFrequency: number;
    roofing: boolean;
}

export const FTDX10_INFO: HfModelInfo = { name: "FTDX10", id: "0761", maxFrequency: 75_000_000, roofing: true };

const MODES: Record<string, string> = {
    LSB: "1", USB: "2", "CW-U": "3", FM: "4", AM: "5", "RTTY-L": "6", "CW-L": "7", "DATA-L": "8",
    "RTTY-U": "9", "DATA-FM": "A", "FM-N": "B", "DATA-U": "C", "AM-N": "D", PSK: "E", "DATA-FM-N": "F"
};

const MODE_BY_CODE: Record<string, string> =
    Object.fromEntries(Object.entries(MODES).map(([name, code]) => [code, name]));

const MODE_ALIASES: Record<string, string> = {
    CW: "CW-U", "CW-R": "CW-L", RTTY: "RTTY-U", DATA: "DATA-U", PKT: "DATA-FM", FT8: "DATA-U", FT4: "DATA-U"
};

export const HF_BANDS: Array<{ code: string; name: string; from: number; to: number }> = [
    { code: "00", name: "160m", from: 1_800_000, to: 2_000_000 },
    { code: "01", name: "80m", from: 3_500_000, to: 4_000_000 },
    { code: "02", name: "60m", from: 5_250_000, to: 5_450_000 },
    { code: "03", name: "40m", from: 7_000_000, to: 7_300_000 },
    { code: "04", name: "30m", from: 10_100_000, to: 10_150_000 },
    { code: "05", name: "20m", from: 14_000_000, to: 14_350_000 },
    { code: "06", name: "17m", from: 18_068_000, to: 18_168_000 },
    { code: "07", name: "15m", from: 21_000_000, to: 21_450_000 },
    { code: "08", name: "12m", from: 24_890_000, to: 24_990_000 },
    { code: "09", name: "10m", from: 28_000_000, to: 29_700_000 },
    { code: "10", name: "6m", from: 50_000_000, to: 54_000_000 },
    { code: "11", name: "GEN", from: 0, to: 0 },
    { code: "12", name: "MW", from: 0, to: 0 }
];

/* when BS does not move the VFO: typical frequency + mode */
const BAND_DEFAULTS: Record<string, [number, string]> = {
    "00": [1_840_000, "LSB"], "01": [3_700_000, "LSB"], "02": [5_357_000, "USB"],
    "03": [7_100_000, "LSB"], "04": [10_120_000, "CW-U"], "05": [14_200_000, "USB"],
    "06": [18_130_000, "USB"], "07": [21_250_000, "USB"], "08": [24_950_000, "USB"],
    "09": [28_500_000, "USB"], "10": [50_150_000, "USB"]
};

const AGC_NAMES = ["OFF", "FAST", "MID", "SLOW", "AUTO-F", "AUTO-M", "AUTO-S"];
const ATT_NAMES = ["OFF", "6 dB", "12 dB", "18 dB"];
const PRE_NAMES = ["IPO", "AMP1", "AMP2"];
const ROOFING: Record<string, string> = { "6": "12 kHz", "7": "3 kHz", "8": "1.2 kHz", "9": "500 Hz", A: "300 Hz" };
const TONE_MODES = ["OFF", "ENC", "TSQ", "DCS"];
const SHIFT_NAMES = ["SIMP", "+", "−"];

/* page tone numbering (FTX-1: 1 ENC, 2 TSQ) <-> FTDX10 CT */
const TONE_TO_CAT = [0, 2, 1, 3];
const TONE_FROM_CAT = [0, 2, 1, 3];

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function pad(value: number, length: number): string {
    return String(Math.round(value)).padStart(length, "0");
}


interface VfoState {
    frequency: number;
    mode: string;
    toneMode: number;
    rptShift: number;
}

function emptyVfo(): VfoState {
    return { frequency: 0, mode: "UNKNOWN", toneMode: 0, rptShift: 0 };
}


export class YaesuHfService extends SerialRadioBase implements YaesuRadio {

    readonly model: "FTDX10" | "FT-710";

    private buffer = "";
    private pollCount = 0;

    private a = emptyVfo();
    private b = emptyVfo();

    /* VS: 0 = VFO A, 1 = VFO B */
    private activeSide: 0 | 1 = 0;
    private split = false;
    private tx = 0;

    /* receiver */
    private smeter = 0;
    private rfGain = 255;
    private afGain = 0;
    private squelch = 0;
    private width = 0;
    private shift = 0;
    private narrow = false;
    private notch = false;
    private notchFrequency = 1500;
    private dnf = false;
    private contour = false;
    private contourFrequency = 1500;
    private apf = false;
    private apfOffset = 0;
    private dnr = false;
    private dnrLevel = 5;
    private nb = false;
    private nbLevel = 5;
    private agc = 4;
    private attenuator = 0;
    private preamp = 0;
    private roofing = "";
    private ctcssIndex = 12;
    private dcsIndex = 0;

    /* transmitter */
    private power = 0;
    private processor = false;
    private micEq = false;
    private micGain = 50;
    private monitorLevel = 0;
    private cwSpeed = 20;
    private breakIn = false;
    private tuning = false;
    private tunerOn = false;
    private meterPo = 0;
    private meterSwr = 0;
    private meterAlc = 0;
    private meterComp = 0;
    private meterIdd = 0;
    private meterVdd = 0;

    private cwMemories = ["", "", "", "", ""];

    private poweredOn = true;
    private lastAnswerAt = 0;
    private lastSetAt = 0;

    constructor(device: string, baudRate: number, private readonly info: HfModelInfo = FTDX10_INFO) {
        super({
            name: `${info.name} CAT`,
            device,
            baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            rtscts: false,
            pollIntervalMs: 700,
            rxTimeoutMs: 15000,
            expectedId: info.id
        });
        this.model = info.name;
    }


    /* ------------------------------------------------------------
       Polling
       ------------------------------------------------------------ */

    protected override poll(): void {

        this.pollCount++;

        let fast = "FA;FB;IF;TX;SM0;";
        if (this.tx) fast += "RM5;RM6;RM4;RM3;";
        this.write(fast);

        if (this.pollCount % 2 === 0) {
            this.write("VS;ST;OI;PC;AC;");
        }

        if (this.pollCount % 3 === 1) {
            this.write(
                "AG0;RG0;SQ0;SH0;IS0;NA0;BP00;BP01;BC0;CO00;CO01;CO02;CO03;" +
                "NR0;RL0;NB0;NL0;GT0;PR0;RA0;PA0;" + (this.info.roofing ? "RF0;" : "")
            );
        }

        if (this.pollCount % 5 === 2) {
            this.write("MG;KS;BI;PR1;ML1;CT0;CN00;CN01;RM7;RM8;");
        }

        if (this.pollCount % 60 === 3) {
            this.write("KM1;KM2;KM3;KM4;KM5;");
        }

    }

    protected onData(data: Buffer): void {

        this.buffer += data.toString("ascii");

        if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-1024);

        let end: number;

        while ((end = this.buffer.indexOf(";")) !== -1) {

            const message = this.buffer.slice(0, end + 1).replace(/^[\r\n\s]+/, "");
            this.buffer = this.buffer.slice(end + 1);

            if (message === "?;" || message.length < 3) continue;

            this.lastAnswerAt = Date.now();
            this.poweredOn = true;

            try {
                this.parse(message);
            }
            catch (error) {
                console.error(`${this.model} parse:`, message, (error as Error).message);
            }

        }

    }

    private vfo(p: 0 | 1 = this.activeSide): VfoState {
        return p === 1 ? this.b : this.a;
    }

    private parse(m: string): void {

        let r: RegExpMatchArray | null;

        if ((r = m.match(/^FA(\d{9});$/))) { this.a.frequency = Number(r[1]); return; }
        if ((r = m.match(/^FB(\d{9});$/))) { this.b.frequency = Number(r[1]); return; }

        // IF / OI: ch(3) freq(9) clar(+-4) rxclar txclar mode P7 tone(P8) 00 shift(P10)
        if ((r = m.match(/^(IF|OI)\d{3}(\d{9})[+-]\d{4}\d\d([0-9A-F])\d(\d)\d{2}(\d);$/))) {
            const v = r[1] === "IF" ? this.a : this.b;
            v.frequency = Number(r[2]);
            v.mode = MODE_BY_CODE[r[3] ?? ""] ?? v.mode;
            v.toneMode = TONE_FROM_CAT[Number(r[4])] ?? 0;
            v.rptShift = clamp(Number(r[5]), 0, 2);
            return;
        }

        if ((r = m.match(/^MD([01])([0-9A-F]);$/))) {
            this.vfo(Number(r[1]) as 0 | 1).mode = MODE_BY_CODE[r[2] ?? ""] ?? "UNKNOWN";
            return;
        }

        if ((r = m.match(/^TX(\d);$/))) { this.tx = Number(r[1]); return; }
        if ((r = m.match(/^VS([01]);$/))) { this.activeSide = Number(r[1]) as 0 | 1; return; }
        if ((r = m.match(/^ST([0-2]);$/))) { this.split = r[1] !== "0"; return; }
        if ((r = m.match(/^PC(\d{3});$/))) { this.power = Number(r[1]); return; }
        if ((r = m.match(/^SM0(\d{3});$/))) { this.smeter = Number(r[1]); return; }

        if ((r = m.match(/^RM(\d)(\d{3})\d*;$/))) {
            const value = Number(r[2]);
            switch (r[1]) {
                case "1": this.smeter = value; break;
                case "3": this.meterComp = value; break;
                case "4": this.meterAlc = value; break;
                case "5": this.meterPo = value; break;
                case "6": this.meterSwr = value; break;
                case "7": this.meterIdd = value; break;
                case "8": this.meterVdd = value; break;
            }
            return;
        }

        if ((r = m.match(/^AG0(\d{3});$/))) { this.afGain = Number(r[1]); return; }
        if ((r = m.match(/^RG0(\d{3});$/))) { this.rfGain = Number(r[1]); return; }
        if ((r = m.match(/^SQ0(\d{3});$/))) { this.squelch = Number(r[1]); return; }
        if ((r = m.match(/^SH0\d(\d{2});$/))) { this.width = Number(r[1]); return; }
        if ((r = m.match(/^IS0\d([+-])(\d{4});$/))) { this.shift = (r[1] === "-" ? -1 : 1) * Number(r[2]); return; }
        if ((r = m.match(/^NA0([01]);$/))) { this.narrow = r[1] === "1"; return; }
        if ((r = m.match(/^BC0([01]);$/))) { this.dnf = r[1] === "1"; return; }

        if ((r = m.match(/^BP0([01])(\d{3});$/))) {
            if (r[1] === "0") this.notch = r[2] !== "000";
            else this.notchFrequency = Number(r[2]) * 10;
            return;
        }

        if ((r = m.match(/^CO0([0-3])(\d{4});$/))) {
            const v = Number(r[2]);
            switch (r[1]) {
                case "0": this.contour = v === 1; break;
                case "1": this.contourFrequency = v; break;
                case "2": this.apf = v === 1; break;
                case "3": this.apfOffset = (v - 25) * 10; break;
            }
            return;
        }

        if ((r = m.match(/^NR0([01]);$/))) { this.dnr = r[1] === "1"; return; }
        if ((r = m.match(/^RL0(\d{2});$/))) { this.dnrLevel = Number(r[1]); return; }
        if ((r = m.match(/^NB0([01]);$/))) { this.nb = r[1] === "1"; return; }
        if ((r = m.match(/^NL0(\d{3});$/))) { this.nbLevel = Number(r[1]); return; }
        if ((r = m.match(/^GT0(\d);$/))) { this.agc = Number(r[1]); return; }

        if ((r = m.match(/^PR([01])([12]);$/))) {
            if (r[1] === "0") this.processor = r[2] === "2";
            else this.micEq = r[2] === "2";
            return;
        }

        if ((r = m.match(/^RA0([0-3]);$/))) { this.attenuator = Number(r[1]); return; }
        if ((r = m.match(/^PA0([0-2]);$/))) { this.preamp = Number(r[1]); return; }
        if ((r = m.match(/^RF0([0-9A-F]);$/))) { this.roofing = r[1] ?? ""; return; }

        if ((r = m.match(/^MG(\d{3});$/))) { this.micGain = Number(r[1]); return; }
        if ((r = m.match(/^KS(\d{3});$/))) { this.cwSpeed = Number(r[1]); return; }
        if ((r = m.match(/^BI([01]);$/))) { this.breakIn = r[1] === "1"; return; }
        if ((r = m.match(/^ML1(\d{3});$/))) { this.monitorLevel = Number(r[1]); return; }

        if ((r = m.match(/^CT0(\d);$/))) { this.vfo().toneMode = TONE_FROM_CAT[Number(r[1])] ?? 0; return; }
        if ((r = m.match(/^CN0([01])(\d{3});$/))) {
            if (r[1] === "0") this.ctcssIndex = clamp(Number(r[2]), 0, 49);
            else this.dcsIndex = clamp(Number(r[2]), 0, 103);
            return;
        }

        // AC P1 P2 P3: P3 0 tuner off, 1 tuner on, 2 tuning
        if ((r = m.match(/^AC\d\d(\d);$/))) {
            this.tunerOn = r[1] !== "0";
            this.tuning = r[1] === "2";
            return;
        }

        if ((r = m.match(/^PS([01]);$/))) { this.poweredOn = r[1] === "1"; return; }

        if ((r = m.match(/^KM([1-5])(.*);$/))) {
            this.cwMemories[Number(r[1]) - 1] = (r[2] ?? "").trim();
            return;
        }

    }


    /* ------------------------------------------------------------
       Helpers
       ------------------------------------------------------------ */

    private send(command: string): void {
        if (!this.isConnected()) throw new Error(`${this.model} not connected`);
        this.lastSetAt = Date.now();
        this.write(command);
    }

    private normalizeMode(mode: string, frequency: number): string {
        let m = String(mode || "").toUpperCase().trim();
        if (m === "SSB") m = frequency < 10_000_000 ? "LSB" : "USB";
        m = MODE_ALIASES[m] ?? m;
        if (!MODES[m]) throw new Error(`Unsupported ${this.model} mode: ${mode}`);
        return m;
    }

    private checkFrequency(hz: number): number {
        const value = Math.round(Number(hz));
        if (!Number.isFinite(value) || value < 30_000 || value > this.info.maxFrequency) {
            throw new Error(`Frequency out of range (30 kHz - ${this.info.maxFrequency / 1e6} MHz)`);
        }
        return value;
    }

    private bandOf(hz: number): string {
        return HF_BANDS.find(b => b.to && hz >= b.from && hz <= b.to)?.name ?? "GEN";
    }


    /* ------------------------------------------------------------
       Set methods
       ------------------------------------------------------------ */

    setFrequencyA(frequency: number): void {
        const hz = this.checkFrequency(frequency);
        this.send(FTDX10_CAT.vfoA.set(hz));
        this.a.frequency = hz;
    }

    setFrequencyB(frequency: number): void {
        const hz = this.checkFrequency(frequency);
        this.send(FTDX10_CAT.vfoB.set(hz));
        this.b.frequency = hz;
    }

    /* MD0 = VFO A, MD1 = VFO B (like IF / OI) */
    setMode(side: 0 | 1, mode: string): void {
        const v = this.vfo(side);
        const m = this.normalizeMode(mode, v.frequency);
        this.send(`MD${side}${MODES[m]};`);
        v.mode = m;
    }

    setActiveVfo(side: 0 | 1): void {
        this.send(side === 1 ? FTDX10_CAT.vfo.selectB : FTDX10_CAT.vfo.selectA);
        this.activeSide = side;
    }

    setSplit(enabled: boolean): void {
        this.send(enabled ? FTDX10_CAT.split.on : FTDX10_CAT.split.off);
        this.split = Boolean(enabled);
    }

    /* BS works on the receiving VFO: select it first */
    setBand(code: string, side: 0 | 1): void {
        const band = HF_BANDS.find(b => b.code === code);
        if (!band) throw new Error(`Unsupported ${this.model} band code: ${code}`);
        if (side !== this.activeSide) this.setActiveVfo(side);
        this.send(FTDX10_CAT.band.set(code));
        const fallback = BAND_DEFAULTS[code];
        if (!fallback) return;
        setTimeout(() => {
            const f = this.vfo(side).frequency;
            if (f >= band.from && f <= band.to) return;
            try {
                if (side === 1) this.setFrequencyB(fallback[0]);
                else this.setFrequencyA(fallback[0]);
                this.setMode(side, fallback[1]);
            }
            catch { /* disconnected */ }
        }, 900);
    }

    setPtt(enabled: boolean): void {
        this.send(enabled ? FTDX10_CAT.ptt.on : FTDX10_CAT.ptt.off);
        this.tx = enabled ? 1 : 0;
    }

    setPower(watts: number): void {
        const v = clamp(Math.round(Number(watts)), 5, 100);
        this.send(FTDX10_CAT.power.set(v));
        this.power = v;
    }

    setPowerState(enabled: boolean): void {
        if (enabled) {
            // the radio needs PS1 twice within 1-2 s to wake up
            this.write(FTDX10_CAT.powerSwitch.on);
            setTimeout(() => this.write(FTDX10_CAT.powerSwitch.on), 1200);
            return;
        }
        this.send(FTDX10_CAT.powerSwitch.off);
    }

    getPowerState(): boolean {
        return this.poweredOn && Date.now() - this.lastAnswerAt < 10_000;
    }

    private level(control: string, value: number, min: number, max: number): number {
        const v = Math.round(Number(value));
        if (!Number.isFinite(v)) throw new Error(`Invalid value for ${control}`);
        return clamp(v, min, max);
    }


    /* ------------------------------------------------------------
       Page (/api/radio)
       ------------------------------------------------------------ */

    getLastAnswerAt(): number { return this.lastAnswerAt; }

    getProfile(): RadioProfile {
        return {
            model: this.model,
            dualReceiver: false,
            sides: { main: { name: "VFO A", short: "A" }, sub: { name: "VFO B", short: "B" } },
            frequency: { min: 30_000, max: this.info.maxFrequency },
            bands: HF_BANDS.filter(b => b.code !== "12").map(b => ({ value: b.code, label: b.name.replace(/(\d)m$/, "$1 m") })),
            modeGroups: [
                ["SSB", ["LSB", "USB"]],
                ["CW", ["CW-U", "CW-L"]],
                ["AM", ["AM", "AM-N"]],
                ["FM", ["FM", "FM-N"]],
                ["DATA", ["DATA-U", "DATA-L", "DATA-FM", "DATA-FM-N"]],
                ["RTTY / PSK", ["RTTY-U", "RTTY-L", "PSK"]]
            ],
            attenuator: ATT_NAMES.map((label, value) => ({ label, value })),
            preamp: PRE_NAMES.map((label, value) => ({ label, value })),
            roofing: this.info.roofing ? [{ label: "12 kHz", value: "6" }, { label: "3 kHz", value: "7" }, { label: "500 Hz", value: "9" }] : null,
            agc: [{ label: "OFF", value: 0 }, { label: "FAST", value: 1 }, { label: "MID", value: 2 }, { label: "SLOW", value: 3 }, { label: "AUTO", value: 4 }],
            dnrMax: 15,
            nbMax: 10,
            fm: true,
            memories: null,
            cw: { memories: 5, stop: false },
            hints: {
                band: `The ${this.model} recalls the last frequency and mode of the band (band stack).`,
                tuner: `TUNE starts the internal antenna tuner of the ${this.model}.`,
                fm: "FM on 10 m and 6 m: repeater shift and CTCSS / DCS tone. The offset itself is set in the radio menu."
            },
            showHead: false
        };
    }

    getState(): Record<string, unknown> {

        const receiver = {
            rfGain: this.rfGain,
            afGain: this.afGain,
            squelch: this.squelch,
            width: this.width,
            shift: this.shift,
            narrow: this.narrow,
            notch: this.notch,
            notchFrequency: this.notchFrequency,
            dnf: this.dnf,
            contour: this.contour,
            contourFrequency: this.contourFrequency,
            apf: this.apf,
            apfOffset: this.apfOffset,
            // the page shows "level 0 = off" like on the FTX-1
            dnrLevel: this.dnr ? Math.max(1, this.dnrLevel) : 0,
            nbLevel: this.nb ? Math.max(1, this.nbLevel) : 0,
            agc: AGC_NAMES[this.agc] ?? "---",
            processor: this.processor,
            ctcssIndex: this.ctcssIndex,
            ctcss: (YAESU_CTCSS[this.ctcssIndex] ?? 0) / 10,
            dcsIndex: this.dcsIndex,
            dcs: YAESU_DCS[this.dcsIndex] ?? 0,
            memoryMode: false,
            memoryChannel: 0,
            memoryName: ""
        };

        const side = (v: VfoState, p: 0 | 1) => ({
            ...receiver,
            frequency: v.frequency,
            mode: v.mode,
            band: this.bandOf(v.frequency),
            smeter: p === this.activeSide ? this.smeter : 0,
            rptShift: SHIFT_NAMES[v.rptShift] ?? "SIMP",
            rptShiftCode: v.rptShift,
            toneMode: TONE_MODES[v.toneMode] ?? "OFF",
            toneModeCode: v.toneMode
        });

        const txSide = this.split ? 1 - this.activeSide : this.activeSide;

        return {
            model: this.model,
            connected: this.isConnected(),
            alive: Date.now() - this.lastAnswerAt < 5000,
            lastError: this.getLastError(),
            poweredOn: this.getPowerState(),
            activeSide: this.activeSide === 1 ? "SUB" : "MAIN",
            split: this.split,
            txSide: txSide === 1 ? "SUB" : "MAIN",
            tx: this.tx > 0,
            tuning: this.tuning,
            tunerOn: this.tunerOn,
            main: side(this.a, 0),
            sub: side(this.b, 1),
            power: this.power,
            powerRange: { min: 5, max: 100, step: 1, head: "", note: "5 - 100 W" },
            head: "",
            attenuator: this.attenuator > 0,
            attenuatorCode: this.attenuator,
            attenuatorName: ATT_NAMES[this.attenuator] ?? "OFF",
            preamp: PRE_NAMES[this.preamp] ?? "IPO",
            preampCode: this.preamp,
            preampGroup: "HF",
            roofing: ROOFING[this.roofing] ?? "",
            roofingCode: this.roofing,
            meters: {
                po: this.meterPo,
                swr: this.meterSwr,
                alc: this.meterAlc,
                comp: this.meterComp,
                idd: this.meterIdd,
                vdd: this.meterVdd
            },
            micGain: this.micGain,
            micEq: this.micEq,
            cwSpeed: this.cwSpeed,
            breakIn: this.breakIn,
            monitor: this.monitorLevel,
            ctcssIndex: this.ctcssIndex,
            ctcss: (YAESU_CTCSS[this.ctcssIndex] ?? 0) / 10,
            dcsIndex: this.dcsIndex,
            dcs: YAESU_DCS[this.dcsIndex] ?? 0,
            memoryScan: null,
            cwMemories: [...this.cwMemories],
            recentlySet: Date.now() - this.lastSetAt < 1500
        };

    }

    control(control: string, value: unknown): void {

        const num = (): number => {
            const n = Number(value);
            if (!Number.isFinite(n)) throw new Error(`Invalid value for ${control}`);
            return n;
        };
        const bool = (): boolean => value === true || value === 1 || value === "1" || value === "on";
        const sideOf = (v: unknown): 0 | 1 => (v === "SUB" || v === "B" ? 1 : 0);

        switch (control) {

            case "frequency": return this.setFrequencyA(num());
            case "frequencyB": return this.setFrequencyB(num());
            case "mode": return this.setMode(0, String(value));
            case "modeB": return this.setMode(1, String(value));
            case "band": return this.setBand(String(value), 0);
            case "bandB": return this.setBand(String(value), 1);
            case "side": return this.setActiveVfo(sideOf(value));
            case "split": return this.setSplit(bool());
            case "swap": return this.send(FTDX10_CAT.vfo.swap);
            case "mainToSub": return this.send(FTDX10_CAT.vfo.aToB);
            case "subToMain": return this.send(FTDX10_CAT.vfo.bToA);
            case "ptt": return this.setPtt(bool());
            case "power": return this.setPower(num());
            case "powerSwitch": return this.setPowerState(bool());

            case "tune":
                this.send(FTDX10_CAT.tuner.start);
                this.tuning = true;
                return;
            case "tuneStop":
                this.send("AC000;");
                this.tuning = false;
                return;

            case "afGain": { const v = this.level(control, num(), 0, 255); this.send(FTDX10_CAT.afGain.set(v)); this.afGain = v; return; }
            case "rfGain": { const v = this.level(control, num(), 0, 255); this.send(FTDX10_CAT.rfGain.set(v)); this.rfGain = v; return; }
            case "squelch": { const v = this.level(control, num(), 0, 255); this.send(`SQ0${pad(v, 3)};`); this.squelch = v; return; }

            case "att": {
                // the page sends a level (0-3) or a toggle (true / false)
                const v = typeof value === "boolean" ? (value ? 2 : 0) : this.level(control, num(), 0, 3);
                this.send(FTDX10_CAT.attenuator.set(v as 0 | 1 | 2 | 3));
                this.attenuator = v;
                return;
            }
            case "preamp": { const v = this.level(control, num(), 0, 2); this.send(FTDX10_CAT.ipo.set(v as 0 | 1 | 2)); this.preamp = v; return; }
            case "roofing": {
                const v = String(value).toUpperCase();
                if (!this.info.roofing || !/^[6-9A]$/.test(v)) throw new Error("Invalid roofing filter");
                this.send(FTDX10_CAT.filter.roofing.set(v));
                this.roofing = v;
                return;
            }
            case "agc": { const v = this.level(control, num(), 0, 4); this.send(FTDX10_CAT.agc.set(v)); this.agc = v; return; }

            case "width": { const v = this.level(control, num(), 0, 23); this.send(FTDX10_CAT.filter.width.set(v)); this.width = v; return; }
            case "shift": { const v = clamp(Math.round(num() / 20) * 20, -1200, 1200); this.send(FTDX10_CAT.filter.ifShift.set(v)); this.shift = v; return; }
            case "narrow": this.send(`NA0${bool() ? 1 : 0};`); this.narrow = bool(); return;

            case "notch":
                this.send(bool() ? "BP00001;" : FTDX10_CAT.notch.manual.off);
                this.notch = bool();
                return;
            case "notchFrequency": { const v = this.level(control, num(), 10, 3200); this.send(FTDX10_CAT.notch.manual.on(v)); this.notchFrequency = Math.round(v / 10) * 10; return; }
            case "dnf": this.send(bool() ? FTDX10_CAT.notch.auto.on : FTDX10_CAT.notch.auto.off); this.dnf = bool(); return;

            case "contour": this.send(bool() ? "CO000001;" : FTDX10_CAT.contour.off); this.contour = bool(); return;
            case "contourFrequency": { const v = this.level(control, num(), 10, 3200); this.send(FTDX10_CAT.contour.on(v)); this.contourFrequency = v; return; }
            case "apf": this.send(bool() ? FTDX10_CAT.contour.apfOn : FTDX10_CAT.contour.apfOff); this.apf = bool(); return;
            case "apfOffset": { const v = this.level(control, num() / 10, -25, 25); this.send(FTDX10_CAT.contour.apfFrequency(v + 25)); this.apfOffset = v * 10; return; }

            case "dnr": this.send(bool() ? FTDX10_CAT.noiseReduction.on : FTDX10_CAT.noiseReduction.off); this.dnr = bool(); return;
            case "dnrLevel": {
                const v = this.level(control, num(), 1, 15);
                this.send(FTDX10_CAT.noiseReduction.levelSet(v));
                if (!this.dnr) this.send(FTDX10_CAT.noiseReduction.on);
                this.dnr = true;
                this.dnrLevel = v;
                return;
            }
            case "nb": this.send(bool() ? FTDX10_CAT.noiseBlanker.on : FTDX10_CAT.noiseBlanker.off); this.nb = bool(); return;
            case "nbLevel": {
                const v = this.level(control, num(), 1, 10);
                this.send(FTDX10_CAT.noiseBlanker.levelSet(v));
                if (!this.nb) this.send(FTDX10_CAT.noiseBlanker.on);
                this.nb = true;
                this.nbLevel = v;
                return;
            }

            case "micGain": { const v = this.level(control, num(), 0, 100); this.send(FTDX10_CAT.micGain.set(v)); this.micGain = v; return; }
            case "micEq": this.send(FTDX10_CAT.micEq.set(bool())); this.micEq = bool(); return;
            case "processor": this.send(bool() ? "PR02;" : "PR01;"); this.processor = bool(); return;
            case "monitor": { const v = this.level(control, num(), 0, 100); this.send(FTDX10_CAT.monitor.level(v)); this.monitorLevel = v; return; }

            case "cwSpeed": { const v = this.level(control, num(), 4, 60); this.send(FTDX10_CAT.cwSpeed.set(v)); this.cwSpeed = v; return; }
            case "breakIn": this.send(FTDX10_CAT.breakIn.set(bool())); this.breakIn = bool(); return;
            case "cwMemory": {
                // message keyer memory 1-5: KY6 .. KYA
                const n = this.level(control, num(), 1, 5);
                this.send(`KY${"6789A"[n - 1]};`);
                return;
            }

            case "rptShift": { const v = this.level(control, num(), 0, 2); this.send(`OS0${v};`); this.vfo().rptShift = v; return; }
            case "toneMode": { const v = this.level(control, num(), 0, 3); this.send(`CT0${TONE_TO_CAT[v]};`); this.vfo().toneMode = v; return; }
            case "ctcss": { const v = this.level(control, num(), 0, 49); this.send(`CN00${pad(v, 3)};`); this.ctcssIndex = v; return; }
            case "dcs": { const v = this.level(control, num(), 0, 103); this.send(`CN01${pad(v, 3)};`); this.dcsIndex = v; return; }

            default: throw new Error(`Unknown ${this.model} control: ${control}`);

        }

    }

}
