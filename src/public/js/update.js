/*
 * YAESU-REMOTE - software update page
 *
 *   GET  /api/update           version, new commits, last run, log
 *   POST /api/update/check     git fetch now
 *   POST /api/update/install   install: the server restarts, this page
 *                              waits for it and shows the result
 */

(() => {

    "use strict";

    const $ = id => document.getElementById(id);

    let status = null;
    let waiting = false;      // install started: the server goes away and comes back
    let wentAway = false;
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

    function when(ms) {
        if (!ms) return "";
        const d = new Date(ms);
        return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    }

    function day(iso) {
        return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
    }

    function banner(text, kind) {
        const el = $("banner");
        el.hidden = !text;
        el.className = `banner${kind ? ` ${kind}` : ""}`;
        el.innerHTML = text || "";
    }

    function link(ok, text) {
        $("link").classList.toggle("ok", ok);
        $("link-text").textContent = text;
    }

    async function api(path, method = "GET") {
        const response = await fetch(`/api/update${path}`, { method, cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
        return data;
    }

    function render(s) {

        status = s;
        const c = s.current || {};

        $("u-ver").textContent = c.version || "?";
        $("u-facts").innerHTML = [
            c.commit ? `commit <b>${esc(c.commit)}</b>` : "",
            c.date ? `from <b>${esc(day(c.date))}</b>` : "",
            c.branch ? `branch <b>${esc(c.branch)}</b>` : "",
            s.lastCheck ? `checked <b>${esc(when(s.lastCheck))}</b>` : "not checked yet"
        ].filter(Boolean).map(x => `<span>${x}</span>`).join("");

        const tag = $("u-tag");
        tag.className = "tag";
        if (s.running) { tag.classList.add("new"); tag.textContent = "UPDATING"; }
        else if (s.behind > 0) { tag.classList.add("new"); tag.textContent = "UPDATE"; }
        else if (s.lastCheck && !s.checkError) { tag.classList.add("ok"); tag.textContent = "UP TO DATE"; }
        else { tag.classList.add("off"); tag.textContent = "VERSION"; }

        // banner: running / last result / check error / why not available
        if (s.running) banner("Update running - YAESU-REMOTE restarts, this page comes back by itself …");
        else if (s.lastRun && Date.now() - s.lastRun.at < 3600_000) banner(esc(s.lastRun.message), s.lastRun.ok ? "ok" : "bad");
        else if (s.checkError) banner(`Check failed: ${esc(s.checkError)}`, "bad");
        else if (!s.available && s.reason) banner(esc(s.reason));
        else banner("");

        // new commits
        if (s.checking) {
            $("commits").innerHTML = `<p class="hint">Checking GitHub …</p>`;
        }
        else if (!s.lastCheck) {
            $("commits").innerHTML = `<p class="hint">Not checked yet - press CHECK NOW.</p>`;
        }
        else if (!s.behind) {
            $("commits").innerHTML = `<p class="hint">Nothing new - version <b>${esc(c.version)}</b> is the latest.</p>`;
        }
        else {
            const more = s.behind > s.commits.length ? `<p class="hint">… and ${s.behind - s.commits.length} older changes.</p>` : "";
            $("commits").innerHTML = s.commits.map(x => `
                <div class="commit">
                    <span class="v">${esc(x.version || "")}</span>
                    <code>${esc(x.hash)}</code>
                    <span class="s" title="${esc(x.subject)}">${esc(x.subject)}</span>
                    <span class="d">${esc(day(x.date))}</span>
                </div>`).join("") + more;
        }

        const canInstall = s.available && !s.running && s.behind > 0;
        $("install").disabled = !canInstall;
        $("install").textContent = s.behind > 0 && s.latest ? `INSTALL ${s.latest}` : "INSTALL UPDATE";
        $("install-hint").textContent = s.running ? "running …" : !s.available ? "" : s.behind > 0 ? `${s.behind} change${s.behind === 1 ? "" : "s"}, about a minute` : "";
        $("check").disabled = Boolean(s.checking) || s.running;

        // log of the running / last update
        $("log-panel").hidden = !s.log;
        if (s.log) {
            const log = $("log");
            const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;
            log.textContent = s.log;
            if (atEnd || s.running) log.scrollTop = log.scrollHeight;
            $("log-when").textContent = s.running ? `started ${when(s.startedAt)}` : s.lastRun ? when(s.lastRun.at) : "";
        }

    }

    async function load() {

        try {
            const s = await api("");
            link(true, "ONLINE");
            if (waiting && wentAway) {
                // the server is back after the restart: done
                waiting = false;
                wentAway = false;
                toast(s.lastRun?.ok ? `Updated to ${s.current?.version}` : "Update finished - see the log", Boolean(s.lastRun?.ok));
            }
            render(s);
        }
        catch {
            link(false, waiting ? "RESTARTING" : "OFFLINE");
            if (waiting) {
                wentAway = true;
                banner("Update running - YAESU-REMOTE restarts, this page comes back by itself …");
            }
        }

    }

    async function check() {
        $("check").disabled = true;
        $("commits").innerHTML = `<p class="hint">Checking GitHub …</p>`;
        try {
            render(await api("/check", "POST"));
        }
        catch (error) {
            toast(error.message);
            void load();
        }
    }

    function confirmInstall() {
        if (!status) return;
        $("m-text").innerHTML =
            `<p>From <b>${esc(status.current?.version)}</b> to <b>${esc(status.latest || "the latest version")}</b> ` +
            `(${status.behind} change${status.behind === 1 ? "" : "s"}).</p>` +
            "<p>The remote and the audio stop for about a minute while the box builds and restarts. " +
            "The radio itself keeps running.</p>";
        $("modal").classList.add("show");
    }

    async function install() {
        $("modal").classList.remove("show");
        $("install").disabled = true;
        try {
            const response = await fetch("/api/update/install", { method: "POST" });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
            waiting = true;
            toast("Update started", true);
            void load();
        }
        catch (error) {
            toast(error.message);
            void load();
        }
    }

    $("check").addEventListener("click", () => void check());
    $("install").addEventListener("click", confirmInstall);
    $("m-cancel").addEventListener("click", () => $("modal").classList.remove("show"));
    $("m-ok").addEventListener("click", () => void install());

    void load();
    // faster while an update runs
    (function poll() {
        setTimeout(async () => {
            await load();
            poll();
        }, waiting || status?.running ? 1500 : 5000);
    })();

})();
