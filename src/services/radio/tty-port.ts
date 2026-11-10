import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import tty from "node:tty";

/*
 * TtyPort
 *
 * Minimal serial port without native modules: the line is configured
 * with stty, received data comes from a tty.ReadStream (non-blocking,
 * event loop), commands are written to a second, blocking descriptor.
 *
 * Same surface as the part of "serialport" that SerialRadioBase uses:
 *   open(cb), close(), write(), isOpen, events data / open / close / error
 *
 * Why two descriptors: libuv puts the descriptor of a ReadStream into
 * non-blocking mode and closes it together with the stream. Writing on
 * an own descriptor keeps writes simple (CAT commands are a few bytes)
 * and avoids closing a descriptor twice.
 */

export interface TtyOptions {
    baudRate: number;
    dataBits?: 5 | 6 | 7 | 8;
    stopBits?: 1 | 1.5 | 2;
    parity?: "none" | "even" | "odd" | "mark" | "space";
    rtscts?: boolean;
}

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400];


/* stty arguments for raw 8N1 (or as configured) */
export function sttyArgs(device: string, options: TtyOptions): string[] {

    if (!BAUD_RATES.includes(options.baudRate)) {
        throw new Error(`Unsupported baud rate ${options.baudRate}`);
    }

    const args = ["-F", device, String(options.baudRate), "raw", "-echo", "-echoe", "-echok", "-echoctl", "-echoke"];

    args.push(`cs${options.dataBits ?? 8}`);
    args.push(options.stopBits === 2 ? "cstopb" : "-cstopb");

    switch (options.parity ?? "none") {
        case "none": args.push("-parenb"); break;
        case "even": args.push("parenb", "-parodd"); break;
        case "odd": args.push("parenb", "parodd"); break;
        default: throw new Error(`Parity ${options.parity} not supported`);
    }

    args.push(options.rtscts ? "crtscts" : "-crtscts");
    args.push("clocal", "cread", "-hupcl", "min", "1", "time", "0");

    return args;

}


export class TtyPort extends EventEmitter {

    private readFd: number | null = null;
    private writeFd: number | null = null;
    private stream: tty.ReadStream | null = null;
    private closing = false;
    private ptySlave = false;

    constructor(readonly path: string, private readonly options: TtyOptions) {
        super();
    }

    get isOpen(): boolean {
        return this.writeFd !== null;
    }

    open(callback: (error: Error | null) => void): void {

        if (this.isOpen) return callback(null);

        try {

            if (!fs.existsSync(this.path)) throw new Error(`${this.path}: no such device`);

            try {
                execFileSync("stty", sttyArgs(this.path, this.options), { stdio: ["ignore", "ignore", "pipe"], timeout: 3000 });
            }
            catch (error) {
                const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
                throw new Error(stderr || (error as Error).message);
            }

            this.ptySlave = fs.realpathSync(this.path).startsWith("/dev/pts/");

            const flags = fs.constants.O_RDWR | fs.constants.O_NOCTTY;

            this.writeFd = fs.openSync(this.path, flags);
            this.readFd = fs.openSync(this.path, flags);

            if (!tty.isatty(this.readFd)) throw new Error(`${this.path} is not a serial device`);

            const stream = new tty.ReadStream(this.readFd);
            this.stream = stream;
            this.closing = false;

            stream.on("data", (data: Buffer) => this.emit("data", data));
            stream.on("error", (error: Error) => {
                // EIO = device gone (USB unplugged, radio switched off)
                if ((error as NodeJS.ErrnoException).code !== "EIO") this.emit("error", error);
                this.close();
            });
            stream.on("end", () => this.close());

        }
        catch (error) {
            this.release();
            return callback(error as Error);
        }

        this.emit("open");
        callback(null);

    }

    write(data: string | Buffer): void {

        if (this.writeFd === null) return;

        try {
            fs.writeSync(this.writeFd, typeof data === "string" ? Buffer.from(data, "ascii") : data);
        }
        catch (error) {
            this.emit("error", error as Error);
            this.close();
        }

    }

    close(): void {

        if (this.closing || !this.isOpen) return;

        this.closing = true;
        this.release();
        this.emit("close");

    }

    private release(): void {

        const stream = this.stream;
        const readFd = this.readFd;

        this.stream = null;
        this.readFd = null;

        if (stream) {
            stream.removeAllListeners("data");
            stream.on("error", () => undefined);
            // For a pty slave libuv reads on a reopened descriptor: then
            // the original one is still ours to close.
            stream.destroy();
            if (this.ptySlave && readFd !== null) closeQuietly(readFd);
        }
        else if (readFd !== null) {
            closeQuietly(readFd);
        }

        if (this.writeFd !== null) {
            closeQuietly(this.writeFd);
            this.writeFd = null;
        }

    }

}

function closeQuietly(fd: number): void {
    try { fs.closeSync(fd); } catch { /* already closed */ }
}
