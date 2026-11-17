/*
 * Setup assistant of the ready-made image (/setup.html)
 *
 *   welcome   callsign (only where the box uses one: GET /api/settings)
 *   wifi      saved networks, add one (/api/wifi/...)
 *   ntfy      phone message with the address (optional)
 *   radio     is the transceiver found? (/api/status)
 *   finish    POST /api/setup/done -> the remote page
 */

(() => {

    "use strict";

    const $ = id => document.getElementById(id);
    const STEPS = ["welcome", "wifi", "ntfy", "radio"];

    let step = 0;
    let hasCallsign = false;
    let radioTimer = null;
    let toastTimer = null;

    function toast(text, ok = false) {
        const el = $("toast");
        el.textContent = text;
        el.classList.toggle("ok", ok);
        el.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("show"), 3600);
    }

    function esc(text) {
        return String(text ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    }

    async function api(path, body) {
        const response = await fetch(path, body === undefined
            ? { cache: "no-store" }
            : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
        return data;
    }

    /* ------------------------------------------------------------ steps */

    function show(index) {

        step = index;
        const name = STEPS[step];

        document.querySelectorAll(".step").forEach(el => { el.hidden = el.dataset.step !== name; });
        $("steps").innerHTML = STEPS.map((_, i) => `<span class="${i < step ? "done" : i === step ? "now" : ""}"></span>`).join("");
        $("back").style.visibility = step === 0 ? "hidden" : "visible";
        $("next").textContent = step === STEPS.length - 1 ? "FINISH ▶" : "NEXT ▶";

        clearInterval(radioTimer);
        if (name === "wifi") void loadWifi();
        if (name === "ntfy") void loadNtfy();
        if (name === "radio") {
            void loadRadio();
            radioTimer = setInterval(loadRadio, 2000);
        }

    }

    /* leaving a step: save what it has */
    async function save() {

        const name = STEPS[step];

        if (name === "welcome" && hasCallsign) {
            const callsign = $("call").value.trim().toUpperCase();
            await api("/api/settings", { callsign });
        }

        if (name === "wifi") {
            // typed but not saved yet: save it now
            if (selectedSsid() && $("pass").value) await addNetwork();
        }

        if (name === "ntfy") {
            const topic = $("topic").value.trim();
            if (topic || $("ntfy-on").checked) {
                await api("/api/wifi/ntfy", { server: "https://ntfy.sh", topic, enabled: $("ntfy-on").checked && topic !== "" });
            }
        }

    }

    async function next() {
        try {
            await save();
        }
        catch (error) {
            toast(error.message);
            return;
        }
        if (step < STEPS.length - 1) show(step + 1);
        else await finish();
    }

    async function finish() {
        try {
            await api("/api/setup/done", {});
        }
        catch { /* the remote works anyway */ }
        location.href = "/";
    }

    /* ------------------------------------------------------------ welcome */

    async function loadWelcome() {

        try {
            const status = await api("/api/status");
            const name = status.name || "YAESU-REMOTE";
            $("product").textContent = name;
            document.title = `Setup · ${name}`;
        }
        catch { /* keep */ }

        try {
            const settings = await api("/api/settings");
            hasCallsign = "callsign" in settings;
            $("call").value = settings.callsign || "";
        }
        catch {
            hasCallsign = false;
        }
        $("call-field").hidden = !hasCallsign;

    }

    /* ------------------------------------------------------------ Wi-Fi */

    function selectedSsid() {
        const value = $("ssid").value;
        return value === "\u0000other" ? $("ssid-other").value.trim() : value;
    }

    async function loadWifi() {

        try {
            const status = await api("/api/wifi");
            $("setup-ssid").textContent = status.setup?.ssid || "YAESU-REMOTE";
            $("wifi-lead").innerHTML = !status.available
                ? "Wi-Fi is not managed here."
                : status.hotspot?.active
                    ? `You are in the box's setup Wi-Fi <b>${esc(status.hotspot.ssid)}</b>. Add your home Wi-Fi - the box joins it and this Wi-Fi disappears. Then connect your phone to the home Wi-Fi and open this page again.`
                    : status.ssid
                        ? `The box is connected to <b>${esc(status.ssid)}</b> (${esc(status.ip)}). Add your home Wi-Fi and, if you like, your phone hotspot for portable use.`
                        : "The box has no network yet.";

            const saved = (await api("/api/wifi/saved")).networks || [];
            $("wifi-saved").innerHTML = saved.map(n =>
                `<div>${esc(n.ssid)}<small>${n.setup ? "setup network" : n.active ? "connected" : "saved"}</small></div>`).join("");

            const air = (await api("/api/wifi/scan")).networks || [];
            const known = new Set(saved.map(n => n.ssid));
            $("ssid").innerHTML =
                air.filter(n => !known.has(n.ssid))
                    .map(n => `<option value="${esc(n.ssid)}">${esc(n.ssid)}  ·  ${n.signal} %${n.security ? "  🔒" : ""}</option>`).join("") +
                `<option value="\u0000other">Other network (type the name) …</option>`;
            $("ssid-other").hidden = $("ssid").value !== "\u0000other";
        }
        catch (error) {
            $("wifi-lead").textContent = error.message;
        }

    }

    async function addNetwork() {

        const ssid = selectedSsid();
        const password = $("pass").value;
        if (!ssid) throw new Error("Choose a network");
        if (password && (password.length < 8 || password.length > 63)) throw new Error("Wi-Fi password: 8 - 63 characters");

        const status = await api("/api/wifi");
        // in the box's own setup Wi-Fi: join at once (that ends the setup Wi-Fi)
        const connect = Boolean(status.hotspot?.active);
        await api("/api/wifi/add", { ssid, password, hidden: $("ssid").value === "\u0000other", connect });
        $("pass").value = "";
        toast(connect ? `Joining ${ssid} …` : `${ssid} saved`, true);
        if (!connect) void loadWifi();

    }

    /* ------------------------------------------------------------ ntfy */

    async function loadNtfy() {
        try {
            const ntfy = await api("/api/wifi/ntfy");
            $("topic").value = ntfy.topic || `yaesu-remote-${Math.random().toString(36).slice(2, 8)}`;
            $("ntfy-on").checked = Boolean(ntfy.enabled);
        }
        catch { /* not available */ }
    }

    /* ------------------------------------------------------------ radio */

    async function loadRadio() {
        try {
            const status = await api("/api/status");
            const r = status.radio || {};
            const tag = $("radio-tag");
            tag.className = "tag";
            if (r.state === "connected") {
                tag.textContent = "FOUND";
                tag.style.background = "var(--ok)";
                $("radio-name").textContent = r.model || "Transceiver";
                $("radio-lead").textContent = "Found. FINISH opens the remote.";
            }
            else {
                tag.style.background = "";
                tag.classList.add(r.state === "unsupported" ? "off" : "off");
                tag.textContent = r.state === "unsupported" ? "NOT SUPPORTED" : "SEARCHING";
                $("radio-name").textContent = r.state === "unsupported" ? "?" : "—";
            }
            $("radio-msg").textContent = r.message || "";
        }
        catch { /* server restarting */ }
    }

    /* ------------------------------------------------------------ wiring */

    $("next").addEventListener("click", () => void next());
    $("back").addEventListener("click", () => show(Math.max(0, step - 1)));
    $("skip").addEventListener("click", event => { event.preventDefault(); void finish(); });
    $("ssid").addEventListener("change", () => { $("ssid-other").hidden = $("ssid").value !== "\u0000other"; });
    $("wifi-add").addEventListener("click", async () => {
        try {
            await addNetwork();
        }
        catch (error) {
            toast(error.message);
        }
    });

    void loadWelcome().then(() => show(0));

})();
