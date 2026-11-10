import { HttpError, Router, sendJson } from "../http/server.js";
import { radioManager } from "../services/radio/radio-manager.js";
import type { YaesuRadio } from "../services/radio/radio.interface.js";
import { YAESU_CTCSS, YAESU_DCS } from "../services/radio/yaesu-tables.js";

/*
 * /api/radio - the connected transceiver (FTX-1, FTDX10, ...)
 *
 *   GET  /api/status                 server + detection status
 *   GET  /api/radio                  state (409 while no radio is connected)
 *   GET  /api/radio/profile          what the radio can do + CTCSS / DCS tables
 *   POST /api/radio/control          { control, value }
 *   GET  /api/radio/memories         channel list (read with control "memoryScan")
 *   POST /api/radio/memories/store   { channel, from: MAIN|SUB, name }
 *   POST /api/radio/memories/rename  { channel, name }
 */

const started = Date.now();

function radio(): YaesuRadio {
    const r = radioManager.getRadio();
    if (!r) {
        const status = radioManager.getStatus();
        throw new HttpError(409, status.state === "unsupported" ? status.message : "No transceiver connected", { status });
    }
    return r;
}

function channelOf(value: unknown, max: number): number {
    const ch = Number(value);
    if (!Number.isInteger(ch) || ch < 1 || ch > max) throw new HttpError(400, `Channel 1 - ${max}`);
    return ch;
}

function memoryRadio(): YaesuRadio & Required<Pick<YaesuRadio, "getMemories" | "getMemoryScan" | "storeMemory" | "renameMemory">> {
    const r = radio();
    if (!r.getProfile().memories || !r.getMemories || !r.getMemoryScan || !r.storeMemory || !r.renameMemory) {
        throw new HttpError(404, `Memory channels are not available for the ${r.model}`);
    }
    return r as ReturnType<typeof memoryRadio>;
}


export function radioRoutes(router: Router): void {

    router.get("/api/status", ({ res }) => {
        const r = radioManager.getRadio();
        sendJson(res, 200, {
            name: "YAESU-REMOTE",
            uptime: Math.round((Date.now() - started) / 1000),
            radio: radioManager.getStatus(),
            connected: r ? r.isConnected() : false
        });
    });

    router.get("/api/radio", ({ res }) => {
        const r = radio();
        sendJson(res, 200, { name: r.model, ...r.getState() });
    });

    router.get("/api/radio/profile", ({ res }) => {
        const r = radio();
        sendJson(res, 200, {
            ...r.getProfile(),
            ctcss: YAESU_CTCSS.map(v => v / 10),
            dcs: YAESU_DCS
        });
    });

    router.post("/api/radio/control", ({ res, body }) => {

        const r = radio();
        const { control, value } = body;

        if (typeof control !== "string" || !control) throw new HttpError(400, "control missing");

        try {
            r.control(control, value);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new HttpError(/not connected/i.test(message) ? 503 : 400, message);
        }

        sendJson(res, 200, { success: true, control, value });

    });

    router.get("/api/radio/memories", ({ res }) => {
        const r = memoryRadio();
        sendJson(res, 200, { scan: r.getMemoryScan(), memories: r.getMemories() });
    });

    router.post("/api/radio/memories/store", async ({ res, body }) => {
        const r = memoryRadio();
        const ch = channelOf(body.channel, r.getProfile().memories!.channels);
        try {
            const memory = await r.storeMemory(ch, body.from === "SUB" ? "SUB" : "MAIN", String(body.name ?? ""));
            if (!memory) throw new HttpError(502, "Stored, but the channel could not be read back - check on the radio");
            sendJson(res, 200, { success: true, memory });
        }
        catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(409, (error as Error).message);
        }
    });

    router.post("/api/radio/memories/rename", async ({ res, body }) => {
        const r = memoryRadio();
        const ch = channelOf(body.channel, r.getProfile().memories!.channels);
        try {
            await r.renameMemory(ch, String(body.name ?? ""));
        }
        catch (error) {
            throw new HttpError(409, (error as Error).message);
        }
        sendJson(res, 200, { success: true });
    });

}
