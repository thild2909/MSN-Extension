const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const pace = document.getElementById("pace");

// content.js clamps this too; here it only keeps the input from accepting absurd numbers
function paceValue() {
    return Math.min(5000, Math.max(0, parseInt(pace.value, 10) || 0));
}

async function save() {

    pace.value = paceValue();

    await chrome.storage.local.set({
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        pace: paceValue()
    });

}

async function init() {

    const settings = await chrome.storage.local.get(["maxPages", "pace"]);

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.pace !== undefined) pace.value = settings.pace;

    maxPages.addEventListener("change", save);
    pace.addEventListener("change", save);

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

        if (!tab || !/^https:\/\/(www\.)?getlatka\.com\//.test(tab.url || "")) {
            status.textContent = "Open a getlatka.com list page first.";
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

    if (message && message.type === "latka-crawler-status") {
        status.textContent = message.text;
    }

});

init();
