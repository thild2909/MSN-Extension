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

`ctgoodjobs-crawler` makes no HTTP requests at all — it drives the live tab — but it carries the
worker too. Its paginator is what gets refused: past a couple of dozen pages the app's own page
request comes back `405`, the list never swaps, and the walk used to stop there. `content.js` hands
the remaining pages to `tabs.js`, which reopens each `?page=N` as a real navigation and reads the
rendered DOM out of it.

`dice-crawler` is the opposite case: `www.dice.com/jobs?q=…&page=N` is server-rendered, so all 30
cards arrive in the HTML and the whole walk is fetches — the live tab is only read for page one and
the result count. What it cannot fetch its way past is Dice's own ceiling: **25 pages, 750 jobs,
per search**, whatever the result count says. `?page=26` upwards answer `200` with a full list, and
it is page 25's list again. The crawler stops at the repeat and says so in the summary rather than
letting a file with 750 of 11,850 jobs read like a complete run.

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

All of them run under plain Node, no dependencies, no browser. `minidom.js` is not a test — it is
the HTML parser and CSS selector engine the site-markup fixtures share, so a wrong selector fails
there instead of writing an empty column in a real run.

```bash
# 32 fault-injection tests: dropped connections, 429 ladders, dead pages,
# retry passes, cell clipping, name folding, gate backoff
node _shared/test/core.test.js _shared/core.js

# checks every crawler's core.js is still byte-identical to _shared/core.js, then runs
# every content.js against a stubbed DOM and reports any crawler that throws,
# references something undefined, or dies in the export path
node _shared/test/smoke.js .

# drives seek-job-crawler through a search where no company has a SEEK profile and no job ad
# publishes a headcount: the run must stop paying for the lookups, say so in the summary, and
# still write every company to the file
node _shared/test/seek-probe.test.js ./seek-job-crawler

# drives ctgoodjobs-crawler through a search whose paginator stops turning part way: the walk
# must reopen the remaining pages in a background tab rather than reading a dead pager as the
# end of the list. Against the pre-fix content.js this stops at page 2 of 5.
node _shared/test/ctgj-pager.test.js ./ctgoodjobs-crawler

# drives reed-crawler against REAL Reed markup, parsed for real: the test carries a small HTML
# parser and selector engine, so unlike the stub above it can actually fail on a wrong selector.
# Reed hashes every class name per build, so the whole crawler reads the page through data-qa
# attributes - and a wrong one there does not crash a run, it writes an empty column.
node _shared/test/reed-cards.test.js ./reed-crawler

# drives wellfound-company-crawler through a 150 company search where every detail page answers
# 403: eight refusals trip its breaker, so from there on EVERY company needs a tab. All 150 must
# get one. Against the pre-fix content.js the tab budget was a flat 80 and companies 81-150 got
# neither a request nor a tab - blank Location and Employees, and nothing in the console to say
# the tabs had stopped.
node _shared/test/wf-403.test.js ./wellfound-company-crawler

# drives dice-crawler against REAL Dice markup, parsed for real, into Dice's page ceiling. Dice
# serves 25 result pages per search and no more: ?page=26 upwards come back 200 with a full list of
# 30 jobs, and they are page 25's jobs again. A walk that trusts the advertised total ("11,850
# results" -> 395 pages) keeps asking, keeps being served and keeps adding nothing, then writes a
# file that reads like a complete run. The same fixture covers both list layouts (the "Group by
# company" toggle is client-side, so the live tab can be grouped while every fetched page is not)
# and checks the detail pane's "Similar Jobs" strip - role="list" aria-label="Job search results",
# the same two attributes as the real list - stays out of the file.
node _shared/test/dice-cap.test.js ./dice-crawler
```

Run all of them after touching `core.js` or any `content.js`.

## Sizing the tab fallback

`makeTabFallback` takes a flat `budget` (80 pages) because it is built before the crawl knows how
much work there is. Two setters exist for what is only known afterwards, and a crawler whose pages
are refused in bulk has to call both — the defaults are sized for a bad day, not for a search where
every page needs a tab:

```js
tabs.setLimit(concurrency);        // how wide the worker may run - the crawl's real width
tabs.setBudget(unique.length*2);   // how many pages this run may rescue
```

`tabs.ready()` is worth calling once before the crawl too: it wakes the MV3 worker so the first
refusal is not also a cold start, and reports a missing worker in the first second rather than after
twenty refused pages.

## What core.js guarantees

| Guarantee | How |
|---|---|
| **Coverage** | A page that fails is stepped over (`walkPages.guessNext`), remembered, and retried at the end. It can never end the walk and silently truncate the list. |
| **No data loss** | Whatever has been collected is written to a file even when the run crashes (`finish`/`salvage` in each crawler), and checkpointed to `chrome.storage.local` every few seconds so a tab navigation does not erase it either. |
| **Fault tolerance** | Dropped connections, rate limits and permanent statuses are told apart and answered differently — retry, back off, give up. A failed fetch is never cached. |
| **Speed** | Pacing is adaptive, floor zero: full speed until the site pushes back, penalty walked back down to the floor once it stops. Page fetching is a pipeline with no batch barrier. Work that cannot produce an answer is not done: `fetchDoc(url, {needs})` skips building a DOM for a body that cannot contain what the caller came for, `fetchDoc(url, {slice, sliced})` parses only the part of the page the caller reads (DOMParser runs on the crawl's own main thread, so on a megabyte page it, not the network, is what a wide run waits for), and `headcount()` reads each element only as far as it takes to reject it. |
| **Parallel stays parallel** | The two things that quietly turned a pool back into a queue are both bounded. `makeGate({minLimit})` stops refusals from narrowing the pool all the way to one, and a clean answer gives a slot straight back rather than one per three. `tabs.js` runs a pool of tabs (`makeTabFallback({tabLimit})`, capped at 8) instead of one at a time — once a site refuses everything, the tab path *is* the crawl, and serial there meant serial everywhere however wide the popup was set. |
| **A failure that repeats is stopped** | Every recovery path has a way to notice it is not recovering. `makeTabFallback({giveUpAfter})` gives up once N tabs in a row fail — a real navigation failing the way the fetches do means the connection is the problem, not the site — and says which of the two it was. `makeFetcher({maxTransportStreak})` writes the session off once N URLs in a row never connect at all. Without these, a VPN mangling HTTP/2 cost a run 80 tab loads and 644 dead requests to learn what the first ten already said. |
| **No invented values** | `headcount()` reads a company size from a labelled field, or from an element that *is* the value — never by running a regex over the whole `<body>`, where an advert saying "join our 200 employees" produced a headcount indistinguishable from a real one. Every value records which of the two it was, and `describeSizes()` puts the split in the summary. |
| **A refusal is not the end** | 429/403/5xx is as often "that did not look like a browser" as "too fast", and backing off answers only one of the two. `makeTabFallback()` reopens the URL as a real top-level navigation, which carries the cookies, the TLS fingerprint and the JS a managed challenge asks for. If the check needs a person, the tab comes to the front — at most `askLimit` times a run, one at a time, because one cleared check covers the whole site and the cheap path works again after it. `makeTabFallback({extract})` names the elements the caller actually reads, so the worker sends back that markup instead of a document that is mostly the page's own JSON. |
