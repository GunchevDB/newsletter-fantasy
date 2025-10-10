/**
 * Production-ready Express server for the newsletter application.
 * Handles subscriber management, Cloudinary-backed image uploads,
 * sanitized rich text newsletters, and delivery via Resend.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const { Resend } = require('resend');
const { v2: cloudinary } = require('cloudinary');
const { performance } = require('perf_hooks');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve important paths once.
const dataDir = path.join(__dirname, 'data');
const subscribersPath = path.join(dataDir, 'subscribers.json');

/**
 * Tiny timestamped logger for consistent console output in production.
 */
const logger = {
  info(message, ...args) {
    console.log(`[${new Date().toISOString()}] [INFO] ${message}`, ...args);
  },
  warn(message, ...args) {
    console.warn(`[${new Date().toISOString()}] [WARN] ${message}`, ...args);
  },
  error(message, ...args) {
    console.error(`[${new Date().toISOString()}] [ERROR] ${message}`, ...args);
  },
};

const requiredEnvVars = [
  'RESEND_API_KEY',
  'SENDER_EMAIL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'APP_URL',
];

const missingEnv = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnv.length) {
  logger.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  throw new Error('Environment not configured. Check your .env file.');
}

let resendStatus = {
  valid: null,
  checkedAt: null,
  error: null,
};

let lastEmailDiagnostic = null;

const suspiciousAttempts = new Map();

function recordSuspiciousAttempt(ip, reason, details = {}) {
  if (!ip) {
    return;
  }

  const entry = suspiciousAttempts.get(ip) || { count: 0, lastAttempt: null, reasons: [] };
  entry.count += 1;
  entry.lastAttempt = new Date().toISOString();
  entry.reasons.push({ reason, details, at: entry.lastAttempt });
  suspiciousAttempts.set(ip, entry);

  logger.warn('Suspicious activity detected.', {
    ip,
    reason,
    attempts: entry.count,
    details,
  });
}

const appUrl = process.env.APP_URL;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const resendClient = new Resend(process.env.RESEND_API_KEY);
const senderEmail = process.env.SENDER_EMAIL;

if (!isValidEmail(senderEmail)) {
  logger.error('SENDER_EMAIL is not a valid email format.', { senderEmail });
  throw new Error('SENDER_EMAIL environment variable must be a valid email address.');
}

if (senderEmail.toLowerCase().includes('onboarding@resend.dev')) {
  logger.warn(
    'SENDER_EMAIL is using the onboarding@resend.dev test domain. Emails may not deliver to real inboxes.',
  );
}

// Multer in-memory storage keeps files ephemeral before handing off to Cloudinary.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(new Error('Only JPG, PNG, GIF, or WEBP images are allowed.'));
      return;
    }
    cb(null, true);
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
  },
});

const sanitizerOptions = {
  allowedTags: [
    'a',
    'blockquote',
    'br',
    'code',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'div',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'style'],
    div: ['style'],
    span: ['style'],
    p: ['style'],
    table: ['role', 'cellpadding', 'cellspacing', 'border', 'width', 'align', 'style'],
    td: ['width', 'align', 'valign', 'style'],
    th: ['width', 'align', 'valign', 'style'],
    tr: ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https'],
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
};

/**
 * Strip HTML tags to create a plain text fallback for email clients.
 */
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Provide actionable suggestions based on common Resend error messages.
 */
function buildResendSuggestions(message = '') {
  const lower = message.toLowerCase();
  const suggestions = [];
  if (lower.includes('domain')) {
    suggestions.push('Verify your sending domain in the Resend dashboard and ensure DNS records are propagated.');
  }
  if (lower.includes('sender') || lower.includes('from')) {
    suggestions.push('Confirm that SENDER_EMAIL is verified in Resend and matches the domain you verified.');
  }
  if (lower.includes('limit') || lower.includes('quota')) {
    suggestions.push('Check Resend usage limits; consider upgrading your plan if you exceeded the quota.');
  }
  if (lower.includes('dkim') || lower.includes('spf')) {
    suggestions.push('Make sure SPF and DKIM DNS records are correctly configured for your domain.');
  }
  if (!suggestions.length) {
    suggestions.push('Review the Resend dashboard event logs for detailed failure information.');
  }
  return suggestions;
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') {
    return '';
  }
  const cleaned = sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} }).trim();
  return cleaned.slice(0, 80);
}

