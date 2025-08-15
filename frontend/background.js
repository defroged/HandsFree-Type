// background.js — MV3-compliant, no Firebase Auth, no remote scripts

// ----------------- Notifications -----------------
function showInfoNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title,
    message
  });
}
function showErrorNotification(message) {
  showInfoNotification('HandsFree Type Error', message || 'An unexpected error occurred.');
}

// ----------------- Auth (Google via chrome.identity) -----------------
const API_BASE = "https://asia-northeast1-handsfreetype.cloudfunctions.net";

let currentUser = null;              // { email, sub } or null
let authReadyPromise = null;         // resolves after first auth check
let isRecording = false;
let creatingOffscreen = false;
let lastKnownRemainingSeconds = null;
let recordStartTs = null;
let targetTabId = null;
let pendingStartAfterPermission = false;
let pendingTargetTabId = null;
let discardNextResult = false;
let pendingStopResolve = null;
let pendingStopTimer = null;
let badgeAnimationTimer = null;

// First-load: determine auth state from cached Google token
function initializeAuth() {
  if (authReadyPromise) return;
  authReadyPromise = new Promise((resolve) => {
    // Try to get a cached access token without UI
    chrome.identity.getAuthToken({ interactive: false }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        currentUser = null;
        try { await chrome.runtime.sendMessage({ type: 'auth-state-changed', user: null }); } catch {}
        return resolve();
      }
      try {
        const profile = await fetchGoogleUser(token);
        currentUser = { email: profile.email || null, sub: profile.sub || null };
        try { await chrome.runtime.sendMessage({ type: 'auth-state-changed', user: currentUser ? { email: currentUser.email } : null }); } catch {}
      } catch {
        currentUser = null; // token may be invalid/expired
      } finally {
        resolve();
      }
    });
  });
}
initializeAuth();

async function fetchGoogleUser(accessToken) {
  const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok) throw new Error(`userinfo ${r.status}`);
  return r.json();
}

async function getGoogleAccessToken({ interactive } = { interactive: false }) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
      if (chrome.runtime.lastError || !token) return resolve(null);
      resolve(token);
    });
  });
}

async function getAuthHeaderOrNull() {
  await authReadyPromise;
  const tok = await getGoogleAccessToken({ interactive: false });
  if (!tok) return {};
  return { Authorization: `Bearer ${tok}` };
}

// Attempt silent sign-in on service worker startup
(async () => {
  const t = await getGoogleAccessToken({ interactive: false });
  if (t) {
    try {
      const profile = await fetchGoogleUser(t);
      currentUser = { email: profile.email || null, sub: profile.sub || null };
      try { await chrome.runtime.sendMessage({ type: 'auth-state-changed', user: { email: currentUser.email } }); } catch {}
    } catch { /* ignore */ }
  }
})();

// ----------------- Badge Animation -----------------
async function startBadgeAnimation() {
  if (badgeAnimationTimer) return;
  let frame = 0;
  const frames = ["·", "··", "···", " ··", "  ·", "   "];
  const animate = () => {
    chrome.action.setBadgeText({ text: frames[frame++ % frames.length] });
  };
  badgeAnimationTimer = setInterval(animate, 200);
  animate();
}
async function stopBadgeAnimation(finalText = "") {
  if (badgeAnimationTimer) {
    clearInterval(badgeAnimationTimer);
    badgeAnimationTimer = null;
  }
  await setBadge(finalText);
}

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.action.setBadgeBackgroundColor({ color: "#CC0000" }); } catch {}
});

// ----------------- Commands -----------------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-dictation") {
    console.log(`[${Date.now()}] Command received: toggle-dictation`);
    if (tab?.id) {
      targetTabId = tab.id;
      pendingTargetTabId = tab.id;
    }
    await toggleRecordingState();
  }
});

