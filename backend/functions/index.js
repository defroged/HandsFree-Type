// index.js

/* ------------------------------------------------------------------
 * HandsFree Type - Cloud Functions (CommonJS Version)
 *-----------------------------------------------------------------*/
// Use v2 everywhere so the region option is honoured.
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest }        = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const Stripe = require("stripe");
// No longer need the third-party 'form-data' library
// const FormData = require("form-data"); 

// --- Initialization ---
admin.initializeApp();

// --- Set the region for ALL functions in this file ---
setGlobalOptions({ region: "asia-northeast1" });

// --- LAZY-INITIALIZED SERVICE GETTERS ---
let dbInstance;
let stripeInstance;
let stripeWebhookSecretValue;

const getDb = () => {
    if (!dbInstance) {
        dbInstance = admin.firestore();
    }
    return dbInstance;
};

const getStripe = () => {
    if (!stripeInstance) {
        stripeInstance = new Stripe(process.env.STRIPE_SECRET, { apiVersion: "2024-06-20" });
    }
    return stripeInstance;
};

const getStripeWebhookSecret = () => {
    if (!stripeWebhookSecretValue) {
        stripeWebhookSecretValue = process.env.STRIPE_WEBHOOK_SECRET;
    }
    return stripeWebhookSecretValue;
};

/* ---------- Helpers ----------------------------------- */
const ymKey = (date = new Date()) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
};

const verifyIdToken = async (req) => {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("No Authorization header.");
  const decoded = await admin.auth().verifyIdToken(m[1]);
  return decoded.uid;
};

/* ---------- QUOTA: canStart ------------------------------------ */
exports.canStart = onRequest({ region: "asia-northeast1" }, async (req, res) => {
  const db = getDb();
  if (req.method !== "GET") return res.status(405).end();
  try {
    const uid = await verifyIdToken(req);
    const user = (await db.doc(`users/${uid}`).get()).data() || {};
    const plan = user.plan === "pro" ? "pro" : "free";
    const yyyyMM = ymKey();
    const usageRef = db.doc(`usage/${uid}/months/${yyyyMM}`);
    const snap = await usageRef.get();
    const used = snap.exists ? snap.data().secondsUsed || 0 : 0;
    const FREE_CAP_SECONDS = 10 * 60;
    const remainingSeconds = plan === "pro" ?
      Number.MAX_SAFE_INTEGER :
      Math.max(0, FREE_CAP_SECONDS - used);
    res.json({ plan, remainingSeconds });
  } catch (e) {
    console.error("canStart error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- QUOTA: commitUsage --------------------------------- */
exports.commitUsage = onRequest({ region: "asia-northeast1" }, async (req, res) => {
  const db = getDb();
  if (req.method !== "POST") return res.status(405).end();
  try {
    const uid = await verifyIdToken(req);
    const elapsedSec = Math.max(0, Math.floor(req.body?.elapsedSeconds || 0));
    const user = (await db.doc(`users/${uid}`).get()).data() || {};
    const plan = user.plan === "pro" ? "pro" : "free";
    if (plan === "pro") return res.json({ ok: true });
    const yyyyMM = ymKey();
    const usageRef = db.doc(`usage/${uid}/months/${yyyyMM}`);
    const FREE_CAP_SECONDS = 10 * 60;
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(usageRef);
      const prev = doc.exists ? doc.data().secondsUsed || 0 : 0;
      tx.set(usageRef, {
        secondsUsed: Math.min(FREE_CAP_SECONDS, prev + elapsedSec),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("commitUsage error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- BILLING: createCheckout ---------------------------- */
exports.createCheckout = onRequest({ region: "asia-northeast1", secrets: ["STRIPE_SECRET", "STRIPE_PRICE_ID"] }, async (req, res) => {
  const db = getDb();
  const stripe = getStripe();
  if (req.method !== "POST") return res.status(405).end();
  try {
    const uid = await verifyIdToken(req);
    const usersRef = db.doc(`users/${uid}`);
    const user = (await usersRef.get()).data() || {};
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const cust = await stripe.customers.create({ metadata: { firebase_uid: uid } });
      customerId = cust.id;
      await usersRef.set({ stripeCustomerId: customerId }, { merge: true });
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: req.body?.successUrl,
      cancel_url: req.body?.cancelUrl
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("createCheckout error:", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---------- BILLING: createPortal ------------------------------ */
exports.createPortal = onRequest({ region: "asia-northeast1", secrets: ["STRIPE_SECRET"] }, async (req, res) => {
  const db = getDb();
  const stripe = getStripe();
  if (req.method !== "POST") return res.status(405).end();
  try {
    const uid = await verifyIdToken(req);
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

/* ---------- Stripe Webhook ------------------------------------ */
exports.stripeWebhook = onRequest({ region: "asia-northeast1", secrets: ["STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET"] }, async (req, res) => {
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
          const uid = sess.metadata?.firebase_uid;
          if (uid) {
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

/* ---------- Audio Transcription ------------------------------ */
exports.transcribeAudio = onRequest(
  { region: "asia-northeast1", secrets: ["OPENAI_API_KEY"] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).send("");
    }

    // ⬇️  1)  Auth check
    try {
      await verifyIdToken(req);
    } catch {
      return res.status(401).json({ error: "Unauthorized request." });
    }

    // ⬇️ 2)  Decode the base64 that the extension sent
    const b64 = req.body?.b64;
    if (!b64) {
      return res.status(400).json({ error: "Missing 'b64' audio data." });
    }
    const audioBuffer = Buffer.from(b64, "base64");

    try {
      // --- Build multipart/form-data body using native FormData ---
      const form = new FormData();
      const audioBlob = new Blob([audioBuffer], { type: "audio/webm" });

      form.append("file", audioBlob, "audio.webm");
      form.append("model", "gpt-4o-mini-transcribe"); // Or "gpt-4o-transcribe"
      form.append("response_format", "json");

      // --- Let fetch set the multipart headers automatically ---
      const headers = {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        // DO NOT set 'Content-Type': fetch does it for FormData automatically
      };

      const openaiRes = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: headers,
          body: form,
        },
      );

      const data = await openaiRes.json();
      if (!openaiRes.ok) {
        console.error("OpenAI error:", data);
        return res
          .status(openaiRes.status)
          .json({ error: data.error?.message || "OpenAI request failed." });
      }

      return res.json({ transcription: data.text });
    } catch (err) {
      console.error("Transcription function error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  },
);