#!/usr/bin/env python3
"""
Fake nmcli for testing the Wi-Fi page without NetworkManager.

Implements only the commands YAESU-REMOTE uses. State in a JSON file
(FAKE_NMCLI_STATE, default /tmp/fake-nmcli.json): networks in range
("air", with their real passwords), saved connections, active connection.

    NMCLI=tools/sim/fake_nmcli.py npm run dev

Activation succeeds when the network is in range and the stored password
matches the one in "air"; otherwise it fails like nmcli (exit 4).

Access point connections (the box's setup Wi-Fi, 802-11-wireless.mode ap)
always come up, address 10.42.0.1. Test "no network": remove the home
network from "air" and set "active" to null in the state file.
"""

import json
import os
import sys
import time
import uuid as uuidlib

STATE = os.environ.get("FAKE_NMCLI_STATE", "/tmp/fake-nmcli.json")

DEFAULT = {
    "air": [
        {"ssid": "HB9OM-Home", "signal": 78, "security": "WPA2", "chan": 6, "password": "home-secret"},
        {"ssid": "YAESU-REMOTE", "signal": 64, "security": "WPA2", "chan": 1, "password": "yaesu-remote"},
        {"ssid": "Neighbour:5G", "signal": 31, "security": "WPA2 WPA3", "chan": 11, "password": "x"},
        {"ssid": "Cafe Guest", "signal": 22, "security": "", "chan": 1, "password": ""},
    ],
    "connections": [
        {"uuid": "11111111-2222-3333-4444-555555555555", "name": "preconfigured", "ssid": "HB9OM-Home",
         "priority": 0, "psk": "home-secret", "hidden": False},
    ],
    "active": "11111111-2222-3333-4444-555555555555",
    "ip_base": 23,
}


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except FileNotFoundError:
        return json.loads(json.dumps(DEFAULT))


def save(state):
    with open(STATE, "w") as f:
        json.dump(state, f, indent=1)


def esc(value):
    return str(value).replace("\\", "\\\\").replace(":", "\\:")


def fail(message, code=10):
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(code)


