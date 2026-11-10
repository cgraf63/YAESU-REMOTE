import fs from "node:fs";
import path from "node:path";

/*
 * Configuration: defaults < data/config.json < environment.
 * Everything works without a config file: the transceiver is found
 * automatically (ID;), audio uses the USB sound card of the radio.
 *
 * data/config.json (all optional):
 *   {
 *     "http":  { "port": 8080, "host": "0.0.0.0" },
 *     "cat":   { "device": "auto", "baudRate": 0 },
 *     "audio": { "enabled": true, "device": "plughw:CARD=CODEC,DEV=0" }
 *   }
 *
 * Environment: PORT, HOST, CAT_DEVICE, CAT_BAUD, AUDIO_DEVICE, AUDIO,
 * YAESU_DATA (data directory).
 */

export interface Config {
    dataDir: string;
    publicDir: string;
    http: { port: number; host: string };
    /* device "auto" = search; baudRate 0 = try the usual rates */
    cat: { device: string; baudRate: number };
    audio: { enabled: boolean; device: string; sampleRate: number; channels: number };
}

const dataDir = process.env.YAESU_DATA || path.join(process.cwd(), "data");

function readFile(): Partial<Config> {
    try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")) as Partial<Config>;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("config.json:", (error as Error).message, "- using defaults");
        }
        return {};
    }
}

const file = readFile();
const env = process.env;

/* public/ next to the compiled index.js (dist/public) or src/public with tsx */
const here = path.dirname(new URL(import.meta.url).pathname);

export const config: Config = {
    dataDir,
    publicDir: path.join(here, "public"),
    http: {
        port: Number(env.PORT) || file.http?.port || 8080,
        host: env.HOST || file.http?.host || "0.0.0.0"
    },
    cat: {
        device: env.CAT_DEVICE || file.cat?.device || "auto",
        baudRate: Number(env.CAT_BAUD) || file.cat?.baudRate || 0
    },
    audio: {
        enabled: env.AUDIO ? env.AUDIO !== "off" : file.audio?.enabled ?? true,
        device: env.AUDIO_DEVICE || file.audio?.device || "plughw:CARD=CODEC,DEV=0",
        sampleRate: file.audio?.sampleRate || 48000,
        channels: file.audio?.channels || 1
    }
};
