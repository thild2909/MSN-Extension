# _shared

Two files are the **source of truth** for every crawler in this folder:

| File | What it is | Runs in |
|---|---|---|
| `core.js` | the crawl engine — pacing, fetching, pagination, grouping, export | the page, injected by `popup.js` |
| `tabs.js` | the tab fallback — reopens a refused URL as a real navigation | the service worker |

A Chrome extension can only load files that sit inside its own folder, so both are duplicated
rather than referenced. Each `*-crawler/core.js` and `*-crawler/tabs.js` is a byte-identical copy.

`popup.js` injects the engine ahead of `content.js`:

```js
files: ["xlsx.full.min.js", "core.js", "content.js"]
```

and each crawler's `background.js` is a one-liner that pulls in the worker half:

```js
importScripts("tabs.js");
```

which the manifest has to register, along with the permission it needs:

```json
"background": { "service_worker": "background.js" },
"permissions": ["activeTab", "scripting", "storage", "tabs"]
```

`ctgoodjobs-crawler` has neither: it drives the live tab and never makes an HTTP request, so there
is no refusal for a tab to recover from.

## After editing core.js or tabs.js

Copy them back out, or the change only lands in one crawler:

```bash
cd "MSN Extension"
for d in *-crawler; do cp _shared/core.js "$d/core.js"; done
for d in *-crawler; do [ -f "$d/background.js" ] && cp _shared/tabs.js "$d/tabs.js"; done
```

`smoke.js` fails the build if any copy has drifted or a worker is not registered, so there is no
need to check by hand — but if you want to: this must print `1`.

```bash
md5sum */core.js _shared/core.js | awk '{print $1}' | sort -u | wc -l
```

## Tests

Both run under plain Node, no dependencies, no browser.

```bash
# 32 fault-injection tests: dropped connections, 429 ladders, dead pages,
# retry passes, cell clipping, name folding, gate backoff
node _shared/test/core.test.js _shared/core.js

# checks every crawler's core.js is still byte-identical to _shared/core.js, then runs
# all 7 content.js files against a stubbed DOM and reports any crawler that throws,
# references something undefined, or dies in the export path
node _shared/test/smoke.js .

# drives seek-job-crawler through a search where no company has a SEEK profile and no job ad
# publishes a headcount: the run must stop paying for the lookups, say so in the summary, and
# still write every company to the file
node _shared/test/seek-probe.test.js ./seek-job-crawler
```

Run all three after touching `core.js` or any `content.js`.

## What core.js guarantees

| Guarantee | How |
|---|---|
| **Coverage** | A page that fails is stepped over (`walkPages.guessNext`), remembered, and retried at the end. It can never end the walk and silently truncate the list. |
| **No data loss** | Whatever has been collected is written to a file even when the run crashes (`finish`/`salvage` in each crawler), and checkpointed to `chrome.storage.local` every few seconds so a tab navigation does not erase it either. |
| **Fault tolerance** | Dropped connections, rate limits and permanent statuses are told apart and answered differently — retry, back off, give up. A failed fetch is never cached. |
| **Speed** | Pacing is adaptive, floor zero: full speed until the site pushes back, penalty walked back down to the floor once it stops. Page fetching is a pipeline with no batch barrier. Work that cannot produce an answer is not done: `fetchDoc(url, {needs})` skips building a DOM for a body that cannot contain what the caller came for, and `headcount()` reads each element only as far as it takes to reject it. |
| **No invented values** | `headcount()` reads a company size from a labelled field, or from an element that *is* the value — never by running a regex over the whole `<body>`, where an advert saying "join our 200 employees" produced a headcount indistinguishable from a real one. Every value records which of the two it was, and `describeSizes()` puts the split in the summary. |
| **A refusal is not the end** | 429/403/5xx is as often "that did not look like a browser" as "too fast", and backing off answers only one of the two. `makeTabFallback()` reopens the URL as a real top-level navigation, which carries the cookies, the TLS fingerprint and the JS a managed challenge asks for. If the check needs a person, the tab comes to the front — at most `askLimit` times a run, because one cleared check covers the whole site and the cheap path works again after it. |
