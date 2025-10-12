/**
 * Production-ready Express server for the newsletter application.
 * Handles subscriber management, Cloudinary-backed image uploads,
 * sanitized rich text newsletters, and delivery via Resend.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const bcrypt = require('bcrypt');
const csrf = require('csurf');
const { Resend } = require('resend');
const { v2: cloudinary } = require('cloudinary');
const { createClient: createRedisClient } = require('redis');
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
const STORAGE_RETRY_DELAYS_MS = [250, 500];
const VERIFICATION_DELAY_MS = 150;
const VERIFICATION_MAX_ATTEMPTS = 3;
const ANALYTICS_INDEX_KEY = 'newsletter:analytics:index';
const ANALYTICS_PREFIX = 'newsletter:analytics:campaign:';
const ANALYTICS_AGGREGATE_KEY = 'newsletter:analytics:aggregate';
const NEWSLETTER_ARCHIVE_PREFIX = 'newsletter:archive:';\nconst SUBSCRIBER_GROWTH_KEY = 'newsletter:analytics:subscriber-growth';\nconst MAX_GROWTH_POINTS = 365;
const CAMPAIGN_ZSET_KEY = 'newsletter:campaigns';
const CAMPAIGN_SUMMARY_KEY_PREFIX = 'newsletter:campaigns:';
const CLICK_TRACKING_PATH = '/t/click';
const OPEN_TRACKING_PATH = '/t/open';
const TRACKING_PIXEL_FILENAME = 'pixel.gif';
const FLAGGED_SUBSCRIBERS_SET_KEY = 'newsletter:flagged-subscribers';
const BOUNCE_LOG_PREFIX = 'newsletter:bounce:';
const DEFAULT_PHYSICAL_ADDRESS =
  process.env.MAILING_ADDRESS ||
  'Example Newsletter Â· 123 Main Street Â· Suite 100 Â· Anytown, USA';
const ENABLE_OPEN_TRACKING = process.env.ENABLE_OPEN_TRACKING !== 'false';
const ENABLE_CLICK_TRACKING = process.env.ENABLE_CLICK_TRACKING !== 'false';
const WARMUP_MODE_ENABLED = process.env.WARMUP_MODE === 'true';
const WARMUP_INITIAL_LIMIT = Number(process.env.WARMUP_INITIAL_LIMIT || 50);
const WARMUP_GROWTH_DAYS = Number(process.env.WARMUP_GROWTH_DAYS || 7);
const WARMUP_GROWTH_INCREMENT = Number(process.env.WARMUP_GROWTH_INCREMENT || 50);
const ABSOLUTE_DAILY_SEND_LIMIT = Number(process.env.DAILY_SEND_LIMIT || 0);
const CLICK_ALLOWED_SCHEMES = ['https:'];
const SESSION_PREFIX = 'newsletter:sess:';

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

const KV_ENV_VARS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN'];
const inMemorySubscribers = new Map();
const inMemoryFlaggedSubscribers = new Set();
const inMemoryAnalyticsStore = {
  aggregate: {
    sent: 0,
    delivered: 0,
    failed: 0,
    opens: 0,
    clicks: 0,
    bounces: 0,
    unsubscribes: 0,
  },
  campaigns: new Map(),
  index: [],
  opens: new Map(),
  clicks: new Map(),
  growth: [],
  archives: new Map(),
};
const inMemoryCampaignStore = {
  summaries: new Map(),
  index: [],
};
const warmupState = {
  dayKey: null,
  sent: 0,
  history: [],
};
let sessionStore = null;
let sessionStoreMode = 'memory';
let redisSessionClient = null;
const sessionHealth = {
  ready: false,
  error: null,
  lastErrorAt: null,
  lastConnectedAt: null,
  redisUrlPresent: Boolean(process.env.KV_URL),
};
const sessionLifecycle = {
  lastCreatedAt: null,
  lastCreatedSessionId: null,
  lastDestroyedAt: null,
  lastDestroyedSessionId: null,
  lastTouchedAt: null,
  lastTouchSessionId: null,
};
let kvClient = null;
let kvInitializationError = null;
let subscriberStoreMode = 'memory';
let kvConnectionHealthy = false;
let storageLastOperationDetails = null;

(function initializeSubscriberStore() {
  const missingKvEnv = KV_ENV_VARS.filter((key) => !process.env[key]);

  if (missingKvEnv.length === 0) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const { createClient } = require('@vercel/kv');
      kvClient = createClient({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      if (!kvClient) {
        throw new Error('Vercel KV client not available.');
      }
      subscriberStoreMode = 'kv';
      kvInitializationError = null;
      kvConnectionHealthy = true;
      logSubscriberEvent('info', 'Subscriber storage configured to use Vercel KV (REST API).', {
        restApiUrl: process.env.KV_REST_API_URL,
      });
      logger.info('Subscriber storage configured to use Vercel KV (REST API).', {
        restApiUrl: process.env.KV_REST_API_URL,
      });
    } catch (error) {
      kvInitializationError = error;
      subscriberStoreMode = 'memory';
      kvConnectionHealthy = false;
      logger.error(
        'Failed to initialize Vercel KV client. Falling back to in-memory subscriber storage.',
        { message: error?.message },
      );
      logSubscriberEvent('error', 'Failed to initialize Vercel KV client. Using in-memory storage.', {
        message: error?.message,
      });
    }
  } else {
    logger.warn(
      'Vercel KV environment not detected (set KV_REST_API_URL and KV_REST_API_TOKEN). Using in-memory subscriber storage.',
    );
    logSubscriberEvent('warn', 'Vercel KV environment variables missing. Using in-memory storage.', {
      missingEnv: missingKvEnv,
    });
  }

  if (subscriberStoreMode === 'memory') {
    logger.info('Subscriber storage is in-memory; data resets when the server restarts.');
    logSubscriberEvent('warn', 'Subscriber storage is in-memory; data resets when the server restarts.', {
      environment: process.env.NODE_ENV || 'development',
    });
    if (process.env.NODE_ENV === 'production') {
      logSubscriberEvent(
        'error',
        'Running with in-memory storage in production. Subscriber data will not persist between deployments.',
      );
    }
  }
})();

function initializeSessionStore() {
  if (sessionStore) {
    return;
  }

  sessionHealth.store = 'memory';

  if (process.env.KV_URL) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
redisSessionClient = createRedisClient({
        url: process.env.KV_URL,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
        },
      });

      redisSessionClient.on('connect', () => {
        sessionHealth.ready = true;
        sessionHealth.error = null;
        sessionHealth.lastConnectedAt = new Date().toISOString();
        logger.info('Redis session store connected.');
      });

      redisSessionClient.on('end', () => {
        sessionHealth.ready = false;
        logger.warn('Redis session store connection closed.');
      });

      redisSessionClient.on('error', (error) => {
        sessionHealth.ready = false;
        sessionHealth.error = error?.message || String(error);
        sessionHealth.lastErrorAt = new Date().toISOString();
        logger.error('Redis session store connection error.', {
          message: error?.message,
        });
      });

      redisSessionClient.connect().catch((error) => {
        sessionHealth.ready = false;
        sessionHealth.error = error?.message || String(error);
        sessionHealth.lastErrorAt = new Date().toISOString();
        logger.error('Failed to connect to Redis session store.', {
          message: error?.message,
        });
      });

      sessionStore = new RedisStore({
        client: redisSessionClient,
        prefix: SESSION_PREFIX,
      });
      sessionStoreMode = 'redis';
      sessionHealth.store = 'redis';
      return;
    } catch (error) {
      sessionHealth.ready = false;
      sessionHealth.error = error?.message || String(error);
      sessionHealth.lastErrorAt = new Date().toISOString();
      logger.error('Failed to initialize Redis session store. Falling back to in-memory store.', {
        message: error?.message,
      });
      sessionStore = new session.MemoryStore();
      sessionStoreMode = 'memory';
      sessionHealth.store = 'memory';
      sessionHealth.ready = true;
      return;
    }
  }

  sessionStore = new session.MemoryStore();
  sessionStoreMode = 'memory';
  sessionHealth.store = 'memory';
  sessionHealth.ready = true;
  sessionHealth.error = null;
  logger.warn(
    'Using in-memory session store. Sessions will reset when the server restarts. Configure KV_URL for persistent sessions.',
  );
  if (process.env.NODE_ENV === 'production') {
    logger.error(
      'Session store is in-memory while running in production. Configure KV_URL to persist admin sessions across deployments.',
    );
  }
}

initializeSessionStore();

if (sessionStore && typeof sessionStore.destroy === 'function') {
  const originalDestroy = sessionStore.destroy.bind(sessionStore);
  sessionStore.destroy = (sid, callback) => {
    sessionLifecycle.lastDestroyedAt = new Date().toISOString();
    sessionLifecycle.lastDestroyedSessionId = sid;
    logger.info('Session destroyed.', { sessionId: sid, store: sessionStoreMode });
    return originalDestroy(sid, callback);
  };
}

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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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

function generateNewsletterId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function generateCampaignId() {
  const base = Date.now();
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${base}-${suffix}`;
}
  return crypto.randomBytes(16).toString('hex');
}

function createEmptyMetricSnapshot() {
  return {
    sent: 0,
    delivered: 0,
    failed: 0,
    opens: 0,
    clicks: 0,
    bounces: 0,
    unsubscribes: 0,
  };
}

function hashRecipientForMetric(newsletterId, recipientEmail) {
  if (!newsletterId || !recipientEmail) {
    return null;
  }
  return crypto
    .createHash('sha256')
    .update(`${newsletterId}:${recipientEmail.toLowerCase()}`)
    .digest('hex');
}

function getWarmupDayKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
}

function analyticsUsesKv() {
  return Boolean(kvClient);
}

async function getAggregateMetrics() {
  if (analyticsUsesKv()) {
    const raw = await withKvRetries(
      () => kvClient.get(ANALYTICS_AGGREGATE_KEY),
      'analytics-get-aggregate',
    );
    if (!raw) {
      return createEmptyMetricSnapshot();
    }
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      logger.warn('Failed to parse aggregate analytics payload; resetting.', {
        message: error?.message,
      });
      return createEmptyMetricSnapshot();
    }
  }
  return { ...inMemoryAnalyticsStore.aggregate };
}

async function saveAggregateMetrics(snapshot) {
  const safeSnapshot = snapshot || createEmptyMetricSnapshot();
  if (analyticsUsesKv()) {
    await withKvRetries(
      () => kvClient.set(ANALYTICS_AGGREGATE_KEY, JSON.stringify(safeSnapshot)),
      'analytics-set-aggregate',
    );
    return;
  }
  inMemoryAnalyticsStore.aggregate = { ...safeSnapshot };
}

async function getCampaignRecord(newsletterId) {
  if (!newsletterId) {
    return null;
  }
  if (analyticsUsesKv()) {
    const raw = await withKvRetries(
      () => kvClient.get(`${ANALYTICS_PREFIX}${newsletterId}`),
      'analytics-get-campaign',
    );
    if (!raw) {
      return null;
    }
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      logger.warn('Failed to parse campaign analytics payload.', {
        message: error?.message,
        newsletterId,
      });
      return null;
    }
  }
  return inMemoryAnalyticsStore.campaigns.get(newsletterId) || null;
}

async function saveCampaignRecord(record) {
  if (!record?.id) {
    return;
  }
  const payload = {
    ...record,
    metrics: { ...createEmptyMetricSnapshot(), ...(record.metrics || {}) },
  };
  if (analyticsUsesKv()) {
    await withKvRetries(
      () => kvClient.set(`${ANALYTICS_PREFIX}${record.id}`, JSON.stringify(payload)),
      'analytics-set-campaign',
    );
    await withKvRetries(
      () => kvClient.lrem(ANALYTICS_INDEX_KEY, 0, record.id),
      'analytics-index-remove',
    );
    await withKvRetries(
      () => kvClient.lpush(ANALYTICS_INDEX_KEY, record.id),
      'analytics-index-add',
    );
    await withKvRetries(
      () => kvClient.ltrim(ANALYTICS_INDEX_KEY, 0, 49),
      'analytics-index-trim',
    );
    return;
  }
  inMemoryAnalyticsStore.campaigns.set(record.id, payload);
  inMemoryAnalyticsStore.index = [
    record.id,
    ...inMemoryAnalyticsStore.index.filter((candidate) => candidate !== record.id),
  ].slice(0, 50);
}

async function listRecentCampaignRecords() {
  if (analyticsUsesKv()) {
    const ids = await withKvRetries(
      () => kvClient.lrange(ANALYTICS_INDEX_KEY, 0, 49),
      'analytics-index-list',
    );
    if (!ids || ids.length === 0) {
      return [];
    }
    const records = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const record = await getCampaignRecord(id);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }
  return inMemoryAnalyticsStore.index
    .map((id) => inMemoryAnalyticsStore.campaigns.get(id))
    .filter(Boolean);
}

async function recordAggregateDelta(delta) {
  const aggregate = await getAggregateMetrics();
  const fields = Object.keys(createEmptyMetricSnapshot());
  fields.forEach((field) => {
    if (typeof delta[field] === 'number') {
      aggregate[field] = Math.max(0, (aggregate[field] || 0) + delta[field]);
    }
  });
  await saveAggregateMetrics(aggregate);
}

async function recordCampaignMetric(newsletterId, metric, recipientEmail) {
  if (!newsletterId || !metric) {
    return { updated: false };
  }
  const record = await getCampaignRecord(newsletterId);
  if (!record) {
    return { updated: false };
  }

  const allowedMetric = ['opens', 'clicks', 'bounces', 'unsubscribes', 'delivered'].includes(
    metric,
  );
  if (!allowedMetric) {
    return { updated: false };
  }

  let recipientHash = null;
  if (recipientEmail && ['opens', 'clicks', 'unsubscribes'].includes(metric)) {
    recipientHash = hashRecipientForMetric(newsletterId, recipientEmail);
  }

  if (analyticsUsesKv()) {
    if (recipientHash) {
      const key = `${ANALYTICS_PREFIX}${newsletterId}:dedupe:${metric}`;
      const added = await withKvRetries(
        () => kvClient.sadd(key, recipientHash),
        `analytics-dedupe-${metric}`,
      );
      if (added === 0) {
        return { updated: false, record };
      }
    }
    record.metrics[metric] = Math.max(0, (record.metrics[metric] || 0) + 1);
    await saveCampaignRecord(record);
    await recordAggregateDelta({ [metric]: 1 });
    return { updated: true, record };
  }

  if (recipientHash) {
    const targetMap =
      metric === 'opens'
        ? inMemoryAnalyticsStore.opens
        : metric === 'clicks'
        ? inMemoryAnalyticsStore.clicks
        : null;
    if (targetMap) {
      const existingSet = targetMap.get(newsletterId) || new Set();
      if (existingSet.has(recipientHash)) {
        return { updated: false, record };
      }
      existingSet.add(recipientHash);
      targetMap.set(newsletterId, existingSet);
    }
  }

  record.metrics[metric] = Math.max(0, (record.metrics[metric] || 0) + 1);
  inMemoryAnalyticsStore.aggregate[metric] = Math.max(
    0,
    (inMemoryAnalyticsStore.aggregate[metric] || 0) + 1,
  );
  inMemoryAnalyticsStore.campaigns.set(newsletterId, record);
  return { updated: true, record };
}

async function recordBounceMetric(newsletterId, recipientEmail, reason = '') {
  const result = await recordCampaignMetric(newsletterId, 'bounces', recipientEmail);
  if (result.updated) {
    await recordAggregateDelta({ bounces: 1 });
  }
  const timestamp = new Date().toISOString();
  if (analyticsUsesKv()) {
    const key = `${BOUNCE_LOG_PREFIX}${recipientEmail.toLowerCase()}`;
    await withKvRetries(
      () =>
        kvClient.set(
          key,
          JSON.stringify({
            reason,
            newsletterId,
            timestamp,
          }),
        ),
      'bounce-log-set',
    );
    await withKvRetries(
      () => kvClient.sadd(FLAGGED_SUBSCRIBERS_SET_KEY, recipientEmail.toLowerCase()),
      'flag-subscriber',
    );
  } else {
    inMemoryFlaggedSubscribers.add(recipientEmail.toLowerCase());
  }
}

async function recordUnsubscribeMetric(newsletterId, recipientEmail) {
  await recordCampaignMetric(newsletterId, 'unsubscribes', recipientEmail);
}

async function resetWarmupCounterIfNeeded() {
  const dayKey = getWarmupDayKey();
  if (!WARMUP_MODE_ENABLED) {
    return;
  }
  if (analyticsUsesKv()) {
    const key = 'newsletter:warmup:state';
    const raw = await withKvRetries(() => kvClient.get(key), 'warmup-get-state');
    let state = null;
    if (raw) {
      try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
state = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (error) {
        state = null;
      }
    }
    if (!state || state.dayKey !== dayKey) {
      state = { dayKey, sent: 0, history: state?.history || [] };
      await withKvRetries(
        () => kvClient.set(key, JSON.stringify(state)),
        'warmup-reset-state',
      );
      return state;
    }
    return state;
  }
  if (warmupState.dayKey !== dayKey) {
    warmupState.dayKey = dayKey;
    warmupState.sent = 0;
  }
  return { dayKey: warmupState.dayKey, sent: warmupState.sent };
}

async function updateWarmupCounter(delta) {
  if (!WARMUP_MODE_ENABLED) {
    return;
  }
  const key = 'newsletter:warmup:state';
  if (analyticsUsesKv()) {
    const raw = await withKvRetries(() => kvClient.get(key), 'warmup-get-state');
    let state = null;
    if (raw) {
      try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
state = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (error) {
        state = null;
      }
    }
    if (!state) {
      state = { dayKey: getWarmupDayKey(), sent: 0, history: [] };
    }
    state.sent = Math.max(0, (state.sent || 0) + delta);
    await withKvRetries(() => kvClient.set(key, JSON.stringify(state)), 'warmup-set-state');
    return state;
  }
  warmupState.sent = Math.max(0, (warmupState.sent || 0) + delta);
  return { dayKey: warmupState.dayKey, sent: warmupState.sent };
}

function computeWarmupLimit(historyCount = 0) {
  if (!WARMUP_MODE_ENABLED) {
    return Infinity;
  }
  const base = Math.max(1, WARMUP_INITIAL_LIMIT);
  const growthSteps = Math.max(0, Math.floor(historyCount / Math.max(1, WARMUP_GROWTH_DAYS)));
  return base + growthSteps * Math.max(1, WARMUP_GROWTH_INCREMENT);
}

function buildDayKey(date) {
  const current = date instanceof Date ? date : new Date(date);
  return `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}-${String(
    current.getUTCDate(),
  ).padStart(2, '0')}`;
}

function normalizeGrowthHistory(history = []) {
  return history
    .filter((entry) => entry && typeof entry.date === 'string')
    .map((entry) => ({
      date: entry.date,
      count: Number(entry.count) || 0,
      recordedAt: entry.recordedAt || entry.timestamp || new Date().toISOString(),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadSubscriberGrowthHistory(limit = MAX_GROWTH_POINTS) {
  if (analyticsUsesKv()) {
    const raw = await withKvRetries(
      () => kvClient.get(SUBSCRIBER_GROWTH_KEY),
      'analytics-growth-get',
    );
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    const normalized = normalizeGrowthHistory(Array.isArray(parsed) ? parsed : []);
    return normalized.slice(-Math.max(limit, 0));
  }
  const normalized = normalizeGrowthHistory(inMemoryAnalyticsStore.growth);
  return normalized.slice(-Math.max(limit, 0));
}

async function saveSubscriberGrowthHistory(history) {
  const trimmed = normalizeGrowthHistory(history).slice(-MAX_GROWTH_POINTS);
  if (analyticsUsesKv()) {
    await withKvRetries(
      () => kvClient.set(SUBSCRIBER_GROWTH_KEY, JSON.stringify(trimmed)),
      'analytics-growth-set',
    );
  } else {
    inMemoryAnalyticsStore.growth = trimmed;
  }
  return trimmed;
}

async function recordSubscriberGrowthSnapshot(count, timestamp = new Date()) {
  if (typeof count !== 'number' || Number.isNaN(count) || count < 0) {
    return [];
  }
  const iso = new Date(timestamp).toISOString();
  const dayKey = buildDayKey(timestamp);
  const history = await loadSubscriberGrowthHistory();
  const nextHistory = [...history];
  const existingIndex = nextHistory.findIndex((entry) => entry.date === dayKey);
  if (existingIndex >= 0) {
    nextHistory[existingIndex] = { date: dayKey, count, recordedAt: iso };
  } else {
    nextHistory.push({ date: dayKey, count, recordedAt: iso });
  }
  return saveSubscriberGrowthHistory(nextHistory);
}

async function ensureSubscriberGrowthSnapshot(count) {
  const history = await loadSubscriberGrowthHistory();
  const lastEntry = history[history.length - 1];
  if (!lastEntry || lastEntry.count !== count) {
    await recordSubscriberGrowthSnapshot(count);
  }
}

async function getSubscriberGrowthWindow(days = 30) {
  const history = await loadSubscriberGrowthHistory();
  if (!history.length) {
    return history;
  }
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(days - 1, 0));
  const cutoffKey = buildDayKey(cutoff);
  return history.filter((entry) => entry.date >= cutoffKey);
}

/**
 * Persist a snapshot of campaign delivery stats so the analytics API can respond quickly.
 * The payload mirrors the frontend cards/table, so we store both neutral names (delivered/failed)
 * and explicit success/failure counts for readability when the record is fetched later.
 */
