import fs from "node:fs";
import path from "node:path";

import { TtyPort } from "./tty-port.js";
import type { RadioModel } from "./radio.interface.js";

/*
 * Find the transceiver: try the serial ports with "ID;".
 *
 *   ID0840;  FTX-1      ID0761;  FTDX10      ID0800;  FT-710
 *
 * Yaesu radios have a CP2105 dual UART: interface 00 is the "Enhanced"
 * port (CAT), interface 01 the "Standard" port (RTS / DTR keying).
 * Only the CAT port is probed when /dev/serial/by-id exists, so the
 * keying lines of the standard port are never touched.
 */

export const RADIO_IDS: Record<string, RadioModel> = {
    "0840": "FTX-1",
    "0761": "FTDX10",
    "0800": "FT-710"
};

/* usual CAT rates, the factory setting first */
export const BAUD_RATES = [38400, 115200, 19200, 9600, 4800];

export interface Detected {
    device: string;
    baudRate: number;
    id: string;
    model: RadioModel | null;
}

const BY_ID = "/dev/serial/by-id";


function list(dir: string, filter: (name: string) => boolean): string[] {
    try {
        return fs.readdirSync(dir).filter(filter).sort().map(name => path.join(dir, name));
    }
    catch {
        return [];
    }
}

/* candidate CAT ports, best first */
export function candidates(): string[] {

    const byId = list(BY_ID, () => true);

    if (byId.length) {
        // CP2105: if00 = CAT. Other adapters (one port each): all of them.
        const cat = byId.filter(p => /if00/.test(p) || !/-if0[1-9]/.test(p));
        return [...new Set(cat.map(p => fs.realpathSync(p)))];
    }

    return [
        ...list("/dev", name => /^ttyUSB\d+$/.test(name)),
        ...list("/dev", name => /^ttyACM\d+$/.test(name))
    ];

}


/* one device, one rate: null = no answer */
export function probe(device: string, baudRate: number, timeoutMs = 600): Promise<Detected | null> {

    return new Promise(resolve => {

        const port = new TtyPort(device, { baudRate, dataBits: 8, stopBits: 1, parity: "none", rtscts: false });
        let buffer = "";
        let done = false;

        const finish = (result: Detected | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(retry);
            port.removeAllListeners();
            port.on("error", () => undefined);
            port.close();
            resolve(result);
        };

        const timer = setTimeout(() => finish(null), timeoutMs);
        let retry: NodeJS.Timeout | undefined;

        port.on("error", () => finish(null));
        port.on("close", () => finish(null));
        port.on("data", (data: Buffer) => {
            buffer += data.toString("latin1");
            const m = buffer.match(/ID(\d{4});/);
            if (m) finish({ device, baudRate, id: m[1]!, model: RADIO_IDS[m[1]!] ?? null });
            if (buffer.length > 512) buffer = buffer.slice(-64);
        });

        port.open(error => {
            if (error) return finish(null);
            port.write("ID;");
            // a radio that just woke up may drop the first command
            retry = setTimeout(() => { if (!done) port.write("ID;"); }, timeoutMs / 2);
        });

    });

}


/*
 * Search all candidates (or the configured device) at all rates
 * (or the configured rate).
 */
export async function detect(device: string, baudRate: number, log: (text: string) => void): Promise<Detected | null> {

    const devices = device && device !== "auto" ? [device] : candidates();
    const rates = baudRate ? [baudRate] : BAUD_RATES;

    if (!devices.length) {
        log("no serial device (USB cable plugged in, radio switched on?)");
        return null;
    }

    for (const dev of devices) {
        for (const rate of rates) {
            log(`trying ${dev} @ ${rate}`);
            const found = await probe(dev, rate);
            if (found) return found;
        }
    }

    log(`no answer to ID; on ${devices.join(", ")}`);
    return null;

}