function escapeHtml(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEmail(value) {
  const email = extractEmailAddress(value);
  return email ? email.toLowerCase() : null;
}

/**
 * Shared helper to send email via Resend with consistent diagnostics.
 */
async function sendWithResend(payload, context = {}) {
  const start = performance.now();
  const normalizedPayload = {
    ...payload,
    to: Array.isArray(payload.to) ? payload.to : [payload.to].filter(Boolean),
  };

  logger.info('Resend send initiated.', {
    context,
    from: normalizedPayload.from,
    to: normalizedPayload.to,
    toCount: normalizedPayload.to.length,
    subject: normalizedPayload.subject,
    htmlLength: normalizedPayload.html?.length || 0,
    textLength: normalizedPayload.text?.length || 0,
  });

  normalizedPayload.to.forEach((recipient, index) => {
    logger.info('Resend recipient target.', { context, index, email: recipient });
  });

  try {
    const { data, error } = await resendClient.emails.send(normalizedPayload);
    const durationMs = Math.round(performance.now() - start);

    if (error) {
      logger.error('Resend API error response.', {
        context,
        durationMs,
        message: error?.message,
        statusCode: error?.statusCode,
        name: error?.name,
        response: error?.response,
      });

      if (error?.statusCode === 401 || error?.statusCode === 403) {
        resendStatus = {
          valid: false,
          checkedAt: new Date().toISOString(),
          error: error?.message || 'Authentication failed.',
        };
      }

      return {
        success: false,
        durationMs,
        error,
        data: null,
        payload: normalizedPayload,
      };
    }

    logger.info('Resend API success response.', {
      context,
      durationMs,
      statusCode: data?.statusCode || 202,
      response: data,
      warnings: data?.warnings,
      metadata: data?.metadata,
    });

    if (data?.warnings) {
      logger.warn('Resend API returned warnings.', { context, warnings: data.warnings });
    }

    if (data?.metadata) {
      logger.info('Resend API metadata details.', { context, metadata: data.metadata });
    }

    resendStatus = {
      valid: true,
      checkedAt: new Date().toISOString(),
      error: null,
    };

    return {
      success: true,
      durationMs,
      data,
      error: null,
      payload: normalizedPayload,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);

    logger.error('Unexpected failure while sending via Resend.', {
      context,
      durationMs,
      message: error?.message,
      statusCode: error?.statusCode,
      name: error?.name,
      response: error?.response,
      stack: error?.stack,
    });

    if (error?.statusCode === 401 || error?.statusCode === 403) {
      resendStatus = {
        valid: false,
        checkedAt: new Date().toISOString(),
        error: error?.message || 'Authentication failed.',
      };
    }

    return {
      success: false,
      durationMs,
      error,
      data: null,
      payload: normalizedPayload,
    };
  }
}

/**
 * Build responsive, inline-styled email template.
 */
function buildEmailTemplate(title, content, previewText = '', unsubscribeLink = '', subscriberName = '') {
  const safeName = escapeHtml(subscriberName);
  const showGreeting = Boolean(safeName);
  const safeUnsubscribeLink = unsubscribeLink || '';
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f6f6f6;">
    <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
      ${previewText || ''}
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f6f6f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px rgba(149,157,165,0.2);">
            <tr>
              <td style="padding:32px 32px 16px 32px;">
                <h1 style="margin:0;font-size:28px;font-family:Arial,Helvetica,sans-serif;color:#111827;">${title}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#374151;">
                ${showGreeting ? `<p style="margin-top:0;margin-bottom:16px;">Hi ${safeName},</p>` : ''}
                ${content}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;text-align:center;background-color:#f9fafb;">
                <p style="margin:0;">You are receiving this email because you subscribed to our newsletter.</p>
                <p style="margin:8px 0 0 0;">If this was a mistake you can ignore this message or unsubscribe.</p>
                ${
                  safeUnsubscribeLink
                    ? `<p style="margin:12px 0 0 0;">
                        <a href="${safeUnsubscribeLink}" style="color:#2563eb;text-decoration:underline;">
                          Unsubscribe from this list
                        </a>
                      </p>`
                    : ''
                }
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

/**
 * Best-effort check to confirm the Resend API key is valid.
 */
async function verifyResendCredentials() {
  try {
    await resendClient.apiKeys.list();
    resendStatus = {
      valid: true,
      checkedAt: new Date().toISOString(),
      error: null,
    };
    logger.info('Resend API key verified with Resend API.');
  } catch (error) {
    resendStatus = {
      valid: false,
      checkedAt: new Date().toISOString(),
      error: error?.message || String(error),
    };
    logger.warn('Unable to verify Resend API key during startup.', {
      message: error?.message,
      statusCode: error?.statusCode,
      name: error?.name,
    });
  }
}

verifyResendCredentials();

app.set('trust proxy', 1);

const corsConfig = {
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};

app.use(cors(corsConfig));
app.options('*', cors(corsConfig));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP ${req.ip}`);
    res.status(429).json({ message: 'Too many requests. Please slow down and try again later.' });
  },
});

const publicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    logger.warn('Public subscription rate limit exceeded.', {
      ip: req.ip,
      path: req.originalUrl,
    });
    res
      .status(429)
      .json({ success: false, error: 'Too many requests. Please try again later.' });
  },
});

app.use('/api/public', publicLimiter);
app.use('/api', apiLimiter);

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Ensure data directory exists before interacting with the JSON file.
 */
async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

/**
 * Read subscribers from JSON file.
 */
async function readSubscribers() {
  await ensureDataDir();
  try {
    const data = await fs.readFile(subscribersPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(subscribersPath, JSON.stringify([]));
      return [];
    }
    throw error;
  }
}

/**
 * Write subscribers array to JSON file.
 * @param {Array} subscribers
 */
async function writeSubscribers(subscribers) {
  await ensureDataDir();
  await fs.writeFile(subscribersPath, JSON.stringify(subscribers, null, 2));
}

/**
 * Extract the actual email address from a value that may include a display name.
 */
function extractEmailAddress(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const hasLt = trimmed.includes('<');
  const hasGt = trimmed.includes('>');

  if (!hasLt && !hasGt) {
    return trimmed;
  }

  if (!hasLt || !hasGt) {
    return null;
  }

  const start = trimmed.lastIndexOf('<');
  const end = trimmed.indexOf('>', start);

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const suffix = trimmed.slice(end + 1).trim();
  if (suffix.length > 0) {
    return null;
  }

  const email = trimmed.slice(start + 1, end).trim();
  return email || null;
}

/**
 * Validate an email address, allowing optional display name wrapper.
 */
function isValidEmail(value) {
  const email = extractEmailAddress(value);
  if (!email) {
    return false;
  }
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email);
}

/**
 * GET subscribers list.
 */
app.get('/api/subscribers', async (_, res) => {
  try {
    const subscribers = await readSubscribers();
    res.json({ subscribers });
  } catch (error) {
    logger.error('Failed to read subscribers:', error);
    res.status(500).json({ message: 'Failed to load subscribers.' });
  }
});

/**
 * Add a new subscriber.
 */
app.post('/api/subscribers', async (req, res) => {
  const { email } = req.body;

  if (!email || !isValidEmail(email)) {
    res.status(400).json({ message: 'Please provide a valid email address.' });
    return;
  }

  const normalizedEmail = extractEmailAddress(email);

  try {
    const subscribers = await readSubscribers();
    const alreadyExists = subscribers.some(
      (subscriber) =>
        extractEmailAddress(subscriber.email)?.toLowerCase() === normalizedEmail.toLowerCase(),
    );

    if (alreadyExists) {
      res.status(409).json({ message: 'This email is already subscribed.' });
      return;
    }

    const newSubscriber = {
      email: normalizedEmail,
      joinedAt: new Date().toISOString(),
    };

    subscribers.push(newSubscriber);
    await writeSubscribers(subscribers);
    res.status(201).json({ subscriber: newSubscriber });
  } catch (error) {
    logger.error('Failed to add subscriber:', error);
    res.status(500).json({ message: 'Could not add subscriber. Please try again later.' });
  }
});

/**
 * Remove an existing subscriber.
 */
app.delete('/api/subscribers/:encodedEmail', async (req, res) => {
  const email = decodeURIComponent(req.params.encodedEmail);
  const normalizedTarget = extractEmailAddress(email);

  if (!normalizedTarget) {
    res.status(400).json({ message: 'Invalid email address provided.' });
    return;
  }

  try {
    const subscribers = await readSubscribers();
    const filtered = subscribers.filter(
      (subscriber) =>
        extractEmailAddress(subscriber.email)?.toLowerCase() !== normalizedTarget.toLowerCase(),
    );

    if (filtered.length === subscribers.length) {
      res.status(404).json({ message: 'Subscriber not found.' });
      return;
    }

    await writeSubscribers(filtered);
    res.status(200).json({ message: 'Subscriber removed.' });
  } catch (error) {
    logger.error('Failed to remove subscriber:', error);
    res.status(500).json({ message: 'Could not remove subscriber.' });
  }
});

/**
 * Public subscription endpoint for external sites.
 */
app.post('/api/public/subscribe', async (req, res) => {
  const ip = req.ip;
  const { email, name } = req.body || {};
  const sanitizedName = sanitizeName(typeof name === 'string' ? name : '');
  const honeypotValue =
    (req.body && (req.body.honeypot || req.body.hp || req.body.botField)) || '';

  logger.info('Public subscribe attempt received.', { ip, email, name: sanitizedName });

  if (honeypotValue) {
    recordSuspiciousAttempt(ip, 'honeypot-triggered', { email, name: sanitizedName });
    res.status(200).json({ success: false, error: 'Unable to process the request.' });
    return;
  }

  if (!email || !isValidEmail(email)) {
    recordSuspiciousAttempt(ip, 'invalid-email', { email });
    res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  try {
    const subscribers = await readSubscribers();
    const alreadyExists = subscribers.some(
      (subscriber) => normalizeEmail(subscriber.email) === normalizedEmail,
    );

    if (alreadyExists) {
      logger.info('Public subscribe duplicate attempt.', { ip, email: normalizedEmail });
      res.status(200).json({ success: false, error: 'Email already subscribed' });
      return;
    }

    const newSubscriber = {
      email: normalizedEmail,
      ...(sanitizedName ? { name: sanitizedName } : {}),
      joinedAt: new Date().toISOString(),
      source: 'public-api',
    };

    subscribers.push(newSubscriber);
    await writeSubscribers(subscribers);

    logger.info('Public subscribe success.', { ip, email: normalizedEmail, name: sanitizedName });
    res.json({ success: true, message: 'Successfully subscribed!' });
  } catch (error) {
    logger.error('Public subscribe failed.', {
      ip,
      email: normalizedEmail,
      message: error?.message,
    });
    res.status(500).json({
      success: false,
      error: 'We could not process your subscription right now. Please try again later.',
    });
  }
});

/**
 * Public unsubscribe endpoint.
 */
app.post('/api/public/unsubscribe', async (req, res) => {
  const ip = req.ip;
  const { email } = req.body || {};
  const honeypotValue =
    (req.body && (req.body.honeypot || req.body.hp || req.body.botField)) || '';

  logger.info('Public unsubscribe attempt received.', { ip, email });

  if (honeypotValue) {
    recordSuspiciousAttempt(ip, 'honeypot-triggered-unsubscribe', { email });
    res.status(200).json({ success: false, error: 'Unable to process the request.' });
    return;
  }

  if (!email || !isValidEmail(email)) {
    recordSuspiciousAttempt(ip, 'invalid-email-unsubscribe', { email });
    res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
    return;
  }

  const normalizedEmail = normalizeEmail(email);

  try {
    const subscribers = await readSubscribers();
    const filtered = subscribers.filter(
      (subscriber) => normalizeEmail(subscriber.email) !== normalizedEmail,
    );

    if (filtered.length === subscribers.length) {
      logger.info('Public unsubscribe not found.', { ip, email: normalizedEmail });
      recordSuspiciousAttempt(ip, 'unsubscribe-not-found', { email: normalizedEmail });
      res.status(200).json({ success: false, error: 'Email not found' });
      return;
    }

    await writeSubscribers(filtered);
    logger.info('Public unsubscribe success.', { ip, email: normalizedEmail });
    res.json({ success: true, message: 'Successfully unsubscribed' });
  } catch (error) {
    logger.error('Public unsubscribe failed.', {
      ip,
      email: normalizedEmail,
      message: error?.message,
    });
    res.status(500).json({
      success: false,
      error: 'We could not process your unsubscribe request right now. Please try again later.',
    });
  }
});

/**
 * Lightweight status endpoint for external integrations.
 */
app.get('/api/test-subscribe', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Newsletter subscription API is reachable.',
    cors: '*',
    rateLimit: '10 requests per IP per hour',
    endpoints: {
      subscribe: '/api/public/subscribe',
      unsubscribe: '/api/public/unsubscribe',
    },
    example: {
      subscribe: {
        method: 'POST',
        url: '/api/public/subscribe',
        body: { email: 'user@example.com', name: 'Sample Name' },
      },
      unsubscribe: {
        method: 'POST',
        url: '/api/public/unsubscribe',
        body: { email: 'user@example.com' },
      },
    },
  });
});

/**
 * Handle image uploads for the newsletter editor by streaming to Cloudinary.
 */
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: 'No image uploaded.' });
    return;
  }

  try {
    const uploadResult = await cloudinary.uploader.upload(
      `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
      {
        folder: 'newsletter/uploads',
        use_filename: true,
        unique_filename: true,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      },
    );

    if (!uploadResult?.secure_url) {
      throw new Error('Cloudinary did not return a secure URL.');
    }

    res.status(201).json({ imageUrl: uploadResult.secure_url });
  } catch (error) {
    logger.error('Failed to upload image to Cloudinary:', error);
    res.status(502).json({
      message: 'Image upload failed. Please try again later.',
      details: 'Cloud storage is temporarily unavailable.',
    });
  }
});

