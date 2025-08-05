// popup.js

/****************************************************************
 * HandsFree Type  –  popup.js
 * ------------------------------------------------------------
 * • Renders auth state received from the background script.
 * • Sends messages to the background script to trigger
 * sign-in, sign-out, and API calls.
 ****************************************************************/

/* ----------  1. DOM refs  ---------- */
const loadingView = document.getElementById('loading-view');
const signedOutView = document.getElementById('signed-out-view');
const signedInView = document.getElementById('signed-in-view');

const googleBtn = document.getElementById('google-btn');
const emailEl = document.getElementById('user-email');
const planName = document.getElementById('plan-name');
const planLeft = document.getElementById('plan-left');
const upgradeBtn = document.getElementById('upgrade-btn');
const portalBtn = document.getElementById('portal-btn');
const signoutBtn = document.getElementById('signout-btn');

/* ----------  2. UI updaters ---------- */
function showLoading() {
  loadingView.style.display = 'block';
  signedOutView.style.display = 'none';
  signedInView.style.display = 'none';
}

function showSignedOut() {
  loadingView.style.display = 'none';
  signedOutView.style.display = 'block';
  signedInView.style.display = 'none';
  googleBtn.disabled = false;
}

async function showSignedIn(user) {
  loadingView.style.display = 'none';
  signedOutView.style.display = 'none';
  signedInView.style.display = 'block';
  emailEl.textContent = user.email;
  await refreshPlan();
}

async function refreshPlan() {
  try {
    planName.textContent = 'Loading...';
    planLeft.textContent = '';
    const { plan, remainingSeconds } = await chrome.runtime.sendMessage({ type: 'api-get', path: '/canStart' });
    const isPro = plan === 'pro';
    planName.textContent = isPro ? 'Pro' : 'Free';
    const remainingMinutes = Math.floor((remainingSeconds || 0) / 60);
    planLeft.textContent = `${remainingMinutes} min`;
    upgradeBtn.style.display = isPro ? 'none' : 'block';
    portalBtn.style.display = isPro ? 'block' : 'none';
  } catch (e) {
    console.error('[popup] refreshPlan failed', e);
    planName.textContent = 'Error';
    planLeft.textContent = 'N/A';
  }
}

/* ----------  3. Event wiring ---------- */
googleBtn.addEventListener('click', () => {
  googleBtn.disabled = true;
  googleBtn.textContent = 'Opening...';
  chrome.runtime.sendMessage({ type: 'trigger-signin' }, (response) => {
    if (response?.error || !response?.success) {
      console.error('Sign-in error:', response?.error);
      alert(`Sign-in failed. Please try again.\nError: ${response?.error}`);
      googleBtn.disabled = false;
      googleBtn.textContent = 'Sign in with Google';
    }
  });
});

signoutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'trigger-signout' });
  showLoading(); // Show loading while state changes
});

upgradeBtn.addEventListener('click', async () => {
  try {
    upgradeBtn.disabled = true;
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
      window.close(); // Close popup after opening checkout
    } else {
      throw new Error(error || 'No checkout URL returned.');
    }
  } catch (e) {
    console.error('[popup] createCheckout failed', e);
    alert('Could not open Stripe Checkout.');
    upgradeBtn.disabled = false;
  }
});

portalBtn.addEventListener('click', async () => {
  try {
    portalBtn.disabled = true;
    const { url, error } = await chrome.runtime.sendMessage({
      type: 'api-post',
      path: '/createPortal',
      body: { returnUrl: 'https://hands-free-type-website.vercel.app/' }
    });
    if (url) {
      chrome.tabs.create({ url });
      window.close(); // Close popup after opening portal
    } else {
      throw new Error(error || 'No portal URL returned.');
    }
  } catch (e) {
    console.error('[popup] createPortal failed', e);
    alert('Could not open Billing Portal.');
    portalBtn.disabled = false;
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
  showLoading(); // Show loading spinner initially
  chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError.message);
      loadingView.innerHTML = '<p style="color: #fce8e6;">Error connecting to extension.</p>';
      return;
    }
    if (response?.user) {
      showSignedIn(response.user).catch(console.error);
    } else {
      showSignedOut();
    }
  });
});