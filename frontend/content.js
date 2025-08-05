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

function showTemporaryIndicator(msg) {
  const id = "openai-dictation-indicator";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.style.position = "fixed";
    el.style.right = "20px";
    el.style.bottom = "20px";
    el.style.background = "#b30000";
    el.style.color = "#fff";
    el.style.padding = "10px 14px";
    el.style.fontFamily = "system-ui, sans-serif";
    el.style.fontSize = "13px";
    el.style.borderRadius = "6px";
    el.style.zIndex = "2147483647";
    el.style.boxShadow = "0 6px 24px rgba(0,0,0,.25)";
    el.style.maxWidth = "300px";
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  // Ensure the countdown timer from a previous recording is stopped
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  // Hide the message after 4 seconds
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = "none"; }, 4000);
}

function showRecordingIndicator(remainingStart = null) {
  const id = "openai-dictation-indicator";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.style.position = "fixed";
    el.style.right = "20px";
    el.style.bottom = "20px";
    el.style.background = "#b30000";
    el.style.color = "#fff";
    el.style.padding = "10px 14px";
    el.style.fontFamily = "system-ui, sans-serif";
    el.style.fontSize = "13px";
    el.style.borderRadius = "6px";
    el.style.zIndex = "2147483647";
    el.style.boxShadow = "0 6px 24px rgba(0,0,0,.25)";
    el.style.maxWidth = "300px";
    document.documentElement.appendChild(el);
  }
  el.style.display = "block";
  clearTimeout(el._t); // Cancel any pending hide timers

  let start = Date.now();

  function render() {
    // --- THIS TEXT IS UPDATED ---
    let txt = "Recording… (Press Alt+Shift+D to stop)";
    if (remainingStart !== null) {
      const left = Math.max(0, remainingStart - (Date.now() - start) / 1000);
      txt = `Recording… (Press Alt+Shift+D to stop) — ${mmss(left)} left this month`;
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
  // New handler for showing an error in the bottom bar
  if (request.type === "ui-show-error-bar") {
    if (request.text) showTemporaryIndicator(request.text);
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

  // Fallback for complex editors (like Google Docs) or when no field is focused.
  try {
    navigator.clipboard.writeText(text);
    showToast(`Text copied. Press Ctrl+V to paste.`);
  } catch (err) {
    console.error('Failed to copy text:', err);
    // If clipboard fails, fall back to the original toast behavior.
    showToast(text);
  }
});