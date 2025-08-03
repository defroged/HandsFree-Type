// content.js

// ---- UI helpers ----
function showToast(msg) {
  const id = "openai-dictation-toast";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.style.position = "fixed";
    el.style.zIndex = "2147483647";
    el.style.left = "50%";
    el.style.top = "20px";
    el.style.transform = "translateX(-50%)";
    el.style.padding = "10px 14px";
    el.style.borderRadius = "6px";
    el.style.background = "#222";
    el.style.color = "#fff";
    el.style.fontFamily = "system-ui, sans-serif";
    el.style.fontSize = "13px";
    el.style.boxShadow = "0 6px 24px rgba(0,0,0,.25)";
    el.style.maxWidth = "90vw";
    el.style.wordBreak = "break-word";
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = "none"; }, 4000);
}

let countdownTimer = null;

function mmss(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ":" + (sec % 60).toString().padStart(2, "0");
}

function showRecordingIndicator(remainingStart = null) {
  const id = "openai-dictation-indicator";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.style.position = "fixed";
    el.style.left = "0";
    el.style.right = "0";
    el.style.bottom = "0";
    el.style.background = "#b30000";
    el.style.color = "#fff";
    el.style.padding = "10px 14px";
    el.style.fontFamily = "system-ui, sans-serif";
    el.style.fontSize = "13px";
    el.style.display = "flex";
    el.style.justifyContent = "center";
    el.style.alignItems = "center";
    el.style.zIndex = "2147483647";
    el.style.boxShadow = "0 -4px 16px rgba(0,0,0,.25)";
    document.documentElement.appendChild(el);
  }
  el.style.display = "flex";

  let start = Date.now();

  function render() {
    let txt = "Recording… (hold Ctrl / ⌘)";
    if (remainingStart !== null) {
      const left = Math.max(0, remainingStart - (Date.now() - start) / 1000);
      txt = `Recording… (hold Ctrl / ⌘) — ${mmss(left)} left this month`;
    }
    el.textContent = txt;
  }
  render();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(render, 500);
}

function hideRecordingIndicator() {
  const el = document.getElementById("openai-dictation-indicator");
  if (el) el.style.display = "none";
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// ---- Paste / UI messages from background ----
chrome.runtime.onMessage.addListener((request) => {
  if (!request) return;

  // UI start/stop signals
  if (request.type === "ui-recording-started") {
  showRecordingIndicator(request.remainingSeconds ?? null);
  return;
}
  if (request.type === "ui-recording-stopped") {
    hideRecordingIndicator();
    return;
  }

  // Errors must always be shown as toast, never inserted.
  if (request.isError) {
    if (request.text) showToast(request.text);
    hideRecordingIndicator();
    return;
  }

  const text = request.text;
  if (!text) return;

  const activeElement = document.activeElement;

  // Input / textarea
  if (activeElement && (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")) {
    const start = activeElement.selectionStart ?? (activeElement.value?.length ?? 0);
    const end = activeElement.selectionEnd ?? start;
    const originalText = activeElement.value ?? "";
    const newText = originalText.slice(0, start) + text + originalText.slice(end);
    activeElement.value = newText;
    const caret = start + text.length;
    try { activeElement.selectionStart = activeElement.selectionEnd = caret; } catch {}
    activeElement.dispatchEvent(new Event("input", { bubbles: true }));
    activeElement.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // contentEditable
  if (activeElement && activeElement.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      activeElement.appendChild(document.createTextNode(text));
    } else {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    activeElement.dispatchEvent(new Event("input", { bubbles: true }));
    activeElement.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // No editable focused: show toast so the user notices
  showToast(text);
});

// ---- Press-and-hold Ctrl / ⌘ logic ----
let ctrlHeld = false;
let metaHeld = false; // ⌘ on macOS
let recordingRequested = false;
let comboWhileHeld = false;

function anyModifierHeld() {
  return ctrlHeld || metaHeld;
}

function startIfNeeded() {
  if (recordingRequested) return;
  recordingRequested = true;
  // NOTE: We do NOT show the indicator here anymore. We wait for ui-recording-started.
  chrome.runtime.sendMessage({ type: "start-hold-recording" });
}

function stopIfNeeded() {
  if (!recordingRequested) return;
  recordingRequested = false;
  chrome.runtime.sendMessage({ type: "stop-hold-recording", discard: comboWhileHeld });
  // Background will send ui-recording-stopped; hide just in case.
  hideRecordingIndicator();
  comboWhileHeld = false;
}

document.addEventListener("keydown", (e) => {
  // Start when Ctrl or Meta alone is pressed (no repeat)
  if (!e.repeat && (e.key === "Control" || e.key === "Meta")) {
    if (e.key === "Control") ctrlHeld = true;
    if (e.key === "Meta") metaHeld = true;

    if (anyModifierHeld()) {
      comboWhileHeld = false;
      startIfNeeded();
    }
    return;
  }

  // Any other key while a modifier is down marks this as a combo -> discard on release
  if (anyModifierHeld() && e.key !== "Control" && e.key !== "Meta") {
    comboWhileHeld = true;
  }
}, true);

document.addEventListener("keyup", (e) => {
  if (e.key === "Control") ctrlHeld = false;
  if (e.key === "Meta") metaHeld = false;

  // Stop when neither modifier is still held
  if (!anyModifierHeld()) {
    stopIfNeeded();
  }
}, true);

// Safety: if the tab loses focus or becomes hidden, stop any ongoing recording request.
window.addEventListener("blur", () => {
  if (anyModifierHeld() || recordingRequested) {
    ctrlHeld = false;
    metaHeld = false;
    stopIfNeeded();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (anyModifierHeld() || recordingRequested) {
      ctrlHeld = false;
      metaHeld = false;
      stopIfNeeded();
    }
  }
});
