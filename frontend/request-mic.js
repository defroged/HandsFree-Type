// request-mic.js

const statusEl = document.getElementById("status");
const devicesEl = document.getElementById("devices");
const grantBtn = document.getElementById("grant");
const testBtn = document.getElementById("test");
const mainContainer = document.getElementById("main-container");
const successOverlay = document.getElementById("success-overlay");

function setStatus(text, cls) {
  statusEl.textContent = `Status: ${text}`;
  statusEl.className = cls || "";
  console.log("[request-mic]", text);
}

async function sendPermission(state, error) {
  try {
    await chrome.runtime.sendMessage({ type: "mic-permission", state, error });
  } catch (e) {
    console.warn("Could not send permission to background. It might have been closed.", e);
  }
}

async function showSuccessAndClose() {
    // Hide the main content and show the spinner overlay
    mainContainer.style.opacity = '0';
    successOverlay.style.display = 'flex';
  
    // Inform the background script to start recording
    await sendPermission("granted");
  
    // Close this tab after a short delay
    setTimeout(() => window.close(), 1500);
}


async function requestMic() {
  grantBtn.disabled = true;
  setStatus("Awaiting permission. Please click 'Allow' in the browser prompt.", "warn");
  try {
    // This is the line that triggers the browser's permission pop-up
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });

    // We don't need the stream here, so we can stop it immediately.
    stream.getTracks().forEach(tr => tr.stop());

    // If we get here, the user clicked "Allow"
    await showSuccessAndClose();

  } catch (e) {
    console.error("[request-mic] getUserMedia error:", e);
    const state = await queryState();
    let errorMessage = `Error: ${e.message} (state: ${state})`;
    if (e.name === 'NotAllowedError') {
        errorMessage = 'Permission denied. You may need to grant access in your browser settings if you previously blocked it.';
    }
    setStatus(errorMessage, "err");
    await sendPermission("denied", e.message);
    grantBtn.disabled = false; // Re-enable button on failure.
  }
}

// (The rest of the file remains the same, but is included here for completeness)

async function showDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === "audioinput");
    if (inputs.length > 0) {
      devicesEl.innerHTML = "<b>Detected Audio Inputs:</b><br>" +
        inputs.map(d => `• ${d.label || "Default Microphone"} (${d.deviceId.slice(0, 10)}…)`).join("<br>");
      devicesEl.style.display = "block";
    }
  } catch (e) {
    devicesEl.textContent = "Could not list audio devices: " + e.message;
    devicesEl.style.display = "block";
  }
}

async function queryState() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    return p.state;
  } catch (err) {
    console.error("Permission query failed:", err);
    return "unknown";
  }
}

async function testRecord2s() {
  setStatus("Starting 2s test...", "warn");
  testBtn.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const track = stream.getAudioTracks()[0];
    const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = ac.createMediaStreamSource(stream);
    const processor = ac.createScriptProcessor(2048, 1, 1);

    let samples = 0, sumAbs = 0;
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        sumAbs += Math.abs(data[i]);
      }
      samples += data.length;
    };
    source.connect(processor);
    processor.connect(ac.destination);

    await new Promise(r => setTimeout(r, 2000));

    source.disconnect();
    processor.disconnect();
    await ac.close();
    stream.getTracks().forEach(t => t.stop());

    const mean = samples > 0 ? sumAbs / samples : 0;
    const resultText = `Test complete. Average signal level: ${mean.toFixed(4)}.`;
    if (mean > 0.001) {
      setStatus(`${resultText} Looks good!`, "ok");
    } else {
      setStatus(`${resultText} Very low signal. Is the mic muted or unplugged?`, "warn");
    }
  } catch (e) {
    console.error("[request-mic] Test recording error:", e);
    setStatus(`Test failed: ${e.message}`, "err");
  } finally {
    stream?.getTracks().forEach(t => t.stop());
    testBtn.disabled = false;
  }
}

(async () => {
  grantBtn.addEventListener("click", requestMic);
  testBtn.addEventListener("click", testRecord2s);
  const initialState = await queryState();

  if (initialState === 'granted') {
    // Permission is already granted, so show the success overlay immediately.
    await showSuccessAndClose();
  } else {
    // Wait for the user to click the button.
    setStatus(`Permission state: ${initialState}. Please click the button above.`, "warn");
    testBtn.disabled = false; // Allow testing even if permission is just "prompt"
  }
})();