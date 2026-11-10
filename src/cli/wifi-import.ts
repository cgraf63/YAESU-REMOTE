import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { WifiService, parseWifiFile, scrubWifiFile } from "../services/wifi/wifi.service.js";

/*
 * Runs at boot as root (systemd ExecStartPre=+..., see system/):
 *
 *   1. setup network "YAESU-REMOTE" stored (lowest priority)
 *   2. wifi.txt on the boot partition imported (networks in order),
 *      passwords removed from the file afterwards
 *
 * Never fails the service start: errors are logged only.
 */

const FILES = process.env.WIFI_TXT ? [process.env.WIFI_TXT] : ["/boot/firmware/wifi.txt", "/boot/wifi.txt"];

async function main(): Promise<void> {

    const wifi = new WifiService();

    if (!(await wifi.isAvailable())) {
        console.log("wifi-import: NetworkManager / wlan0 not available");
        return;
    }

    await wifi.ensureSetupNetwork();

    const file = FILES.find(f => fs.existsSync(f));
    if (!file) return;

    const text = fs.readFileSync(file, "utf8");
    const data = parseWifiFile(text);
    const todo = data.networks.filter(n => n.ssid);

    if (data.country) {
        try {
            execFileSync("raspi-config", ["nonint", "do_wifi_country", data.country], { stdio: "ignore", timeout: 20_000 });
            console.log(`wifi-import: country ${data.country}`);
        }
        catch {
            console.error(`wifi-import: could not set country ${data.country}`);
        }
    }

    // after an import the passwords are gone: import again only when
    // someone entered new ones (open networks: on the first import only)
    const imported = text.startsWith("# imported by YAESU-REMOTE");
    if (!todo.length || (imported && !todo.some(n => n.password))) return;
    if (imported) todo.splice(0, todo.length, ...todo.filter(n => n.password));

    const added: string[] = [];
    for (const net of todo) {
        try {
            const saved = await wifi.addNetwork(net.ssid, net.password, net.hidden);
            added.push(saved.uuid);
            console.log(`wifi-import: ${net.ssid} stored`);
        }
        catch (error) {
            console.error(`wifi-import: ${net.ssid}: ${(error as Error).message}`);
        }
    }

    // order of the file = order of preference, imported networks on top
    const others = (await wifi.savedNetworks()).filter(n => !n.setup && !added.includes(n.uuid)).map(n => n.uuid);
    await wifi.reorder([...added, ...others]);

    fs.writeFileSync(file, scrubWifiFile(text, new Date()));
    console.log(`wifi-import: ${added.length} network(s) imported, passwords removed from ${file}`);

}

main().catch(error => {
    console.error("wifi-import:", (error as Error).message);
}).finally(() => process.exit(0));
