# Simple Newsletter App

A production-ready newsletter builder and API that lets you create polished campaigns, manage subscribers, and embed signup forms directly on any website. The backend uses Express, Cloudinary, and Resend for reliable email delivery with the right diagnostics and compliance features built in.

## Features
- Rich text editor with image uploads (optimized & hosted on Cloudinary) and live email previews.
- Sanitized content pipeline with per-subscriber unsubscribe links and plaintext fallbacks.
- Public subscription/unsubscription API with CORS `*` support, rate limiting, honeypot detection, and detailed logging.
- Built-in unsubscribe confirmation page (`/unsubscribe`) and a ready-to-copy HTML example form (`public/example-form.html`).
- Robust email diagnostics: per-recipient logging, delivery summaries, `/api/test-email`, `/api/test-subscribe`, `/api/diagnostics`, and Cloudinary/Resend connectivity checks.
- Health check, timestamped logging, and configurable environment validation for smooth deployments.

## Project Structure
```
.
data/
  subscribers.json         # JSON storage for subscribers
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
   ```
   The server refuses to boot if anything is missing or if `SENDER_EMAIL` is malformed, so you catch configuration issues right away.

3. **Run locally**
   ```bash
   npm run dev   # nodemon with reload
   # or
   npm start     # plain node
   ```
   Visit [http://localhost:3000](http://localhost:3000) to use the editor UI.

## Using the App
1. Add subscribers manually in the dashboard (or through the public API described below).
2. Compose a campaign: write a title, optional preview text, format content, and upload images.
3. Click **Preview Email** to see the responsive, inline-styled template with the unsubscribe link preview.
4. Click **Send Newsletter** to deliver a personalized email (including a per-recipient unsubscribe link) to each subscriber. Detailed results are returned in the response and logged server-side.
5. Use `/api/test-email` or `/api/diagnostics` whenever you need to verify deliverability or check external integrations (Resend/Cloudinary).

## Public Subscription API
These endpoints are designed for external sites (e.g., your GoDaddy pages) and accept cross-origin requests.

### CORS & Rate Limits
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`
- Rate limit: **10 requests per IP per hour** on `/api/public/*`

### Endpoints
| Method | Endpoint                     | Description                                |
|--------|------------------------------|--------------------------------------------|
| POST   | `/api/public/subscribe`      | Adds a subscriber (JSON `{ email, name? }`) |
| POST   | `/api/public/unsubscribe`    | Removes a subscriber (JSON `{ email }`)    |
| GET    | `/api/test-subscribe`        | Health + usage hints for the public API    |

#### Subscribe
Request body:
```json
{
  "email": "alex@example.com",
  "name": "Alex Example",
  "honeypot": ""          // optional bot trap; leave empty
}
```
Responses:
- Success → `200 { "success": true, "message": "Successfully subscribed!" }`
- Duplicate → `200 { "success": false, "error": "Email already subscribed" }`
- Validation/other errors return `success: false` with a helpful message.

#### Unsubscribe
Request body:
```json
{
  "email": "alex@example.com"
}
```
Responses:
- Success → `200 { "success": true, "message": "Successfully unsubscribed" }`
- Missing entry → `200 { "success": false, "error": "Email not found" }`

### Example Form
The file `public/example-form.html` contains a complete HTML/CSS/JS example you can drop into any site. Update the `API_BASE` constant inside that file to point to your deployed server, and it will call the subscription API via `fetch`. The honeypot field is included to deter bots.

## Unsubscribe Flow
- Every newsletter includes a subscriber-specific link (`${APP_URL}/unsubscribe?email=<encoded-email>`).
- `/unsubscribe` serves `public/unsubscribe.html`, a simple confirmation page that calls the public unsubscribe API and displays success/error states.
- You can customize the page styling, but keep the JSON call intact for consistency.

## Deployment Guide

### Environment Checklist
Confirm these variables are set in your hosting platform:
- `RESEND_API_KEY`
- `SENDER_EMAIL`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `APP_URL` (e.g., `https://newsletter.example.com`)

### Vercel
1. Create a new Vercel project from this repo.
2. Set the environment variables (Project → Settings → Environment Variables).
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

## Diagnostics & Testing
- `GET /health` – basic service uptime.
- `GET /api/test-subscribe` – verify the public API is reachable (useful for CORS checks).
- `POST /api/test-email { testEmail, includeImage? }` – send a diagnostic email; the response includes Resend metadata, timing, DNS/SPF/DKIM hints, and full logging.
- `GET /api/diagnostics` – returns sender info, subscriber counts, Resend/Cloudinary status, last email summary, and recent suspicious activity counts.

## Troubleshooting
- **Startup fails** → Check the console; missing or malformed `.env` configuration halts the server.
- **Image upload fails** → Verify Cloudinary credentials; check `/api/diagnostics` for the latest ping result.
- **Resend rejects the email** → Inspect the response for `statusCode`, `error`, and `suggestions`. Common causes: unverified sender, missing domain DNS (SPF/DKIM), or quota limits.
- **Public API returns 429** → You’ve hit the 10 requests/hour/IP rate limit; slow down or aggregate submissions.
- **CORS blocked** → Confirm your frontend is sending `Content-Type: application/json` and that you’re hitting the correct API base URL.

## Migration Guide (from the original local uploads build)
1. Pull the latest codebase.
2. Install new dependencies:
   ```bash
   npm install cloudinary cors express-rate-limit sanitize-html
   ```
3. Update `.env` with Cloudinary credentials and `APP_URL`.
4. Remove the obsolete local `uploads/` directory (Cloudinary now handles media).
5. Review the new public API endpoints and update any client integrations accordingly.
6. Send a test campaign to confirm personalized unsubscribe links and diagnostics.

## Server API Quick Reference
- `GET /health`
- `GET /api/subscribers`
- `POST /api/subscribers { email }`
- `DELETE /api/subscribers/:email`
- `POST /api/upload-image`
- `POST /api/send-newsletter { title, content, previewText? }`
- `POST /api/test-email { testEmail, includeImage? }`
- `POST /api/public/subscribe { email, name?, honeypot? }`
- `POST /api/public/unsubscribe { email }`
- `GET /api/test-subscribe`
- `GET /api/diagnostics`

Enjoy building your audience and sending campaigns with confidence. The new diagnostics, unsubscribe flow, and public API make it easy to integrate this backend with any website while staying compliant and observable. Pull requests and enhancements are always welcome!*** End Patch