/**
 * Send the newsletter to all subscribers.
 * Steps: sanitize content -> validate subscriber list -> send personalized emails sequentially with diagnostics.
 */
app.post('/api/send-newsletter', async (req, res) => {
  const { title, content, previewText } = req.body;

  if (!title || !content) {
    res.status(400).json({ message: 'Title and content are required.' });
    return;
  }

  if (!resendClient || !senderEmail) {
    res.status(500).json({
      message: 'Email service not configured. Please check your environment variables.',
    });
    return;
  }

  if (!isValidEmail(senderEmail)) {
    logger.error('SENDER_EMAIL failed validation during send.', { senderEmail });
    res.status(500).json({
      message: 'SENDER_EMAIL is not a valid email address. Update your configuration and try again.',
    });
    return;
  }

  try {
    const sanitizedContent = sanitizeHtml(content, sanitizerOptions);
    const subscribers = await readSubscribers();

    if (subscribers.length === 0) {
      lastEmailDiagnostic = {
        timestamp: new Date().toISOString(),
        status: 'skipped',
        context: 'send-newsletter',
        recipients: [],
        reason: 'no-subscribers',
      };
      res.status(400).json({ message: 'No subscribers available to send the newsletter.' });
      return;
    }

    const invalidSubscribers = subscribers.filter(
      (subscriber) => !isValidEmail(subscriber.email),
    );

    if (invalidSubscribers.length > 0) {
      const invalidList = invalidSubscribers.map((subscriber) => subscriber.email);
      logger.warn('Invalid subscriber emails detected, aborting send.', { invalidList });
      lastEmailDiagnostic = {
        timestamp: new Date().toISOString(),
        status: 'error',
        context: 'send-newsletter',
        recipients: invalidList,
        reason: 'invalid-subscribers',
      };
      res.status(400).json({
        message: 'One or more subscriber email addresses are invalid. Please fix them and try again.',
        invalidEmails: invalidList,
      });
      return;
    }

    const unsubscribeBase = appUrl.replace(/\/$/, '');
    const strippedContent = stripHtml(sanitizedContent);
    const previewSnippet = typeof previewText === 'string' ? previewText.trim() : '';
    const summary = {
      total: subscribers.length,
      successes: [],
      failures: [],
    };

    for (const subscriber of subscribers) {
      const recipientEmail = normalizeEmail(subscriber.email);

      if (!recipientEmail) {
        logger.error('Stored subscriber email is invalid. Skipping recipient.', {
          rawValue: subscriber.email,
        });
        summary.failures.push({
          email: subscriber.email,
          error: 'Stored subscriber email is invalid.',
          statusCode: 400,
        });
        continue;
      }

      const unsubscribeLink = `${unsubscribeBase}/unsubscribe?email=${encodeURIComponent(
        recipientEmail,
      )}`;

      const personalizedHtml = buildEmailTemplate(
        title,
        sanitizedContent,
        previewSnippet,
        unsubscribeLink,
        subscriber.name || '',
      );

      const plainTextBody = `${
        previewSnippet ? `${previewSnippet}\n\n` : ''
      }${strippedContent}\n\nUnsubscribe: ${unsubscribeLink}`;

      const sendResult = await sendWithResend(
        {
          from: senderEmail,
          to: [recipientEmail],
          subject: title,
          html: personalizedHtml,
          text: plainTextBody,
        },
        {
          endpoint: 'send-newsletter',
          subject: title,
          recipient: recipientEmail,
          previewTextLength: previewSnippet.length,
        },
      );

      if (sendResult.success && sendResult.data?.id) {
        summary.successes.push({
          email: recipientEmail,
          id: sendResult.data.id,
          durationMs: sendResult.durationMs,
          dns: sendResult.data?.dns,
          spf: sendResult.data?.spf,
          dkim: sendResult.data?.dkim,
        });
      } else {
        const resendError = sendResult.error;
        const failureMessage =
          resendError?.message || sendResult.data?.message || 'Unknown Resend error.';
        summary.failures.push({
          email: recipientEmail,
          error: failureMessage,
          statusCode: resendError?.statusCode,
          response: resendError?.response || sendResult.data,
          suggestions: buildResendSuggestions(failureMessage),
        });
      }
    }

    const totalDuration = summary.successes.reduce(
      (acc, item) => acc + (item.durationMs || 0),
      0,
    );

    lastEmailDiagnostic = {
      timestamp: new Date().toISOString(),
      status:
        summary.failures.length === 0
          ? 'success'
          : summary.failures.length === summary.total
          ? 'error'
          : 'partial',
      context: 'send-newsletter',
      recipients: subscribers
        .map((subscriber) => normalizeEmail(subscriber.email))
        .filter(Boolean),
      durationMs: totalDuration,
      response: summary,
    };

    if (summary.failures.length === summary.total) {
      res.status(502).json({
        message: 'Failed to send newsletter to subscribers.',
        summary,
      });
      return;
    }

    res.status(summary.failures.length ? 207 : 200).json({
      message: summary.failures.length
        ? 'Newsletter sent with some issues.'
        : 'Newsletter sent successfully.',
      summary,
    });
  } catch (error) {
    logger.error('Failed to send newsletter.', {
      message: error?.message,
      statusCode: error?.statusCode,
      name: error?.name,
      response: error?.response,
      stack: error?.stack,
    });
    const friendlyMessage =
      error?.response?.body?.message || error.message || 'Unknown error occurred.';

    const suggestions = buildResendSuggestions(error?.message);

    lastEmailDiagnostic = {
      timestamp: new Date().toISOString(),
      status: 'error',
      context: 'send-newsletter',
      recipients: [],
      error: {
        message: error?.message,
        statusCode: error?.statusCode,
        response: error?.response,
      },
    };

    res.status(500).json({
      message: 'Failed to send newsletter.',
      details: friendlyMessage,
      meta: {
        errorName: error?.name,
        statusCode: error?.statusCode,
        resendResponse: error?.response,
      },
      suggestions,
    });
  }
});

