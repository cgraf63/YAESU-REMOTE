import fs from "node:fs";

import { config } from "../../config.js";
import { detect, type Detected } from "./detect.js";
import { Ftx1Service } from "./ftx-1.service.js";
import type { YaesuRadio } from "./radio.interface.js";
import { YaesuHfService } from "./yaesu-hf.service.js";

/*
 * RadioManager: finds the transceiver and keeps the driver running.
 *
 *   searching   probe the serial ports with ID; every few seconds
 *   connected   driver running (it reconnects on its own after short
 *               interruptions)
 *
 * If the driver has had no connection or no answer for LOST_AFTER_MS
 * (cable moved to another radio, other USB port), it is stopped and the
 * search starts again. This way the box also works when the FTX-1 is
 * swapped for the FTDX10.
 */

const SEARCH_INTERVAL_MS = 4000;
const LOST_AFTER_MS = 20_000;

export interface ManagerStatus {
    state: "searching" | "connected" | "unsupported";
    model: string | null;
    device: string;
    baudRate: number;
    id: string;
    message: string;
    since: number;
}


class RadioManager {

    private radio: YaesuRadio | null = null;
    private found: Detected | null = null;
    private status: ManagerStatus = { state: "searching", model: null, device: "", baudRate: 0, id: "", message: "starting", since: Date.now() };
    private timer: NodeJS.Timeout | null = null;
    private searching = false;
    private stopped = false;
    private problemSince = 0;

    start(): void {
        this.stopped = false;
        void this.search();
        this.timer = setInterval(() => this.tick(), SEARCH_INTERVAL_MS);
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.radio?.stop();
        this.radio = null;
    }

    getRadio(): YaesuRadio | null {
        return this.radio;
    }

    getStatus(): ManagerStatus {
        return { ...this.status };
    }

    private setStatus(patch: Partial<ManagerStatus>): void {
        const changed = patch.state !== undefined && patch.state !== this.status.state;
        this.status = { ...this.status, ...patch, ...(changed ? { since: Date.now() } : {}) };
    }

    private tick(): void {

        if (this.stopped) return;

        if (!this.radio) {
            void this.search();
            return;
        }

        // another radio on the same port: start over at once
        if (this.radio.isWrongRadio()) {
            console.log(`RADIO: another transceiver answers instead of the ${this.radio.model} - searching again`);
            this.drop("other transceiver, searching");
            return;
        }

        // driver running: lost for good?
        const answering = this.radio.isConnected() && Date.now() - this.radio.getLastAnswerAt() < 5000;

        if (answering) {
            this.problemSince = 0;
            return;
        }

        if (!this.problemSince) this.problemSince = Date.now();

        if (Date.now() - this.problemSince > LOST_AFTER_MS) {
            console.log(`RADIO: ${this.radio.model} lost - searching again`);
            this.drop("connection lost, searching");
        }

    }

    private drop(message: string): void {
        this.radio?.stop();
        this.radio = null;
        this.found = null;
        this.problemSince = 0;
        this.setStatus({ state: "searching", model: null, message });
        void this.search();
    }

    private async search(): Promise<void> {

        if (this.searching || this.radio || this.stopped) return;

        this.searching = true;

        try {

            let last = "";
            const found = await detect(config.cat.device, config.cat.baudRate, text => {
                last = text;
                this.setStatus({ message: text });
            });

            if (this.stopped) return;

            if (!found) {
                this.setStatus({ state: "searching", model: null, device: "", baudRate: 0, id: "", message: last || "no transceiver found" });
                return;
            }

            if (!found.model || found.model === "FT-710") {
                // FT-710: driver follows (CAT manual + Hamlib)
                const name = found.model ?? `unknown Yaesu (ID ${found.id})`;
                if (this.status.state !== "unsupported" || this.status.id !== found.id) {
                    console.log(`RADIO: ${name} on ${found.device} @ ${found.baudRate} - not supported yet`);
                }
                this.setStatus({ state: "unsupported", model: found.model, device: found.device, baudRate: found.baudRate, id: found.id, message: `${name} is not supported yet` });
                return;
            }

            console.log(`RADIO: ${found.model} found on ${found.device}${realName(found.device)} @ ${found.baudRate}`);

            this.found = found;
            this.radio = found.model === "FTX-1"
                ? new Ftx1Service(found.device, found.baudRate)
                : new YaesuHfService(found.device, found.baudRate);
            this.radio.start();
            this.problemSince = 0;

            this.setStatus({ state: "connected", model: found.model, device: found.device, baudRate: found.baudRate, id: found.id, message: `${found.model} on ${found.device} @ ${found.baudRate}` });

        }
        catch (error) {
            this.setStatus({ message: (error as Error).message });
        }
        finally {
            this.searching = false;
        }

    }

    /* for the status API */
    getDetected(): Detected | null {
        return this.found;
    }

}

export const radioManager = new RadioManager();

/* " (/dev/ttyUSB0)" for a /dev/serial/by-id name */
function realName(device: string): string {
    try {
        const real = fs.realpathSync(device);
        return real !== device ? ` (${real})` : "";
    }
    catch {
        return "";
    }
}
