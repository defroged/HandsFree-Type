// request-mic.js

const statusEl = document.getElementById("status");
const grantBtn = document.getElementById("grant");
const mainContainer = document.getElementById("main-container");
const successOverlay = document.getElementById("success-overlay");

// Shows an error message in the status div.
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.style.display = 'block'; // Make it visible
  console.warn("[request-mic]", text);
}

// Informs the background script about the permission result.
async function sendPermission(state, error) {
  try {
    await chrome.runtime.sendMessage({ type: "mic-permission", state, error });
  } catch (e) {
    // This can happen if the user closes the tab before the message is sent.
    console.warn("Could not send permission to background script.", e);
  }
}

// Displays a success animation and then closes the tab.
async function showSuccessAndClose() {
    mainContainer.style.opacity = '0';
    successOverlay.style.display = 'flex';
  
    // Let the background script know permission was granted so it can start recording.
    await sendPermission("granted");
  
    // Close this tab after a brief moment.
    setTimeout(() => window.close(), 2000);
}

// Handles the logic for requesting microphone access.
async function requestMic() {
  grantBtn.disabled = true;
  grantBtn.textContent = "Awaiting Permission...";

  try {
    // This is the key line that triggers the browser's native permission prompt.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });

    // We don't need to keep the stream active on this page. Stop the tracks immediately.
    stream.getTracks().forEach(tr => tr.stop());

    // If getUserMedia succeeds, the user has granted permission.
    await showSuccessAndClose();

  } catch (e) {
    console.error("[request-mic] getUserMedia error:", e);
    
    let errorMessage = `Error: ${e.message}`;
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        errorMessage = 'Permission denied. You may need to grant access in your browser or OS settings if you previously blocked it.';
    } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        errorMessage = 'No microphone found. Please ensure a microphone is connected and enabled.';
    }
    
    setStatus(errorMessage);
    await sendPermission("denied", e.message);

    // Re-enable the button so the user can try again.
    grantBtn.disabled = false;
    grantBtn.textContent = "Enable Microphone";
  }
}

// Checks the current permission status.
async function queryState() {
  try {
    // Note: The 'microphone' permission name is still a draft standard in some browsers,
    // but it's the most reliable way for extensions to query this.
    const p = await navigator.permissions.query({ name: "microphone" });
    return p.state;
  } catch (err) {
    console.error("Permission query failed:", err);
    // Fallback if the query API itself fails or isn't supported.
    return "unknown";
  }
}

// Initial setup when the page loads.
(async () => {
  grantBtn.addEventListener("click", requestMic);
  const initialState = await queryState();
  console.log('[request-mic] Initial permission state:', initialState);

  if (initialState === 'granted') {
    // If permission is already granted, we don't need user interaction.
    // Proceed directly to the success flow.
    await showSuccessAndClose();
  } else {
    // If state is 'prompt' or 'denied', the page will wait for the user to click the button.
    // No status message is needed initially for a cleaner look.
  }
})();