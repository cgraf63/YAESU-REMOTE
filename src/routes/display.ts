import { Router, sendJson } from "../http/server.js";
import { radioManager } from "../services/radio/radio-manager.js";
import { updateService } from "../services/system/update.service.js";
import type { WifiService } from "../services/wifi/wifi.service.js";

/*
 * GET /api/display - everything the small OLED shows, in one call
 * (polled about once a second by oled/yaesu_oled.py). Wi-Fi data come
 * from a short cache, so polling does not start nmcli every second.
 */

export function displayRoutes(router: Router, wifi: WifiService): void {

    router.get("/api/display", async ({ res }) => {

        const status = radioManager.getStatus();
        const radio = radioManager.getRadio();

        let state: Record<string, unknown> | null = null;
        try {
            state = radio ? radio.getState() : null;
        }
        catch { /* driver restarting */ }

        const side = state ? (state.activeSide === "SUB" ? state.sub : state.main) as Record<string, unknown> : null;

        let w: Awaited<ReturnType<WifiService["cachedStatus"]>> | null = null;
        try {
            w = await wifi.cachedStatus(5000);
        }
        catch { /* NetworkManager busy */ }

        sendJson(res, 200, {
            radio: {
                state: status.state,                    // searching | connected | unsupported
                model: status.model ?? "",
                alive: Boolean(state?.alive),
                frequency: Number(side?.frequency ?? 0),
                mode: String(side?.mode ?? ""),
                tx: Boolean(state?.tx),
                split: Boolean(state?.split),
                message: status.message
            },
            wifi: {
                available: Boolean(w?.available),
                ssid: w?.ssid ?? "",
                ip: w?.ip ?? "",
                signal: w?.signal ?? 0,
                switching: w?.switching?.to ?? "",
                setupSsid: w?.setup.ssid ?? "YAESU-REMOTE",
                hotspot: w?.hotspot.active ? w.hotspot.ssid : "",
                hotspotIp: w?.hotspot.ip ?? ""
            },
            hostname: w?.hostname ?? "",
            version: updateService.getVersion().version,
            updating: updateService.isRunning()
        });

    });

}
