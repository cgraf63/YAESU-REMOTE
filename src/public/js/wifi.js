/*
 * YAESU-REMOTE - Wi-Fi setup (/wifi.html)
 *
 * Saved networks in order of preference, networks in range, add / delete,
 * switch with a warning first (the page loses the connection while the
 * box changes networks), ntfy message with the address.
 */

(function () {

    "use strict";

    const $ = id => document.getElementById(id);

    let status = null;
    let saved = [];
    let air = [];
    let pending = null;          // switch started from this page
    let shownSwitch = 0;         // finishedAt of the last result shown
    let shownAt = 0;

    /* ------------------------------------------------------------
       Helpers
       ------------------------------------------------------------ */

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
        return String(text ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    }

    function bars(signal) {
        const lit = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : signal > 0 ? 1 : 0;
        return `<span class="bars">${[1, 2, 3, 4].map(i => `<span class="${i <= lit ? "lit" : ""}"></span>`).join("")}</span>`;
    }

    async function api(path, body) {
        const response = await fetch(`/api/wifi${path}`, body === undefined
            ? { cache: "no-store" }
            : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    }

    function banner(text, kind = "") {
        const el = $("banner");
        el.hidden = !text;
        el.className = `banner ${kind}`;
        el.innerHTML = text || "";
    }

    function where() {
        const host = status?.hostname || "yaesu-remote";
        const port = location.port ? `:${location.port}` : "";
        return `http://${host}.local${port}`;
    }

    /* ------------------------------------------------------------
       Status
       ------------------------------------------------------------ */

    async function loadStatus() {

        try {

            status = await api("");

            const online = Boolean(status.ip);
            $("link").classList.toggle("ok", online);
            $("link-text").textContent = !status.available ? "NOT MANAGED" : online ? "ONLINE" : status.state.toUpperCase();

            $("w-tag").textContent = online ? "ONLINE" : "OFFLINE";
            $("w-tag").classList.toggle("off", !online);
            $("w-ssid").textContent = status.ssid || (status.available ? "not connected" : "Wi-Fi not available");

            $("w-facts").innerHTML = status.available
                ? [
                    status.ssid ? `${bars(status.signal)} <b>${status.signal} %</b>` : "",
                    status.ip ? `IP <b>${esc(status.ip)}</b>` : "",
                    ...status.urls.map(u => `<a href="${esc(u)}">${esc(u.replace(/\/$/, ""))}</a>`)
                ].filter(Boolean).join("")
                : esc(status.error);

            $("h-setup").textContent = status.setup.ssid;
            $("h-ssid").textContent = status.setup.ssid;
            $("h-pass").textContent = status.setup.password;
            $("h-url").textContent = where();

            if (!status.available) {
                banner(`Wi-Fi is not managed by NetworkManager here (${esc(status.error)}). On the YAESU-REMOTE box this page sets up the Wi-Fi.`, "bad");
                return;
            }

            if (status.switching) {
                banner(`Switching to <b>${esc(status.switching.to)}</b> …`);
            }
            else if (status.lastSwitch && status.lastSwitch.finishedAt !== shownSwitch) {
                const s = status.lastSwitch;
                if (pending || Date.now() - s.finishedAt < 120_000) {
                    banner(esc(s.message), s.result === "ok" ? "ok" : "bad");
                    shownSwitch = s.finishedAt;
                    shownAt = Date.now();
                    pending = null;
                    void loadSaved();
                }
            }
            else if (!pending && Date.now() - shownAt > 20_000) {
                banner("");
            }

        }
        catch {
            $("link").classList.remove("ok");
            $("link-text").textContent = "NO CONNECTION";
            if (pending) {
                banner(`The box is switching to <b>${esc(pending)}</b> - this page lost the connection, as expected. ` +
                    `Connect your phone / PC to the same network and open <b>${esc(where())}</b> (iPhone, PC, Mac) ` +
                    `or the address from the ntfy message. If <b>${esc(pending)}</b> does not work, the box returns to the previous network within about 30 s.`);
            }
        }

    }

    /* ------------------------------------------------------------
       Saved networks
       ------------------------------------------------------------ */

    async function loadSaved() {
        try {
            saved = (await api("/saved")).networks;
            renderSaved();
        }
        catch (error) {
            $("saved").innerHTML = `<p class="hint">${esc(error.message)}</p>`;
        }
    }

    function renderSaved() {

        const normal = saved.filter(n => !n.setup);
        const signal = ssid => air.find(a => a.ssid === ssid)?.signal;

        $("saved").innerHTML = saved.length ? saved.map(n => {
            const i = normal.indexOf(n);
            const s = signal(n.ssid);
            return `
            <div class="row${n.active ? " active" : ""}" data-uuid="${esc(n.uuid)}">
                <span class="no">${n.setup ? "—" : i + 1}</span>
                <span class="nm">${esc(n.ssid)}${n.active ? '<span class="pill ok">CONNECTED</span>' : ""}${n.setup ? '<span class="pill setup">SETUP</span>' : ""}
                    <small>${n.setup ? "setup network · always kept as the last way in" : esc(n.name)}${s !== undefined ? ` · in range ${s} %` : ""}</small></span>
                <span class="acts">
                    ${n.setup ? "" : `<button class="k" type="button" data-move="-1" ${i === 0 ? "disabled" : ""} title="Up">▲</button>
                    <button class="k" type="button" data-move="1" ${i === normal.length - 1 ? "disabled" : ""} title="Down">▼</button>`}
                    ${n.active ? "" : `<button class="k go" type="button" data-connect>CONNECT</button>`}
                    ${n.setup ? "" : `<button class="k warn" type="button" data-remove title="Delete">✕</button>`}
                </span>
            </div>`;
        }).join("") : `<p class="hint">No saved networks.</p>`;

    }

    async function move(uuid, delta) {
        const order = saved.filter(n => !n.setup).map(n => n.uuid);
        const i = order.indexOf(uuid);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        try {
            saved = (await api("/order", { uuids: order })).networks;
            renderSaved();
        }
        catch (error) {
            toast(error.message);
        }
    }

    async function remove(uuid) {
        const n = saved.find(x => x.uuid === uuid);
        if (!n) return;
        const warn = n.active ? `\n\nThe box is connected to ${n.ssid} right now - it changes to another saved network and this page loses the connection.` : "";
        if (!confirm(`Delete ${n.ssid}?${warn}`)) return;
        try {
            await api("/remove", { uuid });
            toast(`${n.ssid} deleted`, true);
            await loadSaved();
        }
        catch (error) {
            toast(error.message);
        }
    }

    /* ------------------------------------------------------------
       Switching: warn first
       ------------------------------------------------------------ */

    function confirmSwitch(target) {

        return new Promise(resolve => {

            const from = status?.ssid;
            $("m-title").textContent = `Switch to ${target}?`;
            $("m-text").innerHTML = `
                <p>The box leaves ${from ? `<b>${esc(from)}</b>` : "the current network"} and joins <b>${esc(target)}</b>.
                   This page loses the connection.</p>
                <p>Afterwards: connect this device to <b>${esc(target)}</b> and open <b>${esc(where())}</b>
                   (iPhone, PC, Mac) or the address from the ntfy message.</p>
                <p>If <b>${esc(target)}</b> does not connect within about 30 s, the box goes back to ${from ? `<b>${esc(from)}</b>` : "the previous network"}.</p>`;
            $("modal").classList.add("show");

            const done = ok => {
                $("modal").classList.remove("show");
                $("m-ok").onclick = $("m-cancel").onclick = null;
                resolve(ok);
            };
            $("m-ok").onclick = () => done(true);
            $("m-cancel").onclick = () => done(false);

        });

    }

    async function connect(uuid) {
        const n = saved.find(x => x.uuid === uuid);
        if (!n || !(await confirmSwitch(n.ssid))) return;
        try {
            await api("/connect", { uuid });
            pending = n.ssid;
            banner(`Switching to <b>${esc(n.ssid)}</b> …`);
        }
        catch (error) {
            toast(error.message);
        }
    }

    /* ------------------------------------------------------------
       Add / scan
       ------------------------------------------------------------ */

    async function add() {

        const ssid = $("f-ssid").value;
        const password = $("f-pass").value;
        const connectNow = $("f-connect").checked;

        if (!ssid.trim()) return toast("Network name missing");
        if (password && (password.length < 8 || password.length > 64)) return toast("Password: 8 - 63 characters");
        if (connectNow && !(await confirmSwitch(ssid))) return;

        $("f-add").disabled = true;

        try {
            const data = await api("/add", { ssid, password, hidden: $("f-hidden").checked, connect: connectNow });
            $("f-ssid").value = "";
            $("f-pass").value = "";
            $("f-hidden").checked = false;
            if (data.switching) {
                pending = data.switching.to;
                banner(`Switching to <b>${esc(pending)}</b> …`);
            }
            else {
                toast(`${data.network.ssid} saved`, true);
            }
            await loadSaved();
        }
        catch (error) {
            toast(error.message);
        }
        finally {
            $("f-add").disabled = false;
        }

    }

    async function scan(rescan) {
        $("scan").disabled = true;
        $("scan").textContent = "SCANNING …";
        try {
            air = (await api(`/scan${rescan ? "?rescan=1" : ""}`)).networks;
            renderAir();
            renderSaved();
        }
        catch (error) {
            $("air").innerHTML = `<p class="hint">${esc(error.message)}</p>`;
        }
        finally {
            $("scan").disabled = false;
            $("scan").textContent = "SCAN";
        }
    }

    function renderAir() {
        $("air").innerHTML = air.length ? air.map(a => `
            <div class="row${a.inUse ? " active" : ""}" data-ssid="${esc(a.ssid)}">
                <span class="no">${bars(a.signal)}</span>
                <span class="nm">${esc(a.ssid)}${a.inUse ? '<span class="pill ok">CONNECTED</span>' : ""}
                    <small>${a.signal} % · ${a.security ? "🔒 " + esc(a.security) : "open"} · channel ${a.channel}${a.channel > 14 ? " (5 GHz - not usable)" : ""}</small></span>
                <span class="acts">${a.saved ? '<span class="hint">saved</span>' : `<button class="k" type="button" data-pick>ADD</button>`}</span>
            </div>`).join("") : `<p class="hint">No networks found.</p>`;
    }

    /* ------------------------------------------------------------
       ntfy
       ------------------------------------------------------------ */

    async function loadNtfy() {
        try {
            const n = await api("/ntfy");
            $("n-server").value = n.server || "https://ntfy.sh";
            $("n-topic").value = n.topic || "";
            $("n-enabled").checked = Boolean(n.enabled);
        }
        catch { /* later */ }
    }

    async function saveNtfy() {
        try {
            const data = await api("/ntfy", { server: $("n-server").value || "https://ntfy.sh", topic: $("n-topic").value, enabled: $("n-enabled").checked });
            $("n-enabled").checked = data.ntfy.enabled;
            toast(data.ntfy.enabled ? "Saved - the box sends its address" : "Saved (messages off)", true);
            return true;
        }
        catch (error) {
            toast(error.message);
            return false;
        }
    }

    /* ------------------------------------------------------------
       Events, start
       ------------------------------------------------------------ */

    $("saved").addEventListener("click", e => {
        const row = e.target.closest(".row");
        if (!row) return;
        const uuid = row.dataset.uuid;
        const mv = e.target.closest("[data-move]");
        if (mv) return void move(uuid, Number(mv.dataset.move));
        if (e.target.closest("[data-connect]")) return void connect(uuid);
        if (e.target.closest("[data-remove]")) return void remove(uuid);
    });

    $("air").addEventListener("click", e => {
        const row = e.target.closest(".row");
        if (!row || !e.target.closest("[data-pick]")) return;
        $("f-ssid").value = row.dataset.ssid;
        $("f-pass").value = "";
        $("f-pass").focus();
        $("f-ssid").scrollIntoView({ behavior: "smooth", block: "center" });
    });

    $("f-add").addEventListener("click", () => void add());
    $("f-pass").addEventListener("keydown", e => { if (e.key === "Enter") void add(); });
    $("f-show").addEventListener("change", e => { $("f-pass").type = e.target.checked ? "text" : "password"; });
    $("scan").addEventListener("click", () => void scan(true));

    $("n-random").addEventListener("click", () => {
        const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");
        $("n-topic").value = `yaesu-remote-${hex}`;
        $("n-enabled").checked = true;
    });
    $("n-save").addEventListener("click", () => void saveNtfy());
    $("n-test").addEventListener("click", async () => {
        if (!(await saveNtfy())) return;
        try {
            await api("/ntfy/test", {});
            toast("Test message sent", true);
        }
        catch (error) {
            toast(error.message);
        }
    });

    void (async () => {
        await loadStatus();
        if (status?.available) {
            await loadSaved();
            void scan(false);
        }
        void loadNtfy();
    })();

    setInterval(loadStatus, 3000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadStatus(); });

})();
