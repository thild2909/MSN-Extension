const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const readModel = document.getElementById("readModel");

async function save() {

    await chrome.storage.local.set({
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        readModel: readModel.checked
    });

}

async function init() {

    const settings = await chrome.storage.local.get(["maxPages", "readModel"]);

    if (settings.maxPages) maxPages.value = settings.maxPages;

    // undefined on a first run -> keep the checked default from the markup
    if (settings.readModel !== undefined) readModel.checked = settings.readModel;

    // options removed from the popup -> clear their old values to avoid silent filtering
    // the detail step is gone, so the parallelism knob no longer controls anything
    chrome.storage.local.remove(["listingTypes", "minSalary", "maxExperience", "oneRowPerCompany", "concurrency"]);

    maxPages.addEventListener("change", save);
    readModel.addEventListener("change", save);

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

        if (!tab || !/^https:\/\/jobs\.ctgoodjobs\.hk\//.test(tab.url || "")) {
            status.textContent = "Open a jobs.ctgoodjobs.hk search page first.";
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

    if (message && message.type === "ctgj-crawler-status") {
        status.textContent = message.text;
    }

});

init();
