import { HttpError, Router, sendJson } from "../http/server.js";
import type { WifiService } from "../services/wifi/wifi.service.js";

/*
 * /api/wifi - Wi-Fi setup in the browser (NetworkManager)
 *
 *   GET  /api/wifi                 status: network, signal, IP, addresses
 *   GET  /api/wifi/saved           saved networks, best first (setup network last)
 *   GET  /api/wifi/scan?rescan=1   networks in range
 *   POST /api/wifi/add             { ssid, password, hidden, connect }
 *   POST /api/wifi/remove          { uuid }
 *   POST /api/wifi/order           { uuids: [...] }  best first
 *   POST /api/wifi/connect         { uuid }  switches in the background, fallback to the previous network
 *   GET  /api/wifi/ntfy            ntfy settings
 *   POST /api/wifi/ntfy            { enabled, server, topic }
 *   POST /api/wifi/ntfy/test
 *
 * Passwords are never returned.
 */

function fail(error: unknown, status = 400): never {
    if (error instanceof HttpError) throw error;
    throw new HttpError(status, (error as Error).message);
}

export function wifiRoutes(router: Router, wifi: WifiService): void {

    const ready = async () => {
        if (!(await wifi.isAvailable())) {
            const status = await wifi.status();
            throw new HttpError(503, status.error || "Wi-Fi is not managed by NetworkManager");
        }
    };

    router.get("/api/wifi", async ({ res }) => {
        sendJson(res, 200, await wifi.status());
    });

    router.get("/api/wifi/saved", async ({ res }) => {
        await ready();
        sendJson(res, 200, { networks: await wifi.savedNetworks() });
    });

    router.get("/api/wifi/scan", async ({ res, url }) => {
        await ready();
        try {
            sendJson(res, 200, { networks: await wifi.scan(url.searchParams.get("rescan") === "1") });
        }
        catch (error) {
            fail(error, 502);
        }
    });

    router.post("/api/wifi/add", async ({ res, body }) => {
        await ready();
        try {
            const network = await wifi.addNetwork(body.ssid, body.password, body.hidden === true);
            const switching = body.connect === true && !network.active ? await wifi.startSwitch(network.uuid) : null;
            sendJson(res, 200, { success: true, network, switching, status: await wifi.status() });
        }
        catch (error) {
            fail(error);
        }
    });

    router.post("/api/wifi/remove", async ({ res, body }) => {
        await ready();
        try {
            await wifi.removeNetwork(String(body.uuid ?? ""));
            sendJson(res, 200, { success: true });
        }
        catch (error) {
            fail(error);
        }
    });

    router.post("/api/wifi/order", async ({ res, body }) => {
        await ready();
        if (!Array.isArray(body.uuids)) throw new HttpError(400, "uuids missing");
        try {
            await wifi.reorder(body.uuids.map(String));
            sendJson(res, 200, { success: true, networks: await wifi.savedNetworks() });
        }
        catch (error) {
            fail(error);
        }
    });

    router.post("/api/wifi/connect", async ({ res, body }) => {
        await ready();
        try {
            const switching = await wifi.startSwitch(String(body.uuid ?? ""));
            sendJson(res, 202, { success: true, switching, status: await wifi.status() });
        }
        catch (error) {
            fail(error, 409);
        }
    });

    router.get("/api/wifi/ntfy", ({ res }) => {
        sendJson(res, 200, wifi.getSettings().ntfy);
    });

    router.post("/api/wifi/ntfy", ({ res, body }) => {
        try {
            sendJson(res, 200, { success: true, ntfy: wifi.saveNtfy(body) });
        }
        catch (error) {
            fail(error);
        }
    });

    router.post("/api/wifi/ntfy/test", async ({ res }) => {
        const status = await wifi.status();
        const url = status.urls[status.urls.length - 1] ?? "";
        try {
            await wifi.notify(`YAESU-REMOTE test - ${status.ip || "no IP"} (${status.ssid || "Wi-Fi"})`, url);
            sendJson(res, 200, { success: true });
        }
        catch (error) {
            fail(error, 502);
        }
    });

}
