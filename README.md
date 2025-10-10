# Simple Newsletter App

A production-ready newsletter builder and API that lets you create polished campaigns, manage subscribers, and embed signup forms on any website. The backend uses Express, Cloudinary, Resend, and Vercel KV for a portable storage layer.

## Features
- Rich text editor with image uploads (optimized & hosted on Cloudinary) and live email previews.
- Sanitized content pipeline with per-subscriber unsubscribe links and plaintext fallbacks.
- Public subscription/unsubscription API with CORS `*` support, rate limiting, honeypot detection, and detailed logging.
- Built-in unsubscribe confirmation page (`/unsubscribe`) and a ready-to-copy HTML example form (`public/example-form.html`).
- Robust email diagnostics: per-recipient logging, delivery summaries, `/api/test-email`, `/api/test-subscribe`, `/api/diagnostics`, and Cloudinary/Resend connectivity checks.
- Subscriber storage backed by Vercel KV in production with an automatic in-memory fallback for local development.

## Project Structure
```
.
public/
  app.js                   # Editor logic (composer, preview, subscriber list)
  example-form.html        # Embeddable subscription form sample
  index.html               # App interface
  styles.css               # UI styling
  unsubscribe.html         # Unsubscribe confirmation page
.env.example               # Required environment variables
package.json               # Dependencies and scripts
server.js                  # Express server + API routes
README.md
```

