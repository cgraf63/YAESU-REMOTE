import http from "node:http";

import { config } from "./config.js";
import { Router, sendJson, serveStatic } from "./http/server.js";
import { radioRoutes } from "./routes/radio.js";
import { wifiRoutes } from "./routes/wifi.js";
import { startAudioWebSocket } from "./services/audio/audio-ws.service.js";
import { radioManager } from "./services/radio/radio-manager.js";
import { WifiService } from "./services/wifi/wifi.service.js";

/*
 * YAESU-REMOTE - browser remote for Yaesu FTX-1 / FTDX10 / FT-710
 *
 *   /            remote page (adapts to the detected radio)
 *   /wifi.html   Wi-Fi setup (NetworkManager)
 *   /api/...     radio state and control (routes/radio.ts)
 *   /audio       RX audio WebSocket (48 kHz, 16 bit, mono)
 *   /audio-tx    TX audio WebSocket (browser microphone)
 */

const wifi = new WifiService();

const router = new Router();
radioRoutes(router);
wifiRoutes(router, wifi);

const server = http.createServer((req, res) => {

    const url = new URL(req.url ?? "/", "http://localhost");

    void router.handle(req, res, url).then(handled => {
        if (handled) return;
        if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
        serveStatic(config.publicDir, req, res, url);
    });

});

server.on("error", error => {
    console.error("HTTP:", error.message);
    process.exit(1);
});

startAudioWebSocket(server);

server.listen(config.http.port, config.http.host, () => {
    console.log(`YAESU-REMOTE listening on http://${config.http.host}:${config.http.port}`);
    radioManager.start();
    void wifi.start();
});

/* never leave the radio transmitting when the server stops */
function shutdown(signal: string): void {
    console.log(`${signal}: stopping`);
    try {
        radioManager.getRadio()?.control("ptt", false);
    }
    catch { /* not connected */ }
    setTimeout(() => {
        radioManager.stop();
        wifi.stop();
        server.close();
        process.exit(0);
    }, 150);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
