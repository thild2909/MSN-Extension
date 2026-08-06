// Size buckets shown in the popup. content.js matches by numeric range overlap,
// so picking 51-100 still catches a company Wellfound labels more coarsely as "51-200 Employees".
const SIZE_BUCKETS = [
    "1-10",
    "11-20",
    "21-50",
    "51-100",
    "101-200",
    "201-500",
    "501-1000",
    "1001-2000",
    "2001-5000",
    "5001-10000",
    "10001+"
];

const button = document.getElementById("crawl");
const status = document.getElementById("status");
const hint = document.getElementById("hint");
const sizes = document.getElementById("sizes");
const maxPages = document.getElementById("maxPages");
const concurrency = document.getElementById("concurrency");

// content.js clamps this too; here it only keeps the input from accepting absurd numbers
function parallelValue() {
    return Math.min(12, Math.max(1, parseInt(concurrency.value, 10) || 6));
}

function selected() {
    return [...sizes.querySelectorAll("input:checked")].map(input => input.value);
}

function refreshHint() {

    const count = selected().length;

    hint.textContent = count === 0
        ? "Nothing checked = no filter, every company is exported."
        : `Only companies matching ${count} selected size${count > 1 ? "s" : ""}.`;

}

async function save() {

    refreshHint();

    concurrency.value = parallelValue();

    await chrome.storage.local.set({
        sizeFilter: selected(),
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        concurrency: parallelValue()
    });

}

function setAll(checked) {

    sizes.querySelectorAll("input").forEach(input => {
        input.checked = checked;
    });

    save();

}

async function init() {

    const settings = await chrome.storage.local.get(["sizeFilter", "maxPages", "concurrency"]);
    const stored = settings.sizeFilter || [];

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    maxPages.addEventListener("change", save);
    concurrency.addEventListener("change", save);

    SIZE_BUCKETS.forEach(bucket => {

        const label = document.createElement("label");
        const input = document.createElement("input");

        input.type = "checkbox";
        input.value = bucket;
        input.checked = stored.includes(bucket);
        input.addEventListener("change", save);

        label.appendChild(input);
        label.appendChild(document.createTextNode(bucket));

        sizes.appendChild(label);

    });

    refreshHint();

}

document.getElementById("all").addEventListener("click", () => setAll(true));
document.getElementById("none").addEventListener("click", () => setAll(false));

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

        if (!tab || !/^https:\/\/(www\.)?wellfound\.com\//.test(tab.url || "")) {
            status.textContent = "Open a wellfound.com page first.";
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

    if (message && message.type === "wf-crawler-status") {
        status.textContent = message.text;
    }

});

init();
