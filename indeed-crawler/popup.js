const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const employees = document.getElementById("employees");
const concurrency = document.getElementById("concurrency");

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
        concurrency: parallelValue()
    });

}

async function init() {

    const settings = await chrome.storage.local.get(["maxPages", "employees", "concurrency"]);

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    // off until asked for, so an absent setting must read as unticked rather than leaving
    // whatever the markup happened to ship with
    employees.checked = settings.employees === true;

    maxPages.addEventListener("change", save);
    employees.addEventListener("change", save);
    concurrency.addEventListener("change", save);

    // Left behind by the proxy build. Harmless, but one of them is a Webshare API key, so it
    // should not sit in the profile of an extension that no longer has any use for it.
    chrome.storage.local.remove(
        ["useProxy", "rotateEvery", "webshareKey", "webshareList", "webshareListAt"]);

}

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