async function storeCampaignSummary(record) {
  if (!record?.id) {
    return;
  }
  const deliveredCount = Math.max(0, Number(record.delivered ?? record.successCount) || 0);
  const failedCount = Math.max(0, Number(record.failed ?? record.failureCount) || 0);
  const safeRecord = {
    id: String(record.id),
    title: record.title || 'Untitled campaign',
    sentAt: record.sentAt || new Date().toISOString(),
    recipients: Math.max(0, Number(record.recipients) || 0),
    delivered: deliveredCount,
    failed: failedCount,
    successCount: deliveredCount,
    failureCount: failedCount,
    status: record.status || 'unknown',
  };
  if (analyticsUsesKv()) {
    const score = Date.parse(safeRecord.sentAt) || Date.now();
    await withKvRetries(
      () => kvClient.set(`${CAMPAIGN_SUMMARY_KEY_PREFIX}${safeRecord.id}`, JSON.stringify(safeRecord)),
      'campaign-summary-set',
    );
    await withKvRetries(
      () => kvClient.zadd(CAMPAIGN_ZSET_KEY, { score, member: safeRecord.id }),
      'campaign-summary-zadd',
    );
    return;
  }
  inMemoryCampaignStore.summaries.set(safeRecord.id, safeRecord);
  inMemoryCampaignStore.index = inMemoryCampaignStore.index.filter((id) => id !== safeRecord.id);
  inMemoryCampaignStore.index.push(safeRecord.id);
  if (inMemoryCampaignStore.index.length > 100) {
    const removedId = inMemoryCampaignStore.index.shift();
    if (removedId) {
      inMemoryCampaignStore.summaries.delete(removedId);
    }
  }
}

