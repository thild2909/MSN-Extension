// Cross-origin fetch on behalf of content.js.
//
// A search on one Glassdoor site links to job pages on another country domain: a
// glassdoor.com search for jobs in Australia links every card to glassdoor.com.au.
// A fetch from the content script runs with the page's origin and is refused by CORS,
// which is why every company page came back as a request error. The service worker is
// not bound by that: it may fetch any host listed in host_permissions.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (!message || message.type !== "gd-fetch") return;

    fetch(message.url, { credentials: "include" })
        .then(async response => sendResponse({
            status: response.status,
            retryAfter: +response.headers.get("retry-after") || 0,
            html: response.ok ? await response.text() : ""
        }))
        .catch(e => sendResponse({ error: String(e && e.message || e) }));

    // the answer is sent from a promise -> keep the message channel open
    return true;

});