// ----------------- Messaging -----------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleMessage = async () => {
    // --- Auth / API for popup ---
    if (message.type === 'get-auth-state') {
      return { user: currentUser ? { email: currentUser.email } : null };
    }

    if (message.type === 'trigger-signin') {
      const t = await getGoogleAccessToken({ interactive: true });
      if (!t) return { success: false, error: 'Sign-in canceled or failed.' };
      try {
        const profile = await fetchGoogleUser(t);
        currentUser = { email: profile.email || null, sub: profile.sub || null };
        try { await chrome.runtime.sendMessage({ type: 'auth-state-changed', user: { email: currentUser.email } }); } catch {}
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message || 'Could not fetch Google profile.' };
      }
    }

    if (message.type === 'trigger-signout') {
      // Remove cached token; user may still be logged into Google, which is fine.
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (token) {
          chrome.identity.removeCachedAuthToken({ token }, () => {});
        }
      });
      currentUser = null;
      try { await chrome.runtime.sendMessage({ type: 'auth-state-changed', user: null }); } catch {}
      return { success: true };
    }

    if (message.type === 'api-get') {
      return await apiGet(message.path);
    }
    if (message.type === 'api-post') {
      return await apiPost(message.path, message.body);
    }

    // --- Offscreen recording transitions ---
    if (message?.type === "recording-started") {
      console.log(`[${Date.now()}] Event received: recording-started from offscreen`);
      recordStartTs = Date.now();
      await setBadge("REC");
      await sendUIStarted(lastKnownRemainingSeconds);
      return;
    }

    if (message?.type === "audio-ready-b64") {
      console.log(`[${Date.now()}] Event received: audio-ready-b64 from offscreen`);
      const b64 = message.b64 || "";
      const size = message.size || 0;

      if (pendingStopResolve) {
        clearTimeout(pendingStopTimer);
        pendingStopResolve(true);
        pendingStopResolve = null;
        pendingStopTimer = null;
      }

      isRecording = false;

      const cleanup = async () => {
        await sendUIStopped();
        await closeOffscreenSafe();
        discardNextResult = false;
      };

      if (!b64 || size === 0) {
        await stopBadgeAnimation("0");
        if (!discardNextResult) await sendErrorToContentScript("Error: No audio was captured.");
        await cleanup();
        return;
      }

      if (discardNextResult) {
        await stopBadgeAnimation("");
        await cleanup();
        return;
      }

      await processAudio(b64);
      
      // Fire-and-forget usage commit
      if (recordStartTs) {
        const elapsed = Math.max(0, Math.round((Date.now() - recordStartTs) / 1000));
        apiPost("/commitUsage", { elapsedSeconds: elapsed }).catch(err => {
            showErrorNotification('Could not save your usage data. Please check your connection.');
        });
      }
      recordStartTs = null;
      lastKnownRemainingSeconds = null;

      await cleanup();
      return;
    }

    if (message?.type === "audio-error") {
      showErrorNotification(message.error || "An unknown error occurred while recording audio.");
      await stopBadgeAnimation("ERR");
      if (!discardNextResult) await sendErrorToContentScript(`Error: ${message.error || "Audio pipeline error."}`);
      if (pendingStopResolve) {
        clearTimeout(pendingStopTimer);
        const resolve = pendingStopResolve;
        pendingStopResolve = null;
        pendingStopTimer = null;
        resolve(null);
      }
      await sendUIStopped();
      await closeOffscreenSafe();
      discardNextResult = false;
      return;
    }

    if (message?.type === "mic-permission") {
      if (message.state === "granted") {
        if (pendingStartAfterPermission) {
          pendingStartAfterPermission = false;
          await startOffscreenRecording(pendingTargetTabId || targetTabId);
        }
      } else {
        showErrorNotification('Microphone permission not granted. Please allow microphone access to use dictation.');
        await setBadge("ERR");
        if (!discardNextResult) await sendErrorToContentScript(`Error: Microphone permission not granted. ${message.error || ""}`);
        await sendUIStopped();
      }
      return;
    }
  };

  handleMessage()
    .then((response) => { if (response !== undefined) sendResponse(response); })
    .catch((error) => {
      showErrorNotification(`An internal error occurred: ${error.message}`);
      sendResponse({ error: error.message });
    });

  return true; // async response
});

