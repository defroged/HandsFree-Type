// request-mic.js

const statusEl = document.getElementById("status");
const grantBtn = document.getElementById("grant");
const mainContainer = document.getElementById("main-container");
const successOverlay = document.getElementById("success-overlay");

// Shows an error message in the status div.
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.style.display = 'block'; // Make it visible
}

// Informs the background script about the permission result.
function sendPermission(state, error) {
  try {
    // We don't need to wait for a response, so we don't use await here.
    chrome.runtime.sendMessage({ type: "mic-permission", state, error });
  } catch (e) {
    // This can happen if the user closes the tab before the message is sent.
    // The user doesn't need to see this error, so we can ignore it.
  }
}

// Displays a success animation and then closes the tab.
async function showSuccessAndClose() {
    mainContainer.style.opacity = '0';
    successOverlay.style.display = 'flex';
  
    // Let the background script know permission was granted so it can start recording.
    // The 'await' is removed here to prevent waiting for a response.
    sendPermission("granted");
  
    // Close this tab after a brief moment.
    setTimeout(() => window.close(), 1500);
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
    let errorMessage = `An unexpected error occurred: ${e.message}.`;
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        errorMessage = 'Microphone permission was denied. To use this extension, please grant access. You may need to do this in your browser\'s settings if you have previously blocked it.';
    } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        errorMessage = 'No microphone was found. Please make sure a microphone is connected and enabled in your system settings.';
    }
    
    setStatus(errorMessage);
    await sendPermission("denied", errorMessage);

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
    setStatus('Could not query microphone permission state. Please try clicking the button.');
    // Fallback if the query API itself fails or isn't supported.
    return "unknown";
  }
}

// Initial setup when the page loads.
document.addEventListener('DOMContentLoaded', async () => {
  grantBtn.addEventListener("click", requestMic);
  const initialState = await queryState();

  if (initialState === 'granted') {
    // If permission is already granted, we don't need user interaction.
    // Proceed directly to the success flow.
    await showSuccessAndClose();
  }
});