async function listRecentCampaignSummaries(limit = 10) {
  if (analyticsUsesKv()) {
    const ids = await withKvRetries(
      () => kvClient.zrange(CAMPAIGN_ZSET_KEY, -limit, -1, { rev: true }),
      'campaign-summary-zrange',
    );
    if (!ids || !ids.length) {
      return [];
    }
    const records = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await withKvRetries(
        () => kvClient.get(`${CAMPAIGN_SUMMARY_KEY_PREFIX}${id}`),
        'campaign-summary-get',
      );
      if (!raw) {
        continue;
      }
      try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        records.push(parsed);
      } catch (error) {
        logger.warn('Failed to parse stored campaign summary.', { id, message: error?.message });
      }
    }
    return records;
  }
  const recentIds = inMemoryCampaignStore.index.slice(-limit).reverse();
  return recentIds
    .map((id) => inMemoryCampaignStore.summaries.get(id))
    .filter(Boolean);
}

async function countCampaignSummaries() {
  if (analyticsUsesKv()) {
    const count = await withKvRetries(
      () => kvClient.zcard(CAMPAIGN_ZSET_KEY),
      'campaign-summary-count',
    );
    return Number(count) || 0;
  }
  return inMemoryCampaignStore.index.length;
}

async function flagSubscriberEmail(email, reason = '') {
  if (!email) {
    return;
  }
  const normalized = email.toLowerCase();
  if (analyticsUsesKv()) {
    await withKvRetries(
      () => kvClient.sadd(FLAGGED_SUBSCRIBERS_SET_KEY, normalized),
      'flag-subscriber-sadd',
    );
    await withKvRetries(
      () =>
        kvClient.set(
          `${FLAGGED_SUBSCRIBERS_SET_KEY}:reason:${normalized}`,
          JSON.stringify({ reason, timestamp: new Date().toISOString() }),
        ),
      'flag-subscriber-reason',
    );
  } else {
    inMemoryFlaggedSubscribers.add(normalized);
  }
}

