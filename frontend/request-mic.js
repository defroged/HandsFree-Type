// request-mic.js

const statusEl = document.getElementById("status");
const devicesEl = document.getElementById("devices");
const grantBtn = document.getElementById("grant");
const testBtn = document.getElementById("test");
const closeBtn = document.getElementById("close");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
  console.log("[request-mic]", text);
}

async function sendPermission(state, error) {
  chrome.runtime.sendMessage({ type: "mic-permission", state, error });
}
async function sendStatus(state, error) {
  chrome.runtime.sendMessage({ type: "mic-permission-status", state, error });
}

async function showDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === "audioinput");
    devicesEl.innerHTML = "<b>Audio inputs:</b><br>" + (inputs.length
      ? inputs.map(d => `• ${d.label || "(no label)"} (${d.deviceId.slice(0,8)}…)`).join("<br>")
      : "• none");
  } catch (e) {
    devicesEl.textContent = "enumerateDevices failed: " + e;
  }
}

async function queryState() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    return p.state;
  } catch {
    return "unknown";
  }
}

function logTrack(track) {
  if (!track) return "no track";
  return `readyState=${track.readyState}, enabled=${track.enabled}, muted=${track.muted}`;
}

async function requestMic() {
  try {
    const before = await queryState();
    setStatus(`Permission state before request: ${before}`, before === "granted" ? "ok" : "");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const t = stream.getAudioTracks()[0];
    setStatus(`Microphone granted. Track: ${logTrack(t)}`, "ok");

    // Track events to detect muted sources
    t.onmute = () => setStatus(`Track muted. ${logTrack(t)}`, "warn");
    t.onunmute = () => setStatus(`Track unmuted. ${logTrack(t)}`, "ok");
    t.onended = () => setStatus(`Track ended. ${logTrack(t)}`, "warn");

    stream.getTracks().forEach(tr => tr.stop());
    await showDevices();
    const after = await queryState();
    setStatus(`Current permission state: ${after}`, "ok");

    testBtn.disabled = false;
    closeBtn.disabled = false;
    await sendPermission("granted");
  } catch (e) {
    console.error("[request-mic] getUserMedia error:", e);
    setStatus(`Error requesting microphone: ${e.name || ""} ${e.message || e}`, "err");
    await sendPermission("error", String(e));
  }
}

async function testRecord2s() {
  setStatus("Starting 2s test recording…");
  let chunks = [];
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const track = stream.getAudioTracks()[0];
    console.log("[request-mic] test track:", logTrack(track));
    track.onmute = () => setStatus(`Test: track muted. ${logTrack(track)}`, "warn");
    track.onunmute = () => setStatus(`Test: track unmuted. ${logTrack(track)}`, "ok");

    // ---- Try MediaRecorder first with timeslice to force periodic blobs ----
    let mime = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported?.(mime)) {
      mime = MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : "";
    }
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.start(250); // timeslice -> periodic dataavailable events
    await new Promise(r => setTimeout(r, 2000));
    rec.stop();
    await new Promise(r => rec.onstop = r);

    const webmSize = chunks.reduce((s, b) => s + b.size, 0);
    setStatus(`MediaRecorder finished. Blob size: ${webmSize} bytes.`, webmSize > 0 ? "ok" : "warn");

    // ---- If zero, run WebAudio fallback to see if PCM frames arrive ----
    if (webmSize === 0) {
      setStatus("MediaRecorder produced 0 bytes. Running WebAudio fallback…", "warn");
      const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const src = ac.createMediaStreamSource(stream);
      const processor = ac.createScriptProcessor(4096, 1, 1);

      let samples = 0;
      let sumAbs = 0;

      processor.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        samples += ch.length;
        for (let i = 0; i < ch.length; i++) sumAbs += Math.abs(ch[i]);
      };

      src.connect(processor);
      processor.connect(ac.destination);

      await new Promise(r => setTimeout(r, 2000));

      src.disconnect(); processor.disconnect();
      await ac.close();

      const meanAbs = samples ? (sumAbs / samples) : 0;
      setStatus(`WebAudio test done. Samples: ${samples}, mean|amp|: ${meanAbs.toExponential(3)}`, meanAbs > 1e-5 ? "ok" : "warn");
    }
  } catch (e) {
    console.error("[request-mic] test record error:", e);
    setStatus(`Test record error: ${e.name || ""} ${e.message || e}`, "err");
  } finally {
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
  }
}

async function reportStatusOnly() {
  const state = await queryState();
  await sendStatus(state);
}

(async () => {
  if (location.hash === "#query") {
    await reportStatusOnly();
    return;
  }
  setStatus("Loading…");
  await showDevices();
  const init = await queryState();
  setStatus(`Initial permission state: ${init}`);

  grantBtn.addEventListener("click", requestMic);
  testBtn.addEventListener("click", testRecord2s);
  closeBtn.addEventListener("click", () => window.close());
})();