## Requirements
- [Node.js](https://nodejs.org/) (LTS recommended)
- Resend API key with a verified sender address
- Cloudinary account (free tier works great)
- (Optional) Vercel KV database. On Vercel, the `STORAGE_*` environment variables are provisioned automatically when the KV integration is linked.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in every value (all are required during startup):
   ```
   RESEND_API_KEY=your_resend_api_key_here
   SENDER_EMAIL=Your Name <you@example.com>   # Must be verified in Resend
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_cloudinary_api_key
   CLOUDINARY_API_SECRET=your_cloudinary_api_secret
   APP_URL=http://localhost:3000              # Update to your production URL when deployed
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=$2b$12$replace_with_bcrypt_hash
   SESSION_SECRET=super_secret_session_key_change_me
   # Optional: Vercel KV credentials (falls back to in-memory storage if omitted)
   STORAGE_REST_API_URL=
   STORAGE_REST_API_TOKEN=
   STORAGE_URL=                               # Only needed for direct Redis connections
   ```
   The server refuses to boot if anything is missing or if `SENDER_EMAIL` is malformed, so you catch configuration issues right away. For local development you may keep `ADMIN_PASSWORD` as plain text—the server hashes it at runtime—but in production you should store a bcrypt hash (see below). When the storage variables are missing, the app logs that it is using in-memory storage (ideal for local development).

3. **Run locally**
   ```bash
   npm run dev   # nodemon with reload
   # or
   npm start     # plain node
   ```
   Visit [http://localhost:3000/login](http://localhost:3000/login) to authenticate with your admin credentials; after logging in you will be redirected to the editor dashboard.

## Using the App
1. Sign in at `/login` using the credentials defined by `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Add subscribers manually in the dashboard (or through the public API described below).
3. Compose a campaign: write a title, optional preview text, format content, and upload images.
4. Click **Preview Email** to see the responsive, inline-styled template with the unsubscribe link preview.
5. Click **Send Newsletter** to deliver a personalized email (including a per-recipient unsubscribe link) to each subscriber. Detailed results are returned in the response and logged server-side.
6. Use `/api/test-email` or `/api/diagnostics` whenever you need to verify deliverability or check external integrations (Resend/Cloudinary).

## Subscriber Storage

### Local development
- If the `STORAGE_*` variables are not present, the server automatically switches to an in-memory `Map`. Subscriber data resets whenever the process restarts, which keeps local testing simple.
- To exercise Vercel KV locally (or from another environment), set `STORAGE_REST_API_URL` and `STORAGE_REST_API_TOKEN` in `.env`. You can copy these values from Vercel (Project -> Storage -> KV -> Tokens) or create a separate KV instance for local testing.
- When the server boots, check the console output. It logs whether it is using Vercel KV (REST API) or in-memory storage.

### Production on Vercel
- Vercel attaches `STORAGE_URL`, `STORAGE_REST_API_URL`, and `STORAGE_REST_API_TOKEN` automatically when you add the KV integration to your project. No code changes are required.
- Ensure the Storage integration is linked to each environment (Production/Preview/Development) where you deploy. Redeploy after linking so the environment variables become available.

### Verifying Vercel KV
1. Deploy (or run locally with KV credentials) and watch the startup logs for `Subscriber storage configured to use Vercel KV (REST API).`
2. Add a test subscriber via `/api/subscribers` or the dashboard UI.
3. Call `GET /api/subscribers` and confirm the subscriber appears with `subscribedAt`.
4. From the Vercel dashboard, open **Storage -> KV -> Browser** and verify a hash exists under `newsletter:subscriber:<normalized-email>` with the expected fields.
5. Run `GET /api/diagnostics` to see the storage mode and subscriber count summary returned in JSON.

### Migrating existing `subscribers.json` data
If you previously stored subscribers in `data/subscribers.json`, you can seed the KV database with a simple script:

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const { createClient } = require('@vercel/kv');

const SUBSCRIBERS_SET_KEY = 'newsletter:subscribers';
const SUBSCRIBER_HASH_PREFIX = 'newsletter:subscriber:';

function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

(async () => {
  const file = path.join(__dirname, 'data', 'subscribers.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kv = createClient({
    url: process.env.STORAGE_REST_API_URL,
    token: process.env.STORAGE_REST_API_TOKEN,
  });

  for (const subscriber of payload) {
    const normalized = normalizeEmail(subscriber.email);
    if (!normalized) continue;
    const hashKey = `${SUBSCRIBER_HASH_PREFIX}${normalized}`;
    const subscribedAt = subscriber.subscribedAt || subscriber.joinedAt || new Date().toISOString();

    await kv.sadd(SUBSCRIBERS_SET_KEY, normalized);
    await kv.hset(hashKey, {
      email: subscriber.email,
      subscribedAt,
      joinedAt: subscribedAt,
      ...(subscriber.name ? { name: subscriber.name } : {}),
      ...(subscriber.source ? { source: subscriber.source } : {}),
    });
  }

  console.log(`Imported ${payload.length} subscribers into Vercel KV.`);
})();
NODE
```

Ensure `STORAGE_REST_API_URL` and `STORAGE_REST_API_TOKEN` are available in your environment before running the script.

## Authentication & Sessions
- The admin interface is protected by a password gate at `/login`. Credentials come from `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
- Sessions are backed by `express-session` with a 24-hour idle timeout; selecting “Remember me” extends the cookie to 30 days.
- Login attempts are rate limited (5 per 15 minutes per IP). When the limit is exceeded the form is locked temporarily and a warning is logged.
- The login form is protected with a CSRF token; unauthenticated API calls respond with HTTP 401 so the client can redirect back to `/login`.
- Passwords should be stored as bcrypt hashes in production. Generate one with `npx bcrypt-cli "your-strong-password"` (or any bcrypt tool) and place the resulting hash in `ADMIN_PASSWORD`.
- `SESSION_SECRET` must be a long, random string. Rotate it whenever credentials change to invalidate all sessions.
- For production, swap the default in-memory session store for something durable such as Redis (e.g., `connect-redis`). Redis also satisfies Vercel’s stateless requirements.
- Need multiple admin users? Extend the auth middleware to load a hashed credential list from a secure data store (KV, Redis, or a managed secret) and compare via bcrypt.
- Use `/logout` or the “Logout” button in the navigation to terminate the session. When a session expires naturally the app redirects back to `/login` and preserves the originally requested URL.

## Public Subscription API
These endpoints are designed for external sites (e.g., your GoDaddy pages) and accept cross-origin requests.

### CORS and rate limits
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`
- Rate limit: 10 requests per IP per hour on `/api/public/*`

### Endpoints
| Method | Endpoint                  | Description                                 |
|--------|---------------------------|---------------------------------------------|
| POST   | `/api/public/subscribe`   | Adds a subscriber (`{ email, name? }`)      |
| POST   | `/api/public/unsubscribe` | Removes a subscriber (`{ email }`)          |
| GET    | `/api/test-subscribe`     | Health and usage hints for the public API   |

#### Subscribe
Request body:
```json
{
  "email": "alex@example.com",
  "name": "Alex Example",
  "honeypot": ""
}
```
Responses:
- Success: `200 { "success": true, "message": "Successfully subscribed!" }`
- Duplicate: `200 { "success": false, "error": "Email already subscribed" }`
- Validation/other errors return `success: false` with a helpful message.

#### Unsubscribe
Request body:
```json
{
  "email": "alex@example.com"
}
```
Responses:
- Success: `200 { "success": true, "message": "Successfully unsubscribed" }`
- Missing entry: `200 { "success": false, "error": "Email not found" }`

### Example form
The file `public/example-form.html` contains a complete HTML/CSS/JS example you can drop into any site. Update the `API_BASE` constant inside that file to point to your deployed server. The honeypot field is included to deter bots.

## Unsubscribe Flow
- Every newsletter includes a subscriber-specific link (`${APP_URL}/unsubscribe?email=<encoded-email>`).
- `/unsubscribe` serves `public/unsubscribe.html`, a simple confirmation page that calls the public unsubscribe API and displays success/error states.
- You can customize the page styling, but keep the JSON call intact for consistency.

## Deployment Guide

### Environment checklist
Confirm these variables are set in your hosting platform:
- `RESEND_API_KEY`
- `SENDER_EMAIL`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `APP_URL` (e.g., `https://newsletter.example.com`)
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD` (bcrypt hash recommended)
- `SESSION_SECRET` (long, random string)
- `STORAGE_REST_API_URL` (auto-provisioned when the Vercel KV integration is linked)
- `STORAGE_REST_API_TOKEN` (auto-provisioned when the Vercel KV integration is linked)
- `STORAGE_URL` (optional; only required for direct Redis connections)

### Vercel
1. Create a new Vercel project from this repo.
2. Set the environment variables (Project -> Settings -> Environment Variables). Provide `ADMIN_USERNAME`, a bcrypt-hashed `ADMIN_PASSWORD`, and a strong `SESSION_SECRET`. Once the KV integration is attached, Vercel adds the `STORAGE_*` values automatically.
3. Use `npm install` as the build command and `npm start` as the run command.
4. Redeploy and check:
   - `GET /health`
   - `GET /api/test-subscribe`
   - `POST /api/test-email` with a known inbox

### Railway (or similar platforms)
1. Deploy the repository.
2. Add the environment variables under **Variables**.
3. Use `npm start` as the start command.
4. Ensure port `3000` is exposed.

> `app.set('trust proxy', 1)` is already enabled for accurate IP-based rate limiting behind proxies.

## Diagnostics and Testing
- `GET /health` – basic service uptime.
- `GET /api/test-subscribe` – verify the public API is reachable (useful for CORS checks).
- `POST /api/test-email { testEmail, includeImage? }` – send a diagnostic email; the response includes Resend metadata, timing, DNS/SPF/DKIM hints, and full logging.
- `GET /api/diagnostics` – returns sender info, subscriber counts, Resend/Cloudinary status, last email summary, storage mode, and recent suspicious activity counts.

## Troubleshooting
- **Startup fails** – Check the console; missing or malformed `.env` configuration halts the server.
- **Image upload fails** – Verify Cloudinary credentials; check `/api/diagnostics` for the latest ping result.
- **Resend rejects the email** – Inspect the response for `statusCode`, `error`, and `suggestions`. Common causes: unverified sender, missing domain DNS (SPF/DKIM), or quota limits.
- **Public API returns 429** – You hit the 10 requests/hour/IP rate limit; slow down or aggregate submissions.
- **CORS blocked** – Confirm your frontend is sending `Content-Type: application/json` and that you are hitting the correct API base URL.
- **Subscriber storage unavailable** – Ensure the `STORAGE_*` variables are present and correct. The server logs and `/api/diagnostics` response will call out connection issues.

## Server API Quick Reference
- `GET /health`
- `GET /api/subscribers`
- `POST /api/subscribers { email, name? }`
- `DELETE /api/subscribers/:email`
- `POST /api/upload-image`
- `POST /api/send-newsletter { title, content, previewText? }`
- `POST /api/test-email { testEmail, includeImage? }`
- `POST /api/public/subscribe { email, name?, honeypot? }`
- `POST /api/public/unsubscribe { email }`
- `GET /api/test-subscribe`
- `GET /api/diagnostics`

Enjoy building your audience and sending campaigns with confidence. The diagnostics, unsubscribe flow, and public API make it easy to integrate this backend with any website while staying compliant and observable. Pull requests and enhancements are always welcome!
