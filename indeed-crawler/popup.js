const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const employees = document.getElementById("employees");
const concurrency = document.getElementById("concurrency");

const useProxy = document.getElementById("useProxy");
const proxyTest = document.getElementById("proxyTest");
const proxyStatus = document.getElementById("proxyStatus");

const INDEED_ROOT = /^https:\/\/(sg|au|hk|uk|my|de)\.indeed\.com\//;

// content.js clamps this too; here it only keeps the input from accepting absurd numbers
function parallelValue() {
    return Math.min(8, Math.max(1, parseInt(concurrency.value, 10) || 3));
}

async function save() {

    concurrency.value = parallelValue();

    await chrome.storage.local.set({
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        employees: employees.checked,
        concurrency: parallelValue(),
        useProxy: useProxy.checked
    });

}

// the popup is a separate page from the worker, so anything that touches the proxy is a message
async function ask(message) {

    try {
        return (await chrome.runtime.sendMessage(message)) || { ok: false, error: "no reply from the extension worker" };
    }
    catch (e) {
        return { ok: false, error: e && e.message || String(e) };
    }

}

// the root of the open tab decides which country's proxy is preferred (uk -> GB, de -> DE)
async function currentCountry() {

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const match = INDEED_ROOT.exec(tab && tab.url || "");

    return match ? match[1] : "";

}

async function showProxyStatus() {

    const state = await ask({ type: "proxy:status" });

    if (!state.ok) {
        proxyStatus.textContent = state.error;
        return;
    }

    if (state.enabled) {
        proxyStatus.textContent = `On - ${state.label}, ${state.rotations} swap(s), ${state.pool} usable IP(s) left.`;
        return;
    }

    if (!state.total) {
        proxyStatus.textContent = "Proxy list not loaded yet - press Check IPs.";
        return;
    }

    proxyStatus.textContent = `${state.pool} of ${state.total} IP(s) usable. `
        + "Applied only while a crawl is running.";

}

async function init() {

    const settings = await chrome.storage.local.get(
        ["maxPages", "employees", "concurrency", "useProxy"]);

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    // both of these are off until asked for, so an absent setting must read as unticked rather
    // than leaving whatever the markup happened to ship with
    employees.checked = settings.employees === true;

    useProxy.checked = settings.useProxy === true;

    maxPages.addEventListener("change", save);
    employees.addEventListener("change", save);
    concurrency.addEventListener("change", save);
    useProxy.addEventListener("change", save);

    await showProxyStatus();

}

// Walks every IP in the plan against the real Indeed search page. Indeed is behind Cloudflare and
// refuses a lot of datacentre addresses outright, so the number that matters is not how many
// proxies the plan has - it is how many of them Indeed answers. The refused ones are retired here
// so a crawl never spends a request finding out.
proxyTest.addEventListener("click", async () => {

    proxyTest.disabled = true;
    proxyStatus.textContent = "Checking every IP against Indeed - this takes a moment...";

    try {

        await save();

        const result = await ask({ type: "proxy:audit", country: await currentCountry() });

        if (!result.ok) {
            proxyStatus.textContent = "Failed: " + result.error;
            return;
        }

        const usable = result.good.length;

        proxyStatus.textContent = usable
            ? `${usable} of ${result.total} IP(s) get through: ${result.good.join("; ")}.`
                + (result.walled ? ` ${result.walled} blocked by Cloudflare.` : "")
                + (result.dead ? ` ${result.dead} did not answer.` : "")
            : `None of the ${result.total} IP(s) get past Indeed's Cloudflare `
                + "- leave the rotation off, or replace the proxies in the Webshare dashboard.";

    }
    finally {
        proxyTest.disabled = false;
    }

});

button.addEventListener("click", async () => {

    button.disabled = true;
    status.textContent = "Starting...";

    try {

        // commit the selection before injecting the script; content.js reads it back from storage
        await save();

        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        // the roots declared in the manifest; adding a new country means updating both places
        if (!tab || !INDEED_ROOT.test(tab.url || "")) {
            status.textContent = "Open a job search page on sg / au / hk / uk / my / de .indeed.com first.";
            return;
        }

        // xlsx.full.min.js MUST load before content.js: the content script runs in the
        // tab's isolated world and cannot see the popup's variables.
        await chrome.scripting.executeScript({
            target: {
                tabId: tab.id
            },
            files: ["xlsx.full.min.js", "core.js", "content.js"]
        });

        status.textContent = "Running. Keep this tab open until the file downloads.";

    }
    catch (e) {

        console.error(e);
        status.textContent = "Injection failed: " + (e && e.message || e);

    }
    finally {

        button.disabled = false;

    }

});

chrome.runtime.onMessage.addListener((message) => {

    if (message && message.type === "indeed-crawler-status") {
        status.textContent = message.text;
    }

});

init();
