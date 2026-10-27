# Shopify Admin Token

[English](README.md) · **Português (BR)**

A Shopify não mostra mais o access token da Admin API no Dev Dashboard. Para conseguir um, é
preciso rodar o fluxo OAuth você mesmo. Este repositório faz isso por você e serve a dois públicos:

- **Quem só precisa do token** para um app de teste, um script ou uma ferramenta de terceiros:
  rode o serviço local, aprove a tela da Shopify e copie o token.
- **Quem está construindo uma aplicação web** e quer entender o OAuth da Shopify: leia
  [`src/shopify-oauth.mjs`](src/shopify-oauth.mjs). Ele não tem dependências, então dá para
  copiar para Express, Fastify, Next.js ou qualquer outro framework Node.

Não há dependências: basta ter Node.js 20.12 ou mais recente.

---

## 1. Criar o app no Dev Dashboard

1. Abra o admin da loja, clique no seu **perfil** (canto superior direito) e depois em **Dev Dashboard**.
2. Clique em **Criar app** e dê um nome descritivo, como o da ferramenta que vai usar o token.
3. Preencha a seção **URLs**:

   | Campo | Valor |
   | --- | --- |
   | URL do app | `http://localhost:3456` |
   | Incorporar app ao admin da Shopify | desmarcado |
   | URL(s) de redirecionamento permitida(s) | `http://localhost:3456/callback` |
   | Usar fluxo de instalação legado | desmarcado |

   A URL de redirecionamento precisa ser idêntica, com a porta e o `/callback`. Se você mudar a
   `PORT`, mude aqui também.

4. Em **Acesso à API / Escopos**, marque só os escopos de que você precisa, como
   `read_products`, `write_products` ou `read_orders`. Mantenha a lista curta: o token pode fazer
   tudo o que esses escopos permitem. Um escopo `write_*` também dá acesso de leitura.
5. Clique em **Lançar** (Release) para publicar a versão do app.
6. Na página inicial do app, vá em **Instalações → Instalar app**, escolha a loja e aprove as
   permissões.
7. Abra as **Configurações** do app e copie o **Client ID** e o **Client secret**.

### Cuidados com os escopos

- **"Contém escopos inválidos"** significa que você marcou escopos *protegidos*, que precisam de
  aprovação da Shopify, como `read_all_orders`, `read_customer_payment_methods`,
  `read_payment_mandate`, `read_own_subscription_contracts` e
  `read_discounts_allocator_functions`. Remova-os para criar o app.
- Sem `read_all_orders`, a API só devolve pedidos dos **últimos 60 dias**. Se você precisar do
  histórico completo, peça esse acesso à parte.

## 2. Rodar o serviço

```bash
git clone https://github.com/oalexandre/shopify-admin-token.git
cd shopify-admin-token
cp .env.example .env   # opcional: preenche o formulário
npm start
```

1. Abra http://localhost:3456.
2. Informe a loja (`minha-loja` ou `minha-loja.myshopify.com`), o Client ID, o Client secret e,
   se quiser, os escopos. Deixe os escopos vazios para usar os que estão configurados no app.
3. Clique em **Authorize on Shopify** e aprove a tela que abrir.
4. O token aparece no navegador e fica salvo em `tokens.json`, que só o seu usuário pode ler.

Teste o token:

```bash
curl -X POST "https://minha-loja.myshopify.com/admin/api/2025-10/graphql.json" \
  -H "X-Shopify-Access-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ shop { name } }"}'
```

## 3. Como funciona

O cadastro do app te dá um **client ID** (quem é o app) e um **client secret** (a prova de que é
você mesmo), como um usuário e uma senha. A loja precisa aprovar o app antes de a Shopify emitir
um token para ela:

```
Navegador                     Este serviço                       Shopify
   │  POST /start               │                                   │
   │ ─────────────────────────> │                                   │
   │  302 → /admin/oauth/authorize?client_id&scope&redirect_uri&state
   │ <───────────────────────── │                                   │
   │ ─────────────────────────────────────────────────────────────> │ lojista aprova
   │  302 → /callback?code&hmac&shop&state&timestamp                │
   │ <───────────────────────────────────────────────────────────── │
   │ ─────────────────────────> │  confere state + HMAC             │
   │                            │  POST /admin/oauth/access_token   │
   │                            │  { client_id, client_secret, code }
   │                            │ ────────────────────────────────> │
   │                            │ <──── { access_token, scope } ─── │
   │  página com o token        │                                   │
   │ <───────────────────────── │                                   │
```

1. **Autorização.** O navegador vai para `https://{loja}/admin/oauth/authorize` com o seu
   `client_id`, o `redirect_uri` permitido no app e um `state` aleatório.
2. **Callback.** A Shopify devolve o navegador para o seu `redirect_uri` com um `code` de vida
   curta. O serviço confere se o `state` foi criado por ele (proteção contra CSRF) e se o `hmac`
   foi assinado com o seu client secret (prova de que veio da Shopify).
3. **Troca.** O servidor envia `client_id`, `client_secret` e `code` para
   `https://{loja}/admin/oauth/access_token` e recebe o `access_token`. O code dura poucos
   minutos, então o serviço faz a troca na hora. O token nunca aparece numa URL nem no histórico
   do navegador.

### Usando na sua aplicação web

```js
import {
  normalizeShop, createState, buildAuthorizeUrl, verifyHmac, exchangeCodeForToken,
} from './shopify-oauth.mjs';

// GET /auth?shop=minha-loja
const shop = normalizeShop(req.query.shop);
const state = createState();
req.session.oauthState = state;
res.redirect(buildAuthorizeUrl({ shop, clientId, redirectUri, state, scopes: 'read_products' }));

// GET /auth/callback
const query = new URLSearchParams(req.url.split('?')[1]);
if (query.get('state') !== req.session.oauthState) throw new Error('state inválido');
if (!verifyHmac(query, clientSecret)) throw new Error('hmac inválido');
const { access_token } = await exchangeCodeForToken({
  shop: normalizeShop(query.get('shop')), clientId, clientSecret, code: query.get('code'),
});
// Guarde o access_token no servidor (criptografado), por loja.
```

Em produção, use um `redirect_uri` HTTPS no seu próprio domínio, guarde o `state` na sessão do
usuário e salve os tokens criptografados num banco de dados, e não num arquivo JSON.

## Estrutura do projeto

```
src/shopify-oauth.mjs   funções de OAuth reutilizáveis (sem dependências)
src/server.mjs          interface web local que usa essas funções
.env.example            valores padrão opcionais para o formulário
tokens.json             tokens gerados (ignorado pelo git)
```

## Segurança

- O servidor escuta só em `127.0.0.1`.
- O `state` e o `hmac` são conferidos em todo callback, e a loja precisa ser um domínio `*.myshopify.com`.
- O client secret fica em memória só durante o fluxo.
- `.env` e `tokens.json` guardam segredos e são ignorados pelo git. Um token da Admin API lê e
  altera dados da loja dentro dos escopos dele, então nunca faça commit nem compartilhe. Para
  revogar um token, desinstale o app da loja.

## Créditos

O fluxo segue o tutorial
[Shopify Access Token 2026 – How to get an Admin API Access Token](https://www.youtube.com/watch?v=8dymQjcylv8),
do Coding with Jan, e a
[documentação da Shopify sobre o authorization code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant).

## Licença

[MIT](LICENSE)
