// JobStreet and JobsDB run on the same platform as SEEK, so the DOM is identical.
const SITES = /^https:\/\/(au\.seek\.com|my\.jobstreet\.com|sg\.jobstreet\.com|hk\.jobsdb\.com)\//;

// Values taken straight off the card:
//   work arrangement <span data-testid="work-arrangement">(Remote)</span>
const WORK_ARRANGEMENTS = ["Remote", "Hybrid", "On-site"];

const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxPages = document.getElementById("maxPages");
const concurrency = document.getElementById("concurrency");

// content.js clamps this too; here it only keeps the input from accepting absurd numbers
function parallelValue() {
    return Math.min(24, Math.max(1, parseInt(concurrency.value, 10) || 10));
}

const groups = [
    { box: document.getElementById("workArrangements"), values: WORK_ARRANGEMENTS, key: "workArrangements", hint: document.getElementById("arrHint"), noun: "arrangement" }
];

function selected(group) {
    return [...group.box.querySelectorAll("input:checked")].map(input => input.value);
}

function refreshHints() {

    groups.forEach(group => {

        const count = selected(group).length;

        group.hint.textContent = count === 0
            ? `Nothing checked = every ${group.noun}.`
            : `Only ${count} selected ${group.noun}${count > 1 ? "s" : ""}.`;

    });

}

async function save() {

    refreshHints();

    concurrency.value = parallelValue();

    const settings = {
        maxPages: Math.max(0, parseInt(maxPages.value, 10) || 0),
        concurrency: parallelValue()
    };

    groups.forEach(group => {
        settings[group.key] = selected(group);
    });

    await chrome.storage.local.set(settings);

}

function setAll(group, checked) {

    group.box.querySelectorAll("input").forEach(input => {
        input.checked = checked;
    });

    save();

}

async function init() {

    const settings = await chrome.storage.local.get(["workArrangements", "maxPages", "concurrency"]);

    // the work type filter was removed from the popup -> clear its old value to avoid silent filtering
    chrome.storage.local.remove("workTypes");

    if (settings.maxPages) maxPages.value = settings.maxPages;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    maxPages.addEventListener("change", save);
    concurrency.addEventListener("change", save);

    groups.forEach(group => {

        const stored = settings[group.key] || [];

        group.values.forEach(value => {

            const label = document.createElement("label");
            const input = document.createElement("input");

            input.type = "checkbox";
            input.value = value;
            input.checked = stored.includes(value);
            input.addEventListener("change", save);

            label.appendChild(input);
            label.appendChild(document.createTextNode(value));

            group.box.appendChild(label);

        });

    });

    refreshHints();

}

document.getElementById("arrAll").addEventListener("click", () => setAll(groups[0], true));
document.getElementById("arrNone").addEventListener("click", () => setAll(groups[0], false));

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

        if (!tab || !SITES.test(tab.url || "")) {
            status.textContent = "Open a search results page on au.seek.com, my.jobstreet.com, sg.jobstreet.com or hk.jobsdb.com first.";
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

    if (message && message.type === "seek-crawler-status") {
        status.textContent = message.text;
    }

});

init();
