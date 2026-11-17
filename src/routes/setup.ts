import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { Router, sendJson } from "../http/server.js";

/*
 * Setup assistant (/setup.html) - ready-made image only.
 *
 * The image is built with data/setup.json = { "pending": true }: until
 * the assistant is finished, "/" leads to it. Own installations have no
 * such file and never see it (it is still reachable as /setup.html).
 *
 *   GET  /api/setup        { pending }
 *   POST /api/setup/done   assistant finished: "/" is the remote again
 */

const FILE = () => path.join(config.dataDir, "setup.json");

export function setupPending(): boolean {
    try {
        return JSON.parse(fs.readFileSync(FILE(), "utf8")).pending === true;
    }
    catch {
        return false;
    }
}

export function setupRoutes(router: Router): void {

    router.get("/api/setup", ({ res }) => {
        sendJson(res, 200, { pending: setupPending() });
    });

    router.post("/api/setup/done", ({ res }) => {
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(FILE(), JSON.stringify({ pending: false, doneAt: new Date().toISOString() }) + "\n");
        sendJson(res, 200, { success: true });
    });

}