async function unflagSubscriberEmail(email) {
  if (!email) {
    return;
  }
  const normalized = email.toLowerCase();
  if (analyticsUsesKv()) {
    await withKvRetries(
      () => kvClient.srem(FLAGGED_SUBSCRIBERS_SET_KEY, normalized),
      'flag-subscriber-srem',
    );
    await withKvRetries(
      () => kvClient.del(`${FLAGGED_SUBSCRIBERS_SET_KEY}:reason:${normalized}`),
      'flag-subscriber-del',
    );
  } else {
    inMemoryFlaggedSubscribers.delete(normalized);
  }
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

function logSubscriberEvent(level, message, meta = {}) {
  const logLevel = typeof logger[level] === 'function' ? level : 'info';
  logger[logLevel](`[Subscribers] ${message}`, {
    at: new Date().toISOString(),
    storage: subscriberStoreMode,
    kvConnectionHealthy,
    ...meta,
  });
}

function recordStorageOperation(action, meta = {}) {
  storageLastOperationDetails = {
    timestamp: new Date().toISOString(),
    action,
    storage: subscriberStoreMode,
    ...meta,
  };
}

async function withKvRetries(action, description) {
  let attempt = 0;
  while (attempt <= STORAGE_RETRY_DELAYS_MS.length) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const result = await action();
      kvConnectionHealthy = true;
      return result;
    } catch (error) {
      kvConnectionHealthy = false;
      const delayMs = STORAGE_RETRY_DELAYS_MS[attempt];
      logSubscriberEvent('warn', `KV operation failed (${description}).`, {
        attempt: attempt + 1,
        delayMs,
        message: error?.message,
      });
      if (delayMs === undefined) {
        throw error;
      }
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

function parseStoredValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function hydrateSubscriberRecord(normalizedEmail, hash) {
  if (!hash || typeof hash !== 'object') {
    return null;
  }
  const processed = {};
  for (const [key, value] of Object.entries(hash)) {
    processed[key] = parseStoredValue(value);
  }
  processed.email = processed.email || normalizedEmail;
  return normalizeRecordShape(processed);
}

async function fetchSubscriberRecord(normalizedEmail) {
  if (!normalizedEmail) {
    return null;
  }

  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const hash = await withKvRetries(
        () => kvClient.hgetall(subscriberHashKey(normalizedEmail)),
        'hgetall-subscriber',
      );
      if (!hash || Object.keys(hash).length === 0) {
        return null;
      }
      return hydrateSubscriberRecord(normalizedEmail, hash);
    } catch (error) {
      throw new SubscriberStorageError('Failed to read subscriber from Vercel KV.', {
        cause: error,
        code: 'kv-read-failed',
      });
    }
  }

  const record = inMemorySubscribers.get(normalizedEmail);
  if (!record) {
    return null;
  }
  return normalizeRecordShape(record);
}

