import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

import { config } from "../../config.js";

/*
 * Software version and update ("UPDATE" page, after SHACK-SERVER).
 *
 * The installer keeps /opt/yaesu-remote as a git checkout (owned by
 * root). The server runs as user "yaesu" and may only read it; fetching
 * and installing run as root in a systemd unit the server may start
 * (polkit rule, no sudo):
 *
 *   yaesu-remote-update@check.service     git fetch
 *   yaesu-remote-update@install.service   git reset to origin, install.sh
 *                                       --update, back to the old commit
 *                                       if that fails (scripts/update.sh)
 *
 * The install unit is not part of the server: restarting the server
 * does not stop it. Output: <data>/update.log.
 *
 * Version: "version" in package.json, every later commit counts the
 * patch number up - 0.1.0 + 3 commits = 0.1.3. A new release (e.g.
 * "0.2.0" in package.json) starts counting again.
 *
 * Development (no unit): check = git fetch in the checkout, install is
 * not available.
 */

const ROOT = process.cwd();
const LOG_FILE = path.join(config.dataDir, "update.log");
const STATE_FILE = path.join(config.dataDir, "update-state.json");
const UNIT = "yaesu-remote-update";

/* checked automatically: 3 min after the start, then every 12 h */
const FIRST_CHECK_MS = 3 * 60_000;
const CHECK_EVERY_MS = 12 * 3600_000;
/* an install that has not ended after this is taken as failed */
const RUN_TIMEOUT_MS = 20 * 60_000;


export interface CommitInfo {
    hash: string;
    date: string;
    subject: string;
    version: string;
}

export interface VersionInfo {
    version: string;
    commit: string;
    date: string;
    branch: string;
}

export interface UpdateStatus {
    available: boolean;
    reason: string;
    current: VersionInfo;
    behind: number;
    latest: string;
    commits: CommitInfo[];
    lastCheck: number | null;
    checking: boolean;
    checkError: string;
    running: boolean;
    startedAt: number | null;
    lastRun: null | { at: number; ok: boolean; message: string };
    log: string;
}

interface RunState {
    startedAt: number | null;
    lastRun: UpdateStatus["lastRun"];
}


function run(command: string, args: string[], timeout = 30_000): Promise<string> {

    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error((String(stderr) || error.message).trim().split("\n").pop() || error.message));
                return;
            }
            resolve(String(stdout).trim());
        });
    });

}

/* the checkout belongs to root: safe.directory, or git refuses to read it */
function git(args: string[], timeout = 30_000): Promise<string> {
    return run("git", ["-c", `safe.directory=${ROOT}`, "-C", ROOT, ...args], timeout);
}

function packageVersion(): string {
    try {
        return String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "");
    }
    catch {
        return "";
    }
}

function parseCommits(text: string): CommitInfo[] {
    return text
        .split("\n")
        .filter(Boolean)
        .map(line => {
            const [hash = "", date = "", ...subject] = line.split("\t");
            return { hash, date, subject: subject.join("\t"), version: "" };
        });
}

async function commitVersion(hash: string): Promise<string> {

    try {
        const pkg = JSON.parse(await git(["show", `${hash}:package.json`]));
        const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version ?? ""));
        if (!match) return "";
        // the last commit that changed "version" in package.json
        const release = await git(["log", "-1", "--format=%H", "-G", "\"version\"", hash, "--", "package.json"]);
        const count = release ? Number(await git(["rev-list", "--count", `${release}..${hash}`])) || 0 : 0;
        return `${match[1]}.${match[2]}.${Number(match[3]) + count}`;
    }
    catch {
        return "";
    }

}

function readState(): RunState {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RunState;
    }
    catch {
        return { startedAt: null, lastRun: null };
    }
}

function writeState(state: RunState): void {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    }
    catch {
        // only for the display
    }
}

