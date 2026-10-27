# Shopify Admin Token

**English** · [Português (BR)](README.pt-BR.md)

Shopify no longer shows Admin API access tokens on the Dev Dashboard. To get one you have to
run the OAuth flow yourself. This repo does that for you, and is meant for two kinds of user:

- **You just need a token** for a test app, a script or a third-party tool: run the local
  service, click through the approval screen and copy the token.
- **You are building a web app** and want to see how Shopify's OAuth works: read
  [`src/shopify-oauth.mjs`](src/shopify-oauth.mjs). It has no dependencies, so you can copy it
  into Express, Fastify, Next.js or any other Node framework.

There are no dependencies: you need Node.js 20.12 or newer, and nothing else.

---

## 1. Create the app in the Dev Dashboard

1. Open your store's admin, click your **profile** (top right), then **Dev Dashboard**.
2. Click **Create app** and give it a descriptive name, such as the tool that will use the token.
3. Fill in the **URLs** section:

   | Field | Value |
   | --- | --- |
   | App URL | `http://localhost:3456` |
   | Embed app in Shopify admin | unchecked |
   | Allowed redirection URL(s) | `http://localhost:3456/callback` |
   | Use legacy install flow | unchecked |

   The redirection URL must match exactly, including the port and `/callback`. If you change
   `PORT`, change it here too.

4. Under **API access / Scopes**, select only the scopes you actually need, for example
   `read_products`, `write_products` or `read_orders`. Keep the list narrow: the token can do
   everything these scopes allow. A `write_*` scope also grants read access.
5. Click **Release** to publish the app version.
6. On the app's home page, go to **Installs → Install app**, pick your store and approve the
   permissions.
7. Open the app's **Settings** and copy the **Client ID** and the **Client secret**.

### Scope pitfalls

- **"Contains invalid scopes"** means you selected *protected* scopes that need Shopify's
  approval, such as `read_all_orders`, `read_customer_payment_methods`, `read_payment_mandate`,
  `read_own_subscription_contracts` and `read_discounts_allocator_functions`. Remove them to
  create the app.
- Without `read_all_orders`, the API only returns orders from the **last 60 days**. If you need
  the full history, request that access separately.

## 2. Run the service

```bash
git clone https://github.com/oalexandre/shopify-admin-token.git
cd shopify-admin-token
cp .env.example .env   # optional: pre-fills the form
npm start
```

1. Open http://localhost:3456.
2. Enter the store (`my-store` or `my-store.myshopify.com`), the Client ID, the Client secret
   and, optionally, the scopes. Leave scopes empty to use the ones configured on the app.
3. Click **Authorize on Shopify** and approve the screen that opens.
4. The token is shown in the browser and saved to `tokens.json`, which only your user can read.

Test the token:

```bash
curl -X POST "https://my-store.myshopify.com/admin/api/2025-10/graphql.json" \
  -H "X-Shopify-Access-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ shop { name } }"}'
```

## 3. How it works

The app record gives you a **client ID** (who the app is) and a **client secret** (proof that it
is really you), much like a username and a password. A store has to approve the app before
Shopify issues a token for that store:

```
Browser                       This service                       Shopify
   │  POST /start               │                                   │
   │ ─────────────────────────> │                                   │
   │  302 → /admin/oauth/authorize?client_id&scope&redirect_uri&state
   │ <───────────────────────── │                                   │
   │ ─────────────────────────────────────────────────────────────> │ merchant approves
   │  302 → /callback?code&hmac&shop&state&timestamp                │
   │ <───────────────────────────────────────────────────────────── │
   │ ─────────────────────────> │  verify state + HMAC              │
   │                            │  POST /admin/oauth/access_token   │
   │                            │  { client_id, client_secret, code }
   │                            │ ────────────────────────────────> │
   │                            │ <──── { access_token, scope } ─── │
   │  token page                │                                   │
   │ <───────────────────────── │                                   │
```

1. **Authorize.** The browser goes to `https://{shop}/admin/oauth/authorize` with your
   `client_id`, the `redirect_uri` you allowed on the app and a random `state`.
2. **Callback.** Shopify sends the browser back to your `redirect_uri` with a short-lived `code`.
   The service checks that the `state` is one it created (CSRF protection) and that the `hmac`
   was signed with your client secret (proof that Shopify sent it).
3. **Exchange.** The server posts `client_id`, `client_secret` and `code` to
   `https://{shop}/admin/oauth/access_token` and receives the `access_token`. The code lasts only
   a few minutes, so the service exchanges it immediately. The token never appears in a URL or
   in your browser history.

### Using it in your own web app

```js
import {
  normalizeShop, createState, buildAuthorizeUrl, verifyHmac, exchangeCodeForToken,
} from './shopify-oauth.mjs';

// GET /auth?shop=my-store
const shop = normalizeShop(req.query.shop);
const state = createState();
req.session.oauthState = state;
res.redirect(buildAuthorizeUrl({ shop, clientId, redirectUri, state, scopes: 'read_products' }));

// GET /auth/callback
const query = new URLSearchParams(req.url.split('?')[1]);
if (query.get('state') !== req.session.oauthState) throw new Error('bad state');
if (!verifyHmac(query, clientSecret)) throw new Error('bad hmac');
const { access_token } = await exchangeCodeForToken({
  shop: normalizeShop(query.get('shop')), clientId, clientSecret, code: query.get('code'),
});
// Store access_token server-side (encrypted), keyed by shop.
```

In production, use an HTTPS `redirect_uri` on your own domain, keep `state` in the user's
session, and store tokens encrypted in a database instead of a JSON file.

## Project layout

```
src/shopify-oauth.mjs   reusable OAuth helpers (no dependencies)
src/server.mjs          local web UI on top of the helpers
.env.example            optional defaults for the form
tokens.json             generated tokens (git-ignored)
```

## Security

- The server listens on `127.0.0.1` only.
- `state` and `hmac` are verified on every callback, and the store domain must be `*.myshopify.com`.
- The client secret is kept in memory only for the duration of the flow.
- `.env` and `tokens.json` contain secrets and are git-ignored. An Admin API token can read and
  write store data within its scopes, so never commit or share it. To revoke a token, uninstall
  the app from the store.

## Credits

The flow follows the tutorial
[Shopify Access Token 2026 – How to get an Admin API Access Token](https://www.youtube.com/watch?v=8dymQjcylv8)
by Coding with Jan, and Shopify's
[authorization code grant docs](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant).

## License

[MIT](LICENSE)
