// Framework-agnostic helpers for Shopify's OAuth authorization code grant.
// Copy this file into any Node web app (Express, Fastify, Next.js route
// handlers...) — it only depends on node:crypto and the global fetch.
import crypto from 'node:crypto';

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Accepts "my-store", "my-store.myshopify.com" or "https://my-store.myshopify.com/admin"
 * and returns "my-store.myshopify.com", or null when it is not a myshopify domain.
 * Always validate the shop before building URLs with it, so the client secret
 * is never sent to an arbitrary host.
 */
export function normalizeShop(input) {
  let shop = String(input || '').trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (shop && !shop.includes('.')) shop += '.myshopify.com';
  return SHOP_RE.test(shop) ? shop : null;
}

/** Random value tied to the browser session, checked on the callback (CSRF protection). */
export function createState() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Step 1: the URL the merchant is sent to in order to approve the app.
 * `scopes` is optional — when omitted, Shopify uses the scopes configured on the app.
 */
export function buildAuthorizeUrl({ shop, clientId, redirectUri, state, scopes }) {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  if (scopes) url.searchParams.set('scope', scopes);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Step 2: proves the callback query string was signed by Shopify with your client secret.
 * `query` is a URLSearchParams with every parameter Shopify sent.
 */
export function verifyHmac(query, clientSecret) {
  const hmac = query.get('hmac');
  if (!hmac) return false;
  const message = [...query.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const digest = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hmac, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Step 3: exchanges the short-lived authorization code (valid for a few minutes)
 * for the Admin API access token. Run this server-side only: it needs the client secret.
 * Resolves to Shopify's JSON response: { access_token, scope, ... }.
 */
export async function exchangeCodeForToken({ shop, clientId, clientSecret, code }) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok || !data.access_token) {
    const error = new Error(`Shopify rejected the code exchange (HTTP ${response.status})`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}