function logTail(lines = 30): string {
    try {
        return fs.readFileSync(LOG_FILE, "utf8")
            .replace(/\x1b\[[0-9;]*m/g, "")
            .split("\n")
            .slice(-lines)
            .join("\n")
            .trim();
    }
    catch {
        return "";
    }
}


class UpdateService {

    private current: VersionInfo = { version: packageVersion(), commit: "", date: "", branch: "" };
    private behind = 0;
    private commits: CommitInfo[] = [];
    private lastCheck: number | null = null;
    private checkError = "";
    private checking: Promise<void> | null = null;
    private hasUnit: boolean | null = null;
    private timer: NodeJS.Timeout | undefined;

    private isGit(): boolean {
        return fs.existsSync(path.join(ROOT, ".git"));
    }

    /* at server start: own version (shown at once), automatic checks */
    async start(): Promise<void> {

        await this.readCurrent();
        console.log(`VERSION: ${this.current.version || "?"}${this.current.commit ? ` (${this.current.commit})` : ""}`);

        this.finishRun();

        if (this.isGit()) {
            const check = () => void this.check().catch(() => undefined);
            this.timer = setTimeout(() => {
                check();
                this.timer = setInterval(check, CHECK_EVERY_MS);
            }, FIRST_CHECK_MS);
            this.timer.unref();
        }

    }

    stop(): void {
        clearTimeout(this.timer);
        clearInterval(this.timer);
    }

    private async readCurrent(): Promise<void> {

        if (!this.isGit()) return;

        try {
            const [branch, head] = await Promise.all([
                git(["rev-parse", "--abbrev-ref", "HEAD"]),
                git(["log", "-1", "--format=%h%x09%cI%x09%s"])
            ]);
            const [commit] = parseCommits(head);
            this.current = {
                version: (commit && await commitVersion(commit.hash)) || packageVersion(),
                commit: commit?.hash ?? "",
                date: commit?.date ?? "",
                branch
            };
        }
        catch (error) {
            console.error("VERSION: git:", (error as Error).message);
        }

    }

    getVersion(): VersionInfo {
        return { ...this.current };
    }

    /* for the header of the remote page: new version waiting? */
    getBadge(): { behind: number; latest: string } {
        return { behind: this.behind, latest: this.commits[0]?.version ?? "" };
    }

    isRunning(): boolean {
        const state = readState();
        return Boolean(state.startedAt && Date.now() - state.startedAt < RUN_TIMEOUT_MS);
    }

    /* the installed systemd unit (on the Pi) - not in development */
    private async unitInstalled(): Promise<boolean> {
        if (this.hasUnit === null) {
            try {
                await run("systemctl", ["cat", `${UNIT}@.service`], 5000);
                this.hasUnit = true;
            }
            catch {
                this.hasUnit = false;
            }
        }
        return this.hasUnit;
    }

    /*
     * The last install ended? The new server starts after the update -
     * update.sh ends the log with "UPDATE OK ..." or "UPDATE FAILED: ...".
     */
    private finishRun(): void {

        const state = readState();
        if (!state.startedAt) return;

        const tail = logTail(80);
        const ok = /UPDATE OK(.*)/.exec(tail);
        const failed = /UPDATE FAILED: (.+)/.exec(tail);

        if (ok) {
            writeState({ startedAt: null, lastRun: { at: Date.now(), ok: true, message: `Update installed${ok[1]!.trim() ? ` (${ok[1]!.trim()})` : ""}` } });
        }
        else if (failed) {
            writeState({ startedAt: null, lastRun: { at: Date.now(), ok: false, message: failed[1]!.trim() } });
        }
        else if (Date.now() - state.startedAt > RUN_TIMEOUT_MS) {
            writeState({ startedAt: null, lastRun: { at: Date.now(), ok: false, message: "Update did not finish - see the log" } });
        }

    }

    async getStatus(): Promise<UpdateStatus> {

        this.finishRun();
        const state = readState();

        const base: UpdateStatus = {
            available: false,
            reason: "",
            current: this.getVersion(),
            behind: this.behind,
            latest: this.commits[0]?.version ?? "",
            commits: this.commits,
            lastCheck: this.lastCheck,
            checking: Boolean(this.checking),
            checkError: this.checkError,
            running: Boolean(state.startedAt),
            startedAt: state.startedAt,
            lastRun: state.lastRun,
            log: state.startedAt || state.lastRun ? logTail() : ""
        };

        if (!this.isGit()) {
            return { ...base, reason: "This installation has no git checkout. Run scripts/install.sh once more from a git clone - after that, updates work from here." };
        }

        if (!(await this.unitInstalled())) {
            return { ...base, reason: "Development: the update unit is not installed (scripts/install.sh). CHECK works, INSTALL does not." };
        }

        return { ...base, available: true };

    }

    /* git fetch (as root through the unit), then: which commits are new */
    check(): Promise<void> {

        if (this.checking) return this.checking;
        if (!this.isGit()) return Promise.resolve();

        this.checking = (async () => {

            try {

                if (await this.unitInstalled()) {
                    // Type=oneshot: "start" waits until git fetch is done
                    await run("systemctl", ["start", `${UNIT}@check.service`], 120_000);
                }
                else {
                    await git(["fetch", "--quiet", "origin", this.current.branch || "main"], 60_000);
                }

                const upstream = `origin/${this.current.branch || "main"}`;
                this.behind = Number(await git(["rev-list", "--count", `HEAD..${upstream}`])) || 0;

                const commits = parseCommits(await git(["log", "--format=%h%x09%cI%x09%s", "-n", "30", `HEAD..${upstream}`]));
                const versions = await Promise.all(commits.map(c => commitVersion(c.hash)));
                this.commits = commits.map((c, i) => ({ ...c, version: versions[i] ?? "" }));
                this.checkError = "";

            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.checkError = /could not resolve|unable to access|network/i.test(message)
                    ? "GitHub not reachable - is the box online?"
                    : message;
            }
            finally {
                this.lastCheck = Date.now();
                this.checking = null;
            }

        })();

        return this.checking;

    }

    /* starts the install unit and returns at once; the server is restarted by it */
    async install(): Promise<void> {

        const status = await this.getStatus();
        if (!status.available) throw new Error(status.reason || "Update not available");
        if (status.running) throw new Error("An update is already running");

        writeState({ startedAt: Date.now(), lastRun: status.lastRun });

        try {
            await run("systemctl", ["start", "--no-block", `${UNIT}@install.service`], 15_000);
        }
        catch (error) {
            writeState({ startedAt: null, lastRun: status.lastRun });
            throw error;
        }

        console.log("UPDATE: started (yaesu-remote-update@install), log: update.log");

    }

}


export const updateService = new UpdateService();