async function verifySubscriberPersistence(normalizedEmail) {
  for (let attempt = 1; attempt <= VERIFICATION_MAX_ATTEMPTS; attempt += 1) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const record = await fetchSubscriberRecord(normalizedEmail);
      if (record) {
        logSubscriberEvent('info', 'Subscriber verification succeeded.', {
          email: normalizedEmail,
          attempts: attempt,
        });
        return { verified: true, record, attempts: attempt };
      }
    } catch (error) {
      logSubscriberEvent('error', 'Subscriber verification failed due to storage error.', {
        email: normalizedEmail,
        attempt,
        message: error?.message,
      });
      return { verified: false, record: null, attempts: attempt, error };
    }

    if (attempt < VERIFICATION_MAX_ATTEMPTS) {
      await sleep(VERIFICATION_DELAY_MS);
    }
  }

  logSubscriberEvent('error', 'Subscriber verification failed after maximum attempts.', {
    email: normalizedEmail,
    attempts: VERIFICATION_MAX_ATTEMPTS,
  });
  return { verified: false, record: null, attempts: VERIFICATION_MAX_ATTEMPTS };
}

async function verifySubscriberRemoval(normalizedEmail) {
  for (let attempt = 1; attempt <= VERIFICATION_MAX_ATTEMPTS; attempt += 1) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const record = await fetchSubscriberRecord(normalizedEmail);
      if (!record) {
        logSubscriberEvent('info', 'Subscriber removal verified.', {
          email: normalizedEmail,
          attempts: attempt,
        });
        return { confirmed: true, attempts: attempt };
      }
    } catch (error) {
      logSubscriberEvent('error', 'Subscriber removal verification failed due to storage error.', {
        email: normalizedEmail,
        attempt,
        message: error?.message,
      });
      return { confirmed: false, attempts: attempt, error };
    }

    if (attempt < VERIFICATION_MAX_ATTEMPTS) {
      await sleep(VERIFICATION_DELAY_MS);
    }
  }

  logSubscriberEvent('error', 'Subscriber removal verification failed after maximum attempts.', {
    email: normalizedEmail,
    attempts: VERIFICATION_MAX_ATTEMPTS,
  });
  return { confirmed: false, attempts: VERIFICATION_MAX_ATTEMPTS };
}

async function getSubscriberCount(options = {}) {
  const { record = true } = options;
  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const count = await withKvRetries(
        () => kvClient.scard(SUBSCRIBERS_SET_KEY),
        'scard-subscribers',
      );
      const total = Number(count) || 0;
      logSubscriberEvent('info', 'Fetched subscriber count from Vercel KV.', { count: total });
      if (record) {
        recordStorageOperation('count-subscribers', { count: total });
      }
      return total;
    } catch (error) {
      throw new SubscriberStorageError('Failed to read subscriber count from Vercel KV.', {
        cause: error,
        code: 'kv-read-failed',
      });
    }
  }

  const count = inMemorySubscribers.size;
  logSubscriberEvent('info', 'Calculated subscriber count using in-memory storage.', { count });
  if (record) {
    recordStorageOperation('count-subscribers', { count });
  }
  return count;
}

async function verifyStorageConnection() {
  if (subscriberStoreMode !== 'kv' || !kvClient) {
    kvConnectionHealthy = subscriberStoreMode === 'kv';
    if (!kvConnectionHealthy) {
      logSubscriberEvent('info', 'Storage verification skipped because in-memory storage is active.');
    }
    return;
  }

  try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const probeKey = `${SUBSCRIBERS_SET_KEY}:probe:${Date.now()}`;
    await withKvRetries(
      () => kvClient.set(probeKey, `ping:${Date.now()}`, { ex: 60 }),
      'set-probe',
    );
    await withKvRetries(() => kvClient.del(probeKey), 'del-probe');
    kvConnectionHealthy = true;
    logSubscriberEvent('info', 'Verified connectivity with Vercel KV.');
  } catch (error) {
    kvConnectionHealthy = false;
    kvInitializationError = error;
    logSubscriberEvent('error', 'Failed to verify Vercel KV connectivity.', {
      message: error?.message,
    });
  }
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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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

