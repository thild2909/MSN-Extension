// The shared tab fallback: when a fetch is refused, the URL is reopened as a real navigation and
// the person is asked to clear the check if one needs clearing. See _shared/tabs.js - that file is
// byte-identical in every crawler, so a fix there lands everywhere at once.
//
// foundit sits behind Akamai, which answers a content script's fetch with 403 far more readily than
// it answers a navigation, so this is not a rarely-used corner here - it is the path a bad run
// spends most of its time on.
//
// A content script cannot open tabs, which is the only reason this worker exists.
importScripts("tabs.js");
