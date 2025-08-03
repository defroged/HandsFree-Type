// background.js

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  onAuthStateChanged,
  signOut
} from 'firebase/auth';

const firebaseConfig = {
  apiKey    : 'AIzaSyA653jxrh7r4JS2TSQUAtPF-NcaLdtAqxc',
  authDomain: 'handsfreetype.firebaseapp.com',
  projectId : 'handsfreetype'
};

initializeApp(firebaseConfig);
const auth = getAuth();

// --- Centralized Auth State ---
let currentUser = null;
let authReadyPromise = null;

// Create a promise that resolves when the first auth state is known
const initializeAuth = () => {
  if (authReadyPromise) return;
  authReadyPromise = new Promise(resolve => {
    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      if (user) {
        console.log('[bg] Auth state changed: Logged in as', user.email);
      } else {
        console.log('[bg] Auth state changed: Logged out.');
      }
      // Notify popup if it's open
      chrome.runtime.sendMessage({ type: 'auth-state-changed', user: user ? { email: user.email } : null }).catch(() => {});

      // Resolve the promise on the first check to unblock API calls
      resolve();
    }, (error) => {
      console.error('[bg] onAuthStateChanged error:', error);
      resolve(); // Resolve even on error to not block forever
    });
  });
};

initializeAuth();

async function silentSignIn() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, async (accessToken) => {
      if (chrome.runtime.lastError || !accessToken) {
        console.warn('[bg] Silent sign-in failed:', chrome.runtime.lastError?.message);
        resolve(false);
        return;
      }
      try {
        const cred = GoogleAuthProvider.credential(null, accessToken);
        await signInWithCredential(auth, cred);
        resolve(true);
      } catch (e) {
        console.error('[bg] silent signInWithCredential failed', e);
        resolve(false);
      }
    });
  });
}

// Attempt silent sign-in on service worker startup
silentSignIn();

// --- HandsFree billing ---
const API_BASE = "https://asia-northeast1-handsfreetype.cloudfunctions.net";
let lastKnownRemainingSeconds = null;
let recordStartTs = null;

let isRecording = false;
let creatingOffscreen = false;

// The tab that asked us to start (where we should paste the result)
let targetTabId = null;

// If start requested but mic permission not granted yet, remember it:
let pendingStartAfterPermission = false;
let pendingTargetTabId = null;

// If the user held Ctrl/Meta but then used a combo (e.g., Ctrl+C), don’t paste:
let discardNextResult = false;

// For stop synchronization with offscreen
let pendingStopResolve = null;
let pendingStopTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#CC0000" });
  } catch {}
});

