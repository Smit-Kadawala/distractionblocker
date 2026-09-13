// ---------- Utilities ----------

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function getHostname(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

function matchSite(hostname, sites) {
  if (!hostname) return null;
  for (const key of Object.keys(sites)) {
    if (hostname === key || hostname.endsWith("." + key)) return key;
  }
  return null;
}

async function getSites() {
  const data = await chrome.storage.local.get("sites");
  return data.sites || {};
}

async function saveSites(sites) {
  await chrome.storage.local.set({ sites });
}

async function getTracking() {
  const data = await chrome.storage.local.get("tracking");
  return data.tracking || { host: null, startedAt: null };
}

async function setTracking(tracking) {
  await chrome.storage.local.set({ tracking });
}

// Ensure each site's day is current; reset used time & blocked flag if new day
function rolloverIfNeeded(sites) {
  const today = todayKey();
  let changed = false;
  for (const key of Object.keys(sites)) {
    if (sites[key].dateKey !== today) {
      sites[key].dateKey = today;
      sites[key].usedSeconds = 0;
      sites[key].blocked = false;
      changed = true;
    }
  }
  return changed;
}

// ---------- Core: flush elapsed time (survives service worker restarts because
// the checkpoint lives in chrome.storage.local, not a JS variable) ----------

async function flushAndMaybeSwitch(newHost) {
  const sites = await getSites();
  rolloverIfNeeded(sites);

  const tracking = await getTracking();
  if (tracking.host && tracking.startedAt && sites[tracking.host]) {
    const elapsedSec = Math.floor((Date.now() - tracking.startedAt) / 1000);
    if (elapsedSec > 0) {
      sites[tracking.host].usedSeconds += elapsedSec;
    }
  }

  let newTracking = { host: null, startedAt: null };
  if (newHost && sites[newHost] && !sites[newHost].blocked) {
    newTracking = { host: newHost, startedAt: Date.now() };
  }
  await setTracking(newTracking);
  await saveSites(sites);
  return sites;
}

function redirectToBlocked(tabId, siteKey) {
  const url = chrome.runtime.getURL(`blocked.html?site=${encodeURIComponent(siteKey)}`);
  chrome.tabs.update(tabId, { url }).catch(() => {});
}

// Schedule a one-off alarm timed to fire exactly when the current tracked
// site's limit will be reached, instead of relying only on 1-minute polling.
async function scheduleLimitAlarm() {
  await chrome.alarms.clear("limitCheck");
  const tracking = await getTracking();
  if (!tracking.host) return;
  const sites = await getSites();
  const site = sites[tracking.host];
  if (!site) return;
  const remainingSec = site.limitMinutes * 60 - site.usedSeconds;
  const fireInMs = Math.max(1000, remainingSec * 1000);
  chrome.alarms.create("limitCheck", { when: Date.now() + fireInMs });
}

// Check current active+focused tab and update tracking + blocking
async function evaluate() {
  let activeTab = null;
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.focused) {
      const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
      activeTab = tabs[0] || null;
    }
  } catch (e) {
    activeTab = null;
  }

  const hostname = activeTab ? getHostname(activeTab.url || "") : null;

  // Peek at sites first to know if the hostname matches a tracked (unblocked) site
  let sites = await getSites();
  rolloverIfNeeded(sites);
  const matchedKey = hostname ? matchSite(hostname, sites) : null;

  // Flush previous tracking time and start/stop tracking for the new host
  sites = await flushAndMaybeSwitch(matchedKey);

  if (matchedKey && sites[matchedKey]) {
    const site = sites[matchedKey];
    if (!site.blocked && site.usedSeconds >= site.limitMinutes * 60) {
      site.blocked = true;
      await setTracking({ host: null, startedAt: null });
      await chrome.alarms.clear("limitCheck");
    }
    if (site.blocked && activeTab) {
      redirectToBlocked(activeTab.id, matchedKey);
    }
  }

  await saveSites(sites);
  await scheduleLimitAlarm();
}

// ---------- Event hooks ----------

chrome.tabs.onActivated.addListener(() => evaluate());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" || info.url) evaluate();
});
chrome.windows.onFocusChanged.addListener(() => evaluate());

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state !== "active") {
    // user stepped away: stop the clock but don't lose already-counted time
    await flushAndMaybeSwitch(null);
    await chrome.alarms.clear("limitCheck");
  } else {
    evaluate();
  }
});

// Periodic safety net every 1 minute, plus the precise per-site "limitCheck" alarm
chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick" || alarm.name === "limitCheck") evaluate();
});

// On a real browser start / extension install, any old tracking checkpoint
// is stale (the browser was fully closed) — clear it before evaluating.
async function clearStaleTracking() {
  await setTracking({ host: null, startedAt: null });
}
chrome.runtime.onStartup?.addListener(async () => {
  await clearStaleTracking();
  evaluate();
});
chrome.runtime.onInstalled.addListener(async () => {
  await clearStaleTracking();
  evaluate();
});

// Allow popup to ask for a fresh evaluate + get live data
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_LIVE_SITES") {
    (async () => {
      await evaluate();
      const sites = await getSites();
      sendResponse({ sites });
    })();
    return true; // async
  }
});