/**
 * Send a single test email for diagnostics purposes.
 */
app.post('/api/test-email', async (req, res) => {
  const { testEmail, includeImage, includImage } = req.body || {};
  const targetEmail = typeof testEmail === 'string' ? testEmail.trim() : '';
  const useImage = Boolean(includeImage ?? includImage ?? false);

  if (!targetEmail || !isValidEmail(targetEmail)) {
    res.status(400).json({ message: 'Please provide a valid testEmail.' });
    return;
  }

  if (!isValidEmail(senderEmail)) {
    logger.error('SENDER_EMAIL failed validation during test-email send.', { senderEmail });
    res.status(500).json({
      message: 'SENDER_EMAIL is not a valid email address. Update your configuration and try again.',
    });
    return;
  }

  const htmlBody = `
    <div style="font-family: Arial, Helvetica, sans-serif; line-height:1.6; color:#374151;">
      <h2 style="color:#111827;">Newsletter Delivery Test</h2>
      <p>This is a diagnostic email sent at ${new Date().toISOString()}.</p>
      ${
        useImage
          ? '<p><img src="https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_480/sample.jpg" alt="Diagnostic image" style="max-width:100%;border-radius:8px;" /></p>'
          : ''
      }
      <p>If you received this message, your Resend configuration is working.</p>
    </div>
  `;

  const sanitizedHtmlBody = sanitizeHtml(htmlBody, sanitizerOptions);
  const unsubscribeLink = `${appUrl.replace(/\/$/, '')}/unsubscribe?email=${encodeURIComponent(
    targetEmail,
  )}`;
  const plainTextBody = `${stripHtml(sanitizedHtmlBody)}\n\nUnsubscribe: ${unsubscribeLink}`;

  const emailPayload = {
    from: senderEmail,
    to: [targetEmail],
    subject: 'Newsletter Delivery Test',
    html: buildEmailTemplate(
      'Newsletter Delivery Test',
      sanitizedHtmlBody,
      '',
      unsubscribeLink,
    ),
    text: plainTextBody,
  };

  const sendResult = await sendWithResend(emailPayload, {
    endpoint: 'test-email',
    target: targetEmail,
    includeImage: useImage,
  });

  const payloadSummary = sendResult.payload
    ? {
        subject: sendResult.payload.subject,
        toCount: sendResult.payload.to?.length || 0,
        htmlLength: sendResult.payload.html?.length || 0,
        textLength: sendResult.payload.text?.length || 0,
      }
    : undefined;

  if (!sendResult.success) {
    const resendError = sendResult.error;
    const suggestions = buildResendSuggestions(resendError?.message);

    lastEmailDiagnostic = {
      timestamp: new Date().toISOString(),
      status: 'error',
      context: 'test-email',
      recipients: [targetEmail],
      durationMs: sendResult.durationMs,
      error: {
        message: resendError?.message,
        statusCode: resendError?.statusCode,
        response: resendError?.response,
      },
      payloadSummary,
    };

    res.status(502).json({
      message: 'Test email failed to send via Resend.',
      details: resendError?.message || 'Unknown Resend error.',
      statusCode: resendError?.statusCode,
      suggestions,
      resendResponse: resendError?.response,
      durationMs: sendResult.durationMs,
    });
    return;
  }

  const data = sendResult.data;

  if (!data?.id) {
    lastEmailDiagnostic = {
      timestamp: new Date().toISOString(),
      status: 'error',
      context: 'test-email',
      recipients: [targetEmail],
      durationMs: sendResult.durationMs,
      error: {
        message: 'Resend did not return a message ID for test email.',
        response: data,
      },
      payloadSummary,
    };

    res.status(502).json({
      message: 'Resend did not return a message ID for the test email.',
      details: data,
      durationMs: sendResult.durationMs,
    });
    return;
  }

  logger.info('Test email sent successfully via Resend.', {
    id: data.id,
    durationMs: sendResult.durationMs,
    dns: data?.dns,
    spf: data?.spf,
    dkim: data?.dkim,
  });

  lastEmailDiagnostic = {
    timestamp: new Date().toISOString(),
    status: 'success',
    context: 'test-email',
    recipients: [targetEmail],
    durationMs: sendResult.durationMs,
    response: data,
    payloadSummary,
  };

  res.status(200).json({
    message: 'Test email sent successfully.',
    id: data.id,
    resendResponse: data,
    durationMs: sendResult.durationMs,
    dns: data?.dns,
    spf: data?.spf,
    dkim: data?.dkim,
  });
});

