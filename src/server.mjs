// Local web server that walks through Shopify's OAuth flow and shows the
// resulting Admin API access token. Routes:
//   GET  /          form (shop, client ID, client secret, scopes)
//   POST /start     redirects to https://{shop}/admin/oauth/authorize
//   GET  /callback  verifies state + HMAC, exchanges the code, shows the token
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeShop,
  createState,
  buildAuthorizeUrl,
  verifyHmac,
  exchangeCodeForToken,
} from './shopify-oauth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT || 3456);
const HOST = '127.0.0.1';
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TOKENS_FILE = path.join(root, 'tokens.json');
const STATE_TTL_MS = 10 * 60 * 1000;

// state -> { shop, clientId, clientSecret, createdAt }. In-memory only: a real
// app would keep this in the user's session or a short-lived store.
const pending = new Map();

function saveToken(shop, data) {
  let all = {};
  if (fs.existsSync(TOKENS_FILE)) all = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  all[shop] = { ...data, obtained_at: new Date().toISOString() };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
  h1{font-size:20px} label{display:block;margin:14px 0 4px;font-weight:600}
  input{width:100%;padding:8px;font:inherit;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
  button{margin-top:18px;padding:10px 16px;font:inherit;border:0;border-radius:6px;background:#008060;color:#fff;cursor:pointer}
  code,pre{background:#eee;border-radius:4px;padding:2px 4px;word-break:break-all;white-space:pre-wrap}
  pre{padding:12px} .err{color:#b00020} small{color:#666}
</style></head><body>${body}</body></html>`;
}

function send(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

const errorPage = (message, extra = '') =>
  page('Error', `<p class="err">${esc(message)}</p>${extra}<p><a href="/">Start over</a></p>`);

function formPage(error) {
  return page('Shopify Admin Token', `
<h1>Generate an Admin API access token</h1>
<p>Before you start: create the app in the Dev Dashboard, add <code>${esc(REDIRECT_URI)}</code>
to <b>Allowed redirection URL(s)</b>, release the version and install the app on the store.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/start">
  <label>Store</label>
  <input name="shop" placeholder="my-store.myshopify.com" value="${esc(process.env.SHOPIFY_SHOP)}" required>
  <label>Client ID</label>
  <input name="client_id" value="${esc(process.env.SHOPIFY_CLIENT_ID)}" required>
  <label>Client secret</label>
  <input name="client_secret" type="password" value="${esc(process.env.SHOPIFY_CLIENT_SECRET)}" required>
  <label>Scopes <small>(optional; empty = the scopes configured on the app)</small></label>
  <input name="scopes" placeholder="read_products,write_products" value="${esc(process.env.SHOPIFY_SCOPES)}">
  <button type="submit">Authorize on Shopify</button>
</form>`);
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e5) throw new Error('Request body too large');
  }
  return new URLSearchParams(body);
}

async function handleStart(req, res) {
  const form = await readForm(req);
  const shop = normalizeShop(form.get('shop'));
  const clientId = (form.get('client_id') || '').trim();
  const clientSecret = (form.get('client_secret') || '').trim();
  const scopes = (form.get('scopes') || '').replace(/\s+/g, '');
  if (!shop) return send(res, 400, formPage('Invalid store. Use the *.myshopify.com domain.'));
  if (!clientId || !clientSecret) return send(res, 400, formPage('Client ID and client secret are required.'));

  const state = createState();
  pending.set(state, { shop, clientId, clientSecret, createdAt: Date.now() });
  res.writeHead(302, { Location: buildAuthorizeUrl({ shop, clientId, redirectUri: REDIRECT_URI, state, scopes }) });
  res.end();
}

async function handleCallback(url, res) {
  const query = url.searchParams;
  const state = query.get('state');
  const ctx = state && pending.get(state);
  if (!ctx) return send(res, 400, errorPage('Unknown or expired state.'));
  pending.delete(state);

  if (normalizeShop(query.get('shop')) !== ctx.shop) return send(res, 400, errorPage('The callback store does not match.'));
  if (!verifyHmac(query, ctx.clientSecret)) {
    return send(res, 400, errorPage('Invalid HMAC: the callback did not come from Shopify, or the client secret is wrong.'));
  }
  const code = query.get('code');
  if (!code) return send(res, 400, errorPage('Callback has no code parameter.'));

  let data;
  try {
    data = await exchangeCodeForToken({ shop: ctx.shop, clientId: ctx.clientId, clientSecret: ctx.clientSecret, code });
  } catch (err) {
    return send(res, 502, errorPage(err.message, `<pre>${esc(JSON.stringify(err.details, null, 2))}</pre>`));
  }

  saveToken(ctx.shop, data);
  console.log(`[ok] token generated for ${ctx.shop} (scopes: ${data.scope}) -> tokens.json`);
  send(res, 200, page('Token generated', `
<h1>Token generated for ${esc(ctx.shop)}</h1>
<label>Access token</label><pre>${esc(data.access_token)}</pre>
<label>Scopes</label><pre>${esc(data.scope)}</pre>
${data.expires_in ? `<p>Expires in ${esc(data.expires_in)}s.</p>` : ''}
<p>Saved to <code>tokens.json</code>. Send it in the <code>X-Shopify-Access-Token</code> header. Never share it.</p>
<p><a href="/">Generate another</a></p>`));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, formPage());
    if (req.method === 'POST' && url.pathname === '/start') return await handleStart(req, res);
    if (req.method === 'GET' && url.pathname === '/callback') return await handleCallback(url, res);
    send(res, 404, page('Not found', '<p>Not found.</p>'));
  } catch (err) {
    console.error(err);
    send(res, 500, errorPage(err.message));
  }
});

setInterval(() => {
  for (const [state, ctx] of pending) if (Date.now() - ctx.createdAt > STATE_TTL_MS) pending.delete(state);
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Open http://localhost:${PORT}`);
  console.log(`Redirect URL to allow on the app: ${REDIRECT_URI}`);
});
