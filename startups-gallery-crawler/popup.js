const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxClicks = document.getElementById("maxClicks");
const details = document.getElementById("details");
const concurrency = document.getElementById("concurrency");

// content.js clamps this too; here it only keeps the input from accepting absurd numbers
function parallelValue() {
    return Math.min(12, Math.max(1, parseInt(concurrency.value, 10) || 4));
}

async function save() {

    concurrency.value = parallelValue();

    await chrome.storage.local.set({
        maxClicks: Math.max(0, parseInt(maxClicks.value, 10) || 0),
        details: details.checked,
        concurrency: parallelValue()
    });

}

async function init() {

    const settings = await chrome.storage.local.get(["maxClicks", "details", "concurrency"]);

    if (settings.maxClicks) maxClicks.value = settings.maxClicks;
    if (settings.details === false) details.checked = false;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    maxClicks.addEventListener("change", save);
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

        if (!tab || !/^https:\/\/startups\.gallery\//.test(tab.url || "")) {
            status.textContent = "Open https://startups.gallery/news first.";
            return;
        }

        // core.js MUST load before content.js: the content script runs in the
        // tab's isolated world and cannot see the popup's variables.
        await chrome.scripting.executeScript({
            target: {
                tabId: tab.id
            },
            files: ["core.js", "content.js"]
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

    if (message && message.type === "sg-crawler-status") {
        status.textContent = message.text;
    }

});

init();
