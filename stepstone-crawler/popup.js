const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const details = document.getElementById("details");
const concurrency = document.getElementById("concurrency");

// content.js clamps this too; here it only keeps the input from accepting absurd numbers
function parallelValue() {
    return Math.min(12, Math.max(1, parseInt(concurrency.value, 10) || 4));
}

async function save() {

    concurrency.value = parallelValue();

    await chrome.storage.local.set({
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        details: details.checked,
        concurrency: parallelValue()
    });

}

async function init() {

    const settings = await chrome.storage.local.get(["maxPages", "details", "concurrency"]);

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.details === false) details.checked = false;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    maxPages.addEventListener("change", save);
    details.addEventListener("change", save);
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

        if (!tab || !/^https:\/\/www\.stepstone\.de\//.test(tab.url || "")) {
            status.textContent = "Open a www.stepstone.de search results page first.";
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

    if (message && message.type === "stepstone-crawler-status") {
        status.textContent = message.text;
    }

});

init();