def main():
    args = sys.argv[1:]
    fields = None
    get = None
    while args and args[0].startswith("-"):
        opt = args.pop(0)
        if opt in ("-t", "--terse"):
            continue
        if opt in ("-f", "--fields"):
            fields = args.pop(0).split(",")
        elif opt in ("-g", "--get-values"):
            get = args.pop(0).split(",")
        elif opt in ("-w", "--wait"):
            args.pop(0)
    state = load()
    conns = state["connections"]
    active = next((c for c in conns if c["uuid"] == state.get("active")), None)
    net = lambda ssid: next((a for a in state["air"] if a["ssid"] == ssid), None)

    if args[:2] == ["device", "status"]:
        st = "connected" if active else "disconnected"
        rows = {"DEVICE": "wlan0", "TYPE": "wifi", "STATE": st, "CONNECTION": active["name"] if active else ""}
        print(":".join(esc(rows[f]) for f in fields))
        print("lo:loopback:unmanaged")
        return

    if args[:2] == ["device", "show"]:
        print(f"GENERAL.STATE:{'100 (connected)' if active else '30 (disconnected)'}")
        print(f"GENERAL.CONNECTION:{esc(active['name']) if active else ''}")
        if active and active.get("ap"):
            print("IP4.ADDRESS[1]:10.42.0.1/24")
        elif active:
            print(f"IP4.ADDRESS[1]:192.168.{1 if active['ssid'] == 'HB9OM-Home' else 43}.{state['ip_base']}/24")
        return

    if args[:3] == ["device", "wifi", "list"]:
        if "yes" in args:
            time.sleep(1.0)
        if active and active.get("ap"):
            return   # access point mode: no scan
        for a in state["air"]:
            row = {"IN-USE": "*" if active and active["ssid"] == a["ssid"] else " ", "SSID": a["ssid"],
                   "SIGNAL": a["signal"], "SECURITY": a["security"] or "--", "CHAN": a["chan"]}
            print(":".join(esc(row[f]) for f in fields))
        return

    if args[0] == "connection" and len(args) >= 2:
        sub = args[1]

        if sub == "show" and args[2:] == ["--active"]:
            if active:
                row = {"NAME": active["name"], "TYPE": "802-11-wireless", "STATE": "activated"}
                print(":".join(esc(row[f]) for f in fields))
            if state.get("wired"):
                row = {"NAME": "Wired connection 1", "TYPE": "802-3-ethernet", "STATE": "activated"}
                print(":".join(esc(row[f]) for f in fields))
            return

        # by name (the setup Wi-Fi)
        if sub in ("up", "down", "delete") and len(args) >= 4 and args[2] == "id":
            c = next((c for c in conns if c["name"] == args[3]), None)
            if not c:
                fail(f"unknown connection '{args[3]}'.", 10)
            if sub == "delete":
                conns.remove(c)
                if state.get("active") == c["uuid"]:
                    state["active"] = None
            elif sub == "down":
                if state.get("active") != c["uuid"]:
                    fail(f"'{args[3]}' is not an active connection.", 10)
                state["active"] = None
            else:
                time.sleep(1)
                state["active"] = c["uuid"]
            save(state)
            return

        if sub == "show" and len(args) == 2:
            for c in conns:
                row = {"NAME": c["name"], "UUID": c["uuid"], "TYPE": "802-11-wireless",
                       "AUTOCONNECT-PRIORITY": c["priority"], "ACTIVE": "yes" if active is c else "no"}
                print(":".join(esc(row[f]) for f in fields))
            wired = {"NAME": "Wired connection 1", "UUID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "TYPE": "802-3-ethernet",
                     "AUTOCONNECT-PRIORITY": -999, "ACTIVE": "no"}
            print(":".join(esc(wired[f]) for f in fields))
            return

        if sub == "show" and args[2] == "uuid":
            c = next((c for c in conns if c["uuid"] == args[3]), None)
            if not c:
                fail("unknown connection", 10)
            if get == ["802-11-wireless.ssid"]:
                print(c["ssid"])
            return

        if sub == "add":
            kv = args[2:]
            opts = dict(zip(kv[0::2], kv[1::2]))
            c = {"uuid": str(uuidlib.uuid4()), "name": opts.get("con-name", opts.get("ssid")), "ssid": opts["ssid"],
                 "priority": int(opts.get("connection.autoconnect-priority", 0)), "psk": opts.get("wifi-sec.psk", ""),
                 "hidden": opts.get("802-11-wireless.hidden") == "yes",
                 "ap": opts.get("802-11-wireless.mode") == "ap"}
            conns.append(c)
            save(state)
            print(f"Connection '{c['name']}' ({c['uuid']}) successfully added.")
            return

        if sub in ("modify", "delete", "up") and args[2] == "uuid":
            c = next((c for c in conns if c["uuid"] == args[3]), None)
            if not c:
                fail(f"unknown connection '{args[3]}'.", 10)
            if sub == "delete":
                conns.remove(c)
                if state.get("active") == c["uuid"]:
                    state["active"] = None
                save(state)
                print(f"Connection '{c['name']}' ({c['uuid']}) successfully deleted.")
                return
            if sub == "modify":
                kv = args[4:]
                if kv and kv[0] == "remove":
                    c["psk"] = ""
                else:
                    for k, v in zip(kv[0::2], kv[1::2]):
                        if k == "connection.autoconnect-priority":
                            c["priority"] = int(v)
                        elif k == "wifi-sec.psk":
                            c["psk"] = v
                        elif k == "802-11-wireless.hidden":
                            c["hidden"] = v == "yes"
                save(state)
                return
            if sub == "up":
                time.sleep(2)
                a = net(c["ssid"])
                state["active"] = None
                if not a:
                    save(state)
                    fail(f"Connection activation failed: No network with SSID '{c['ssid']}' found.", 4)
                if a["password"] != c["psk"]:
                    save(state)
                    fail("Connection activation failed: Secrets were required, but not provided.", 4)
                state["active"] = c["uuid"]
                state["ip_base"] += 1
                save(state)
                print(f"Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/{state['ip_base']})")
                return

    fail(f"fake nmcli: unsupported: {' '.join(sys.argv[1:])}", 2)


if __name__ == "__main__":
    main()
