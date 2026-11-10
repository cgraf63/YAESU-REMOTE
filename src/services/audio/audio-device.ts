import fs from "node:fs";
import path from "node:path";

import { config } from "../../config.js";
import { radioManager } from "../radio/radio-manager.js";

/*
 * Which ALSA device is the radio's sound card?
 *
 * The Yaesu radios have a USB hub inside: CAT bridge (CP2105), sound
 * card and more hang on it. The sound card names differ (FTDX10: "CODEC",
 * FTX-1: C-Media "Device"), so with audio.device "auto" the card is
 * found through sysfs: the card on the same USB hub as the CAT port.
 *
 *   /sys/class/tty/ttyUSB0/device   -> .../usb1/1-1/1-1.1/1-1.1:1.0/ttyUSB0   hub .../usb1/1-1
 *   /sys/class/sound/card1/device   -> .../usb1/1-1/1-1.2/1-1.2:1.0           same hub -> card1
 *
 * Fallbacks: the only USB sound card, then "default".
 */

interface Card {
    id: string;
    sysPath: string;
    usb: boolean;
}

function realpath(p: string): string {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return "";
    }
}

function readCards(root: string): Card[] {
    let names: string[] = [];
    try {
        names = fs.readdirSync(path.join(root, "sys/class/sound")).filter(n => /^card\d+$/.test(n)).sort();
    }
    catch {
        return [];
    }
    return names.map(n => {
        const dir = path.join(root, "sys/class/sound", n);
        let id = "";
        try {
            id = fs.readFileSync(path.join(dir, "id"), "utf8").trim();
        }
        catch { /* no id */ }
        const sysPath = realpath(path.join(dir, "device"));
        return { id, sysPath, usb: /\/usb\d+\//.test(sysPath) };
    }).filter(c => c.id);
}

/* sysfs directory of the USB hub the serial device hangs on ("" = unknown) */
export function usbHubOf(device: string, root = "/"): string {

    const tty = path.basename(realpath(device) || device);
    let dir = realpath(path.join(root, "sys/class/tty", tty, "device"));

    // up to the USB device directory ("1-1.1", no ":" interface suffix)
    while (dir && dir !== path.dirname(dir) && !/^\d+-[\d.]+$/.test(path.basename(dir))) {
        dir = path.dirname(dir);
    }

    if (!dir || !/^\d+-[\d.]+$/.test(path.basename(dir))) return "";

    const hub = path.dirname(dir);
    return /^\d+-[\d.]+$/.test(path.basename(hub)) ? hub : "";

}

export function findRadioCard(catDevice: string, root = "/"): { device: string; why: string } {

    const cards = readCards(root);
    const hub = catDevice ? usbHubOf(catDevice, root) : "";

    if (hub) {
        const card = cards.find(c => c.sysPath.startsWith(hub + path.sep));
        if (card) return { device: `plughw:CARD=${card.id},DEV=0`, why: `sound card "${card.id}" on the radio's USB hub` };
    }

    const usb = cards.filter(c => c.usb);
    if (usb.length === 1) return { device: `plughw:CARD=${usb[0]!.id},DEV=0`, why: `the only USB sound card "${usb[0]!.id}"` };

    return { device: "default", why: usb.length ? `${usb.length} USB sound cards, none on the radio's hub` : "no USB sound card found" };

}

let lastLogged = "";

/* device for arecord / aplay */
export function resolveAudioDevice(): string {

    if (config.audio.device && config.audio.device !== "auto") return config.audio.device;

    const found = findRadioCard(radioManager.getStatus().device);
    if (found.device !== lastLogged) {
        console.log(`AUDIO: ${found.device} (${found.why})`);
        lastLogged = found.device;
    }
    return found.device;

}