// ----------------- API helpers -----------------
async function apiGet(path) {
  const start = Date.now();
  console.log(`[${start}] API GET request sent to: ${path}`);
  await authReadyPromise;
  const h = await getAuthHeaderOrNull();
  const r = await fetch(`${API_BASE}${path}`, { headers: { ...h } });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
  const result = await r.json();
  console.log(`[${Date.now()}] API GET response from ${path} received in ${Date.now() - start}ms`);
  return result;
}

async function apiPost(path, body = {}) {
  const start = Date.now();
  console.log(`[${start}] API POST request sent to: ${path}`);
  await authReadyPromise;
  const h = await getAuthHeaderOrNull();
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...h },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt;
    try { msg = JSON.parse(txt).error || msg; } catch {}
    throw new Error(`POST ${path} ${r.status}: ${msg}`);
  }
  const result = JSON.parse(txt);
  console.log(`[${Date.now()}] API POST response from ${path} received in ${Date.now() - start}ms`);
  return result;
}

// ----------------- Start/Stop control -----------------
async function toggleRecordingState() {
  console.log(`[${Date.now()}] toggleRecordingState called. isRecording: ${isRecording}`);
  if (!isRecording) {
    const tabId = await getPasteTargetTabId();
    if (!tabId) {
      showErrorNotification('Could not find a tab to dictate into.');
      return;
    }

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });
    } catch (e) {
      console.log(`Could not inject script into tab ${tabId}: ${e.message}`);
    }

    // Fire off /canStart and mic permission in parallel
    const canStartPromise = apiGet('/canStart').catch(e => {
      showErrorNotification(`Could not verify usage: ${e.message}`);
      setBadge("ERR");
      return null;
    });

    const permissionGranted = await ensureMicPermission();

    if (!permissionGranted) {
      console.log(`[${Date.now()}] Mic permission not granted, will start if/when it is.`);
      pendingStartAfterPermission = true;
    }

    // Now, wait for the API call to complete
    const canStartResult = await canStartPromise;

    if (!canStartResult) {
      // Error already shown
      return;
    }

    const { plan, remainingSeconds } = canStartResult;
    lastKnownRemainingSeconds = remainingSeconds;

    if (remainingSeconds <= 0) {
      const planName = plan === 'pro' ? 'Pro' : 'Free';
      const message = `You've used up all your transcription time for the ${planName} plan this month. You can wait until next month or upgrade now to continue.`;
      await sendToTab(tabId, { type: "ui-show-error-bar", text: message });
      await setBadge("0");
      return;
    }

    if (permissionGranted) {
      await startOffscreenRecording(tabId);
    }
  } else {
    await stopOffscreenRecording();
  }
}

async function ensureMicPermission() {
  // Try Permissions API; if not granted, open a helper page that will prompt
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    if (p.state === "granted") return true;
  } catch { /* permissions API might not be available in SW */ }

  await chrome.tabs.create({ url: chrome.runtime.getURL("request-mic.html"), active: true });
  return false;
}

async function startOffscreenRecording(tabIdFromCaller) {
  console.log(`[${Date.now()}] startOffscreenRecording called`);
  if (creatingOffscreen) return;
  creatingOffscreen = true;
  try {
    if (tabIdFromCaller) {
      targetTabId = tabIdFromCaller;
    } else {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = tabs?.[0]?.id ?? null;
      } catch { targetTabId = null; }
    }

    if (!(await chrome.offscreen.hasDocument())) {
      console.log(`[${Date.now()}] Creating offscreen document`);
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Recording audio for transcription"
      });
      console.log(`[${Date.now()}] Offscreen document created`);
    }

    isRecording = true;
  } catch (e) {
    showErrorNotification(`Failed to start the recorder: ${e.message}`);
    await setBadge("ERR");
    await sendErrorToContentScript(`Error: Failed to start recorder. ${String(e)}`);
    await sendUIStopped();
  } finally {
    creatingOffscreen = false;
  }
}