verifyStorageConnection().catch((error) => {
  logSubscriberEvent('error', 'Storage verification failed unexpectedly.', {
    message: error?.message,
  });
});

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
  store: sessionStore,
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
  if (req.session) {
    const nowIso = new Date().toISOString();
    sessionLifecycle.lastTouchedAt = nowIso;
    sessionLifecycle.lastTouchSessionId = req.sessionID;

    if (!req.session.createdAt) {
      req.session.createdAt = nowIso;
      sessionLifecycle.lastCreatedAt = nowIso;
      sessionLifecycle.lastCreatedSessionId = req.sessionID;
      logger.info('Session created.', {
        sessionId: req.sessionID,
        store: sessionStoreMode,
        ip: req.ip,
      });
    }
  }

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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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

  req.session.regenerate((error) => {
    if (error) {
      logger.error('Session regeneration failed during login.', {
        message: error?.message,
      });
      if (req.session) {
        req.session.authFeedback = {
          type: 'error',
          text: 'We could not establish a secure session. Please try logging in again.',
          remember: rememberMe,
        };
      }
      res.redirect(`/login?next=${encodeURIComponent(nextPath)}`);
      return;
    }

    const nowIso = new Date().toISOString();
    req.session.isAuthenticated = true;
    req.session.username = ADMIN_USERNAME;
    req.session.rememberMe = rememberMe;
    req.session.loginAt = nowIso;
    req.session.createdAt = nowIso;
    req.session.cookie.maxAge = rememberMe ? REMEMBER_ME_MAX_AGE : DEFAULT_SESSION_MAX_AGE;

    sessionLifecycle.lastCreatedAt = nowIso;
    sessionLifecycle.lastCreatedSessionId = req.sessionID;

    logger.info('Authentication succeeded.', {
      ip: req.ip,
      username: ADMIN_USERNAME,
      sessionId: req.sessionID,
      rememberMe,
      store: sessionStoreMode,
    });

    res.redirect(nextPath);
  });
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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const emails = await withKvRetries(
        () => kvClient.smembers(SUBSCRIBERS_SET_KEY),
        'smembers-subscribers',
      );

      if (!emails || emails.length === 0) {
        logSubscriberEvent('info', 'Loaded subscribers from Vercel KV.', { count: 0 });
        recordStorageOperation('get-subscribers', { count: 0 });
        return [];
      }

      const records = await Promise.all(
        emails.map(async (normalizedEmail) => {
          try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const hash = await withKvRetries(
              () => kvClient.hgetall(subscriberHashKey(normalizedEmail)),
              'hgetall-subscriber',
            );
            return hydrateSubscriberRecord(normalizedEmail, hash);
          } catch (innerError) {
            logSubscriberEvent('warn', 'Failed to hydrate subscriber from Vercel KV.', {
              email: normalizedEmail,
              message: innerError?.message,
            });
            return null;
          }
        }),
      );

      const subscribers = sortSubscribers(records.filter(Boolean));
      logSubscriberEvent('info', 'Loaded subscribers from Vercel KV.', {
        count: subscribers.length,
      });
      recordStorageOperation('get-subscribers', { count: subscribers.length });
      return subscribers;
    } catch (error) {
      logSubscriberEvent('error', 'Failed to load subscribers from Vercel KV.', {
        message: error?.message,
      });
      throw new SubscriberStorageError('Failed to read subscribers from Vercel KV.', {
        cause: error,
        code: 'kv-read-failed',
      });
    }
  }

  const subscribers = sortSubscribers(
    Array.from(inMemorySubscribers.values()).map(normalizeRecordShape),
  );
  logSubscriberEvent('info', 'Loaded subscribers from in-memory storage.', {
    count: subscribers.length,
  });
  recordStorageOperation('get-subscribers', { count: subscribers.length });
  return subscribers;
}

async function addSubscriber(email, name = null, metadata = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new SubscriberStorageError('Cannot add subscriber with invalid email address.', {
      code: 'invalid-email',
    });
  }

  logSubscriberEvent('info', 'Subscriber add requested.', { email: normalized });

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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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

      await withKvRetries(() => kvClient.sadd(SUBSCRIBERS_SET_KEY, normalized), 'sadd-subscriber');
      try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
await withKvRetries(
          () => kvClient.hset(subscriberHashKey(normalized), kvPayload),
          'hset-subscriber',
        );
      } catch (writeError) {
        await withKvRetries(
          () => kvClient.srem(SUBSCRIBERS_SET_KEY, normalized),
          'srem-rollback-subscriber',
        );
        throw writeError;
      }
    } catch (error) {
      logSubscriberEvent('error', 'Failed to add subscriber to Vercel KV.', {
        email: normalized,
        message: error?.message,
      });
      throw new SubscriberStorageError('Failed to add subscriber to Vercel KV.', {
        cause: error,
        code: 'kv-write-failed',
      });
    }
  } else {
    inMemorySubscribers.set(normalized, record);
  }

  let countAfterAdd;
  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const total = await withKvRetries(
        () => kvClient.scard(SUBSCRIBERS_SET_KEY),
        'scard-after-add',
      );
      countAfterAdd = Number(total) || 0;
    } catch (error) {
      logSubscriberEvent('warn', 'Unable to fetch subscriber count after add.', {
        email: normalized,
        message: error?.message,
      });
    }
  } else {
    countAfterAdd = inMemorySubscribers.size;
  }

  logSubscriberEvent('info', 'Subscriber stored successfully.', {
    email: normalized,
    count: countAfterAdd,
  });
  recordStorageOperation('add-subscriber', { email: normalized, count: countAfterAdd });

  return record;
}

async function removeSubscriber(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new SubscriberStorageError('Cannot remove subscriber with invalid email address.', {
      code: 'invalid-email',
    });
  }

  logSubscriberEvent('info', 'Subscriber removal requested.', { email: normalized });

  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const removed = await withKvRetries(
        () => kvClient.srem(SUBSCRIBERS_SET_KEY, normalized),
        'srem-subscriber',
      );
      if (!Number(removed)) {
        logSubscriberEvent('warn', 'Subscriber not found during KV removal.', { email: normalized });
        return false;
      }
      await withKvRetries(
        () => kvClient.del(subscriberHashKey(normalized)),
        'del-subscriber-hash',
      );
      const total = await withKvRetries(
        () => kvClient.scard(SUBSCRIBERS_SET_KEY),
        'scard-after-remove',
      );
      const countAfterRemove = Number(total) || 0;
      logSubscriberEvent('info', 'Subscriber removed from Vercel KV.', {
        email: normalized,
        count: countAfterRemove,
      });
      recordStorageOperation('remove-subscriber', {
        email: normalized,
        count: countAfterRemove,
      });
      return true;
    } catch (error) {
      logSubscriberEvent('error', 'Failed to remove subscriber from Vercel KV.', {
        email: normalized,
        message: error?.message,
      });
      throw new SubscriberStorageError('Failed to remove subscriber from Vercel KV.', {
        cause: error,
        code: 'kv-delete-failed',
      });
    }
  }

  const removed = inMemorySubscribers.delete(normalized);
  if (removed) {
    const countAfterRemove = inMemorySubscribers.size;
    logSubscriberEvent('info', 'Subscriber removed from in-memory storage.', {
      email: normalized,
      count: countAfterRemove,
    });
    recordStorageOperation('remove-subscriber', { email: normalized, count: countAfterRemove });
  } else {
    logSubscriberEvent('warn', 'Subscriber not found during in-memory removal.', {
      email: normalized,
    });
  }
  return removed;
}

async function subscriberExists(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }

  if (subscriberStoreMode === 'kv' && kvClient) {
    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const exists = await withKvRetries(
        () => kvClient.sismember(SUBSCRIBERS_SET_KEY, normalized),
        'sismember-subscriber',
      );
      const present = Boolean(exists);
      logSubscriberEvent('info', 'Checked subscriber existence in Vercel KV.', {
        email: normalized,
        exists: present,
      });
      recordStorageOperation('check-exists', { email: normalized, exists: present });
      return present;
    } catch (error) {
      logSubscriberEvent('error', 'Failed to check subscriber in Vercel KV.', {
        email: normalized,
        message: error?.message,
      });
      throw new SubscriberStorageError('Failed to check subscriber in Vercel KV.', {
        cause: error,
        code: 'kv-read-failed',
      });
    }
  }

  const exists = inMemorySubscribers.has(normalized);
  logSubscriberEvent('info', 'Checked subscriber existence in in-memory storage.', {
    email: normalized,
    exists,
  });
  recordStorageOperation('check-exists', { email: normalized, exists });
  return exists;
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
    previewSnippet ? `${previewSnippet}

` : ''
  }${strippedContent}