/**
 * Diagnostics endpoint for quick status checks.
 */
app.get('/api/diagnostics', async (_, res) => {
  try {
    const subscribers = await readSubscribers();
    let cloudinaryStatus = {
      ok: true,
      message: 'Connected',
    };

    try {
      const ping = await cloudinary.api.ping();
      cloudinaryStatus = {
        ok: true,
        message: 'Connected',
        response: ping,
      };
    } catch (cloudError) {
      cloudinaryStatus = {
        ok: false,
        message: cloudError?.message || 'Cloudinary ping failed.',
        statusCode: cloudError?.http_code,
      };
      logger.warn('Cloudinary ping failed during diagnostics.', {
        message: cloudError?.message,
        statusCode: cloudError?.http_code,
      });
    }

    const suspiciousSummary = Array.from(suspiciousAttempts.entries()).map(([ip, data]) => ({
      ip,
      attempts: data.count,
      lastAttempt: data.lastAttempt,
      recentReasons: data.reasons.slice(-5),
    }));

    res.json({
      senderEmail,
      senderEmailValid: isValidEmail(senderEmail),
      senderEmailIsTestDomain: senderEmail.toLowerCase().includes('onboarding@resend.dev'),
      subscriberCount: subscribers.length,
      resendStatus,
      cloudinaryStatus,
      lastEmailSent: lastEmailDiagnostic,
      publicRateLimit: '10 requests per IP per hour',
      suspiciousActivity: suspiciousSummary,
    });
  } catch (error) {
    logger.error('Diagnostics endpoint failed.', {
      message: error?.message,
      statusCode: error?.statusCode,
      name: error?.name,
    });
    res.status(500).json({
      message: 'Diagnostics check failed.',
      details: error?.message,
    });
  }
});

app.get('/unsubscribe', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'unsubscribe.html'));
});

/**
 * Fallback route to serve index.html for any unknown routes (single-page feel).
 */
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Centralized error handler to surface Multer and CORS errors politely.
 */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ message: 'Image is too large. Max size is 5MB.' });
      return;
    }
    res.status(400).json({ message: `Upload failed: ${err.message}` });
    return;
  }

  if (err?.message === 'Not allowed by CORS') {
    res.status(403).json({ message: 'Request blocked by CORS policy.' });
    return;
  }

  if (err) {
    logger.error('Unhandled error occurred:', err);
    res.status(500).json({ message: 'Unexpected server error occurred.' });
    return;
  }

  next();
});

app.listen(PORT, () => {
  logger.info(`Newsletter app running at http://localhost:${PORT}`);
});
