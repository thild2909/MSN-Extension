# _shared

`core.js` is the crawl engine every crawler in this folder runs on. It is the **source of truth**;
each `*-crawler/core.js` is a byte-identical copy.

A Chrome extension can only load files that sit inside its own folder, so the file has to be
duplicated rather than referenced. `popup.js` injects it ahead of `content.js`:

```js
files: ["xlsx.full.min.js", "core.js", "content.js"]
```

## After editing core.js

Copy it back out to every crawler, or the change only lands in one of them:

```bash
cd "MSN Extension"
for d in *-crawler; do cp _shared/core.js "$d/core.js"; done
```

Check they are all in step (this must print `1`):

```bash
md5sum */core.js _shared/core.js | awk '{print $1}' | sort -u | wc -l
```

## Tests

Both run under plain Node, no dependencies, no browser.

```bash
# 32 fault-injection tests: dropped connections, 429 ladders, dead pages,
# retry passes, cell clipping, name folding, gate backoff
node _shared/test/core.test.js _shared/core.js

# runs all 8 content.js files against a stubbed DOM and reports any crawler
# that throws, references something undefined, or dies in the export path
node _shared/test/smoke.js .
```

Run both after touching `core.js` or any `content.js`.

## What core.js guarantees

| Guarantee | How |
|---|---|
| **Coverage** | A page that fails is stepped over (`walkPages.guessNext`), remembered, and retried at the end. It can never end the walk and silently truncate the list. |
| **No data loss** | Whatever has been collected is written to a file even when the run crashes (`finish`/`salvage` in each crawler), and checkpointed to `chrome.storage.local` every few seconds so a tab navigation does not erase it either. |
| **Fault tolerance** | Dropped connections, rate limits and permanent statuses are told apart and answered differently — retry, back off, give up. A failed fetch is never cached. |
| **Speed** | Pacing is adaptive, floor zero: full speed until the site pushes back, penalty walked back down to the floor once it stops. Page fetching is a pipeline with no batch barrier. |
