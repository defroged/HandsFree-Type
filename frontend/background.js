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

function showInfoNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: title,
    message: message
  });
}

function showErrorNotification(message) {
  showInfoNotification('HandsFree Type Error', message || 'An unexpected error occurred.');
}

// Create a promise that resolves when the first auth state is known
const initializeAuth = () => {
  if (authReadyPromise) return;
  authReadyPromise = new Promise(resolve => {
    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      // Notify popup if it's open
      chrome.runtime.sendMessage({ type: 'auth-state-changed', user: user ? { email: user.email } : null }).catch(() => {});

      // Resolve the promise on the first check to unblock API calls
      resolve();
    }, (error) => {
      showErrorNotification('There was an issue with authentication. Please try signing in again.');
      resolve(); // Resolve even on error to not block forever
    });
  });
};

initializeAuth();

async function silentSignIn() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, async (accessToken) => {
      if (chrome.runtime.lastError || !accessToken) {
        // This is an expected condition (user is not signed in), so no notification is needed.
        resolve(false);
        return;
      }
      try {
        const cred = GoogleAuthProvider.credential(null, accessToken);
        await signInWithCredential(auth, cred);
        resolve(true);
      } catch (e) {
        // Don't show a notification for silent sign-in failures
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

// --- Badge Animation ---
let badgeAnimationTimer = null;

async function startBadgeAnimation() {
  if (badgeAnimationTimer) return;
  let frame = 0;
  const frames = ["·", "··", "···", " ··", "  ·", "   "];
  const animate = () => {
    chrome.action.setBadgeText({ text: frames[frame++ % frames.length] });
  };
  badgeAnimationTimer = setInterval(animate, 200);
  animate(); // run once immediately
}

async function stopBadgeAnimation(finalText = "") {
  if (badgeAnimationTimer) {
    clearInterval(badgeAnimationTimer);
    badgeAnimationTimer = null;
  }
  await setBadge(finalText);
}


chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#CC0000" });
  } catch {}
});

// ---------- Command Listener (New) ----------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-dictation") {
    // If a command is triggered with a specific tab context, use it.
    // This happens if the user is in a specific window when they press the shortcut.
    if (tab?.id) {
      targetTabId = tab.id;
      pendingTargetTabId = tab.id;
    }
    // You already have a perfect function to handle this!
    await toggleRecordingState();
  }
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
    // Transitions from the offscreen recorder
    if (message?.type === "recording-started") {
      recordStartTs = Date.now();
      await setBadge("REC");
      await sendUIStarted(lastKnownRemainingSeconds);
      return;
    }
    if (message?.type === "audio-ready-b64") {
      const b64 = message.b64 || "";
      const size = message.size || 0;

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
        await stopBadgeAnimation("0");
        if (!discardNextResult) {
          await sendErrorToContentScript("Error: No audio was captured.");
        }
        await cleanup();
        return;
      }

      if (discardNextResult) {
        await stopBadgeAnimation("");
        await cleanup();
        return;
      }
      
      // Commit usage first
      try {
        if (recordStartTs) {
          const elapsed = Math.max(0, Math.round((Date.now() - recordStartTs) / 1000));
          await apiPost("/commitUsage", { elapsedSeconds: elapsed });
        }
      } catch (e) {
        showErrorNotification('Could not save your usage data. Please check your connection.');
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
      showErrorNotification(message.error || "An unknown error occurred while recording audio.");
      await stopBadgeAnimation("ERR");
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
        if (pendingStartAfterPermission) {
          pendingStartAfterPermission = false;
          await startOffscreenRecording(pendingTargetTabId || targetTabId);
        }
      } else {
        showErrorNotification('Microphone permission not granted. Please allow microphone access to use dictation.');
        await setBadge("ERR");
        if (!discardNextResult) {
          await sendErrorToContentScript(`Error: Microphone permission not granted. ${message.error || ""}`);
        }
        await sendUIStopped();
      }
      return;
    }
    // "mic-permission-status" handler is removed as it's no longer needed.
  };

  handleMessage()
    .then(response => {
      if (response !== undefined) {
        sendResponse(response);
      }
    })
    .catch(error => {
      showErrorNotification(`An internal error occurred: ${error.message}`);
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
      showErrorNotification('Could not verify your session. Please try signing in again.');
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
    try {
      // Check if user can start before doing anything else
      const { plan, remainingSeconds } = await apiGet('/canStart');
      lastKnownRemainingSeconds = remainingSeconds; // Cache the latest value

      if (remainingSeconds <= 0) {
        const planName = plan === 'pro' ? 'Pro' : 'Free';
        const message = `You've used up all your transcription time for the ${planName} plan this month. You can wait until next month or upgrade now to continue.`;
        
        const tabId = await getPasteTargetTabId();
        if (tabId) {
          await sendToTab(tabId, { type: "ui-show-error-bar", text: message });
        } else {
            // Fallback to a notification if we can't find a tab to show the bar on
            showInfoNotification('Usage Limit Reached', message);
        }
        
        await setBadge("0");
        return;
      }

      const granted = await ensureMicPermission();
      if (!granted) {
        pendingStartAfterPermission = true;
        return;
      }
      await startOffscreenRecording(targetTabId);
    } catch (e) {
      showErrorNotification(`Could not verify usage: ${e.message}`);
      await setBadge("ERR");
    }
  } else {
    await stopOffscreenRecording();
  }
}