Unsubscribe: ${unsubscribeLink}`;

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
app.get('/api/session', ensureAuthenticatedApi, (req, res) => {
  res.json({
    sessionId: req.sessionID,
    isAuthenticated: Boolean(req.session?.isAuthenticated),
    username: req.session?.username || null,
    rememberMe: Boolean(req.session?.rememberMe),
    loginAt: req.session?.loginAt || null,
    createdAt: req.session?.createdAt || null,
    cookie: {
      maxAge: req.session?.cookie?.maxAge ?? null,
      expires: req.session?.cookie?.expires ?? null,
      secure: req.session?.cookie?.secure ?? process.env.NODE_ENV === 'production',
      sameSite: req.session?.cookie?.sameSite ?? 'lax',
      httpOnly: true,
    },
    store: {
      mode: sessionStoreMode,
      ready: sessionHealth.ready,
      error: sessionHealth.error,
      lastErrorAt: sessionHealth.lastErrorAt,
      lastConnectedAt: sessionHealth.lastConnectedAt,
      redisUrlPresent: sessionHealth.redisUrlPresent,
    },
    lifecycle: { ...sessionLifecycle },
  });
});

/**
 * GET subscribers list.
 */
app.get('/api/subscribers', ensureAuthenticatedApi, async (_, res) => {
  try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const subscribers = await getSubscribers();
    res.json({
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      lastOperation: storageLastOperationDetails,
      subscribers,
      count: subscribers.length,
    });
  } catch (error) {
    logSubscriberEvent('error', 'Failed to read subscribers for API response.', {
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
  const normalizedEmail = normalizeEmail(canonicalEmail);

  try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
if (await subscriberExists(canonicalEmail)) {
      logSubscriberEvent('warn', 'Attempt to add duplicate subscriber.', { email: normalizedEmail });
      res.status(409).json({
        message: 'This email is already subscribed.',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
      });
      return;
    }

    const newSubscriber = await addSubscriber(canonicalEmail, sanitizedName || null);
    const verification = await verifySubscriberPersistence(normalizedEmail);

    if (!verification.verified) {
      logSubscriberEvent('error', 'Subscriber persistence verification failed.', {
        email: normalizedEmail,
        attempts: verification.attempts,
      });
      res.status(500).json({
        message:
          'Subscriber could not be persisted to storage. Please try again once the storage service is available.',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
        verification,
      });
      return;
    }

    const totalCount = await getSubscriberCount({ record: false });

    logSubscriberEvent('info', 'Subscriber added via API.', {
      email: normalizedEmail,
      count: totalCount,
      verified: verification.verified,
    });

    await recordSubscriberGrowthSnapshot(totalCount);

    res.status(201).json({
      subscriber: verification.record || newSubscriber,
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      verification,
      count: totalCount,
    });
  } catch (error) {
    logSubscriberEvent('error', 'Failed to add subscriber.', {
      email: normalizedEmail,
      message: error?.message,
      code: error?.code,
    });
    const message =
      error instanceof SubscriberStorageError
        ? 'Could not add subscriber because storage is unavailable. Please verify the Vercel KV connection.'
        : 'Could not add subscriber. Please try again later.';
    res.status(500).json({
      message,
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      details: error?.message,
    });
  }
});

/**
 * Remove an existing subscriber.
 */
app.delete('/api/subscribers/:encodedEmail', ensureAuthenticatedApi, async (req, res) => {
  const email = decodeURIComponent(req.params.encodedEmail);
  const normalizedTarget = extractEmailAddress(email);

  if (!normalizedTarget) {
    res.status(400).json({
      message: 'Invalid email address provided.',
      storage: subscriberStoreMode,
      kvConnectionHealthy,
    });
    return;
  }

  try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const removed = await removeSubscriber(normalizedTarget);
    if (!removed) {
      res.status(404).json({
        message: 'Subscriber not found.',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
      });
      return;
    }

    const verification = await verifySubscriberRemoval(normalizedTarget);
    if (!verification.confirmed) {
      logSubscriberEvent('error', 'Subscriber removal verification failed.', {
        email: normalizeEmail(normalizedTarget),
        attempts: verification.attempts,
      });
      res.status(500).json({
        message:
          'Unable to confirm subscriber removal from storage. Please retry once the storage service is available.',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
        verification,
      });
      return;
    }

    const totalCount = await getSubscriberCount({ record: false });

    logSubscriberEvent('info', 'Subscriber removed via API.', {
      email: normalizeEmail(normalizedTarget),
      count: totalCount,
      confirmed: verification.confirmed,
    });

    await recordSubscriberGrowthSnapshot(totalCount);

    res.status(200).json({
      message: 'Subscriber removed.',
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      verification,
      count: totalCount,
    });
  } catch (error) {
    logSubscriberEvent('error', 'Failed to remove subscriber.', {
      email: normalizeEmail(normalizedTarget),
      message: error?.message,
      code: error?.code,
    });
    const message =
      error instanceof SubscriberStorageError
        ? 'Unable to remove subscriber because storage is unavailable. Please verify the Vercel KV connection.'
        : 'Could not remove subscriber.';
    res.status(500).json({
      message,
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      details: error?.message,
    });
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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
if (await subscriberExists(canonicalEmail)) {
      logger.info('Public subscribe duplicate attempt.', { ip, email: normalizedEmail });
      res.status(200).json({
        success: false,
        error: 'Email already subscribed',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
      });
      return;
    }

    await addSubscriber(canonicalEmail, sanitizedName || null, { source: 'public-api' });
    const verification = await verifySubscriberPersistence(normalizedEmail);

    if (!verification.verified) {
      logSubscriberEvent('error', 'Public subscribe verification failed.', {
        email: normalizedEmail,
        attempts: verification.attempts,
      });
      res.status(500).json({
        success: false,
        error:
          'We could not confirm your subscription due to a storage issue. Please try again once the service is available.',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
        verification,
      });
      return;
    }

    const totalCount = await getSubscriberCount({ record: false });

    logger.info('Public subscribe success.', { ip, email: normalizedEmail, name: sanitizedName });
    logSubscriberEvent('info', 'Subscriber added via public API.', {
      email: normalizedEmail,
      count: totalCount,
      verified: verification.verified,
    });

    await recordSubscriberGrowthSnapshot(totalCount);

    res.json({
      success: true,
      message: 'Successfully subscribed!',
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      verification,
      count: totalCount,
    });
  } catch (error) {
    logger.error('Public subscribe failed.', {
      ip,
      email: normalizedEmail,
      message: error?.message,
      code: error?.code,
    });
    logSubscriberEvent('error', 'Public subscribe failed.', {
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
      storage: subscriberStoreMode,
      kvConnectionHealthy,
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
    res.status(400).json({
      success: false,
      error: 'Please provide a valid email address.',
      storage: subscriberStoreMode,
      kvConnectionHealthy,
    });
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  const canonicalEmail = extractEmailAddress(email);

  try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const removed = await removeSubscriber(canonicalEmail);
    if (!removed) {
      logger.info('Public unsubscribe not found.', { ip, email: normalizedEmail });
      recordSuspiciousAttempt(ip, 'unsubscribe-not-found', { email: normalizedEmail });
      res.status(200).json({
        success: false,
        error: 'Email not found',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
      });
      return;
    }

    const verification = await verifySubscriberRemoval(canonicalEmail);
    if (!verification.confirmed) {
      logSubscriberEvent('error', 'Public unsubscribe verification failed.', {
        email: normalizedEmail,
        attempts: verification.attempts,
      });
      res.status(500).json({
        success: false,
        error:
          'Unable to confirm removal in storage. Please try again after the storage service recovers.',
        storage: subscriberStoreMode,
        kvConnectionHealthy,
        verification,
      });
      return;
    }

    const totalCount = await getSubscriberCount({ record: false });

    logger.info('Public unsubscribe success.', { ip, email: normalizedEmail });
    logSubscriberEvent('info', 'Subscriber removed via public API.', {
      email: normalizedEmail,
      count: totalCount,
      confirmed: verification.confirmed,
    });
    await recordSubscriberGrowthSnapshot(totalCount);
    res.json({
      success: true,
      message: 'Successfully unsubscribed',
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      verification,
      count: totalCount,
    });
  } catch (error) {
    logger.error('Public unsubscribe failed.', {
      ip,
      email: normalizedEmail,
      message: error?.message,
      code: error?.code,
    });
    logSubscriberEvent('error', 'Public unsubscribe failed.', {
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
      storage: subscriberStoreMode,
      kvConnectionHealthy,
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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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
      id: campaignId,
      total: totalSubscribers,
      batchSize: RESEND_BATCH_SIZE,
      batchesEstimated,
      delayMsBetweenBatches: RESEND_BATCH_DELAY_MS,
      estimatedCompletion,
      successes: [],
      failures: [],
      skipped: [],
      progressUpdates: [],
      startedAt: sendStartedAt.toISOString(),
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

    const campaignStatus =
      summary.failedCount === 0
        ? 'success'
        : summary.sentCount === 0
        ? 'failed'
        : 'partial';
    summary.status = campaignStatus;

    logger.info('Newsletter send completed.', {
      totalSubscribers,
      sent: summary.sentCount,
      failed: summary.failedCount,
      elapsedMs,
      batchesProcessed: summary.completedBatches,
    });\n    try {
      await storeCampaignSummary({
        id: campaignId,
        title,
        sentAt: summary.completedAt,
        recipients: totalSubscribers,
        delivered: summary.sentCount,
        failed: summary.failedCount,
        successCount: summary.sentCount,
        failureCount: summary.failedCount,
        status: campaignStatus,
      });
      const aggregateMetrics = await getAggregateMetrics();
      aggregateMetrics.sent = Math.max(0, (aggregateMetrics.sent || 0) + totalSubscribers);
      aggregateMetrics.delivered = Math.max(0, (aggregateMetrics.delivered || 0) + summary.sentCount);
      aggregateMetrics.failed = Math.max(0, (aggregateMetrics.failed || 0) + summary.failedCount);
      await saveAggregateMetrics(aggregateMetrics);
    } catch (analyticsError) {
      logger.warn('Failed to persist campaign summary analytics.', {
        message: analyticsError?.message,
      });
    }

    lastEmailDiagnostic = {
      timestamp: new Date().toISOString(),
      status: campaignStatus === 'failed' ? 'error' : campaignStatus,
      context: 'send-newsletter',
      campaignId,
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
      campaignId,
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
            'Confirm KV_REST_API_URL and KV_REST_API_TOKEN are set and valid.',
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

// Lightweight analytics endpoint consumed by the dashboard to populate cards, tables, and charts.
app.get('/api/analytics', ensureAuthenticatedApi, async (req, res) => {
  try {
    const subscriberCount = await getSubscriberCount({ record: false });
    await ensureSubscriberGrowthSnapshot(subscriberCount);

    const [recentCampaigns, totalCampaigns, aggregateMetrics, growthWindow] = await Promise.all([
      listRecentCampaignSummaries(10),
      countCampaignSummaries(),
      getAggregateMetrics(),
      getSubscriberGrowthWindow(30),
    ]);

    const lastCampaign = recentCampaigns.length ? recentCampaigns[0] : null;

    res.json({
      totalSubscribers: subscriberCount,
      totalCampaignsSent: totalCampaigns,
      totalSent: aggregateMetrics.delivered || 0,
      lastCampaign,
      recentCampaigns,
      subscriberGrowth: growthWindow,
    });
  } catch (error) {
    logger.error('Analytics summary request failed.', {
      message: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({
      message: 'Failed to load analytics summary.',
      details: error?.message,
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
  const plainTextBody = `${stripHtml(sanitizedHtmlBody)}

