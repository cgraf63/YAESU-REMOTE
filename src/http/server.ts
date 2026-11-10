import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/*
 * Small HTTP layer on node:http (no Express): exact-path routes with
 * JSON bodies, plus static files from public/.
 */

export interface Ctx {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    url: URL;
    body: Record<string, unknown>;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

export class HttpError extends Error {
    constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
    }
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2"
};

const MAX_BODY = 64 * 1024;


export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
}


function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {

    return new Promise((resolve, reject) => {

        if (req.method === "GET" || req.method === "HEAD") return resolve({});

        const chunks: Buffer[] = [];
        let size = 0;

        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new HttpError(413, "Request too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8").trim();
            if (!text) return resolve({});
            try {
                const data = JSON.parse(text) as unknown;
                resolve(data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {});
            }
            catch {
                reject(new HttpError(400, "Invalid JSON"));
            }
        });

        req.on("error", reject);

    });

}


export class Router {

    private readonly routes = new Map<string, Handler>();

    get(pathname: string, handler: Handler): this {
        this.routes.set(`GET ${pathname}`, handler);
        return this;
    }

    post(pathname: string, handler: Handler): this {
        this.routes.set(`POST ${pathname}`, handler);
        return this;
    }

    /* true when a route answered */
    async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {

        const method = req.method === "HEAD" ? "GET" : req.method ?? "GET";
        const handler = this.routes.get(`${method} ${url.pathname}`);

        if (!handler) {
            if ([...this.routes.keys()].some(key => key.endsWith(` ${url.pathname}`))) {
                sendJson(res, 405, { error: "Method not allowed" });
                return true;
            }
            return false;
        }

        try {
            const body = await readBody(req);
            await handler({ req, res, url, body });
        }
        catch (error) {
            if (res.headersSent) return true;
            if (error instanceof HttpError) {
                sendJson(res, error.status, { error: error.message, ...error.extra });
            }
            else {
                console.error("HTTP:", req.method, url.pathname, error);
                sendJson(res, 500, { error: (error as Error).message || "Internal error" });
            }
        }

        return true;

    }

}


/* static files; "/" -> index.html */
export function serveStatic(publicDir: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
    }

    let pathname: string;
    try {
        pathname = decodeURIComponent(url.pathname);
    }
    catch {
        res.writeHead(400).end();
        return;
    }

    if (pathname.endsWith("/")) pathname += "index.html";

    const root = path.resolve(publicDir);
    const file = path.resolve(root, `.${pathname}`);

    if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
    }

    fs.stat(file, (error, stat) => {

        if (error || !stat.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
            return;
        }

        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            "Content-Length": stat.size,
            // small box, few files: always revalidate, so updates show at once
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff"
        });

        if (req.method === "HEAD") {
            res.end();
            return;
        }

        fs.createReadStream(file).pipe(res);

    });

}
