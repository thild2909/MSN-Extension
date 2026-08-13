// The shared tab fallback: when a fetch is refused, the URL is reopened as a real navigation and
// the person is asked to clear the check if one needs clearing. See _shared/tabs.js - that file is
// byte-identical in every crawler, so a fix there lands everywhere at once.
//
// startups.gallery serves its company pages as plain HTML, so on a good day nothing here is used.
// It sits behind a CDN though, and the detail pass asks for one page per company in the feed -
// which is the shape of request a managed challenge answers with a 403 rather than a 429.
//
// A content script cannot open tabs, which is the only reason this worker exists.
importScripts("tabs.js");
