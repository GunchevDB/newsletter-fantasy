/**
 * Production-ready Express server for the newsletter application.
 * Handles subscriber management, Cloudinary-backed image uploads,
 * sanitized rich text newsletters, and delivery via Resend.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const session = require('express-session');
const bcrypt = require('bcrypt');
const csrf = require('csurf');
const { Resend } = require('resend');
const { v2: cloudinary } = require('cloudinary');
const { performance } = require('perf_hooks');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SUBSCRIBERS_SET_KEY = 'newsletter:subscribers';
const SUBSCRIBER_HASH_PREFIX = 'newsletter:subscriber:';
const RESEND_BATCH_SIZE = 2;
const RESEND_BATCH_DELAY_MS = 1000;
const RESEND_MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_SCHEDULE_MS = [2000, 4000];

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

const KV_ENV_VARS = ['STORAGE_REST_API_URL', 'STORAGE_REST_API_TOKEN'];
const inMemorySubscribers = new Map();
let kvClient = null;
let kvInitializationError = null;
let subscriberStoreMode = 'memory';

(function initializeSubscriberStore() {
  const missingKvEnv = KV_ENV_VARS.filter((key) => !process.env[key]);

  if (missingKvEnv.length === 0) {
    try {
      const { createClient } = require('@vercel/kv');
      kvClient = createClient({
        url: process.env.STORAGE_REST_API_URL,
        token: process.env.STORAGE_REST_API_TOKEN,
      });
      if (!kvClient) {
        throw new Error('Vercel KV client not available.');
      }
      subscriberStoreMode = 'kv';
      kvInitializationError = null;
      logger.info('Subscriber storage configured to use Vercel KV (REST API).', {
        restApiUrl: process.env.STORAGE_REST_API_URL,
      });
    } catch (error) {
      kvInitializationError = error;
      subscriberStoreMode = 'memory';
      logger.error(
        'Failed to initialize Vercel KV client. Falling back to in-memory subscriber storage.',
        { message: error?.message },
      );
    }
  } else {
    logger.warn(
      'Vercel KV environment not detected (set STORAGE_REST_API_URL and STORAGE_REST_API_TOKEN). Using in-memory subscriber storage.',
    );
  }

  if (subscriberStoreMode === 'memory') {
    logger.info('Subscriber storage is in-memory; data resets when the server restarts.');
  }
})();

const requiredEnvVars = [
  'RESEND_API_KEY',
  'SENDER_EMAIL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'APP_URL',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
];

const missingEnv = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnv.length) {
  logger.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  throw new Error('Environment not configured. Check your .env file.');
}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DEFAULT_SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const adminPasswordLooksHashed = /^\$2[aby]\$/.test(ADMIN_PASSWORD || '');
let adminPasswordHash;

if (adminPasswordLooksHashed) {
  adminPasswordHash = ADMIN_PASSWORD;
} else {
  const SALT_ROUNDS = 12;
  adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, SALT_ROUNDS);
  logger.warn(
    'ADMIN_PASSWORD is not stored as a bcrypt hash. A hash has been generated at runtime; update your environment with the hashed value for best security.',
  );
}

const loginTemplatePath = path.join(__dirname, 'public', 'login.html');
let loginTemplate = '';
try {
  loginTemplate = fs.readFileSync(loginTemplatePath, 'utf8');
} catch (error) {
  logger.error('Failed to load login template.', { message: error?.message });
  loginTemplate = '';
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

function renderLoginPage({
  csrfToken,
  message,
  messageType = 'info',
  nextValue = '/',
  rememberMe = false,
} = {}) {
  const safeMessage =
    message && typeof message === 'string'
      ? `<div class="auth-alert auth-alert--${messageType}">${escapeHtml(message)}</div>`
      : '';
  const safeNextValue = escapeHtml(nextValue || '/');
  const rememberAttr = rememberMe ? 'checked' : '';

  if (!loginTemplate) {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Login</title>
  </head>
  <body>
    ${safeMessage}
    <form method="POST" action="/login">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken || '')}" />
      <input type="hidden" name="next" value="${safeNextValue}" />
      <div>
        <label>Username <input type="text" name="username" autocomplete="username" /></label>
      </div>
      <div>
        <label>Password <input type="password" name="password" autocomplete="current-password" /></label>
      </div>
      <div>
        <label><input type="checkbox" name="remember" ${rememberAttr} /> Remember me</label>
      </div>
      <button type="submit">Login</button>
    </form>
  </body>
</html>`;
  }

  return loginTemplate
    .replace(/{{CSRF_TOKEN}}/g, escapeHtml(csrfToken || ''))
    .replace(/{{MESSAGE}}/g, safeMessage)
    .replace(/{{NEXT_VALUE}}/g, safeNextValue)
    .replace(/{{REMEMBER_CHECKED}}/g, rememberAttr);
}

function normalizeEmail(value) {
  const email = extractEmailAddress(value);
  return email ? email.toLowerCase() : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const statusCandidates = [
    error.statusCode,
    error.status,
    error?.response?.statusCode,
    error?.response?.status,
  ].filter((value) => typeof value === 'number');
  if (statusCandidates.includes(429)) {
    return true;
  }
  const message = (error.message || '').toString().toLowerCase();
  return message.includes('rate limit') || message.includes('too many requests');
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

const sessionConfig = {
  name: 'newsletter.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: DEFAULT_SESSION_MAX_AGE,
  },
};

app.use(session(sessionConfig));

app.use((req, res, next) => {
  if (req.session && req.session.isAuthenticated) {
    const targetMaxAge = req.session.rememberMe ? REMEMBER_ME_MAX_AGE : DEFAULT_SESSION_MAX_AGE;
    if (req.session.cookie.maxAge !== targetMaxAge) {
      req.session.cookie.maxAge = targetMaxAge;
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const csrfProtection = csrf();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    logger.warn('Login rate limit exceeded.', { ip: req.ip });
    if (req.session) {
      req.session.authFeedback = {
        type: 'error',
        text: 'Too many login attempts. Please try again in 15 minutes.',
        statusCode: 429,
      };
    }
    res.status(429).redirect('/login');
  },
});

function getSafeRedirect(target) {
  if (typeof target !== 'string' || target.length === 0) {
    return '/';
  }
  if (!target.startsWith('/')) {
    return '/';
  }
  if (target.startsWith('//')) {
    return '/';
  }
  if (target.startsWith('/login') || target.startsWith('/logout')) {
    return '/';
  }
  return target;
}

function ensureAuthenticatedView(req, res, next) {
  if (req.session?.isAuthenticated) {
    next();
    return;
  }
  const redirectTarget = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${redirectTarget}`);
}

function ensureAuthenticatedApi(req, res, next) {
  if (req.session?.isAuthenticated) {
    next();
    return;
  }
  res.status(401).json({ message: 'Authentication required.' });
}

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

app.get('/login', csrfProtection, (req, res) => {
  if (req.session?.isAuthenticated) {
    const redirectTarget = getSafeRedirect(req.query.next);
    res.redirect(redirectTarget);
    return;
  }

  const feedback = req.session?.authFeedback || {};
  if (req.session) {
    delete req.session.authFeedback;
  }

  let message = feedback.text || '';
  let messageType = feedback.type || 'info';
  if (req.query.loggedOut === '1') {
    message = 'Logged out successfully.';
    messageType = 'success';
  } else if (req.query.timeout === '1') {
    message = 'Your session has expired. Please log in again.';
    messageType = 'info';
  }

  const nextParam = typeof req.query.next === 'string' ? req.query.next : '/';
  const html = renderLoginPage({
    csrfToken: req.csrfToken(),
    message,
    messageType,
    nextValue: getSafeRedirect(nextParam),
    rememberMe: Boolean(feedback.remember),
  });

  res.status(feedback.statusCode || 200).send(html);
});

app.post('/login', loginLimiter, csrfProtection, async (req, res) => {
  const { username, password, remember, next: nextParam } = req.body || {};
  const nextPath = getSafeRedirect(nextParam);
  const rememberMe = remember === 'on';

  if (!username || !password) {
    if (req.session) {
      req.session.authFeedback = {
        type: 'error',
        text: 'Username and password are required.',
        remember: rememberMe,
      };
    }
    res.redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    return;
  }

  let passwordMatches = false;
  try {
    passwordMatches = await bcrypt.compare(password, adminPasswordHash);
  } catch (error) {
    logger.error('Bcrypt comparison failed during login.', {
      message: error?.message,
    });
  }

  if (username !== ADMIN_USERNAME || !passwordMatches) {
    logger.warn('Authentication attempt failed.', {
      ip: req.ip,
      usernameAttempt: username,
    });
    recordSuspiciousAttempt(req.ip, 'invalid-login', { usernameAttempt: username });
    if (req.session) {
      req.session.authFeedback = {
        type: 'error',
        text: 'Invalid username or password.',
        remember: rememberMe,
      };
    }
    res.redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    return;
  }

  req.session.isAuthenticated = true;
  req.session.username = ADMIN_USERNAME;
  req.session.rememberMe = rememberMe;
  req.session.loginAt = new Date().toISOString();
  req.session.cookie.maxAge = rememberMe ? REMEMBER_ME_MAX_AGE : DEFAULT_SESSION_MAX_AGE;

  logger.info('Authentication succeeded.', { ip: req.ip, username: ADMIN_USERNAME });

  res.redirect(nextPath);
});

app.post('/logout', (req, res) => {
  const username = req.session?.username;
  logger.info('Logout requested.', { ip: req.ip, username });
  const clearSessionAndRespond = () => {
    res.clearCookie('newsletter.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    res.status(200).json({ redirect: '/login?loggedOut=1' });
  };

  if (req.session) {
    req.session.destroy((error) => {
      if (error) {
        logger.error('Failed to destroy session on logout.', {
          message: error?.message,
        });
      }
      clearSessionAndRespond();
    });
  } else {
    clearSessionAndRespond();
  }
});

app.get('/', ensureAuthenticatedView, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

class SubscriberStorageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SubscriberStorageError';
    if (options.cause) {
      this.cause = options.cause;
    }
    this.code = options.code || 'storage-error';
  }
}

function subscriberHashKey(normalizedEmail) {
  return `${SUBSCRIBER_HASH_PREFIX}${normalizedEmail}`;
}

function sortSubscribers(list) {
  return [...list]
    .filter(Boolean)
    .sort((a, b) => {
      const first = a?.subscribedAt || a?.joinedAt || '';
      const second = b?.subscribedAt || b?.joinedAt || '';
      if (first === second) {
        return (a?.email || '').localeCompare(b?.email || '');
      }
      return first.localeCompare(second);
    });
}

function normalizeRecordShape(rawRecord = {}) {
  if (!rawRecord) {
    return null;
  }

  const record = { ...rawRecord };
  record.subscribedAt = record.subscribedAt || record.joinedAt || new Date().toISOString();
  record.joinedAt = record.joinedAt || record.subscribedAt;
  return record;
}

async function getSubscribers() {
  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
      const emails = await kvClient.smembers(SUBSCRIBERS_SET_KEY);
      if (!emails || emails.length === 0) {
        return [];
      }

      const subscribers = await Promise.all(
        emails.map(async (normalizedEmail) => {
          try {
            const hash = await kvClient.hgetall(subscriberHashKey(normalizedEmail));
            if (!hash || Object.keys(hash).length === 0) {
              return null;
            }
            const hydrated = Object.entries(hash).reduce((acc, [key, value]) => {
              if (value === undefined || value === null) {
                return acc;
              }
              if (key === 'metadata') {
                try {
                  acc.metadata = JSON.parse(value);
                  return acc;
                } catch {
                  acc.metadata = value;
                  return acc;
                }
              }
              acc[key] = value;
              return acc;
            }, {});
            if (!hydrated.email) {
              hydrated.email = normalizedEmail;
            }
            const merged = normalizeRecordShape(hydrated);
            return merged;
          } catch (innerError) {
            logger.warn('Failed to hydrate subscriber from Vercel KV.', {
              email: normalizedEmail,
              message: innerError?.message,
            });
            return null;
          }
        }),
      );

      return sortSubscribers(subscribers.filter(Boolean));
    } catch (error) {
      logger.error('Vercel KV getSubscribers failed.', { message: error?.message });
      throw new SubscriberStorageError('Failed to read subscribers from Vercel KV.', {
        cause: error,
        code: 'kv-read-failed',
      });
    }
  }

  return sortSubscribers(Array.from(inMemorySubscribers.values()).map(normalizeRecordShape));
}

async function addSubscriber(email, name = null, metadata = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new SubscriberStorageError('Cannot add subscriber with invalid email address.', {
      code: 'invalid-email',
    });
  }

  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const timestamp = safeMetadata.subscribedAt || safeMetadata.joinedAt || new Date().toISOString();
  const baseEmail = safeMetadata.email || extractEmailAddress(email) || normalized;

  const additionalMetadata = { ...safeMetadata };
  delete additionalMetadata.email;
  delete additionalMetadata.subscribedAt;
  delete additionalMetadata.joinedAt;

  const record = normalizeRecordShape({
    email: baseEmail,
    subscribedAt: timestamp,
    ...(name ? { name } : {}),
    ...additionalMetadata,
  });

  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
      const kvPayload = {};
      for (const [key, value] of Object.entries(record)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (typeof value === 'string') {
          kvPayload[key] = value;
        } else {
          kvPayload[key] = JSON.stringify(value);
        }
      }

      await kvClient.sadd(SUBSCRIBERS_SET_KEY, normalized);
      try {
        await kvClient.hset(subscriberHashKey(normalized), kvPayload);
      } catch (writeError) {
        await kvClient.srem(SUBSCRIBERS_SET_KEY, normalized);
        throw writeError;
      }
    } catch (error) {
      logger.error('Vercel KV addSubscriber failed.', { message: error?.message });
      throw new SubscriberStorageError('Failed to add subscriber to Vercel KV.', {
        cause: error,
        code: 'kv-write-failed',
      });
    }
  } else {
    inMemorySubscribers.set(normalized, record);
  }

  return record;
}

async function removeSubscriber(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new SubscriberStorageError('Cannot remove subscriber with invalid email address.', {
      code: 'invalid-email',
    });
  }

  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
      const removed = await kvClient.srem(SUBSCRIBERS_SET_KEY, normalized);
      if (!removed) {
        return false;
      }
      await kvClient.del(subscriberHashKey(normalized));
      return true;
    } catch (error) {
      logger.error('Vercel KV removeSubscriber failed.', { message: error?.message });
      throw new SubscriberStorageError('Failed to remove subscriber from Vercel KV.', {
        cause: error,
        code: 'kv-delete-failed',
      });
    }
  }

  return inMemorySubscribers.delete(normalized);
}

async function subscriberExists(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }

  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
      const exists = await kvClient.sismember(SUBSCRIBERS_SET_KEY, normalized);
      return Boolean(exists);
    } catch (error) {
      logger.error('Vercel KV subscriberExists failed.', { message: error?.message });
      throw new SubscriberStorageError('Failed to check subscriber in Vercel KV.', {
        cause: error,
        code: 'kv-read-failed',
      });
    }
  }

  return inMemorySubscribers.has(normalized);
}

async function sendNewsletterToSubscriber(subscriber, options) {
  const { title, sanitizedContent, previewSnippet, strippedContent, unsubscribeBase } = options;

  const recipientEmail = normalizeEmail(subscriber.email);
  if (!recipientEmail) {
    return {
      success: false,
      error: new Error('Stored subscriber email is invalid.'),
      durationMs: 0,
      attempt: 0,
      retryDelays: [],
      unsubscribeLink: null,
      recipientEmail: subscriber.email,
    };
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

  const payload = {
    from: senderEmail,
    to: [recipientEmail],
    subject: title,
    html: personalizedHtml,
    text: plainTextBody,
  };

  const baseContext = {
    endpoint: 'send-newsletter',
    subject: title,
    recipient: recipientEmail,
    previewTextLength: previewSnippet.length,
  };

  let attempt = 0;
  const retryDelays = [];
  let lastResult = null;

  while (attempt <= RESEND_MAX_RATE_LIMIT_RETRIES) {
    const attemptNumber = attempt + 1;
    const sendResult = await sendWithResend(payload, { ...baseContext, attempt: attemptNumber });
    lastResult = sendResult;

    if (sendResult.success && sendResult.data?.id) {
      return {
        success: true,
        data: sendResult.data,
        durationMs: sendResult.durationMs,
        attempt: attemptNumber,
        retryDelays,
        unsubscribeLink,
        recipientEmail,
      };
    }

    const error = sendResult.error || new Error('Unknown Resend error.');

    if (isRateLimitError(error) && attempt < RESEND_MAX_RATE_LIMIT_RETRIES) {
      const backoffMs =
        RATE_LIMIT_BACKOFF_SCHEDULE_MS[attempt] ||
        RATE_LIMIT_BACKOFF_SCHEDULE_MS[RATE_LIMIT_BACKOFF_SCHEDULE_MS.length - 1];
      retryDelays.push(backoffMs);
      logger.warn('Resend rate limit encountered; retry scheduled.', {
        email: recipientEmail,
        attempt: attemptNumber,
        backoffMs,
      });
      await sleep(backoffMs);
      attempt += 1;
      continue;
    }

    return {
      success: false,
      error,
      durationMs: sendResult.durationMs,
      attempt: attemptNumber,
      retryDelays,
      resendResponse: sendResult.data,
      unsubscribeLink,
      recipientEmail,
    };
  }

  return {
    success: false,
    error: lastResult?.error || new Error('Exceeded maximum retry attempts.'),
    durationMs: lastResult?.durationMs ?? 0,
    attempt: RESEND_MAX_RATE_LIMIT_RETRIES + 1,
    retryDelays:
      RATE_LIMIT_BACKOFF_SCHEDULE_MS.slice(0, RESEND_MAX_RATE_LIMIT_RETRIES) ||
      RATE_LIMIT_BACKOFF_SCHEDULE_MS,
    resendResponse: lastResult?.data,
    unsubscribeLink,
    recipientEmail,
  };
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
app.get('/api/subscribers', ensureAuthenticatedApi, async (_, res) => {
  try {
    const subscribers = await getSubscribers();
    res.json({ subscribers });
  } catch (error) {
    logger.error('Failed to read subscribers.', {
      message: error?.message,
      code: error?.code,
    });
    const message =
      error instanceof SubscriberStorageError
        ? 'Unable to load subscribers from storage. Please verify the Vercel KV configuration.'
        : 'Failed to load subscribers.';
    res.status(500).json({ message });
  }
});

/**
 * Add a new subscriber.
 */
