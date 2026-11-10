import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../../config.js";
import { NmcliError, nmcli, terseRows } from "./nmcli.js";

/*
 * Wi-Fi via NetworkManager (nmcli). No hotspot on the Pi: the box joins
 * the home router or the phone hotspot.
 *
 *   - setup network: "YAESU-REMOTE" / "yaesu-remote", always stored with
 *     the lowest priority, cannot be deleted. On the first start the phone
 *     opens a hotspot with exactly these data.
 *   - saved networks: order = autoconnect-priority (top 100, then 90, ...).
 *     NetworkManager picks the best one in range by itself: home router at
 *     home, phone hotspot on the road.
 *   - switching: the page is told first where the box will be; if the new
 *     network does not come up within 30 s, the previous one is activated.
 *   - ntfy: when the box is online with a new address, a message with a
 *     link goes to the phone (Android often cannot open .local names).
 */

const SETUP_NAME = "yaesu-remote-setup";
const SETUP_PRIORITY = -100;
const TOP_PRIORITY = 100;
const PRIORITY_STEP = 10;
const SWITCH_TIMEOUT_S = 30;
const WATCH_INTERVAL_MS = 15_000;

const SETTINGS_FILE = () => path.join(config.dataDir, "wifi.json");

export interface WifiNetwork {
    ssid: string;
    signal: number;
    security: string;
    channel: number;
    inUse: boolean;
    saved: boolean;
}

export interface SavedNetwork {
    uuid: string;
    name: string;
    ssid: string;
    priority: number;
    active: boolean;
    setup: boolean;
}

export interface WifiStatus {
    available: boolean;
    error: string;
    interface: string;
    state: string;
    ssid: string;
    uuid: string;
    signal: number;
    ip: string;
    hostname: string;
    urls: string[];
    switching: SwitchInfo | null;
    lastSwitch: SwitchInfo | null;
    setup: { ssid: string; password: string };
}

export interface SwitchInfo {
    to: string;
    from: string;
    startedAt: number;
    finishedAt: number;
    result: "running" | "ok" | "failed-back" | "failed";
    message: string;
}

export interface NtfySettings {
    enabled: boolean;
    server: string;
    topic: string;
}

interface Settings {
    ntfy: NtfySettings;
}


function validSsid(ssid: unknown): string {
    const s = String(ssid ?? "");
    if (!s || Buffer.byteLength(s, "utf8") > 32) throw new Error("Network name: 1 - 32 characters");
    return s;
}

