const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const perPage = document.getElementById("perPage");
const concurrency = document.getElementById("concurrency");

async function save() {

    await chrome.storage.local.set({
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        perPage: Math.min(100, Math.max(0, parseInt(perPage.value, 10) || 0)),
        concurrency: Math.min(8, Math.max(1, parseInt(concurrency.value, 10) || 5))
    });

}

async function init() {

    const settings = await chrome.storage.local.get(["maxPages", "perPage", "concurrency"]);

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.perPage) perPage.value = settings.perPage;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    maxPages.addEventListener("change", save);
    perPage.addEventListener("change", save);
    concurrency.addEventListener("change", save);

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

        if (!tab || !/^https:\/\/app\.apollo\.io\//.test(tab.url || "")) {
            status.textContent = "Open your Apollo People search (app.apollo.io) first.";
            return;
        }

        // core.js MUST load before content.js: the content script runs in the tab's isolated world
        // and cannot see the popup's variables. inject.js is a declared content script that is
        // already running in the page world - it does not get injected here.
        await chrome.scripting.executeScript({
            target: {
                tabId: tab.id
            },
            files: ["core.js", "content.js"]
        });

        status.textContent = "Running. You can close this popup; progress is in the page console (F12).";

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

    if (message && message.type === "apollo-crawler-status") {
        status.textContent = message.text;
    }

});

init();
