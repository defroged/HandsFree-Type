// popup.js

/****************************************************************
 * HandsFree Type  –  popup.js
 * ------------------------------------------------------------
 * • Renders auth state received from the background script.
 * • Sends messages to the background script to trigger
 * sign-in, sign-out, and API calls.
 ****************************************************************/

/* ----------  1. DOM refs  ---------- */
const outDiv = document.getElementById('signed-out');
const inDiv = document.getElementById('signed-in');
const gBtn = document.getElementById('google-btn');
const statusMsg = document.getElementById('status-message');
const emailEl = document.getElementById('user-email');
const planName = document.getElementById('plan-name');
const planLeft = document.getElementById('plan-left');
const upgradeBtn = document.getElementById('upgrade-btn');
const portalBtn = document.getElementById('portal-btn');
const signoutBtn = document.getElementById('signout-btn');

/* ----------  2. UI updaters ---------- */
function showSignedOut(isInitialLoad = false) {
  outDiv.style.display = 'block';
  inDiv.style.display = 'none';
  if (isInitialLoad) {
    statusMsg.textContent = 'Checking authentication...';
    gBtn.style.display = 'none';
  } else {
    statusMsg.textContent = 'Please sign in to use the extension.';
    gBtn.style.display = 'block';
    gBtn.disabled = false;
  }
}

async function showSignedIn(user) {
  outDiv.style.display = 'none';
  inDiv.style.display = 'block';
  emailEl.textContent = user.email;
  await refreshPlan();
}

async function refreshPlan() {
  try {
    planName.textContent = 'Loading...';
    planLeft.textContent = '';
    // Ask background to make the authenticated API call
    const { plan, remainingSeconds } = await chrome.runtime.sendMessage({ type: 'api-get', path: '/canStart' });
    const isPro = plan === 'pro';
    planName.textContent = isPro ? 'Pro' : 'Free';
    // Ensure remainingSeconds is a number before doing math with it
    const remainingMinutes = Math.floor((remainingSeconds || 0) / 60);
    planLeft.textContent = isPro ? '(unlimited)' : `(${remainingMinutes} min left)`;
    upgradeBtn.style.display = isPro ? 'none' : 'block';
    portalBtn.style.display = isPro ? 'block' : 'none';
  } catch (e) {
    console.error('[popup] refreshPlan failed', e);
    planName.textContent = 'Error';
    planLeft.textContent = 'Could not load plan.';
  }
}

/* ----------  3. Event wiring ---------- */
gBtn.addEventListener('click', () => {
  statusMsg.textContent = 'Opening Google Sign-in...';
  gBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'trigger-signin' }, (response) => {
    if (response?.error || !response?.success) {
      statusMsg.textContent = `Sign-in failed. Please try again.`;
      console.error('Sign-in error:', response?.error);
      gBtn.disabled = false;
    }
    // On success, the 'auth-state-changed' message will update the UI.
  });
});

signoutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'trigger-signout' });
});

upgradeBtn.addEventListener('click', async () => {
  try {
    const { url, error } = await chrome.runtime.sendMessage({
      type: 'api-post',
      path: '/createCheckout',
      body: {
        successUrl: 'https://hands-free-type-website.vercel.app/?checkout=success',
        cancelUrl: 'https://hands-free-type-website.vercel.app/?checkout=cancel'
      }
    });
    if (url) {
      chrome.tabs.create({ url });
    } else {
      throw new Error(error || 'No checkout URL returned.');
    }
  } catch (e) {
    console.error('[popup] createCheckout failed', e);
    alert('Could not open Stripe Checkout.');
  }
});

portalBtn.addEventListener('click', async () => {
  try {
    const { url, error } = await chrome.runtime.sendMessage({
      type: 'api-post',
      path: '/createPortal',
      body: { returnUrl: 'https://hands-free-type-website.vercel.app/' }
    });
    if (url) {
      chrome.tabs.create({ url });
    } else {
      throw new Error(error || 'No portal URL returned.');
    }
  } catch (e) {
    console.error('[popup] createPortal failed', e);
    alert('Could not open Billing Portal.');
  }
});

/* ----------  4. Listen for state changes from background ---------- */
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'auth-state-changed') {
    if (message.user) {
      showSignedIn(message.user).catch(console.error);
    } else {
      showSignedOut();
    }
  }
});

/* ----------  5. Kick things off ---------- */
document.addEventListener('DOMContentLoaded', () => {
  showSignedOut(true); // Show "loading" state initially
  chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
    if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError.message);
        statusMsg.textContent = 'Error connecting to extension.';
        return;
    }
    if (response?.user) {
      showSignedIn(response.user).catch(console.error);
    } else {
      showSignedOut();
    }
  });
});