// ---------- Messaging ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleMessage = async () => {
    // --- Auth and API handlers for the popup ---
    if (message.type === 'get-auth-state') {
      return { user: currentUser ? { email: currentUser.email } : null };
    }
    if (message.type === 'trigger-signin') {
      return new Promise(resolve => {
        chrome.identity.getAuthToken({ interactive: true }, async (accessToken) => {
          if (chrome.runtime.lastError || !accessToken) {
            resolve({ success: false, error: chrome.runtime.lastError?.message || 'Token not found.' });
            return;
          }
          try {
            const cred = GoogleAuthProvider.credential(null, accessToken);
            await signInWithCredential(auth, cred);
            resolve({ success: true });
          } catch (e) {
            resolve({ success: false, error: e.message });
          }
        });
      });
    }
    if (message.type === 'trigger-signout') {
      await signOut(auth);
      return { success: true };
    }
    if (message.type === 'api-get') {
      return await apiGet(message.path);
    }
    if (message.type === 'api-post') {
      return await apiPost(message.path, message.body);
    }

    // --- Original message handlers ---
    // From content.js — start recording on Ctrl/Meta down
    if (message?.type === "start-hold-recording") {
      const fromTabId = sender?.tab?.id ?? null;
      if (fromTabId) {
        targetTabId = fromTabId;
        pendingTargetTabId = fromTabId;
      }
      if (isRecording) return;
      const granted = await ensureMicPermission();
      if (!granted) {
        pendingStartAfterPermission = true;
        await setBadge("PERM");
        return;
      }
      try {
        const q = await apiGet("/canStart");
        lastKnownRemainingSeconds = q.plan === "pro" ? null : q.remainingSeconds;
        if (lastKnownRemainingSeconds !== null && lastKnownRemainingSeconds <= 0) {
          await sendErrorToContentScript("Free plan limit reached (10 min/mo). Click the extension icon to upgrade.");
          return;
        }
      } catch (e) {
        console.warn("Quota check failed", e);
      }
      await startOffscreenRecording(pendingTargetTabId || targetTabId);
      return;
    }
    // From content.js — stop on Ctrl/Meta up (with optional discard)
    if (message?.type === "stop-hold-recording") {
      discardNextResult = !!message.discard;
      if (!isRecording && !(await chrome.offscreen.hasDocument())) {
        pendingStartAfterPermission = false;
        discardNextResult = false;
        await setBadge("");
        await sendUIStopped();
        return;
      }
      await stopOffscreenRecording();
      return;
    }
    // Transitions from the offscreen recorder
    if (message?.type === "recording-started") {
      console.log("[bg] recording-started");
      recordStartTs = Date.now();
      await setBadge("REC");
      await sendUIStarted(lastKnownRemainingSeconds);
      return;
    }
    if (message?.type === "audio-ready-b64") {
      const b64 = message.b64 || "";
      const size = message.size || 0;
      console.log("[bg] audio-ready-b64 received, size:", size);

      // Fulfill the promise for stopOffscreenRecording
      if (pendingStopResolve) {
        clearTimeout(pendingStopTimer);
        pendingStopResolve(true);               // ✅ we succeeded
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
        console.warn("[bg] Empty/invalid audio data.");
        await setBadge("0");
        if (!discardNextResult) {
          await sendErrorToContentScript("Error: No audio was captured.");
        }
        await cleanup();
        return;
      }

      if (discardNextResult) {
        console.log("[bg] Discarding audio due to key combo.");
        await setBadge("");
        await cleanup();
        return;
      }

      await setBadge(""); // Clear "..." badge

      // Commit usage first
      try {
        if (recordStartTs) {
          const elapsed = Math.max(0, Math.round((Date.now() - recordStartTs) / 1000));
          await apiPost("/commitUsage", { elapsedSeconds: elapsed });
        }
      } catch (e) {
        console.warn("commitUsage failed", e);
      } finally {
        recordStartTs = null;
        lastKnownRemainingSeconds = null;
      }

      // Process the audio, then clean up
      await processAudio(b64);
      await cleanup();
      return;
    }
	
    if (message?.type === "audio-error") {
      console.error("[bg] audio-error:", message.error);
      await setBadge("ERR");
      if (!discardNextResult) {
        await sendErrorToContentScript(`Error: ${message.error || "Audio pipeline error."}`);
      }
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
    // Permission reporting from request-mic.html
    if (message?.type === "mic-permission") {
      if (message.state === "granted") {
        console.log("[bg] Mic permission granted.");
        if (pendingStartAfterPermission) {
          pendingStartAfterPermission = false;
          await startOffscreenRecording(pendingTargetTabId || targetTabId);
        }
      } else {
        console.warn("[bg] Mic permission not granted:", message.error || message.state);
        await setBadge("ERR");
        if (!discardNextResult) {
          await sendErrorToContentScript(`Error: Microphone permission not granted. ${message.error || ""}`);
        }
        await sendUIStopped();
      }
      return;
    }
    if (message?.type === "mic-permission-status") {
      console.log("[bg] mic-permission-status:", message.state);
      return;
    }
  };

  handleMessage()
    .then(response => {
      if (response !== undefined) {
        sendResponse(response);
      }
    })
    .catch(error => {
      console.error("[bg] Message handler error:", error);
      sendResponse({ error: error.message });
    });

  // Return true to indicate you wish to send a response asynchronously
  return true;
});

async function getAuthToken() {
  if (auth.currentUser) {
    try {
      return await auth.currentUser.getIdToken();
    } catch (e) {
      console.error('[bg] Error getting ID token', e);
      return null;
    }
  }
  return null;
}

async function apiGet(path) {
  await authReadyPromise; // Wait for the initial auth check to complete
  const tok = await getAuthToken();
  const h = tok ? { Authorization: `Bearer ${tok}` } : {};
  const r = await fetch(`${API_BASE}${path}`, { headers: h });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
  return r.json();
}

