/* ------------------------------------------------------------------
 * HandsFree Type - Cloud Functions (MV3-friendly auth)
 * Auth now verifies a Google OAuth2 access token (from chrome.identity)
 * and identifies users by Google "sub". No Firebase JS on the client.
 *-----------------------------------------------------------------*/
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest }        = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
setGlobalOptions({ region: "asia-northeast1" });

// --- Lazy inits ---
let dbInstance, stripeInstance, stripeWebhookSecretValue;
const getDb = () => (dbInstance ||= admin.firestore());
const getStripe = () => (stripeInstance ||= new Stripe(process.env.STRIPE_SECRET, { apiVersion: "2024-06-20" }));
const getStripeWebhookSecret = () => (stripeWebhookSecretValue ||= process.env.STRIPE_WEBHOOK_SECRET);

// --- Helpers ---
const ymKey = (date = new Date()) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
};

// Verify Google access token (from chrome.identity.getAuthToken)
// Returns { uid: sub, email, userinfo }
const verifyGoogleAccessToken = async (req) => {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("No Authorization header.");
  const token = m[1];

  const resp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Invalid Google token (${resp.status}) ${txt}`);
  }
  const info = await resp.json();
  const uid = info.sub;           // stable Google subject
  const email = info.email || null;
  return { uid, email, userinfo: info };
};

/* -------------------- QUOTA: canStart --------------------------- */
exports.canStart = onRequest(async (req, res) => {
  const db = getDb();
  if (req.method !== "GET") return res.status(405).end();
  try {
    const { uid, email } = await verifyGoogleAccessToken(req);

    // Dev override
    if (email === "defroged@gmail.com") {
      return res.json({ plan: "pro", remainingSeconds: 9_999_999 });
    }

    const userDoc = await db.doc(`users/${uid}`).get();
    const user = userDoc.exists ? userDoc.data() : {};
    const plan = user.plan === "pro" ? "pro" : "free";

    const yyyyMM = ymKey();
    const usageRef = db.doc(`usage/${uid}/months/${yyyyMM}`);
    const snap = await usageRef.get();
    const used = snap.exists ? snap.data().secondsUsed || 0 : 0;

    const FREE_CAP_SECONDS = 10 * 60;
    const PRO_CAP_SECONDS  = 2 * 60 * 60;
    const cap = plan === "pro" ? PRO_CAP_SECONDS : FREE_CAP_SECONDS;
    const remainingSeconds = Math.max(0, cap - used);

    res.json({ plan, remainingSeconds, email });
  } catch (e) {
    console.error("canStart error:", e);
    res.status(401).json({ error: e.message || "Unauthorized" });
  }
});

/* -------------------- QUOTA: commitUsage ------------------------ */
exports.commitUsage = onRequest(async (req, res) => {
  const db = getDb();
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { uid } = await verifyGoogleAccessToken(req);
    const elapsedSec = Math.max(0, Math.floor(req.body?.elapsedSeconds || 0));
    const yyyyMM = ymKey();
    const usageRef = db.doc(`usage/${uid}/months/${yyyyMM}`);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(usageRef);
      const prev = doc.exists ? doc.data().secondsUsed || 0 : 0;
      tx.set(usageRef, {
        secondsUsed: prev + elapsedSec,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("commitUsage error:", e);
    res.status(401).json({ error: e.message || "Unauthorized" });
  }
});

/* -------------------- BILLING: createCheckout ------------------- */
exports.createCheckout = onRequest({ secrets: ["STRIPE_SECRET", "STRIPE_PRICE_ID"] }, async (req, res) => {
  const db = getDb();
  const stripe = getStripe();
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { uid } = await verifyGoogleAccessToken(req);
    const usersRef = db.doc(`users/${uid}`);
    const user = (await usersRef.get()).data() || {};
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const cust = await stripe.customers.create({ metadata: { app_uid: uid } });
      customerId = cust.id;
      await usersRef.set({ stripeCustomerId: customerId }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: req.body?.successUrl,
      cancel_url: req.body?.cancelUrl,
      metadata: { app_uid: uid }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("createCheckout error:", e);
    res.status(400).json({ error: e.message });
  }
});

/* -------------------- BILLING: createPortal --------------------- */
exports.createPortal = onRequest({ secrets: ["STRIPE_SECRET"] }, async (req, res) => {
  const db = getDb();
  const stripe = getStripe();
  if (req.method !== "POST") return res.status(405).end();
  try {
    const { uid } = await verifyGoogleAccessToken(req);
    const user = (await db.doc(`users/${uid}`).get()).data() || {};
    if (!user.stripeCustomerId) throw new Error("No Stripe customer.");
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: req.body?.returnUrl,
    });
    res.json({ url: portal.url });
  } catch (e) {
    console.error("createPortal error:", e);
    res.status(400).json({ error: e.message });
  }
});

/* -------------------- Stripe Webhook ---------------------------- */
exports.stripeWebhook = onRequest({ secrets: ["STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET"] }, async (req, res) => {
  const db = getDb();
  const stripe = getStripe();
  const webhookSecret = getStripeWebhookSecret();
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verify failed:", err);
    return res.status(400).send(`Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const sess = event.data.object;

        // Prefer metadata if present
        const uid = (sess.metadata && (sess.metadata.app_uid || sess.metadata.firebase_uid)) || null;
        if (uid && sess.customer) {
          await db.doc(`users/${uid}`).set({
            stripeCustomerId: sess.customer,
            plan: "pro"
          }, { merge: true });
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object;
        const plan = sub.status === "active" ? "pro" : "free";
        const snap = await db.collection("users").where("stripeCustomerId", "==", sub.customer).limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.set({ plan }, { merge: true });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const snap = await db.collection("users").where("stripeCustomerId", "==", sub.customer).limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.set({ plan: "free" }, { merge: true });
        break;
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error("stripeWebhook error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------- Audio Transcription ----------------------- */
exports.transcribeAudio = onRequest({ secrets: ["OPENAI_API_KEY"] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).send("");
  }

  try {
    await verifyGoogleAccessToken(req); // ensure request is from a signed-in user
  } catch {
    return res.status(401).json({ error: "Unauthorized request." });
  }

  const b64 = req.body?.b64;
  if (!b64) return res.status(400).json({ error: "Missing 'b64' audio data." });
  const audioBuffer = Buffer.from(b64, "base64");

  try {
    const form = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: "audio/webm" });
    form.append("file", audioBlob, "audio.webm");
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("response_format", "json");

    const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers,
      body: form,
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      console.error("OpenAI error:", data);
      return res.status(openaiRes.status).json({ error: data.error?.message || "OpenAI request failed." });
    }
    return res.json({ transcription: data.text });
  } catch (err) {
    console.error("Transcription function error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});