Unsubscribe: ${unsubscribeLink}`;

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

app.get('/api/debug/storage', ensureAuthenticatedApi, async (req, res) => {
  try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const subscribers = await getSubscribers();
    res.json({
      storage: subscriberStoreMode,
      kvConnectionHealthy,
      kvInitializationError: kvInitializationError
        ? { message: kvInitializationError.message }
        : null,
      count: subscribers.length,
      emails: subscribers.map((subscriber) => subscriber.email),
      lastOperation: storageLastOperationDetails,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logSubscriberEvent('error', 'Storage debug endpoint failed.', {
      message: error?.message,
    });
    res.status(500).json({
      message: 'Storage debug lookup failed.',
      details: error?.message,
    });
  }
});

/**
 * Diagnostics endpoint for quick status checks.
 */
app.get('/api/diagnostics', ensureAuthenticatedApi, async (_, res) => {
  try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
const subscribers = await getSubscribers();
    let cloudinaryStatus = {
      ok: true,
      message: 'Connected',
    };

    try {
    const sendStartedAt = new Date();
    const campaignId = generateCampaignId();
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
      session: {
        store: sessionStoreMode,
        ready: sessionHealth.ready,
        error: sessionHealth.error,
        lastErrorAt: sessionHealth.lastErrorAt,
        lastConnectedAt: sessionHealth.lastConnectedAt,
        redisUrlPresent: sessionHealth.redisUrlPresent,
        lifecycle: { ...sessionLifecycle },
      },
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












