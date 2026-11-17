import { HttpError, Router, sendJson } from "../http/server.js";
import { radioManager } from "../services/radio/radio-manager.js";
import { updateService } from "../services/system/update.service.js";

/*
 * Software update (page /update.html)
 *
 *   GET  /api/update          installed version, new commits, last run, log
 *   POST /api/update/check    git fetch now (waits, up to about a minute)
 *   POST /api/update/install  install the new version: the server
 *                             restarts, the page reloads by itself
 */

export function updateRoutes(router: Router): void {

    router.get("/api/update", async ({ res }) => {
        sendJson(res, 200, await updateService.getStatus());
    });

    router.post("/api/update/check", async ({ res }) => {
        await updateService.check();
        sendJson(res, 200, await updateService.getStatus());
    });

    router.post("/api/update/install", async ({ res }) => {

        // never in the middle of a transmission
        const radio = radioManager.getRadio();
        let tx = false;
        try {
            tx = Boolean(radio?.getState().tx);
        }
        catch { /* driver restarting */ }
        if (tx) throw new HttpError(409, "The radio is transmitting - try again when it is back on receive");

        // PTT off, in case
        try {
            radio?.control("ptt", false);
        }
        catch { /* not connected */ }

        try {
            await updateService.install();
        }
        catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : String(error));
        }

        sendJson(res, 200, { success: true, message: "Update started - YAESU-REMOTE restarts, the page reloads in about a minute" });

    });

}