function validPassword(password: unknown): string {
    const p = String(password ?? "");
    if (p === "") return "";
    if (/^[0-9a-fA-F]{64}$/.test(p)) return p;
    if (p.length < 8 || p.length > 63) throw new Error("Password: 8 - 63 characters (or none for an open network)");
    return p;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export class WifiService {

    private readonly cmd: string;
    private readonly iface: string;
    private switching: SwitchInfo | null = null;
    private lastSwitch: SwitchInfo | null = null;
    private watchTimer: NodeJS.Timeout | null = null;
    private lastNotified = "";
    private available: boolean | null = null;
    private lastError = "";

    constructor(command = config.wifi.nmcli, iface = config.wifi.interface) {
        this.cmd = command;
        this.iface = iface;
    }

    private run(args: string[], timeoutMs?: number): Promise<string> {
        return nmcli(this.cmd, args, timeoutMs);
    }

    /* NetworkManager running and the Wi-Fi interface present? */
    async isAvailable(): Promise<boolean> {
        try {
            const rows = terseRows(await this.run(["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"]));
            this.available = rows.some(([device, type]) => device === this.iface && type === "wifi");
            this.lastError = this.available ? "" : `No Wi-Fi interface ${this.iface}`;
        }
        catch (error) {
            this.available = false;
            this.lastError = (error as NmcliError).message || "NetworkManager not available";
        }
        return this.available;
    }


    /* ------------------------------------------------------------
       Status
       ------------------------------------------------------------ */

    async status(): Promise<WifiStatus> {

        const base: WifiStatus = {
            available: false,
            error: "",
            interface: this.iface,
            state: "unavailable",
            ssid: "",
            uuid: "",
            signal: 0,
            ip: "",
            hostname: os.hostname(),
            urls: [],
            switching: this.switching,
            lastSwitch: this.lastSwitch,
            setup: { ssid: config.wifi.setupSsid, password: config.wifi.setupPassword }
        };

        if (!(await this.isAvailable())) return { ...base, error: this.lastError };

        const show = terseRows(await this.run(["-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS", "device", "show", this.iface]));
        const value = (key: string) => show.find(([k]) => k === key || k?.startsWith(`${key}[`))?.slice(1).join(":") ?? "";

        const state = value("GENERAL.STATE").replace(/^\d+\s*\(|\)$/g, "") || "unknown";
        const ip = value("IP4.ADDRESS").split("/")[0] ?? "";

        const saved = await this.savedNetworks();
        const active = saved.find(n => n.active);

        let signal = 0;
        if (active) {
            try {
                const rows = terseRows(await this.run(["-t", "-f", "IN-USE,SIGNAL", "device", "wifi", "list", "ifname", this.iface, "--rescan", "no"]));
                signal = Number(rows.find(([inUse]) => inUse === "*")?.[1] ?? 0);
            }
            catch { /* no scan results */ }
        }

        const port = config.http.port === 80 ? "" : `:${config.http.port}`;
        const host = os.hostname();

        return {
            ...base,
            available: true,
            state,
            ssid: active?.ssid ?? "",
            uuid: active?.uuid ?? "",
            signal,
            ip,
            urls: ip ? [`http://${host}.local${port}/`, `http://${ip}${port}/`] : [`http://${host}.local${port}/`]
        };

    }


    /* ------------------------------------------------------------
       Networks
       ------------------------------------------------------------ */

    async savedNetworks(): Promise<SavedNetwork[]> {

        const rows = terseRows(await this.run(["-t", "-f", "NAME,UUID,TYPE,AUTOCONNECT-PRIORITY,ACTIVE", "connection", "show"]));
        const wifi = rows.filter(([, , type]) => type === "802-11-wireless");

        const list: SavedNetwork[] = [];

        for (const [name = "", uuid = "", , priority = "0", active = ""] of wifi) {
            let ssid = name;
            try {
                ssid = (await this.run(["-g", "802-11-wireless.ssid", "connection", "show", "uuid", uuid])).trim() || name;
            }
            catch { /* keep the name */ }
            list.push({ uuid, name, ssid, priority: Number(priority) || 0, active: active === "yes", setup: name === SETUP_NAME });
        }

        // highest priority first, setup network always last
        return list.sort((a, b) => Number(a.setup) - Number(b.setup) || b.priority - a.priority || a.ssid.localeCompare(b.ssid));

    }

    async scan(rescan: boolean): Promise<WifiNetwork[]> {

        const rows = terseRows(await this.run(
            ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY,CHAN", "device", "wifi", "list", "ifname", this.iface, "--rescan", rescan ? "yes" : "auto"],
            rescan ? 30_000 : 15_000
        ));

        const saved = new Set((await this.savedNetworks()).map(n => n.ssid));
        const best = new Map<string, WifiNetwork>();

        for (const [inUse = "", ssid = "", signal = "0", security = "", chan = "0"] of rows) {
            if (!ssid) continue;   // hidden networks
            const net: WifiNetwork = {
                ssid,
                signal: Number(signal) || 0,
                security: security === "--" ? "" : security,
                channel: Number(chan) || 0,
                inUse: inUse === "*",
                saved: saved.has(ssid)
            };
            const known = best.get(ssid);
            if (!known || net.inUse || (!known.inUse && net.signal > known.signal)) best.set(ssid, net);
        }

        return [...best.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal);

    }

    /*
     * Add a network (or update the password of a saved one with the same
     * name). New networks go to the end of the list, above the setup network.
     */
    async addNetwork(ssidIn: unknown, passwordIn: unknown, hidden = false): Promise<SavedNetwork> {

        const ssid = validSsid(ssidIn);
        const password = validPassword(passwordIn);

        if (ssid === config.wifi.setupSsid) throw new Error(`${ssid} is the setup network, it is always stored`);

        const saved = await this.savedNetworks();
        const existing = saved.find(n => n.ssid === ssid && !n.setup);
        const security = password ? ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password] : [];

        if (existing) {
            if (password) await this.run(["connection", "modify", "uuid", existing.uuid, ...security]);
            else await this.run(["connection", "modify", "uuid", existing.uuid, "remove", "802-11-wireless-security"]).catch(() => undefined);
            await this.run(["connection", "modify", "uuid", existing.uuid, "802-11-wireless.hidden", hidden ? "yes" : "no"]);
            return (await this.savedNetworks()).find(n => n.uuid === existing.uuid) ?? existing;
        }

        const others = saved.filter(n => !n.setup);
        const priority = others.length ? Math.max(Math.min(...others.map(n => n.priority)) - PRIORITY_STEP, SETUP_PRIORITY + 1) : TOP_PRIORITY;

        const out = await this.run([
            "connection", "add", "type", "wifi", "ifname", this.iface,
            "con-name", `yaesu-remote ${ssid}`, "ssid", ssid,
            "connection.autoconnect", "yes", "connection.autoconnect-priority", String(priority),
            "802-11-wireless.hidden", hidden ? "yes" : "no",
            ...security
        ]);

        const uuid = out.match(/\(([0-9a-f-]{36})\)/i)?.[1];
        const added = (await this.savedNetworks()).find(n => n.uuid === uuid || (n.ssid === ssid && !n.setup));
        if (!added) throw new Error("Network added, but not found afterwards");
        return added;

    }

    async removeNetwork(uuid: string): Promise<void> {
        const net = (await this.savedNetworks()).find(n => n.uuid === uuid);
        if (!net) throw new Error("Unknown network");
        if (net.setup) throw new Error("The setup network cannot be deleted - it is the way back in");
        await this.run(["connection", "delete", "uuid", uuid]);
    }

    /* new order (uuids, best first): priorities 100, 90, 80, ... */
    async reorder(uuids: string[]): Promise<void> {
        const saved = (await this.savedNetworks()).filter(n => !n.setup);
        const order = uuids.filter(u => saved.some(n => n.uuid === u));
        for (const n of saved) if (!order.includes(n.uuid)) order.push(n.uuid);
        for (const [i, uuid] of order.entries()) {
            const priority = Math.max(TOP_PRIORITY - i * PRIORITY_STEP, SETUP_PRIORITY + 1);
            if (saved.find(n => n.uuid === uuid)?.priority !== priority) {
                await this.run(["connection", "modify", "uuid", uuid, "connection.autoconnect-priority", String(priority)]);
            }
        }
    }

    /* setup network present with the lowest priority (idempotent) */
    async ensureSetupNetwork(): Promise<void> {
        const setup = (await this.savedNetworks()).find(n => n.setup);
        if (setup) {
            if (setup.priority !== SETUP_PRIORITY) {
                await this.run(["connection", "modify", "uuid", setup.uuid, "connection.autoconnect-priority", String(SETUP_PRIORITY)]);
            }
            return;
        }
        await this.run([
            "connection", "add", "type", "wifi", "ifname", this.iface,
            "con-name", SETUP_NAME, "ssid", config.wifi.setupSsid,
            "connection.autoconnect", "yes", "connection.autoconnect-priority", String(SETUP_PRIORITY),
            "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", config.wifi.setupPassword
        ]);
        console.log(`WIFI: setup network ${config.wifi.setupSsid} stored`);
    }


    /* ------------------------------------------------------------
       Switching with fallback
       ------------------------------------------------------------ */

    /*
     * Starts the switch in the background (the answer has to reach the
     * page before the box leaves the current network) and returns at once.
     */
    async startSwitch(uuid: string): Promise<SwitchInfo> {

        if (this.switching) throw new Error(`Already switching to ${this.switching.to}`);

        const saved = await this.savedNetworks();
        const target = saved.find(n => n.uuid === uuid);
        if (!target) throw new Error("Unknown network");

        const previous = saved.find(n => n.active);

        const info: SwitchInfo = {
            to: target.ssid,
            from: previous?.ssid ?? "",
            startedAt: Date.now(),
            finishedAt: 0,
            result: "running",
            message: `Switching to ${target.ssid}`
        };

        this.switching = info;

        void (async () => {
            await sleep(1500);   // let the HTTP answer go out
            try {
                await this.run(["-w", String(SWITCH_TIMEOUT_S), "connection", "up", "uuid", target.uuid], (SWITCH_TIMEOUT_S + 10) * 1000);
                info.result = "ok";
                info.message = `Connected to ${target.ssid}`;
                console.log(`WIFI: ${info.message}`);
            }
            catch (error) {
                const why = (error as Error).message;
                console.error(`WIFI: ${target.ssid} failed: ${why}`);
                if (previous && previous.uuid !== target.uuid) {
                    try {
                        await this.run(["-w", String(SWITCH_TIMEOUT_S), "connection", "up", "uuid", previous.uuid], (SWITCH_TIMEOUT_S + 10) * 1000);
                        info.result = "failed-back";
                        info.message = `${target.ssid} did not connect (${why}) - back on ${previous.ssid}`;
                    }
                    catch {
                        info.result = "failed";
                        info.message = `${target.ssid} did not connect (${why}); ${previous.ssid} neither - NetworkManager picks a network by itself`;
                    }
                }
                else {
                    info.result = "failed";
                    info.message = `${target.ssid} did not connect (${why})`;
                }
                console.log(`WIFI: ${info.message}`);
            }
            finally {
                info.finishedAt = Date.now();
                this.lastSwitch = info;
                this.switching = null;
                void this.checkOnline();
            }
        })();

        return info;

    }


    /* ------------------------------------------------------------
       ntfy: message with the address when the box is online
       ------------------------------------------------------------ */

    getSettings(): Settings {
        try {
            const data = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) as Partial<Settings>;
            return { ntfy: { enabled: false, server: "https://ntfy.sh", topic: "", ...data.ntfy } };
        }
        catch {
            return { ntfy: { enabled: false, server: "https://ntfy.sh", topic: "" } };
        }
    }

    saveNtfy(input: Partial<NtfySettings>): NtfySettings {

        const server = String(input.server ?? "https://ntfy.sh").trim().replace(/\/+$/, "");
        const topic = String(input.topic ?? "").trim();

        if (!/^https?:\/\/[^\s/]+/.test(server)) throw new Error("ntfy server: http(s)://host");
        if (topic && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error("ntfy topic: letters, digits, - and _ (max 64)");

        const ntfy: NtfySettings = { enabled: Boolean(input.enabled) && topic !== "", server, topic };

        fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
        fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ ...this.getSettings(), ntfy }, null, 1));

        this.lastNotified = "";   // new settings: tell the current address again
        return ntfy;

    }

    async notify(text: string, click: string, settings = this.getSettings().ntfy): Promise<void> {

        if (!settings.topic) throw new Error("No ntfy topic set");

        const response = await fetch(`${settings.server}/${encodeURIComponent(settings.topic)}`, {
            method: "POST",
            headers: { Title: "YAESU-REMOTE", Tags: "radio", Click: click },
            body: text,
            signal: AbortSignal.timeout(10_000)
        });

        if (!response.ok) throw new Error(`ntfy: HTTP ${response.status}`);

    }

    /* online with a new address? -> ntfy */
    private async checkOnline(): Promise<void> {

        try {
            const ntfy = this.getSettings().ntfy;
            if (!ntfy.enabled || this.switching) return;

            const status = await this.status();
            if (!status.ip) return;

            const key = `${status.ssid}|${status.ip}`;
            if (key === this.lastNotified) return;

            const url = status.urls[status.urls.length - 1] ?? "";
            await this.notify(`YAESU-REMOTE online - ${status.ip} (${status.ssid || "Wi-Fi"}). Tap to open.`, url, ntfy);
            this.lastNotified = key;
            console.log(`WIFI: ntfy sent (${status.ip})`);
        }
        catch (error) {
            // no internet yet, ntfy unreachable: try again on the next round
            console.error("WIFI: ntfy:", (error as Error).message);
        }

    }

    /* start: setup network, then watch the address for ntfy */
    async start(): Promise<void> {

        if (!(await this.isAvailable())) {
            console.log(`WIFI: not managed (${this.lastError})`);
            return;
        }

        try {
            await this.ensureSetupNetwork();
        }
        catch (error) {
            console.error("WIFI: setup network:", (error as Error).message);
        }

        void this.checkOnline();
        this.watchTimer = setInterval(() => void this.checkOnline(), WATCH_INTERVAL_MS);

    }

    stop(): void {
        if (this.watchTimer) clearInterval(this.watchTimer);
        this.watchTimer = null;
    }

}


