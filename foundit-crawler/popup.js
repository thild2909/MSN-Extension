const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const concurrency = document.getElementById("concurrency");

// the country sites the manifest grants access to - anything else has no host permission, so the
// injection would fail with a permissions error rather than a useful message
const SITE = /^https:\/\/www\.(foundit\.(my|in|sg|id)|foundit\.com\.(ph|hk)|founditgulf\.com)\//;

async function save() {

    await chrome.storage.local.set({
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        concurrency: Math.min(12, Math.max(1, parseInt(concurrency.value, 10) || 4))
    });

}

async function init() {

    const settings = await chrome.storage.local.get(["maxPages", "concurrency"]);

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    // options this crawler never had -> clear stale values left by another extension sharing
    // the same storage key names, so nothing filters silently
    chrome.storage.local.remove(["listingTypes", "minSalary", "maxExperience", "oneRowPerCompany", "details", "readModel"]);

    maxPages.addEventListener("change", save);
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

        if (!tab || !SITE.test(tab.url || "")) {
            status.textContent = "Open a foundit search results page first.";
            return;
        }

        if (!/\/search\//.test(tab.url)) {
            status.textContent = "That is a foundit page, but not a search. Open a /search/... URL.";
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

    if (message && message.type === "foundit-crawler-status") {
        status.textContent = message.text;
    }

});

init();
