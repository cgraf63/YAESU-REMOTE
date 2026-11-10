import { execFile } from "node:child_process";

/*
 * nmcli runner.
 *
 * The server runs as an ordinary user; a polkit rule (system/) allows
 * that user to manage NetworkManager, so no sudo is needed. The command
 * can be replaced for tests (NMCLI=/path/to/fake_nmcli.py).
 */

export class NmcliError extends Error {
    constructor(message: string, readonly code: number | null) {
        super(message);
    }
}

export function nmcli(command: string, args: string[], timeoutMs = 20_000): Promise<string> {

    return new Promise((resolve, reject) => {

        execFile(command, args, {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, LC_ALL: "C", LANG: "C" }
        }, (error, stdout, stderr) => {
            if (error) {
                const text = String(stderr || error.message).trim().replace(/^Error:\s*/i, "");
                const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
                return reject(new NmcliError(text || "nmcli failed", code));
            }
            resolve(String(stdout));
        });

    });

}


/*
 * Split one line of terse output (-t / -g): fields separated by ':',
 * a literal ':' is written as '\:' and a backslash as '\\'.
 */
export function splitTerse(line: string): string[] {

    const fields: string[] = [];
    let current = "";

    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === "\\" && i + 1 < line.length) {
            current += line[++i];
        }
        else if (ch === ":") {
            fields.push(current);
            current = "";
        }
        else {
            current += ch;
        }
    }

    fields.push(current);
    return fields;

}

export function terseRows(output: string): string[][] {
    return output.split("\n").filter(line => line.length > 0).map(splitTerse);
}