async function apiPost(path, body = {}) {
  await authReadyPromise;
  const tok = await getAuthToken();
  const h = { "Content-Type": "application/json",
              ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
  const r  = await fetch(`${API_BASE}${path}`, {
               method: "POST", headers: h, body: JSON.stringify(body) });
  const txt = await r.text();          // read body *once*

  if (!r.ok) {
    let msg = txt;
    try { msg = JSON.parse(txt).error || msg; } catch {}
    throw new Error(`POST ${path} ${r.status}: ${msg}`);
  }
  return JSON.parse(txt);
}


// ---------- Start/Stop control ----------

async function toggleRecordingState() {
  if (!isRecording) {
    const granted = await ensureMicPermission();
    if (!granted) {
      pendingStartAfterPermission = true;
      return;
    }
    await startOffscreenRecording(targetTabId);
  } else {
    await stopOffscreenRecording();
  }
}

async function ensureMicPermission() {
  const state = await queryMicPermissionInTab();
  console.log("[bg] mic permission probe:", state);
  if (state === "granted") return true;

  await chrome.tabs.create({
    url: chrome.runtime.getURL("request-mic.html"),
    active: true
  });
  return false; // we'll resume when "mic-permission: granted" arrives
}

async function queryMicPermissionInTab() {
  const url = chrome.runtime.getURL("request-mic.html#query");
  const tab = await chrome.tabs.create({ url, active: false });

  return await new Promise((resolve) => {
    let settled = false;
    const timeoutMs = 8000;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      console.warn("[bg] mic-permission-status timed out.");
      try { await chrome.tabs.remove(tab.id); } catch {}
      resolve("unknown");
    }, timeoutMs);

    const listener = async (message, sender) => {
      if (sender.tab?.id !== tab.id) return;
      if (message?.type === "mic-permission-status") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        try { await chrome.tabs.remove(tab.id); } catch {}
        resolve(message.state || "unknown");
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function startOffscreenRecording(tabIdFromCaller) {
  if (creatingOffscreen) {
    console.log("[bg] startOffscreenRecording: already creating, skip.");
    return;
  }
  creatingOffscreen = true;
  try {
    // Prefer the tab that asked us to start; fall back to current active tab
    if (tabIdFromCaller) {
      targetTabId = tabIdFromCaller;
    } else {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = tabs?.[0]?.id ?? null;
      } catch (e) {
        console.warn("[bg] failed to get active tab:", e);
        targetTabId = null;
      }
    }
    console.log("[bg] targetTabId set to:", targetTabId);

    if (await chrome.offscreen.hasDocument()) {
      console.log("[bg] Offscreen already exists.");
    } else {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Recording audio for transcription"
      });
      console.log("[bg] Offscreen document created.");
    }

    // IMPORTANT: do NOT set "REC" yet; wait for `recording-started` from offscreen.
    isRecording = true;
  } catch (e) {
    console.error("[bg] Failed to create offscreen document:", e);
    await setBadge("ERR");
    await sendErrorToContentScript(`Error: Failed to start recorder. ${String(e)}`);
    await sendUIStopped();
  } finally {
    creatingOffscreen = false;
  }
}

async function stopOffscreenRecording() {
  // Nothing to stop?  Just tidy the UI.
  if (!(await chrome.offscreen.hasDocument())) {
    isRecording = false;
    await setBadge("");
    await sendUIStopped();
    return;
  }

  // Ask off-screen page to stop; give it up to 10 s.
  isRecording = false;
  await setBadge("…");        // “stopping”

  const ok = await new Promise((resolve) => {
    pendingStopResolve = resolve;
    try { chrome.runtime.sendMessage({ type: "stop-recording" }); } catch {}
    pendingStopTimer = setTimeout(() => {
      console.warn("[bg] Timed out waiting for audio-ready after stop.");
      pendingStopResolve = null;
      resolve(false);
    }, 10_000);
  });

  if (!ok) {
    await setBadge("ERR");
    if (!discardNextResult) {
      await sendErrorToContentScript("Error: Timed out waiting for audio. Please try again.");
    }
    await sendUIStopped();
    await closeOffscreenSafe();
  }
}

async function closeOffscreenSafe() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
      console.log("[bg] Offscreen document closed.");
    }
  } catch (e) {
    console.warn("[bg] closeOffscreenSafe error:", e);
  }
}

async function setBadge(text) {
  try {
    await chrome.action.setBadgeText({ text });
  } catch {}
}

// ---------- OpenAI ----------

async function processAudio(b64) {
  try {
    console.log('[bg] Sending audio to secure backend for transcription...');
    
    // Call your backend function with the base64 string directly
    const result = await apiPost('/transcribeAudio', { b64 });

    if (result.error) {
      throw new Error(result.error);
    }

    const transcription = result.transcription;
    await setBadge(""); // Should already be blank, but just in case
    await sendTextToContentScript(transcription || "");

  } catch (error) {
    console.error("[bg] Transcription failed:", error);
    await setBadge("ERR");
    await sendErrorToContentScript(`Error: Transcription failed. ${error.message || String(error)}`);
    // No need to re-throw, error is handled here.
  }
}

// ---------- Messaging to content script ----------

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
    if (e?.message?.includes("Could not establish connection")) {
      console.debug("[bg] No content script in tab", tabId);
      return false;
    }
    console.warn("[bg] sendMessage error:", e);
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