/* ------------------------------------------------------------------
 * wifi.txt on the boot partition (read by the CLI at boot, as root)
 *
 *   # networks in order of preference
 *   ssid=Home
 *   password=secret123
 *   ssid=Phone
 *   password=hotspot99
 *   country=CH          (optional, Wi-Fi regulatory country)
 *
 * After the import the passwords are removed from the file.
 * ------------------------------------------------------------------ */

export interface WifiFile {
    networks: Array<{ ssid: string; password: string; hidden: boolean }>;
    country: string;
}

export function parseWifiFile(text: string): WifiFile {

    const result: WifiFile = { networks: [], country: "" };

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        let value = line.slice(eq + 1).trim();
        if (/^".*"$/.test(value)) value = value.slice(1, -1);

        if (key === "ssid") result.networks.push({ ssid: value, password: "", hidden: false });
        else if ((key === "password" || key === "psk") && result.networks.length) result.networks[result.networks.length - 1]!.password = value;
        else if (key === "hidden" && result.networks.length) result.networks[result.networks.length - 1]!.hidden = /^(1|yes|true)$/i.test(value);
        else if (key === "country") result.country = value.toUpperCase();
    }

    return result;

}

export function scrubWifiFile(text: string, when: Date): string {
    const lines = text.split(/\r?\n/).map(line =>
        /^\s*(password|psk)\s*=/i.test(line) ? line.replace(/=.*$/, "=") : line);
    return `# imported by YAESU-REMOTE on ${when.toISOString().slice(0, 16).replace("T", " ")} UTC - passwords removed\n` +
        lines.filter(line => !line.startsWith("# imported by YAESU-REMOTE")).join("\n");
}