async function stopOffscreenRecording() {
  console.log(`[${Date.now()}] stopOffscreenRecording called`);
  if (!(await chrome.offscreen.hasDocument())) {
    isRecording = false;
    await stopBadgeAnimation();
    await sendUIStopped();
    return;
  }

  isRecording = false;
  await startBadgeAnimation();
  await sendUIStopped();

  const ok = await new Promise((resolve) => {
    pendingStopResolve = resolve;
    try {
      console.log(`[${Date.now()}] Sending stop-recording message to offscreen`);
      chrome.runtime.sendMessage({ type: "stop-recording" });
    } catch {}
    pendingStopTimer = setTimeout(() => {
      showErrorNotification("Recording timed out. Please try again.");
      pendingStopResolve = null;
      resolve(false);
    }, 10000);
  });

  if (!ok) {
    await stopBadgeAnimation("ERR");
    if (!discardNextResult) {
      await sendErrorToContentScript("Error: Timed out waiting for audio. Please try again.");
    }
    await closeOffscreenSafe();
  }
}

async function closeOffscreenSafe() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      console.log(`[${Date.now()}] Closing offscreen document`);
      await chrome.offscreen.closeDocument();
      console.log(`[${Date.now()}] Offscreen document closed`);
    }
  } catch (e) {
    if (!String(e?.message || "").includes('The offscreen document is not open.')) {
      showErrorNotification(`Could not close the recording document: ${e.message}`);
    }
  }
}

async function setBadge(text) {
  try { await chrome.action.setBadgeText({ text }); } catch {}
}

// ----------------- Transcription call -----------------
async function processAudio(b64) {
  try {
    console.log(`[${Date.now()}] Starting audio processing`);
    const result = await apiPost('/transcribeAudio', { b64 });
    if (result.error) throw new Error(result.error);
    const transcription = result.transcription;
    await stopBadgeAnimation("");
    await sendTextToContentScript(transcription || "");
    console.log(`[${Date.now()}] Audio processing finished`);
  } catch (error) {
    showErrorNotification(`Transcription failed: ${error.message || 'Please check your internet connection and try again.'}`);
    await stopBadgeAnimation("ERR");
    await sendErrorToContentScript(`Error: Transcription failed. ${error.message || String(error)}`);
  }
}

// ----------------- Messaging to content script -----------------
async function getPasteTargetTabId() {
  let tabId = targetTabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs?.[0]?.id ?? null;
  }
  return tabId;
}

async function sendToTab(tabId, payload) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url || "";
    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return false;
    await chrome.tabs.sendMessage(tabId, payload);
    return true;
  } catch (e) {
    if (e?.message?.includes("Could not establish connection")) return false;
    showErrorNotification(`Could not communicate with the active tab: ${e.message}`);
    return false;
  }
}

async function sendTextToContentScript(text) {
  const tabId = await getPasteTargetTabId();
  if (tabId) await sendToTab(tabId, { text, isError: false });
}
async function sendErrorToContentScript(text) {
  const tabId = await getPasteTargetTabId();
  if (tabId) await sendToTab(tabId, { text, isError: true });
}
async function sendUIStarted(remaining) {
  const tabId = await getPasteTargetTabId();
  if (tabId) await sendToTab(tabId, { type: "ui-recording-started", remainingSeconds: remaining });
}
async function sendUIStopped() {
  const tabId = await getPasteTargetTabId();
  if (tabId) await sendToTab(tabId, { type: "ui-recording-stopped" });
}