app.post('/api/subscribers', ensureAuthenticatedApi, async (req, res) => {
  const { email, name } = req.body;

  if (!email || !isValidEmail(email)) {
    res.status(400).json({ message: 'Please provide a valid email address.' });
    return;
  }

  const canonicalEmail = extractEmailAddress(email);
  const sanitizedName = sanitizeName(typeof name === 'string' ? name : '');

  try {
    if (await subscriberExists(canonicalEmail)) {
      res.status(409).json({ message: 'This email is already subscribed.' });
      return;
    }

    const newSubscriber = await addSubscriber(canonicalEmail, sanitizedName || null);
    res.status(201).json({ subscriber: newSubscriber });
  } catch (error) {
    logger.error('Failed to add subscriber.', {
      message: error?.message,
      code: error?.code,
    });
    const message =
      error instanceof SubscriberStorageError
        ? 'Could not add subscriber because storage is unavailable. Please verify the Vercel KV connection.'
        : 'Could not add subscriber. Please try again later.';
    res.status(500).json({ message });
  }
});

/**
 * Remove an existing subscriber.
 */
app.delete('/api/subscribers/:encodedEmail', ensureAuthenticatedApi, async (req, res) => {
  const email = decodeURIComponent(req.params.encodedEmail);
  const normalizedTarget = extractEmailAddress(email);

  if (!normalizedTarget) {
    res.status(400).json({ message: 'Invalid email address provided.' });
    return;
  }

  try {
    const removed = await removeSubscriber(normalizedTarget);
    if (!removed) {
      res.status(404).json({ message: 'Subscriber not found.' });
      return;
    }

    res.status(200).json({ message: 'Subscriber removed.' });
  } catch (error) {
    logger.error('Failed to remove subscriber.', {
      message: error?.message,
      code: error?.code,
    });
    const message =
      error instanceof SubscriberStorageError
        ? 'Unable to remove subscriber because storage is unavailable. Please verify the Vercel KV connection.'
        : 'Could not remove subscriber.';
    res.status(500).json({ message });
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
  const canonicalEmail = extractEmailAddress(email);
  try {
    if (await subscriberExists(canonicalEmail)) {
      logger.info('Public subscribe duplicate attempt.', { ip, email: normalizedEmail });
      res.status(200).json({ success: false, error: 'Email already subscribed' });
      return;
    }

    await addSubscriber(canonicalEmail, sanitizedName || null, { source: 'public-api' });

    logger.info('Public subscribe success.', { ip, email: normalizedEmail, name: sanitizedName });
    res.json({ success: true, message: 'Successfully subscribed!' });
  } catch (error) {
    logger.error('Public subscribe failed.', {
      ip,
      email: normalizedEmail,
      message: error?.message,
      code: error?.code,
    });
    const errorMessage =
      error instanceof SubscriberStorageError
        ? 'Subscriber storage is unavailable. Please try again after the Vercel KV connection is restored.'
        : 'We could not process your subscription right now. Please try again later.';
    res.status(500).json({
      success: false,
      error: errorMessage,
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
  const canonicalEmail = extractEmailAddress(email);

  try {
    const removed = await removeSubscriber(canonicalEmail);
    if (!removed) {
      logger.info('Public unsubscribe not found.', { ip, email: normalizedEmail });
      recordSuspiciousAttempt(ip, 'unsubscribe-not-found', { email: normalizedEmail });
      res.status(200).json({ success: false, error: 'Email not found' });
      return;
    }

    logger.info('Public unsubscribe success.', { ip, email: normalizedEmail });
    res.json({ success: true, message: 'Successfully unsubscribed' });
  } catch (error) {
    logger.error('Public unsubscribe failed.', {
      ip,
      email: normalizedEmail,
      message: error?.message,
      code: error?.code,
    });
    res.status(500).json({
      success: false,
      error:
        error instanceof SubscriberStorageError
          ? 'Subscriber storage is unavailable. Please try again after the Vercel KV connection is restored.'
          : 'We could not process your unsubscribe request right now. Please try again later.',
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
app.post(
  '/api/upload-image',
  ensureAuthenticatedApi,
  upload.single('image'),
  async (req, res) => {
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
  },
);

/**
 * Send the newsletter to all subscribers.
 * Steps: sanitize content -> validate subscriber list -> send personalized emails sequentially with diagnostics.
 */
app.post('/api/send-newsletter', ensureAuthenticatedApi, async (req, res) => {
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
    const subscribers = await getSubscribers();

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
    const totalSubscribers = subscribers.length;
    const batchesEstimated = Math.ceil(totalSubscribers / RESEND_BATCH_SIZE);
    const estimatedDurationMs = Math.max(batchesEstimated - 1, 0) * RESEND_BATCH_DELAY_MS;
    const estimatedCompletion =
      totalSubscribers > 0
        ? new Date(Date.now() + estimatedDurationMs).toISOString()
        : new Date().toISOString();

    logger.info('Newsletter send queued with rate limiting.', {
      totalSubscribers,
      batchSize: RESEND_BATCH_SIZE,
      batchesEstimated,
      rateLimitDelayMs: RESEND_BATCH_DELAY_MS,
      estimatedCompletion,
    });

    const summary = {
      total: totalSubscribers,
      batchSize: RESEND_BATCH_SIZE,
      batchesEstimated,
      delayMsBetweenBatches: RESEND_BATCH_DELAY_MS,
      estimatedCompletion,
      successes: [],
      failures: [],
      skipped: [],
      progressUpdates: [],
      startedAt: new Date().toISOString(),
      estimatedDurationMs,
    };

    const queueStart = performance.now();
    let processed = 0;

    for (let batchIndex = 0; batchIndex < batchesEstimated; batchIndex += 1) {
      const batchStart = batchIndex * RESEND_BATCH_SIZE;
      const batch = subscribers.slice(batchStart, batchStart + RESEND_BATCH_SIZE);

      for (const subscriber of batch) {
        processed += 1;

        const result = await sendNewsletterToSubscriber(subscriber, {
          title,
          sanitizedContent,
          previewSnippet,
          strippedContent,
          unsubscribeBase,
        });

        if (result.success) {
          summary.successes.push({
            email: result.recipientEmail,
            id: result.data?.id,
            durationMs: result.durationMs,
            attempts: result.attempt,
            dns: result.data?.dns,
            spf: result.data?.spf,
            dkim: result.data?.dkim,
            batch: batchIndex + 1,
            queueIndex: processed,
            retryBackoffMs: result.retryDelays,
            unsubscribeLink: result.unsubscribeLink,
          });
        } else {
          const failureMessage = result.error?.message || 'Unknown Resend error.';
          summary.failures.push({
            email: result.recipientEmail,
            error: failureMessage,
            statusCode:
              result.error?.statusCode || result.error?.response?.statusCode || undefined,
            attempts: result.attempt,
            retryBackoffMs: result.retryDelays,
            response: result.resendResponse,
            suggestions: buildResendSuggestions(failureMessage),
            batch: batchIndex + 1,
            queueIndex: processed,
            rateLimitExceeded: isRateLimitError(result.error),
            unsubscribeLink: result.unsubscribeLink,
          });
        }

        const progressEntry = {
          processed,
          sent: summary.successes.length,
          failed: summary.failures.length,
          total: totalSubscribers,
          batch: batchIndex + 1,
          timestamp: new Date().toISOString(),
          message: `Processed ${processed}/${totalSubscribers} (sent ${summary.successes.length}, failed ${summary.failures.length}).`,
        };
        summary.progressUpdates.push(progressEntry);

        logger.info('Newsletter send progress update.', {
          processed,
          total: totalSubscribers,
          sent: summary.successes.length,
          failed: summary.failures.length,
          batch: batchIndex + 1,
          email: result.recipientEmail,
          success: result.success,
          progressMessage: `Sent ${summary.successes.length}/${totalSubscribers} emails...`,
        });
      }

      if (batchIndex < batchesEstimated - 1) {
        logger.info('Rate limit pause between batches.', {
          completedBatch: batchIndex + 1,
          delayMs: RESEND_BATCH_DELAY_MS,
        });
        await sleep(RESEND_BATCH_DELAY_MS);
      }
    }

    const elapsedMs = Math.round(performance.now() - queueStart);
    summary.elapsedMs = elapsedMs;
    summary.sentCount = summary.successes.length;
    summary.failedCount = summary.failures.length;
    summary.skippedCount = summary.skipped.length;
    summary.completedBatches = Math.ceil(processed / RESEND_BATCH_SIZE);
    summary.completedAt = new Date().toISOString();
    summary.totalProcessed = processed;
    summary.successRate =
      processed > 0 ? Number((summary.sentCount / processed).toFixed(4)) : 0;

    logger.info('Newsletter send completed.', {
      totalSubscribers,
      sent: summary.sentCount,
      failed: summary.failedCount,
      elapsedMs,
      batchesProcessed: summary.completedBatches,
    });

    lastEmailDiagnostic = {
      timestamp: new Date().toISOString(),
      status:
        summary.failedCount === 0
          ? 'success'
          : summary.sentCount === 0
          ? 'error'
          : 'partial',
      context: 'send-newsletter',
      recipients: subscribers
        .map((subscriber) => normalizeEmail(subscriber.email))
        .filter(Boolean),
      durationMs: elapsedMs,
      response: summary,
    };

    if (summary.sentCount === 0 && summary.failedCount > 0) {
      res.status(502).json({
        message: 'Failed to send newsletter; all emails encountered errors.',
        summary,
      });
      return;
    }

    res.status(summary.failedCount > 0 ? 207 : 200).json({
      message:
        summary.failedCount > 0
          ? 'Newsletter sent with some issues.'
          : 'Newsletter sent successfully with rate limiting.',
      summary,
    });
  } catch (error) {
    logger.error('Failed to send newsletter.', {
      message: error?.message,
      statusCode: error?.statusCode,
      name: error?.name,
      response: error?.response,
      stack: error?.stack,
      code: error?.code,
    });
    const friendlyMessage =
      error instanceof SubscriberStorageError
        ? 'Unable to load subscribers from storage. Please verify the Vercel KV connection.'
        : error?.response?.body?.message || error.message || 'Unknown error occurred.';

    const suggestions =
      error instanceof SubscriberStorageError
        ? [
            'Confirm STORAGE_REST_API_URL and STORAGE_REST_API_TOKEN are set and valid.',
            'Verify the Vercel KV database is accessible from this environment.',
          ]
        : buildResendSuggestions(error?.message);

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
app.post('/api/test-email', ensureAuthenticatedApi, async (req, res) => {
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
app.get('/api/diagnostics', ensureAuthenticatedApi, async (_, res) => {
  try {
    const subscribers = await getSubscribers();
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
      subscriberStorage: {
        mode: subscriberStoreMode,
        kvConfigured: subscriberStoreMode === 'kv',
        initializationError: kvInitializationError ? kvInitializationError.message : null,
      },
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
      code: error?.code,
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
app.get('*', ensureAuthenticatedView, (req, res) => {
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
