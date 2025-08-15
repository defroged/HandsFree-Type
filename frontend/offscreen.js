// offscreen.js

let recorder;
let audioChunks = [];
let stopped = false;
let streamRef;

function stopAndFlush() {
  if (stopped) return;
  console.log(`[${Date.now()}] stopAndFlush called`);
  stopped = true;
  try {
    if (recorder && recorder.state === "recording") recorder.stop();
  } catch (e) {
    console.warn("[offscreen] recorder.stop() threw:", e);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stop-recording") {
    console.log("[offscreen] received stop-recording");
    stopAndFlush();
  }
});

(async function startRecording() {
  console.log(`[${Date.now()}] offscreen.js: startRecording`);
  if (recorder?.state === "recording") {
    console.warn("[offscreen] Already recording.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    streamRef = stream;

    const track = stream.getAudioTracks()[0];
    console.log("[offscreen] track state",
      "readyState=", track?.readyState,
      "enabled=", track?.enabled,
      "muted=", track?.muted);
    track.onmute = () => console.warn("[offscreen] track muted");
    track.onunmute = () => console.log("[offscreen] track unmuted");
    track.onended = () => console.warn("[offscreen] track ended");

    let mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported?.(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : "";
    }
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    recorder.onstop = async () => {
      const stopTime = Date.now();
      console.log(`[${stopTime}] recorder.onstop called`);
      const cleanup = () => {
        try { streamRef?.getTracks().forEach(t => t.stop()); } catch {}
        recorder = null;
        streamRef = null;
        audioChunks = [];
      };

      try {
        if (audioChunks.length === 0) {
          console.warn('[offscreen] onstop called with no audio chunks.');
          chrome.runtime.sendMessage({ type: "audio-ready-b64", size: 0, b64: "", mime: "audio/webm" });
          return;
        }

        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        
        // Use the built-in FileReader to efficiently convert the blob to a Base64 data URL
        const b64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            // The result is a data URL like "data:audio/webm;base64,ENCODED_DATA"
            // We only need the part after the comma
            const dataUrl = reader.result;
            resolve(dataUrl.split(',')[1]);
          };
          reader.onerror = (e) => reject(new Error("FileReader failed: " + e));
          reader.readAsDataURL(audioBlob);
        });

        console.log(`[${Date.now()}] onstop, blob size: ${audioBlob.size}, b64 len: ${b64.length}, processing took ${Date.now() - stopTime}ms`);
        
        chrome.runtime.sendMessage({
          type: "audio-ready-b64",
          size: audioBlob.size,
          b64: b64,
          mime: "audio/webm"
        });

      } catch (e) {
        console.error("[offscreen] Failed to process and send blob:", e);
        chrome.runtime.sendMessage({ type: "audio-error", error: String(e) });
      } finally {
        cleanup();
      }
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        console.log("[offscreen] visibility hidden -> stopping recorder.");
        stopAndFlush();
      }
    });
    window.addEventListener("pagehide", stopAndFlush);
    window.addEventListener("beforeunload", stopAndFlush);

    audioChunks = [];
    recorder.start(250); // periodic chunks
    console.log(`[${Date.now()}] Recording started. mimeType: ${mimeType || "(default)"}`);
    chrome.runtime.sendMessage({ type: "recording-started" });
  } catch (error) {
    console.error("[offscreen] getUserMedia failed:", error);
    chrome.runtime.sendMessage({ type: "mic-permission", state: "error", error: String(error) });
  }
})();