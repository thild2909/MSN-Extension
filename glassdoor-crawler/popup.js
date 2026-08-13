const button = document.getElementById("crawl");
const status = document.getElementById("status");
const maxClicks = document.getElementById("maxClicks");
const concurrency = document.getElementById("concurrency");
const sizeBox = document.getElementById("sizes");
const hint = document.getElementById("hint");
const site = document.getElementById("site");

const sizeInputs = [...sizeBox.querySelectorAll("input")];

// One Glassdoor site per country, all built the same way, so content.js works on every one
// of them: it reads the DOM and derives every URL from location.origin.
// KEEP IN SYNC with host_permissions in manifest.json - a domain missing there cannot be injected.
const SITES = {
    "glassdoor.com": "United States",
    "glassdoor.com.au": "Australia",
    "glassdoor.co.uk": "United Kingdom",
    "glassdoor.de": "Germany",
    "glassdoor.com.hk": "Hong Kong",
    "glassdoor.com.my": "Malaysia",
    "glassdoor.sg": "Singapore",
    "glassdoor.ca": "Canada",
    "glassdoor.co.in": "India",
    "glassdoor.ie": "Ireland",
    "glassdoor.co.nz": "New Zealand",
    "glassdoor.fr": "France",
    "glassdoor.nl": "Netherlands",
    "glassdoor.be": "Belgium",
    "glassdoor.at": "Austria",
    "glassdoor.ch": "Switzerland",
    "glassdoor.es": "Spain",
    "glassdoor.it": "Italy",
    "glassdoor.com.br": "Brazil",
    "glassdoor.com.mx": "Mexico",
    "glassdoor.com.ar": "Argentina"
};

// "www.glassdoor.com.au" -> "glassdoor.com.au"; anything else -> null
function domainOf(url) {

    let host;

    try {
        const parsed = new URL(url || "");

        if (parsed.protocol !== "https:") return null;

        host = parsed.hostname.toLowerCase();
    }
    catch (e) {
        return null;
    }

    // the country sites are also reachable through a subdomain (e.g. uk.glassdoor.co.uk)
    const base = Object.keys(SITES).find(domain => host === domain || host.endsWith("." + domain));

    return base || null;

}

// content.js clamps this too; here it only keeps the input from accepting absurd numbers
function parallelValue() {
    return Math.min(12, Math.max(1, parseInt(concurrency.value, 10) || 6));
}

function selectedSizes() {
    return sizeInputs.filter(input => input.checked).map(input => input.value);
}

function drawHint() {

    const count = selectedSizes().length;

    hint.textContent = count
        ? `Only companies matching ${count} selected size${count > 1 ? "s" : ""}. `
          + "Size is read from the job page, so this trims the file, not the crawl."
        : "No size filter: every company is exported.";

}

async function save() {

    concurrency.value = parallelValue();

    drawHint();

    await chrome.storage.local.set({
        maxClicks: Math.max(0, parseInt(maxClicks.value, 10) || 0),
        concurrency: parallelValue(),
        sizes: selectedSizes()
    });

}

// name the Glassdoor site of the active tab, so it is obvious which country is about to be crawled
async function drawSite() {

    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    const domain = domainOf(tab && tab.url);

    site.textContent = domain
        ? `${domain} - ${SITES[domain]}`
        : "Not on a Glassdoor page";

    site.style.opacity = domain ? "1" : ".7";

}

async function init() {

    drawSite();

    const settings = await chrome.storage.local.get(["maxClicks", "concurrency", "sizes"]);

    if (settings.maxClicks) maxClicks.value = settings.maxClicks;
    if (settings.concurrency) concurrency.value = settings.concurrency;

    if (Array.isArray(settings.sizes)) {
        for (const input of sizeInputs) input.checked = settings.sizes.includes(input.value);
    }

    drawHint();

    maxClicks.addEventListener("change", save);
    concurrency.addEventListener("change", save);

    sizeBox.addEventListener("change", save);

    document.getElementById("all").addEventListener("click", () => {
        for (const input of sizeInputs) input.checked = true;
        save();
    });

    document.getElementById("none").addEventListener("click", () => {
        for (const input of sizeInputs) input.checked = false;
        save();
    });

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

        const domain = domainOf(tab && tab.url);

        if (!domain) {
            status.textContent = "Open a Glassdoor job search page first "
                + "(glassdoor.com or a country site such as .com.au, .co.uk, .de, .com.hk, .com.my, .sg).";
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

        status.textContent = "Running. Keep this tab open and in the foreground while it clicks Show more jobs.";

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

    if (message && message.type === "gd-crawler-status") {
        status.textContent = message.text;
    }

});

init();