async function ensureMicPermission() {
  // Service workers can query permissions directly. No need for a helper tab.
  const p = await navigator.permissions.query({ name: "microphone" });

  if (p.state === "granted") {
    return true;
  }

  // If permission is not granted, open our dedicated page for the user to
  // click the button that will trigger the browser's permission prompt.
  await chrome.tabs.create({
    url: chrome.runtime.getURL("request-mic.html"),
    active: true
  });
  
  // Return false because we need to wait for the user's action.
  // The 'mic-permission: granted' message from request-mic.js will resume the flow.
  return false;
}

async function startOffscreenRecording(tabIdFromCaller) {
  if (creatingOffscreen) {
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
        targetTabId = null;
      }
    }

    if (await chrome.offscreen.hasDocument()) {
      // Document already exists, which is fine.
    } else {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Recording audio for transcription"
      });
    }

    // IMPORTANT: do NOT set "REC" yet; wait for `recording-started` from offscreen.
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
  // Nothing to stop? Just tidy the UI.
  if (!(await chrome.offscreen.hasDocument())) {
    isRecording = false;
    await stopBadgeAnimation();
    await sendUIStopped();
    return;
  }

  // Ask off-screen page to stop; give it up to 10 s.
  isRecording = false;
  await startBadgeAnimation(); // Start animating "..."
  await sendUIStopped(); // Hide the red bar immediately

  const ok = await new Promise((resolve) => {
    pendingStopResolve = resolve;
    try {
      chrome.runtime.sendMessage({ type: "stop-recording" });
    } catch {}
    pendingStopTimer = setTimeout(() => {
      showErrorNotification("Recording timed out. Please try again.");
      pendingStopResolve = null;
      resolve(false);
    }, 10_000);
  });

  if (!ok) {
    await stopBadgeAnimation("ERR"); // Stop animation, show error
    if (!discardNextResult) {
      await sendErrorToContentScript(
        "Error: Timed out waiting for audio. Please try again."
      );
    }
    // sendUIStopped is already called
    await closeOffscreenSafe();
  }
}

async function closeOffscreenSafe() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    if (!e.message.includes('The offscreen document is not open.')) {
        showErrorNotification(`Could not close the recording document: ${e.message}`);
    }
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
    // Call your backend function with the base64 string directly
    const result = await apiPost('/transcribeAudio', { b64 });

    if (result.error) {
      throw new Error(result.error);
    }

    const transcription = result.transcription;
    await stopBadgeAnimation(""); // Should already be blank, but just in case
    await sendTextToContentScript(transcription || "");

  } catch (error) {
    showErrorNotification(`Transcription failed: ${error.message || 'Please check your internet connection and try again.'}`);
    await stopBadgeAnimation("ERR");
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
      // This is expected if the content script is not injected on the page.
      return false;
    }
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