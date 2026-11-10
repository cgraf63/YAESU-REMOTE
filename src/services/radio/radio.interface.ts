/*
 * Common interface of the YAESU-REMOTE drivers (FTX-1, FTDX10, FT-710).
 *
 * The page talks to every transceiver the same way:
 *   getProfile()   what the radio can do (built once, drives the layout)
 *   getState()     current state, polled by the page every 500 ms
 *   control()      one named control with a value
 *
 * State shape: two "sides" main / sub. On the FTX-1 these are the MAIN
 * and SUB receivers, on the FTDX10 / FT-710 they are VFO A and VFO B
 * (one receiver, so the DSP values are the same on both sides).
 */

export type RadioModel = "FTX-1" | "FTDX10" | "FT-710";

export interface Choice {
    label: string;
    value: number | string;
}

export interface RadioProfile {

    model: RadioModel;

    /* true: two receivers (FTX-1 MAIN / SUB), false: VFO A / B */
    dualReceiver: boolean;

    /* display names of the two sides */
    sides: {
        main: { name: string; short: string };
        sub: { name: string; short: string };
    };

    frequency: { min: number; max: number };

    bands: Choice[];

    /* [group title, mode names] */
    modeGroups: Array<[string, string[]]>;

    attenuator: Choice[];

    /* null: preamp choices depend on the band (state.preampGroup) */
    preamp: Choice[] | null;

    roofing: Choice[] | null;

    agc: Choice[];

    dnrMax: number;
    nbMax: number;

    /* FM repeater shift / tone panel */
    fm: boolean;

    /* memory channel panel (read, recall, store) */
    memories: { channels: number; store: boolean; quickMemory: boolean } | null;

    cw: { memories: number; stop: boolean };

    /* hints shown on the page */
    hints: { band: string; tuner: string; fm: string };

    /* shows the FTX-1 head (FIELD / SPA-1) in the status line */
    showHead: boolean;

}

export interface RadioMemory {
    channel: number;
    name: string;
    frequency: number;
    mode: string;
    shift: string;
    tone: string;
}

export interface MemoryScan {
    running: boolean;
    done: number;
    total: number;
    at: number;
    error: string;
}

export interface YaesuRadio {

    readonly model: RadioModel;

    start(): void;
    stop(): void;

    isConnected(): boolean;
    getLastError(): string;

    /* ID; answered with another model (radio swapped on the same port) */
    isWrongRadio(): boolean;

    /* time of the last valid answer (ms), 0 = never */
    getLastAnswerAt(): number;

    getProfile(): RadioProfile;
    getState(): Record<string, unknown>;
    control(control: string, value: unknown): void;

    /* memory channels: only when profile.memories is set */
    getMemories?(): RadioMemory[];
    getMemoryScan?(): MemoryScan;
    storeMemory?(channel: number, from: "MAIN" | "SUB", name: string): Promise<RadioMemory | null>;
    renameMemory?(channel: number, name: string): Promise<void>;

}
