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
files: ["core.js", "content.js"]
```

Every crawler writes a **CSV**, not an XLSX. `core.exportCsv()` builds the text itself — quoting a
field only when it holds a comma, a quote or a newline, which for these sheets is the normal case
rather than the exception — and prefixes a UTF-8 BOM so Excel does not open a Chinese or German
employer name as mojibake. That is why no crawler carries `xlsx.full.min.js` (a ~900KB vendored
SheetJS build) any more, and why nothing needs injecting ahead of `core.js`.

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

`foundit-crawler` is both at once, because foundit's search page comes in two shapes and the query
string decides which:

| URL | What arrives |
|---|---|
| `/search/data-engineer-jobs` | server-rendered — 20 cards in the HTML, and the whole search API response in the RSC payload |
| `/search/data-engineer-jobs?query=data+engineer` | a shimmer skeleton — zero cards, zero data, the list is fetched by the browser after load |

The second is the URL a person ends up on and copies, and it is empty to a `fetch()`. So the tab is
read as it stands and every page after it is fetched from the first shape, where page N is the same
path with `-N` on the end. Page 1..24 of a 465 result search answer `200`; page 25 answers `307`,
which redirects to page 1 — a page past the end succeeds and comes back full of jobs, so the walk
has to notice the repeat rather than read the response.

The other thing foundit does not do is put its best two columns in the markup. A server-rendered
card carries **no company id** (the career link is filled in by the browser) and **no posting date
at all** — both are in the RSC payload at the bottom of the document, split across ~340
`self.__next_f.push()` calls with job records straddling the cuts. `content.js` lifts the payload
out of the raw HTML inside its `slice`, so the whole 2MB page is never parsed, and reads the cards
as well: a page rescued through a tab comes back as markup with no payload behind it, and those
jobs still have to reach the file.

`startups-gallery-crawler` is the only one here that is not a job crawler: it reads the funding
feed at `startups.gallery/news`, one row per **funding round** rather than one per company, and a
company that raised twice is two rows and one request.

It is also the only one with **no paginator at all**. The feed ships 50 rounds and loads the rest
when a button is clicked:

| URL | What arrives |
|---|---|
| `/news` | 50 rounds, server-rendered |
| `/news?page=2` | the same 50 rounds |
| `/news?skip=50` | the same 50 rounds |

So the button is pressed for real, in the live tab, and the walk stops when it disappears or three
presses in a row load nothing. Two things about that press are load-bearing:

* **`element.click()` does not work on it.** The control is a Framer component — `framer-v-121ine6`
  is its current *variant* and `data-highlight="true"` is what Framer puts on anything with a tap
  or hover variant — so the gesture behind it is framer-motion's, and framer-motion arms a tap on
  `pointerdown` and completes it on `pointerup`. `click()` fires neither: it dispatches one click
  event, the tap handler never runs, and the walk reads a perfectly good feed as an exhausted one
  and writes the first 50 rounds as a complete run. `pressButton()` sends the sequence a mouse
  actually produces (`pointerover` → `pointerdown` → `pointerup` → native `click()`), then
  escalates to the keyboard and then to the elements either side of the control if a press loads
  nothing — and the summary says which gesture answered, because that is the thing most likely to
  change under the crawler without anything looking broken.
* Framer renders one copy of the button per breakpoint and hides all but one with CSS, so the
  crawler presses the copy that is **laid out**. Pressing the first match presses an invisible one.

Framer also re-renders the whole list rather than appending to it, so every row is read once per
batch and the dedupe, not the reader, is what keeps one round to one line.

The rest of the sheet is on the company page, which is plain HTML and fetched. Two things about
that page decide whether the file is right:

* the footer is the site's **entire directory** — every city, every stage, every fund — linking to
  the same `../investors/` and `../categories/` routes as the company's own header pills. Read
  naively, every company is credited with all sixteen funds. The directory's links are inline text
  inside a paragraph (`class="framer-text"`) and the header's are not, which is the only thing that
  tells them apart — and it is load-bearing exactly when the page arrives through a **tab**, where
  no slice has cut the footer off first.
* **Employees** is a bare `11–50` under an icon: no label, no link, nothing to select it by. It is
  read as the one cell in the pill row that is not inside a pill, so a company that publishes no
  headcount gets a blank rather than the pay band off the job card below it.

Investor names come from three places in order, because a company page prints its investors as
logos and only about half carry an `alt`: the logo's alt, then the name the **feed** spelled out
next to the same slug, then the slug title-cased.

Two columns are empty on every foundit run and the summary says so: there is no headcount on a
card, in the payload, on a job page or in any of the fifteen search facets foundit offers, and no
work-model field either — no remote/hybrid/on-site value anywhere, and no facet to filter by one.

`apollo-crawler` is the only one here that reads nothing off the page it is pointed at. Apollo's
People finder is a masked table — `****@****.com`, no revenue, no funding, no technologies, no
company address — and every column the sheet asks for is in the JSON the app already fetches from
its own `mixed_people/search` endpoint, not in the DOM. So the crawler does not scrape the table:
it **captures the app's own search request and replays it**, page by page, changing only `page`.

That takes a shape none of the others have. `inject.js` is a `world:"MAIN"`, `document_start`
content script — it runs in the page's own JS world, which is the only place the app's `fetch`/XHR
can be patched and the request seen with the exact auth (cookies, CSRF, whatever headers the app
adds) it was sent under. It records the last response that carries **both** a `pagination` block and
a `people`/`contacts` array — matching on shape, not on a path, so an endpoint rename empties nothing
— and answers two questions over `window.postMessage`: *do you have a template yet*, and *replay
page N*. `content.js` runs in the isolated world (it needs `chrome.storage` for the checkpoint and
`core.exportCsv` for the file), drives the walk, and maps each record to the 46 columns. It keeps
**every** record — no dedupe, nothing skipped: the goal here is the complete set, so a person Apollo
serves on two pages is written twice. The walk is bounded instead by the page count, never by the
URL, so it still terminates on a search whose tail repeats.

Speed is three things. It requests **100 records a page** instead of Apollo's 25 (a quarter of the
round-trips), and reads the *real* page size back from page 1 — so if Apollo ignores the override
and serves 25, the page count is recomputed from what actually came back and no record is lost. It
fetches pages **`concurrency` at a time** through `core.pipelinePages`, which keeps a window in
flight but hands them to the mapper in page order, so the file is still deterministic. And it pays
**no fixed delay** — full speed until a `429`/`403`, then a single shared backoff every worker
respects. Page 1 is fetched alone first, only to learn the page count before the pool opens.

Two rules are load-bearing and both are about **not spending the user's credits**: a locked email
comes back as `email_not_unlocked@domain.com` and a locked phone as `null` or a `*`-masked string,
and both are written **blank** rather than filled with a placeholder that reads like real data. The
crawler never calls a reveal endpoint. The company phone, on the other hand, is public and is kept.

Because the request is replayed from the page's own world, there is no `fetch()` from the extension,
no cross-origin call, and so no tab fallback and no worker — `apollo-crawler` is the one crawler here
with no `background.js` and no `tabs.js`. The one failure mode with a human fix is a tab that was
open before the extension was installed or updated: the `document_start` interceptor never ran in
it, the probe comes back empty, and the popup says to reload the tab.

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
#
# It also holds the two rules the sheet is built on, because Reed is where both break hardest -
# most of its ads are posted by agencies, so one company owns dozens of ads and repeats titles:
#   * two ads for the SAME role are two entries in Positions, not one
#   * an ad WITH a profile link and one WITHOUT, from the same agency, are one row not two
# and, across the whole fixture, that every ad read is an entry in some Positions cell.
node _shared/test/reed-cards.test.js ./reed-crawler

# drives reed-crawler off the END of a search, which is where a complete run started reporting
# itself as a broken one. Reed renders its "Next" link on the last page too, so a 27 page search
# followed it to page 28, got a 404, counted forward to 29 and 30 for two more, read three
# failures in a row as a refusal and retried two of them on the way out - "5x HTTP 404", "2
# page(s) could not be read at all", "Reed stopped serving results part way through", all of it
# about pages that do not exist. The fixture reproduces that signature exactly, and also covers
# the sharpest form of it: a search that fits on one page. It also covers the two things that
# made a WORKING run look broken: Reed's Promoted slots, which are the same paid ads repeated on
# every page and outside the result count (54 of one run's 80 duplicate cards), and the list
# moving under the walk - when Reed's list shifts between requests the top of a page repeats the
# bottom of the last one and whatever was pushed off the top is served to nobody, which is why
# recoverGap re-reads the pages once the walk is done.
node _shared/test/reed-tail.test.js ./reed-crawler

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

# drives foundit-crawler against REAL foundit markup and a REAL foundit search payload (in
# foundit-fixture.js), parsed for real. foundit is the one site here whose search page is BOTH
# server-rendered and browser-rendered depending on the query string, and whose two best columns -
# the company id and the posting date - are in neither the cards nor the DOM but in an RSC payload
# split across hundreds of push() calls. So both readers run against both shapes:
#   * the open tab in its browser-rendered shape, whose cards DO carry a career link and a
#     "Posted 12 days ago" label, and whose payload is not there yet
#   * fetched pages in their server-rendered shape, whose cards carry neither
#   * a page as a TAB hands it back - rendered markup, no scripts - which is the shape the payload
#     reader cannot help with at all, and which still has to reach the file
# It also holds the two rules the sheet is built on, and foundit breaks both harder than most:
# "CSI Interfusion" and "CSI Interfusion Sdn Bhd" fold to the same name and are two employers,
# while "mr diy international" and "MR D.I.Y. International" do NOT fold and are one.
# Finally it walks off the end of a search, where foundit answers with a 307 to page 1 rather than
# a 404 - a request that succeeds and comes back full of jobs, and adds nothing.
node _shared/test/foundit-pages.test.js ./foundit-crawler

# drives startups-gallery-crawler against REAL startups.gallery markup, parsed for real. This is a
# Framer site, so every class name is hashed per build and the whole crawler reads the page through
# data-framer-name, hrefs and <time datetime> - a wrong one there writes an empty column rather
# than crashing. The fixture holds the three traps the site is built out of:
#   * the feed has NO page URL, so the Load More button is clicked for real - and the HIDDEN
#     per-breakpoint copy of that button is wired to do nothing, so a crawler that picks the first
#     match instead of the laid-out one comes away with batch 1 and calls it a complete run
#   * the footer directory links to the same /investors/ and /categories/ routes as the header
#     pills, and one company page arrives through a TAB, where nothing has cut the footer off
#   * a company that publishes no headcount, whose job cards carry a pay band in a cell of exactly
#     the same shape as the employees pill
# It also holds the rule the sheet is built on: one row per ROUND, one request per COMPANY, and an
# older round keeps its own stage rather than the stage the company has since raised.
node _shared/test/sg-loadmore.test.js ./startups-gallery-crawler

# drives apollo-crawler/content.js through a REAL mixed_people/search response, mapped for real, and
# inspects the CSV it writes. Where smoke.js only proves the crawler survives a blank stub, this
# stubs the page-world interceptor so the whole replay -> map -> export path runs, and holds the
# two rules the sheet is built on:
#   * a locked email ("email_not_unlocked@domain.com") and a locked phone come out BLANK - the run
#     never spends a credit, so a placeholder that reads like a real address is never written
#   * nothing is skipped - the run keeps every record, so a person served on page 1 and again on
#     page 2 is written twice rather than deduped away
# It also checks all 46 columns come out in order, revenue/funding map to their clean+printed pair,
# and multi-value cells (keywords, technologies, departments) are quoted.
node _shared/test/apollo-map.test.js ./apollo-crawler
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
| **Every job, once per job** | The sheet is one row per **company** and one Positions entry per **ad**. Those are different dedupes and they used to be the same one: `push()` skipped a title the cell already held, so a company running four separate "Software Engineer" ads was written as hiring for one. Only the columns that describe the company — Location, Remote/Onsite — are still a set. An ad whose title cannot be read is marked `(untitled)` rather than dropped, so the entry count in a cell always equals the ad count behind the row. |
| **An unreadable id is not a lost job** | Every crawler keyed its cards on one attribute and dropped the card when it was missing — so a build that renamed `data-jk` / `data-job-id` / `data-jobid` emptied the run while it still reported pages and finished normally. Each now falls back to the ad's own URL, then to what the card says, and warns. Never to its page/position: pages are re-read on purpose (the rewind to page 1, a resumed run, a page reopened in a tab), so a position-based key hands one ad a new identity each time and *duplicates* it. |
| **One employer, one row** | `core.companyKeys()`. Grouping keys are `id:<id>` when the card carried a company id and `name:<folded>` otherwise — and whether that id renders is a property of the **card**, not the employer, so within one search the same company arrived both ways and got two rows, each with a slice of the positions. Ids are read in a first pass; every ad of a name ever seen with an id is then filed under that id. Order-independent, so two runs of one search produce the same sheet. |
| **No invented values** | `headcount()` reads a company size from a labelled field, or from an element that *is* the value — never by running a regex over the whole `<body>`, where an advert saying "join our 200 employees" produced a headcount indistinguishable from a real one. Every value records which of the two it was, and `describeSizes()` puts the split in the summary. |
| **A refusal is not the end** | 429/403/5xx is as often "that did not look like a browser" as "too fast", and backing off answers only one of the two. `makeTabFallback()` reopens the URL as a real top-level navigation, which carries the cookies, the TLS fingerprint and the JS a managed challenge asks for. If the check needs a person, the tab comes to the front — at most `askLimit` times a run, one at a time, because one cleared check covers the whole site and the cheap path works again after it. `makeTabFallback({extract})` names the elements the caller actually reads, so the worker sends back that markup instead of a document that is mostly the page's own JSON. |
