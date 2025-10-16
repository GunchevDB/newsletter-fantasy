/**
 * Frontend logic for the redesigned newsletter builder.
 * Handles navigation, compose workflow, preview modal, subscriber management,
 * image uploads, draft persistence, and sending newsletters.
 */

const TOAST_DEFAULT_DURATION = 6000;
const TOAST_TYPES = new Set(['success', 'error', 'warning', 'info']);
const TOAST_ICONS = {
  success: '✅',
  error: '⛔',
  warning: '⚠️',
  info: 'ℹ️',
};
const MAX_IMAGE_UPLOAD_SIZE = 5 * 1024 * 1024;
const TEMPLATE_STORAGE_KEY = 'newsletter-templates';
const PREVIEW_PREFERENCES_STORAGE_KEY = 'compose-preview-preferences-v1';
const PREVIEW_UPDATE_DEBOUNCE_MS = 500;
const PREVIEW_DEVICE_OPTIONS = ['desktop', 'tablet', 'mobile'];
const BUILT_IN_TEMPLATES = [
  {
    id: 'builtin-product-update',
    name: 'Product Update Template',
    title: "New Features You'll Love",
    previewText: "Discover what's new in this month's update",
    content: `
      <p>Hi there,</p>
      <p>We're excited to share the enhancements we released this month:</p>
      <ul>
        <li><strong>Smarter dashboards:</strong> Real-time insights with customizable widgets.</li>
        <li><strong>Collaboration spaces:</strong> Invite teammates, leave comments, and track decisions.</li>
        <li><strong>Mobile polish:</strong> A refreshed app with faster navigation and offline access.</li>
      </ul>
      <p>If you haven’t explored the updates yet, now’s the perfect time.</p>
      <p><a href="#" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#2563eb;color:#ffffff;text-decoration:none;">Explore the new features →</a></p>
      <p>Thanks for building with us,<br>The Product Team</p>
    `,
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'builtin-news-digest',
    name: 'News Digest Template',
    title: "This Week's Top Stories",
    previewText: 'Stay informed with our weekly roundup',
    content: `
      <p>Hello reader,</p>
      <p>Here’s everything you need to know this week:</p>
      <h3>Stories Worth Noting</h3>
      <ul>
        <li><strong>Industry Spotlight:</strong> <a href="#">Major trend shaping the market</a></li>
        <li><strong>Customer win:</strong> How teams like yours are thriving with our tools.</li>
        <li><strong>One big idea:</strong> Insight from our research desk to help you plan ahead.</li>
      </ul>
      <h3>Resources &amp; Deep Dives</h3>
      <p>• <a href="#">Webinar replay:</a> Making the most of your data stack.<br>
         • <a href="#">Playbook:</a> A 5-step approach to launching faster.</p>
      <p>See something we should include next week? Hit reply and tell us!</p>
      <p>Until next time,<br>The Editorial Team</p>
    `,
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'builtin-event-announcement',
    name: 'Event Announcement Template',
    title: "You're Invited: [Event Name]",
    previewText: 'Join us for an exciting event',
    content: `
      <p>Hello friend,</p>
      <p>We’re thrilled to invite you to <strong>[Event Name]</strong> — an immersive session designed to help you connect, learn, and grow.</p>
      <p><strong>Date:</strong> [Month] [Day], [Year]<br>
         <strong>Time:</strong> [Start time] – [End time] [Timezone]<br>
         <strong>Location:</strong> [Venue or virtual link]</p>
      <p>What to expect:</p>
      <ul>
        <li>Inspiring speakers and practical workshops.</li>
        <li>Hands-on demos of upcoming features.</li>
        <li>Networking with peers and the product team.</li>
      </ul>
      <p><a href="#" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#10b981;color:#ffffff;text-decoration:none;">Reserve your spot →</a></p>
      <p>We hope to see you there!<br>The Events Team</p>
    `,
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
];
let toastCounter = 0;
let previewPreferences = {
  splitMode: false,
  device: 'desktop',
  showImages: true,
};
let previewUpdateTimeoutId = null;
let lastPreviewHtml = '';
let inlinePreviewPendingScroll = 0;
let inlinePreviewRenderToken = 0;
let previewStatusClearTimeoutId = null;

function getToastContainer() {
  if (typeof document === 'undefined') {
    return null;
  }
  let container = document.getElementById('toast-container');
  if (!container && document.body) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(container);
  }
  return container || null;
}

function removeToastElement(element) {
  if (!element || element.dataset.leaving === 'true') {
    return;
  }
  element.dataset.leaving = 'true';
  window.setTimeout(() => {
    element.remove();
  }, 220);
}

function showToast(message, options = {}) {
  if (typeof document === 'undefined' || !message) {
    return null;
  }
  const container = getToastContainer();
  if (!container) {
    return null;
  }

  const {
    type = 'info',
    description = '',
    duration = TOAST_DEFAULT_DURATION,
    actions = [],
  } = options;

  const normalizedType = TOAST_TYPES.has(type) ? type : 'info';
  const toast = document.createElement('div');
  const toastId = `toast-${Date.now()}-${toastCounter += 1}`;
  toast.className = `toast toast--${normalizedType}`;
  toast.dataset.toastId = toastId;
  toast.setAttribute('role', normalizedType === 'error' ? 'alert' : 'status');

  const icon = document.createElement('div');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = TOAST_ICONS[normalizedType] || TOAST_ICONS.info;
  toast.appendChild(icon);

  const content = document.createElement('div');
  content.className = 'toast-content';
  const title = document.createElement('p');
  title.className = 'toast-title';
  title.textContent = message;
  content.appendChild(title);

  if (description) {
    const descriptionEl = document.createElement('p');
    descriptionEl.className = 'toast-description';
    descriptionEl.textContent = description;
    content.appendChild(descriptionEl);
  }

  toast.appendChild(content);

  let dismissalTimeout = null;
  const dismiss = () => {
    window.clearTimeout(dismissalTimeout);
    removeToastElement(toast);
  };

  if (Array.isArray(actions) && actions.length > 0) {
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'toast-actions';
    actions.forEach((action) => {
      if (!action || typeof action.label !== 'string') {
        return;
      }
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'toast-action';
      actionButton.textContent = action.label;
      actionButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof action.onClick === 'function') {
          action.onClick({
            dismiss,
            toastElement: toast,
          });
        }
        if (action.dismissOnClick !== false) {
          dismiss();
        }
      });
      actionsContainer.appendChild(actionButton);
    });
    toast.appendChild(actionsContainer);
  }

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'toast-close';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
  closeButton.textContent = '\u2715';
  toast.appendChild(closeButton);

  container.appendChild(toast);

  closeButton.addEventListener('click', dismiss);
  toast.addEventListener('mouseenter', () => window.clearTimeout(dismissalTimeout));
  toast.addEventListener('mouseleave', () => {
    if (!duration || duration <= 0) {
      return;
    }
    dismissalTimeout = window.setTimeout(dismiss, Math.max(duration / 2, 1200));
  });

  if (duration && duration > 0) {
    dismissalTimeout = window.setTimeout(dismiss, duration);
  }

  return { id: toastId, dismiss, element: toast };
}

function loadPreviewPreferencesFromStorage() {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PREVIEW_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return {
      splitMode: Boolean(parsed.splitMode),
      device: typeof parsed.device === 'string' ? parsed.device : 'desktop',
      showImages: parsed.showImages !== false,
    };
  } catch (error) {
    console.warn('Failed to load preview preferences', error);
    return null;
  }
}

function persistPreviewPreferencesToStorage(preferences) {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      PREVIEW_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch (error) {
    console.warn('Failed to persist preview preferences', error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const DOMPURIFY_CONFIG = {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(https?:|mailto:)/i,
  };
  const DRAFT_STORAGE_KEY = 'newsletter-draft';
  const PREVIEW_MAX_LENGTH = 150;
  const SUBSCRIBER_PAGE_SIZE = 50;
  const SOURCE_LABELS = {
    manual: 'Manual',
    'public-api': 'Public form',
    'public-form': 'Public form',
    imported: 'Imported',
    automation: 'Automation',
    referral: 'Referral',
  };

  // Navigation -----------------------------------------------------------------
  const navTabs = document.querySelectorAll('.nav-tab');
  const views = document.querySelectorAll('.view-card');
  const mobileNavToggle = document.getElementById('mobile-nav-toggle');
  const primaryNav = document.getElementById('primary-nav');
  const logoutButton = document.getElementById('logout-button');

  function toggleNav(forceOpen) {
    const isOpen = forceOpen ?? !primaryNav.classList.contains('is-open');
    primaryNav.classList.toggle('is-open', isOpen);
    mobileNavToggle.setAttribute('aria-expanded', String(isOpen));
  }

  function activateView(targetId) {
    navTabs.forEach((tab) => {
      const isActive = tab.dataset.target === targetId;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });

    views.forEach((view) => {
      const isActive = view.dataset.view === targetId;
      view.classList.toggle('is-active', isActive);
      view.hidden = !isActive;
      if (isActive) {
        view.setAttribute('tabindex', '-1');
        view.focus({ preventScroll: false });
        view.removeAttribute('tabindex');
      }
    });
  }

  navTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetView = tab.dataset.target;
      activateView(targetView);
      if (targetView === 'subscribers-view') {
        loadSubscribers({ silent: subscribersLoadedOnce }).catch(() => { });
      }
      if (primaryNav.classList.contains('is-open')) {
        toggleNav(false);
      }
    });
  });

  if (mobileNavToggle) {
    mobileNavToggle.addEventListener('click', () => toggleNav());
  }

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 992 && primaryNav.classList.contains('is-open')) {
      toggleNav(false);
    }
  });

  views.forEach((view) => {
    view.hidden = !view.classList.contains('is-active');
  });

  // Compose references ---------------------------------------------------------
  const titleInput = document.getElementById('newsletter-title');
  const previewTextInput = document.getElementById('newsletter-preview-text');
  const previewCounter = document.getElementById('preview-char-counter');
  const editor = document.getElementById('newsletter-content');
  const toolbarButtons = document.querySelectorAll('.editor-toolbar button[data-command]');
  const uploadTrigger = document.getElementById('upload-image-trigger');
  const uploadInput = document.getElementById('image-upload-input');
  const imageUploadStatus = document.getElementById('image-upload-status');
  const previewButton = document.getElementById('preview-button');
  const previewModal = document.getElementById('preview-modal');
  const previewClose = document.getElementById('preview-close');
  const previewFrame = document.getElementById('email-preview');
  const sendButton = document.getElementById('send-button');
  const sendButtonLabel = document.getElementById('send-button-label');
  const saveDraftButton = document.getElementById('save-draft-button');
  const sendStatus = document.getElementById('send-status');
  const modalBackdrop = previewModal?.querySelector('[data-close-modal]');
  const sendConfirmModal = document.getElementById('send-confirm-modal');
  const sendConfirmClose = document.getElementById('send-confirm-close');
  const sendConfirmCancel = document.getElementById('send-confirm-cancel');
  const sendConfirmButton = document.getElementById('send-confirm-button');
  const sendConfirmButtonLabel = document.getElementById('send-confirm-button-label');
  const sendConfirmMessage = document.getElementById('send-confirm-message');
  const sendConfirmCount = document.getElementById('send-confirm-count');
  const sendConfirmBackdrop = sendConfirmModal?.querySelector('[data-close-modal]');
  const templateMenuButton = document.getElementById('template-menu-button');
  const templateMenu = document.getElementById('template-menu');
  const saveTemplateButton = document.getElementById('save-template-button');
  const templateManageModal = document.getElementById('template-manage-modal');
  const templateManageClose = document.getElementById('template-manage-close');
  const templateManageCloseFooter = document.getElementById('template-manage-close-footer');
  const templateManageList = document.getElementById('template-manage-list');
  const templateEmptyState = document.getElementById('template-empty-state');
  const templateManageBackdrop = templateManageModal?.querySelector('[data-close-modal]');
  const templateSaveModal = document.getElementById('template-save-modal');
  const templateSaveClose = document.getElementById('template-save-close');
  const templateSaveCancel = document.getElementById('template-save-cancel');
  const templateSaveConfirm = document.getElementById('template-save-confirm');
  const templateNameInput = document.getElementById('template-name-input');
  const templateSaveBackdrop = templateSaveModal?.querySelector('[data-close-modal]');
  const composeLayout = document.getElementById('compose-layout');
  const splitPreviewToggle = document.getElementById('split-preview-toggle');
  const inlinePreviewPane = document.getElementById('compose-preview-pane');
  const inlinePreviewFrame = document.getElementById('split-preview-frame');
  const inlinePreviewDeviceFrame = inlinePreviewPane?.querySelector('.preview-device-frame');
  const previewLoadingIndicator = document.getElementById('preview-loading');
  const previewErrorMessage = document.getElementById('preview-error');
  const previewMetaCounts = document.getElementById('preview-meta-counts');
  const previewRenderTime = document.getElementById('preview-render-time');
  const previewStatusMessage = document.getElementById('preview-status-message');
  const previewImagesCheckbox = document.getElementById('preview-images-checkbox');
  const previewRefreshButton = document.getElementById('preview-refresh-button');
  const previewCopyButton = document.getElementById('preview-copy-button');
  const deviceToggleButtons = inlinePreviewPane
    ? Array.from(inlinePreviewPane.querySelectorAll('.device-toggle-button'))
    : [];

  const storedPreviewPreferences = loadPreviewPreferencesFromStorage();
  if (storedPreviewPreferences) {
    const preferredDevice = PREVIEW_DEVICE_OPTIONS.includes(storedPreviewPreferences.device)
      ? storedPreviewPreferences.device
      : 'desktop';
    previewPreferences = {
      splitMode: Boolean(storedPreviewPreferences.splitMode),
      device: preferredDevice,
      showImages: storedPreviewPreferences.showImages !== false,
    };
  }

  applySplitMode(previewPreferences.splitMode, {
    skipPersist: true,
    suppressRender: true,
    suppressMessage: true,
  });
  applyDeviceSelection(previewPreferences.device, { skipPersist: true, suppressRender: true });
  applyShowImagesPreference(previewPreferences.showImages, { skipPersist: true, suppressRender: true });

  // Subscriber references ------------------------------------------------------
  const subscriberRowTemplate = document.getElementById('subscriber-row-template');
  const subscriberTableBody = document.getElementById('subscriber-table-body');
  const subscriberCount = document.getElementById('subscriber-total');
  const storageModeBadge = document.getElementById('subscriber-storage-mode');
  const subscriberStatus = document.getElementById('subscriber-status');
  const subscriberSearch = document.getElementById('subscriber-search');
  const subscriberFilter = document.getElementById('subscriber-filter');
  const subscriberLoading = document.getElementById('subscriber-loading');
  const subscriberEmptyState = document.getElementById('subscribers-empty');
  const subscriberPrev = document.getElementById('subscriber-prev');
  const subscriberNext = document.getElementById('subscriber-next');
  const subscriberPageInfo = document.getElementById('subscriber-page-info');
  const toggleAddSubscriberButton = document.getElementById('toggle-add-subscriber');
  const addSubscriberForm = document.getElementById('add-subscriber-form');
  const cancelAddSubscriberButton = document.getElementById('cancel-add-subscriber');
  const subscriberEmailInput = document.getElementById('subscriber-email');
  const subscriberNameInput = document.getElementById('subscriber-name');
  // Analytics references ------------------------------------------------------
  const refreshAnalyticsButton = document.getElementById('refresh-analytics');
  const analyticsLoading = document.getElementById('analytics-loading');
  const analyticsError = document.getElementById('analytics-error');
  const analyticsContent = document.getElementById('analytics-content');
  const analyticsTotalSubscribers = document.getElementById('analytics-total-subscribers');
  const analyticsTotalSent = document.getElementById('analytics-total-sent');
  const analyticsLastCampaign = document.getElementById('analytics-last-campaign');
  const analyticsLastCampaignStatus = document.getElementById('analytics-last-campaign-status');
  const analyticsCampaignsBody = document.getElementById('analytics-campaigns-body');
  const analyticsCampaignsEmpty = document.getElementById('analytics-campaigns-empty');
  const analyticsGrowthCanvas = document.getElementById('analytics-growth-chart');


  let subscribersCache = [];
  let filteredSubscribers = [];
  let currentSubscriberPage = 1;
  let searchDebounceTimeout = null;
  let subscribersLoadedOnce = false;
  let analyticsLoadedOnce = false;
  let analyticsChart = null; // Holds the Chart.js instance so we can update or destroy between refreshes.
  let subscriberTotal = 0;
  let releasePreviewFocusTrap = null;
  let releaseSendConfirmFocusTrap = null;
  let lastFocusedBeforePreview = null;
  let lastFocusedBeforeSendConfirm = null;
  let isSendingNewsletter = false;
  let templateMenuOpen = false;
  let customTemplates = [];
  let releaseTemplateManageFocusTrap = null;
  let releaseTemplateSaveFocusTrap = null;
  let lastFocusedBeforeTemplateManage = null;
  let lastFocusedBeforeTemplateSave = null;

  if (toggleAddSubscriberButton) {
    toggleAddSubscriberButton.dataset.defaultContent = toggleAddSubscriberButton.innerHTML;
    toggleAddSubscriberButton.setAttribute('aria-expanded', 'false');
  }

  // Utility helpers ------------------------------------------------------------
  function sanitizeEditorHtml(raw) {
    if (!window.DOMPurify) {
      console.warn('DOMPurify not found; skipping client-side sanitization.');
      return raw;
    }
    return window.DOMPurify.sanitize(raw, DOMPURIFY_CONFIG);
  }

  function updatePreviewCounter() {
    const length = previewTextInput.value.length;
    previewCounter.textContent = `${length} / ${PREVIEW_MAX_LENGTH}`;
    previewCounter.classList.toggle('limit-reached', length >= PREVIEW_MAX_LENGTH);
  }

  function setSendStatus(message, isError = false, options = {}) {
    if (!sendStatus) {
      return;
    }
    sendStatus.textContent = message;
    sendStatus.classList.remove('is-error', 'is-success');
    if (!message) {
      return;
    }
    const { variant, toast } = options;
    const resolvedVariant = variant || (isError ? 'error' : 'info');
    if (resolvedVariant === 'error') {
      sendStatus.classList.add('is-error');
    } else if (resolvedVariant === 'success') {
      sendStatus.classList.add('is-success');
    }
    if (toast) {
      const toastConfig = typeof toast === 'object' ? toast : {};
      const toastTitle = toastConfig.title || message;
      const toastType = toastConfig.type
        || (resolvedVariant === 'error' ? 'error' : resolvedVariant === 'success' ? 'success' : 'info');
      showToast(toastTitle, {
        type: toastType,
        description: toastConfig.description,
        duration: toastConfig.duration,
      });
    }
  }

  function setInlineStatus(element, message, isError = false) {
    if (!element) {
      return;
    }
    element.textContent = message;
    element.classList.toggle('is-error', isError);
  }

  function shouldRenderInlinePreview() {
    return composeLayout?.dataset.previewMode === 'split';
  }

  function updatePreviewStatus(message, variant = 'info') {
    if (!previewStatusMessage) {
      return;
    }
    previewStatusMessage.textContent = message || '';
    previewStatusMessage.classList.remove('is-error', 'is-success');
    if (previewStatusClearTimeoutId) {
      window.clearTimeout(previewStatusClearTimeoutId);
      previewStatusClearTimeoutId = null;
    }
    if (!message) {
      return;
    }
    if (variant === 'error') {
      previewStatusMessage.classList.add('is-error');
    } else if (variant === 'success') {
      previewStatusMessage.classList.add('is-success');
    }
    previewStatusClearTimeoutId = window.setTimeout(() => {
      if (previewStatusMessage) {
        previewStatusMessage.textContent = '';
        previewStatusMessage.classList.remove('is-error', 'is-success');
      }
    }, 4000);
  }

  function showPreviewError(message) {
    if (!previewErrorMessage) {
      return;
    }
    if (!message) {
      previewErrorMessage.classList.add('hidden');
      previewErrorMessage.textContent = '';
      return;
    }
    previewErrorMessage.textContent = message;
    previewErrorMessage.classList.remove('hidden');
  }

  function showPreviewLoading() {
    if (previewLoadingIndicator) {
      previewLoadingIndicator.classList.remove('hidden');
    }
  }

  function hidePreviewLoading() {
    if (previewLoadingIndicator) {
      previewLoadingIndicator.classList.add('hidden');
    }
  }

  function applySplitMode(enabled, options = {}) {
    const normalized = Boolean(enabled);
    if (composeLayout) {
      composeLayout.setAttribute('data-preview-mode', normalized ? 'split' : 'single');
    }
    if (inlinePreviewPane) {
      inlinePreviewPane.setAttribute('aria-hidden', String(!normalized));
    }
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('split-preview-active', normalized);
    }
    if (splitPreviewToggle) {
      splitPreviewToggle.setAttribute('aria-pressed', String(normalized));
      splitPreviewToggle.classList.toggle('is-active', normalized);
    }
    previewPreferences.splitMode = normalized;
    if (!options.skipPersist) {
      persistPreviewPreferencesToStorage(previewPreferences);
    }
    if (normalized && !options.suppressRender) {
      scheduleInlinePreviewUpdate({
        immediate: true,
        reason: 'split-toggle',
        forceRender: true,
      });
      if (!options.suppressMessage) {
        updatePreviewStatus('Split preview enabled', 'success');
      }
    } else if (!normalized) {
      hidePreviewLoading();
      showPreviewError('');
      if (!options.suppressMessage) {
        updatePreviewStatus('Split preview disabled');
      }
    }
  }

  function applyDeviceSelection(device, options = {}) {
    const normalized = PREVIEW_DEVICE_OPTIONS.includes(device) ? device : 'desktop';
    previewPreferences.device = normalized;
    if (inlinePreviewDeviceFrame) {
      inlinePreviewDeviceFrame.setAttribute('data-device', normalized);
    }
    deviceToggleButtons.forEach((button) => {
      const isActive = button.dataset.device === normalized;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    if (!options.skipPersist) {
      persistPreviewPreferencesToStorage(previewPreferences);
    }
    if (!options.suppressRender) {
      if (shouldRenderInlinePreview()) {
        const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);
        updatePreviewStatus(`${label} preview width`, 'info');
      }
      scheduleInlinePreviewUpdate({
        immediate: true,
        reason: 'device-change',
        forceRender: true,
      });
    }
  }

  function applyShowImagesPreference(showImages, options = {}) {
    const normalized = showImages !== false;
    previewPreferences.showImages = normalized;
    if (previewImagesCheckbox) {
      previewImagesCheckbox.checked = normalized;
    }
    if (!options.skipPersist) {
      persistPreviewPreferencesToStorage(previewPreferences);
    }
    if (!options.suppressRender) {
      if (shouldRenderInlinePreview()) {
        updatePreviewStatus(
          normalized ? 'Images visible in preview' : 'Images hidden in preview',
          normalized ? 'success' : 'info',
        );
      }
      scheduleInlinePreviewUpdate({
        immediate: true,
        reason: 'image-visibility-toggle',
        forceRender: true,
      });
    }
  }

  function updatePreviewMetricsDisplay() {
    if (!previewMetaCounts || !editor) {
      return;
    }
    const rawText = editor.innerText || '';
    const normalized = rawText.replace(/\s+/g, ' ').trim();
    const charCount = normalized.length;
    const words = normalized ? normalized.split(' ').filter((word) => word.length > 0) : [];
    const wordCount = words.length;
    const wordLabel = wordCount === 1 ? 'word' : 'words';
    previewMetaCounts.textContent = `${charCount} chars · ${wordCount} ${wordLabel}`;
  }

  function convertContentImagesToPlaceholders(html) {
    if (!html) {
      return html;
    }
    if (typeof DOMParser === 'function') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
        const container = doc.body;
        container.querySelectorAll('img').forEach((img) => {
          const placeholder = doc.createElement('div');
          placeholder.className = 'preview-image-placeholder';
          const alt = (img.getAttribute('alt') || '').trim();
          placeholder.textContent = alt ? `[Image: ${alt}]` : '[Image]';
          img.replaceWith(placeholder);
        });
        return container.innerHTML;
      } catch (error) {
        console.warn('Failed to parse content for image placeholders', error);
      }
    }
    return html
      .replace(
        /<img\b[^>]*alt="([^"]*)"[^>]*>/gi,
        (_, alt) => `<div class="preview-image-placeholder">[Image: ${alt.trim()}]</div>`,
      )
      .replace(
        /<img\b[^>]*>/gi,
        '<div class="preview-image-placeholder">[Image]</div>',
      );
  }

  function scheduleInlinePreviewUpdate(options = {}) {
    const {
      immediate = false,
      reason = 'auto',
      forceRender = false,
    } = options;
    if (immediate) {
      window.clearTimeout(previewUpdateTimeoutId);
      renderPreview({
        showModal: false,
        reason,
        forceRenderInline: forceRender,
      });
      return;
    }
    window.clearTimeout(previewUpdateTimeoutId);
    previewUpdateTimeoutId = window.setTimeout(() => {
      renderPreview({
        showModal: false,
        reason,
        forceRenderInline: forceRender,
      });
    }, PREVIEW_UPDATE_DEBOUNCE_MS);
  }

  function updateInlinePreview(html, options = {}) {
    if (!inlinePreviewFrame || typeof html !== 'string') {
      if (typeof html === 'string') {
        lastPreviewHtml = html;
      }
      return;
    }
    lastPreviewHtml = html;
    const shouldForce = Boolean(options.force);
    if (!shouldForce && !shouldRenderInlinePreview()) {
      return;
    }
    try {
      const frameWindow = inlinePreviewFrame.contentWindow;
      inlinePreviewPendingScroll =
        frameWindow?.scrollY
        ?? frameWindow?.document?.documentElement?.scrollTop
        ?? frameWindow?.document?.body?.scrollTop
        ?? 0;
    } catch (error) {
      inlinePreviewPendingScroll = 0;
    }
    showPreviewLoading();
    inlinePreviewRenderToken += 1;
    inlinePreviewFrame.dataset.renderToken = String(inlinePreviewRenderToken);
    inlinePreviewFrame.srcdoc = html;
  }

  inlinePreviewFrame?.addEventListener('load', () => {
    const { renderToken } = inlinePreviewFrame.dataset;
    if (!renderToken || Number(renderToken) !== inlinePreviewRenderToken) {
      return;
    }
    hidePreviewLoading();
    try {
      inlinePreviewFrame.contentWindow?.scrollTo(0, inlinePreviewPendingScroll || 0);
    } catch (error) {
      // Ignore scroll restoration errors.
    }
    if (shouldRenderInlinePreview()) {
      updatePreviewStatus('Preview updated', 'success');
    }
    updatePreviewMetricsDisplay();
  });

  function setSubscriberStatus(message, isError = false, options = {}) {
    if (!subscriberStatus) {
      return;
    }
    subscriberStatus.textContent = message;
    subscriberStatus.classList.remove('is-error', 'is-success');
    if (!message) {
      return;
    }
    const { highlightSuccess = false, toast } = options;
    if (isError) {
      subscriberStatus.classList.add('is-error');
    } else if (highlightSuccess) {
      subscriberStatus.classList.add('is-success');
    }
    if (toast) {
      const toastConfig = typeof toast === 'object' ? toast : {};
      const toastTitle = toastConfig.title || message;
      const toastType = toastConfig.type
        || (isError ? 'error' : highlightSuccess ? 'success' : 'info');
      showToast(toastTitle, {
        type: toastType,
        description: toastConfig.description,
        duration: toastConfig.duration,
      });
    }
  }

  function loadCustomTemplatesFromStorage() {
    try {
      const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((record) => ({
          id: String(record?.id ?? Date.now().toString()),
          name: String(record?.name || 'Untitled template').trim() || 'Untitled template',
          title: typeof record?.title === 'string' ? record.title : '',
          previewText: typeof record?.previewText === 'string' ? record.previewText : '',
          content: typeof record?.content === 'string' ? record.content : '',
          isBuiltIn: false,
          createdAt: record?.createdAt || new Date().toISOString(),
        }))
        .filter(
          (template, index, list) =>
            list.findIndex((other) => String(other.id) === String(template.id)) === index,
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (error) {
      console.warn('Failed to load templates from storage.', error);
      return [];
    }
  }

  function persistCustomTemplates(nextTemplates) {
    customTemplates = nextTemplates
      .map((template) => ({
        id: String(template.id || Date.now().toString()),
        name: String(template.name || 'Untitled template').trim() || 'Untitled template',
        title: template.title || '',
        previewText: template.previewText || '',
        content: template.content || '',
        isBuiltIn: false,
        createdAt: template.createdAt || new Date().toISOString(),
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    try {
      localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(customTemplates));
    } catch (error) {
      console.warn('Failed to persist templates.', error);
    }
  }

  function getAllTemplates() {
    const builtIns = BUILT_IN_TEMPLATES.map((template) => ({
      ...template,
      content: (template.content || '').trim(),
    }));
    const customs = customTemplates.map((template) => ({
      ...template,
      content: (template.content || '').trim(),
      isBuiltIn: false,
    }));
    return [...builtIns, ...customs];
  }

  function findTemplateById(templateId) {
    if (!templateId) {
      return null;
    }
    const idString = String(templateId);
    return getAllTemplates().find((template) => String(template.id) === idString) || null;
  }

  function stripHtmlToPreview(html, limit = 140) {
    if (!html) {
      return '';
    }
    const parser = document.createElement('div');
    parser.innerHTML = html;
    const text = (parser.textContent || parser.innerText || '').replace(/\s+/g, ' ').trim();
    if (!limit || text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit).trim()}…`;
  }

  function renderTemplateMenu() {
    if (!templateMenu) {
      return;
    }
    templateMenu.innerHTML = '';
    const fragment = document.createDocumentFragment();
    const builtIns = BUILT_IN_TEMPLATES;
    const savedTemplates = customTemplates;

    const addSection = (label, templates) => {
      if (!templates.length) {
        return;
      }
      const sectionLabel = document.createElement('div');
      sectionLabel.className = 'template-menu-section';
      sectionLabel.textContent = label;
      fragment.appendChild(sectionLabel);

      templates.forEach((template) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.templateId = template.id;
        button.dataset.templateBuiltIn = template.isBuiltIn ? 'true' : 'false';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = template.name;
        button.appendChild(nameSpan);

        const note = template.previewText?.trim()
          || stripHtmlToPreview(template.content, 60);
        if (note) {
          const noteSpan = document.createElement('span');
          noteSpan.className = 'menu-note';
          noteSpan.textContent = note;
          button.appendChild(noteSpan);
        }

        fragment.appendChild(button);
      });
    };

    addSection('Built-in templates', builtIns);
    if (builtIns.length && savedTemplates.length) {
      const divider = document.createElement('div');
      divider.className = 'menu-divider';
      fragment.appendChild(divider);
    }
    addSection('Saved templates', savedTemplates);

    const manageDivider = document.createElement('div');
    manageDivider.className = 'menu-divider';
    fragment.appendChild(manageDivider);

    const manageButton = document.createElement('button');
    manageButton.type = 'button';
    manageButton.dataset.menuAction = 'manage';
    manageButton.setAttribute('role', 'menuitem');
    manageButton.textContent = 'Manage templates';
    fragment.appendChild(manageButton);

    templateMenu.appendChild(fragment);
  }

  function handleTemplateMenuClick(event) {
    const targetButton = event.target.closest('button');
    if (!targetButton) {
      return;
    }
    const action = targetButton.dataset.menuAction;
    if (action === 'manage') {
      event.preventDefault();
      closeTemplateMenu();
      openTemplateManageModal();
      return;
    }
    const templateId = targetButton.dataset.templateId;
    if (!templateId) {
      return;
    }
    closeTemplateMenu();
    const template = findTemplateById(templateId);
    requestTemplateLoad(template, { source: 'menu' });
  }

  function handleDocumentClickForTemplateMenu(event) {
    if (!templateMenuOpen) {
      return;
    }
    if (templateMenu?.contains(event.target) || templateMenuButton?.contains(event.target)) {
      return;
    }
    closeTemplateMenu();
  }

  function openTemplateMenu() {
    if (!templateMenuButton || !templateMenu) {
      return;
    }
    renderTemplateMenu();
    templateMenu.classList.remove('hidden');
    templateMenuButton.setAttribute('aria-expanded', 'true');
    templateMenuOpen = true;
  }

  function closeTemplateMenu() {
    if (!templateMenuButton || !templateMenu) {
      return;
    }
    templateMenu.classList.add('hidden');
    templateMenuButton.setAttribute('aria-expanded', 'false');
    templateMenuOpen = false;
  }

  function openTemplateSaveModal() {
    if (!templateSaveModal) {
      return;
    }
    closeTemplateMenu();
    lastFocusedBeforeTemplateSave =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (templateNameInput) {
      templateNameInput.value = titleInput?.value?.trim() || '';
    }
    templateSaveModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    if (typeof releaseTemplateSaveFocusTrap === 'function') {
      releaseTemplateSaveFocusTrap();
    }
    releaseTemplateSaveFocusTrap = createFocusTrap(templateSaveModal);
    window.setTimeout(() => {
      templateNameInput?.focus({ preventScroll: true });
      templateNameInput?.select();
    }, 50);
  }

  function closeTemplateSaveModal({ restoreFocus = true } = {}) {
    if (!templateSaveModal) {
      return;
    }
    templateSaveModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (typeof releaseTemplateSaveFocusTrap === 'function') {
      releaseTemplateSaveFocusTrap();
      releaseTemplateSaveFocusTrap = null;
    }
    if (restoreFocus && lastFocusedBeforeTemplateSave) {
      lastFocusedBeforeTemplateSave.focus({ preventScroll: true });
    }
    lastFocusedBeforeTemplateSave = null;
  }

  function openTemplateManageModal() {
    if (!templateManageModal) {
      return;
    }
    closeTemplateMenu();
    renderTemplateManageList();
    lastFocusedBeforeTemplateManage =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    templateManageModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    if (typeof releaseTemplateManageFocusTrap === 'function') {
      releaseTemplateManageFocusTrap();
    }
    releaseTemplateManageFocusTrap = createFocusTrap(templateManageModal);
    window.setTimeout(() => {
      templateManageModal.querySelector('[data-template-action="load"]')?.focus({ preventScroll: true });
    }, 50);
  }

  function closeTemplateManageModal({ restoreFocus = true } = {}) {
    if (!templateManageModal) {
      return;
    }
    templateManageModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (typeof releaseTemplateManageFocusTrap === 'function') {
      releaseTemplateManageFocusTrap();
      releaseTemplateManageFocusTrap = null;
    }
    if (restoreFocus && lastFocusedBeforeTemplateManage) {
      lastFocusedBeforeTemplateManage.focus({ preventScroll: true });
    }
    lastFocusedBeforeTemplateManage = null;
  }

  function renderTemplateManageList() {
    if (!templateManageList) {
      return;
    }
    const templates = getAllTemplates();
    templateManageList.innerHTML = '';
    if (!templates.length) {
      templateEmptyState?.classList.remove('hidden');
      return;
    }
    templateEmptyState?.classList.add('hidden');

    templates.forEach((template) => {
      const card = document.createElement('article');
      card.className = 'template-card';
      card.dataset.templateId = template.id;
      card.setAttribute('role', 'listitem');

      const header = document.createElement('div');
      header.className = 'template-card__header';
      const name = document.createElement('h3');
      name.className = 'template-card__name';
      name.textContent = template.name;
      header.appendChild(name);

      if (template.isBuiltIn) {
        const badge = document.createElement('span');
        badge.className = 'template-badge';
        badge.textContent = 'Built-in';
        header.appendChild(badge);
      }

      card.appendChild(header);

      const meta = document.createElement('div');
      meta.className = 'template-card__meta';
      const createdAt = document.createElement('span');
      createdAt.textContent = `Updated ${formatDate(template.createdAt)}`;
      meta.appendChild(createdAt);
      card.appendChild(meta);

      const preview = document.createElement('p');
      preview.className = 'template-card__preview';
      preview.textContent =
        template.previewText?.trim() || stripHtmlToPreview(template.content, 120) || 'No preview text';
      card.appendChild(preview);

      const actions = document.createElement('div');
      actions.className = 'template-card__actions';

      const loadButton = document.createElement('button');
      loadButton.type = 'button';
      loadButton.className = 'btn secondary';
      loadButton.dataset.templateAction = 'load';
      loadButton.textContent = 'Load';
      actions.appendChild(loadButton);

      if (!template.isBuiltIn) {
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'btn ghost';
        deleteButton.dataset.templateAction = 'delete';
        deleteButton.textContent = 'Delete';
        actions.appendChild(deleteButton);
      }

      card.appendChild(actions);
      templateManageList.appendChild(card);
    });
  }

  function requestTemplateLoad(template, options = {}) {
    if (!template) {
      return;
    }
    const { source = 'menu' } = options;
    const hasExistingContent =
      Boolean(titleInput?.value?.trim())
      || Boolean(previewTextInput?.value?.trim())
      || Boolean(editor?.innerText?.trim());

    const apply = () => {
      applyTemplate(template);
    };

    if (hasExistingContent) {
      if (source === 'manage') {
        closeTemplateManageModal({ restoreFocus: false });
      }
      showToast('Replace current content with template?', {
        type: 'warning',
        description: `Loading "${template.name}" will overwrite your current draft.`,
        actions: [
          {
            label: 'Replace',
            onClick: ({ dismiss }) => {
              dismiss();
              apply();
            },
          },
          {
            label: 'Cancel',
            dismissOnClick: true,
          },
        ],
      });
    } else {
      if (source === 'manage') {
        closeTemplateManageModal({ restoreFocus: false });
      }
      apply();
    }
  }

  function applyTemplate(template) {
    if (!template) {
      return;
    }
    closeTemplateMenu();
    const templateTitle = (template.title || '').trim();
    const templatePreview = (template.previewText || '').trim();
    const templateContent = (template.content || '').trim();

    if (titleInput) {
      titleInput.value = templateTitle;
      titleInput.dispatchEvent(new Event('input'));
    }
    if (previewTextInput) {
      previewTextInput.value = templatePreview;
      previewTextInput.dispatchEvent(new Event('input'));
    }
    if (editor) {
      editor.innerHTML = templateContent;
      editor.dispatchEvent(new Event('input'));
    }
    updatePreviewCounter();
    updateBestPractices();
    saveDraft({ announce: false });
    showToast(`Template loaded: ${template.name}`, {
      type: 'success',
    });
    setSendStatus(`Template "${template.name}" loaded into the editor.`);
  }

  function handleTemplateSave() {
    if (!templateNameInput) {
      return;
    }
    const name = templateNameInput.value.trim();
    if (!name) {
      showToast('Template name is required', {
        type: 'error',
        description: 'Add a descriptive name before saving.',
      });
      templateNameInput.focus({ preventScroll: true });
      return;
    }

    const titleValue = titleInput?.value?.trim() || '';
    const previewValue = previewTextInput?.value?.trim() || '';
    const contentValue = editor?.innerHTML?.trim() || '';
    if (!titleValue && !previewValue && !contentValue) {
      showToast('No content to save', {
        type: 'error',
        description: 'Add a title, preview, or body content before saving a template.',
      });
      return;
    }

    const duplicate = customTemplates.find(
      (template) => template.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      showToast('Template name already exists', {
        type: 'error',
        description: 'Choose a different name to keep templates distinct.',
      });
      templateNameInput.focus({ preventScroll: true });
      templateNameInput.select();
      return;
    }

    const templateRecord = {
      id: Date.now().toString(),
      name,
      title: titleInput?.value || '',
      previewText: previewTextInput?.value || '',
      content: editor?.innerHTML || '',
      isBuiltIn: false,
      createdAt: new Date().toISOString(),
    };

    persistCustomTemplates([templateRecord, ...customTemplates]);
    renderTemplateMenu();
    if (!templateManageModal?.classList.contains('hidden')) {
      renderTemplateManageList();
    }
    closeTemplateSaveModal({ restoreFocus: false });
    showToast(`Template saved: ${name}`, {
      type: 'success',
    });
  }

  function deleteTemplateById(templateId) {
    const template = customTemplates.find((item) => String(item.id) === String(templateId));
    if (!template) {
      return;
    }
    if (!window.confirm(`Delete template '${template.name}'?`)) {
      return;
    }
    const nextTemplates = customTemplates.filter((item) => String(item.id) !== String(templateId));
    persistCustomTemplates(nextTemplates);
    renderTemplateMenu();
    if (!templateManageModal?.classList.contains('hidden')) {
      renderTemplateManageList();
    }
    showToast(`Template deleted: ${template.name}`, {
      type: 'success',
    });
  }

  customTemplates = loadCustomTemplatesFromStorage();
  renderTemplateMenu();
  templateMenuButton?.setAttribute('aria-expanded', 'false');

  function redirectToLogin() {
    const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const fallback = currentLocation && currentLocation !== '' ? currentLocation : '/';
    window.location.href = `/login?next=${encodeURIComponent(fallback)}`;
  }

  function handleUnauthorizedResponse(response) {
    if (response && response.status === 401) {
      redirectToLogin();
      return true;
    }
    return false;
  }

  const FOCUSABLE_SELECTORS = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  function isFocusableElement(element) {
    if (!element) {
      return false;
    }
    if (element.hasAttribute('disabled')) {
      return false;
    }
    if (element.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const tabIndexAttr = element.getAttribute('tabindex');
    if (tabIndexAttr !== null && Number(tabIndexAttr) < 0) {
      return false;
    }
    const rects = element.getClientRects();
    return rects.length > 0;
  }

  function createFocusTrap(container) {
    if (!container) {
      return () => { };
    }
    const handleKeyDown = (event) => {
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTORS))
        .filter(isFocusableElement);
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey) {
        if (activeElement === first || !container.contains(activeElement)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }

  function setSubscriberLoading(isLoading) {
    if (!subscriberLoading) {
      return;
    }
    subscriberLoading.classList.toggle('hidden', !isLoading);
  }

  function setButtonLoading(button, isLoading, loadingLabel = 'Loading') {
    if (!button) {
      return;
    }
    if (isLoading) {
      if (!button.dataset.originalContent) {
        button.dataset.originalContent = button.innerHTML;
      }
      button.classList.add('is-loading');
      button.disabled = true;
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${loadingLabel}`;
    } else {
      button.classList.remove('is-loading');
      button.disabled = false;
      if (button.dataset.originalContent) {
        button.innerHTML = button.dataset.originalContent;
        delete button.dataset.originalContent;
      }
    }
  }

  function buildEmailTemplate(title, content, previewText = '', unsubscribeLink = '') {
    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta name="x-apple-disable-message-reformatting" />
          <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
          <meta name="color-scheme" content="light dark" />
          <meta name="supported-color-schemes" content="light dark" />
          <title>${title}</title>
          <style>
            body {
              margin: 0;
              padding: 0;
              background-color: #f6f6f6;
              font-family: Arial, Helvetica, sans-serif;
              color: #374151;
            }
            .wrapper {
              width: 100%;
              background-color: #f6f6f6;
              padding: 24px 0;
            }
            .container {
              max-width: 640px;
              margin: 0 auto;
              background: #ffffff;
              border-radius: 12px;
              box-shadow: 0 8px 24px rgba(149, 157, 165, 0.2);
              overflow: hidden;
            }
            h1 {
              margin: 0;
              padding: 32px 32px 16px 32px;
              font-size: 28px;
              color: #111827;
            }
            .content {
              padding: 0 32px 32px 32px;
              font-size: 16px;
              line-height: 1.6;
            }
            .content img {
              max-width: 100%;
              height: auto;
              border-radius: 8px;
            }
            .content .preview-image-placeholder {
              display: block;
              padding: 16px;
              margin: 16px 0;
              border-radius: 8px;
              background: #f1f5f9;
              border: 1px dashed rgba(148, 163, 184, 0.7);
              color: #475569;
              font-style: italic;
              text-align: center;
            }
            .footer {
              background: #f9fafb;
              padding: 24px 32px 32px 32px;
              font-size: 12px;
              text-align: center;
              color: #6b7280;
            }
            a {
              color: #2563eb;
            }
            @media (max-width: 600px) {
              h1 {
                font-size: 24px;
              }
              .content,
              .footer {
                padding-left: 20px;
                padding-right: 20px;
              }
            }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
              ${previewText || ''}
            </div>
            <div class="container">
              <h1>${title}</h1>
              <div class="content">
                ${content}
              </div>
              <div class="footer">
                You are receiving this email because you subscribed to our newsletter.<br />
                <a href="${unsubscribeLink}">Unsubscribe</a>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  function showPreviewModal() {
    if (!previewModal) {
      return;
    }
    lastFocusedBeforePreview =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previewModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    if (typeof releasePreviewFocusTrap === 'function') {
      releasePreviewFocusTrap();
    }
    releasePreviewFocusTrap = createFocusTrap(previewModal);
    window.setTimeout(() => {
      if (previewClose) {
        previewClose.focus({ preventScroll: true });
      } else {
        const firstFocusable = previewModal.querySelector(FOCUSABLE_SELECTORS);
        firstFocusable?.focus({ preventScroll: true });
      }
    }, 50);
  }

  function hidePreviewModal() {
    if (!previewModal) {
      return;
    }
    previewModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (typeof releasePreviewFocusTrap === 'function') {
      releasePreviewFocusTrap();
      releasePreviewFocusTrap = null;
    }
    const fallbackTarget =
      lastFocusedBeforePreview && document.body.contains(lastFocusedBeforePreview)
        ? lastFocusedBeforePreview
        : previewButton;
    fallbackTarget?.focus({ preventScroll: true });
    lastFocusedBeforePreview = null;
  }

  // Compose interactions -------------------------------------------------------
  if (editor) {
    editor.addEventListener('input', () => {
      scheduleInlinePreviewUpdate({ reason: 'auto' });
    });
  }

  toolbarButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      if (!command) {
        return;
      }

      if (command === 'createLink') {
        const url = window.prompt('Enter a URL');
        if (url) {
          document.execCommand(command, false, url);
        }
      } else {
        document.execCommand(command, false, null);
      }

      editor?.focus();
    });
  });

  if (uploadTrigger && uploadInput) {
    uploadTrigger.addEventListener('click', () => uploadInput.click());

    uploadInput.addEventListener('change', async () => {
      const [file] = uploadInput.files || [];
      if (!file) {
        return;
      }

      if (!file.type.startsWith('image/')) {
        const message = 'Image upload failed: please choose an image file.';
        setInlineStatus(imageUploadStatus, message, true);
        showToast('Image upload failed', {
          type: 'error',
          description: message,
        });
        uploadInput.value = '';
        return;
      }

      if (file.size > MAX_IMAGE_UPLOAD_SIZE) {
        const message = 'Image upload failed: file too large (max 5 MB).';
        setInlineStatus(imageUploadStatus, message, true);
        showToast('Image upload failed', {
          type: 'error',
          description: 'Select an image smaller than 5 MB and try again.',
        });
        uploadInput.value = '';
        return;
      }

      const formData = new FormData();
      formData.append('image', file);

      setInlineStatus(imageUploadStatus, 'Uploading image');
      setButtonLoading(uploadTrigger, true, 'Uploading');

      try {
        const response = await fetch('/api/upload-image', {
          method: 'POST',
          body: formData,
        });

        if (handleUnauthorizedResponse(response)) {
          return;
        }

        const result = await response.json().catch(() => null);
        if (!response.ok) {
          const errorMessage =
            result?.error || result?.message || 'Image upload failed. Please try again.';
          throw new Error(errorMessage);
        }

        if (!result?.imageUrl) {
          throw new Error('Image upload failed. Missing image URL in response.');
        }

        document.execCommand(
          'insertHTML',
          false,
          `<img src="${result.imageUrl}" alt="Newsletter image" />`,
        );
        setInlineStatus(imageUploadStatus, 'Image added to the editor.');
        showToast('Image uploaded', {
          type: 'success',
          description: 'Your image has been inserted into the draft.',
        });
      } catch (error) {
        console.error(error);
        const fallback = error?.message || 'Image upload failed. Please try again.';
        setInlineStatus(imageUploadStatus, fallback, true);
        showToast('Image upload failed', {
          type: 'error',
          description: fallback,
        });
      } finally {
        setButtonLoading(uploadTrigger, false);
        uploadInput.value = '';
      }
    });
  }

  if (splitPreviewToggle) {
    splitPreviewToggle.addEventListener('click', () => {
      applySplitMode(!previewPreferences.splitMode);
    });
  }

  deviceToggleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const device = button.dataset.device || 'desktop';
      applyDeviceSelection(device);
    });
  });

  if (previewImagesCheckbox) {
    previewImagesCheckbox.addEventListener('change', (event) => {
      applyShowImagesPreference(event.target.checked);
    });
  }

  if (previewRefreshButton) {
    previewRefreshButton.addEventListener('click', () => {
      updatePreviewStatus('Refreshing preview…');
      scheduleInlinePreviewUpdate({
        immediate: true,
        reason: 'manual-refresh',
        forceRender: true,
      });
    });
  }

  if (previewCopyButton) {
    previewCopyButton.addEventListener('click', async () => {
      if (!lastPreviewHtml) {
        const success = renderPreview({
          showModal: false,
          reason: 'copy-html',
          forceRenderInline: false,
        });
        if (!success) {
          updatePreviewStatus('Nothing to copy yet.', 'error');
          return;
        }
      }
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(lastPreviewHtml);
        } else {
          const fallbackArea = document.createElement('textarea');
          fallbackArea.value = lastPreviewHtml;
          fallbackArea.setAttribute('readonly', '');
          fallbackArea.style.position = 'absolute';
          fallbackArea.style.left = '-9999px';
          document.body.appendChild(fallbackArea);
          fallbackArea.select();
          document.execCommand('copy');
        document.body.removeChild(fallbackArea);
      }
      updatePreviewStatus('HTML copied to clipboard', 'success');
      showToast('Preview HTML copied', {
        type: 'success',
        duration: 2800,
        description: 'The rendered email markup is ready to paste.',
      });
    } catch (error) {
      console.error('Copy preview HTML failed', error);
      updatePreviewStatus('Unable to copy HTML', 'error');
      showToast('Copy failed', {
        type: 'error',
          description: 'Your browser blocked clipboard access.',
        });
      }
    });
  }

  if (previewPreferences.splitMode) {
    scheduleInlinePreviewUpdate({
      immediate: true,
      reason: 'initial-load',
      forceRender: true,
    });
  }

  updatePreviewMetricsDisplay();

  function renderPreview(arg = {}) {
    const defaultOptions = {
      showModal: false,
      reason: 'manual',
      forceRenderInline: false,
      manual: false,
    };
    const options = typeof arg === 'boolean'
      ? { ...defaultOptions, showModal: arg, reason: 'manual', manual: true }
      : { ...defaultOptions, ...arg };
    const {
      showModal,
      reason,
      forceRenderInline,
      manual,
    } = options;

    updatePreviewMetricsDisplay();
    const titleValue = (titleInput?.value || '').trim();
    const rawContent = (editor?.innerHTML || '').trim();
    const previewText = (previewTextInput?.value || '').trim();
    const sanitizedContent = sanitizeEditorHtml(rawContent);
    const strippedContent = sanitizedContent
      .replace(/&nbsp;/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hasMedia = /<(?:img|video|iframe)\b/i.test(sanitizedContent);
    const hasTitle = titleValue.length > 0;
    const hasBody = strippedContent.length > 0 || hasMedia;
    const shouldNotifyUser = manual || showModal || ['modal', 'manual-refresh'].includes(reason);
    const inlineVisible = shouldRenderInlinePreview();
    const willRenderInline = inlineVisible || Boolean(forceRenderInline);

    if (!hasTitle || !hasBody) {
      if (willRenderInline) {
        hidePreviewLoading();
      }
      if (inlineVisible) {
        showPreviewError('Add a title and content to see the preview.');
        updatePreviewStatus('Waiting for title and content…', 'error');
      }
      if (previewRenderTime) {
        previewRenderTime.textContent = '— ms';
      }
      if (shouldNotifyUser) {
        setSendStatus('Preview unavailable. Add a title and content first.', true, {
          toast: {
            title: 'Preview needs content',
            type: 'error',
            description: 'Add a subject and body before opening the preview.',
          },
        });
      }
      return false;
    }

    if (inlineVisible) {
      showPreviewError('');
      updatePreviewStatus('Rendering preview…');
    }

    const contentForPreview = previewPreferences.showImages
      ? sanitizedContent
      : convertContentImagesToPlaceholders(sanitizedContent);

    const startTime = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let previewHtml = '';
    try {
      previewHtml = buildEmailTemplate(titleValue, contentForPreview, previewText);
    } catch (error) {
      console.error('Preview rendering failed', error);
      if (willRenderInline) {
        hidePreviewLoading();
      }
      showPreviewError('Preview failed to render. Try refreshing.');
      if (inlineVisible) {
        updatePreviewStatus('Preview failed to render', 'error');
      }
      if (previewRenderTime) {
        previewRenderTime.textContent = '— ms';
      }
      if (shouldNotifyUser) {
        showToast('Preview failed to render', {
          type: 'error',
          description: 'Try refreshing the preview or check your content.',
        });
      }
      return false;
    }
    const endTime = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const elapsed = Math.max(0, Math.round(endTime - startTime));

    if (previewRenderTime) {
      previewRenderTime.textContent = `${elapsed} ms`;
    }

    lastPreviewHtml = previewHtml;
    updateInlinePreview(previewHtml, { force: forceRenderInline });

    if (previewFrame) {
      previewFrame.srcdoc = previewHtml;
    }

    if (showModal) {
      showPreviewModal();
    }

    return true;
  }

  function handlePreviewRequest() {
    if (!previewButton) {
      renderPreview({
        showModal: true,
        reason: 'modal',
        manual: true,
        forceRenderInline: true,
      });
      return;
    }
    setButtonLoading(previewButton, true, 'Opening preview');
    try {
      renderPreview({
        showModal: true,
        reason: 'modal',
        manual: true,
        forceRenderInline: true,
      });
    } finally {
      setButtonLoading(previewButton, false);
    }
  }

  if (previewButton) {
    previewButton.addEventListener('click', () => {
      handlePreviewRequest();
    });
  }

  previewClose?.addEventListener('click', hidePreviewModal);
  modalBackdrop?.addEventListener('click', hidePreviewModal);

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) {
      return;
    }
    const key = event.key;
    const modifierPressed = event.ctrlKey || event.metaKey;
    const sendConfirmOpen =
      sendConfirmModal && !sendConfirmModal.classList.contains('hidden');
    const previewOpen = previewModal && !previewModal.classList.contains('hidden');
    const templateSaveOpen = templateSaveModal && !templateSaveModal.classList.contains('hidden');
    const templateManageOpen = templateManageModal && !templateManageModal.classList.contains('hidden');

    if (key === 'Escape') {
      if (templateSaveOpen) {
        event.preventDefault();
        closeTemplateSaveModal();
        return;
      }
      if (templateManageOpen) {
        event.preventDefault();
        closeTemplateManageModal();
        return;
      }
      if (sendConfirmOpen) {
        event.preventDefault();
        hideSendConfirmModal();
        return;
      }
      if (previewOpen) {
        event.preventDefault();
        hidePreviewModal();
        return;
      }
      if (templateMenuOpen) {
        event.preventDefault();
        closeTemplateMenu();
      }
      return;
    }

    if (!modifierPressed || event.altKey) {
      return;
    }

    if (key.toLowerCase() === 'p' && event.shiftKey) {
      event.preventDefault();
      applySplitMode(!previewPreferences.splitMode);
      return;
    }

    if (key.toLowerCase() === 's') {
      event.preventDefault();
      saveDraft({ announce: true });
      return;
    }

    if (key === 'Enter') {
      event.preventDefault();
      handlePreviewRequest();
    }
  });

  function formatSubscriberCount(count) {
    const safeCount = Number(count) || 0;
    return safeCount.toLocaleString();
  }

  function buildSendLabel(count) {
    const safeCount = Number(count) || 0;
    if (safeCount <= 0) {
      return 'Send newsletter';
    }
    const noun = safeCount === 1 ? 'subscriber' : 'subscribers';
    return `Send to ${formatSubscriberCount(safeCount)} ${noun}`;
  }

  function updateSendButtonState(count = subscriberTotal) {
    if (!sendButton || !sendButtonLabel) {
      return;
    }
    const safeCount = Number(count) || 0;
    const hasSubscribers = safeCount > 0;
    sendButtonLabel.textContent = buildSendLabel(safeCount);
    sendButton.disabled = !hasSubscribers || isSendingNewsletter;
    sendButton.setAttribute('aria-disabled', String(sendButton.disabled));

    if (sendConfirmButtonLabel) {
      sendConfirmButtonLabel.textContent = buildSendLabel(safeCount);
    }
    if (sendConfirmCount) {
      sendConfirmCount.textContent = formatSubscriberCount(safeCount);
    }
    if (sendConfirmButton) {
      sendConfirmButton.disabled = !hasSubscribers || isSendingNewsletter;
    }
  }

  updateSendButtonState(subscriberTotal);

  function showSendConfirmModal() {
    if (!sendConfirmModal) {
      return;
    }
    if (subscriberTotal <= 0) {
      showToast('Add subscribers before sending', {
        type: 'error',
        description: 'Import or add at least one subscriber to enable sending.',
      });
      return;
    }
    lastFocusedBeforeSendConfirm =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    updateSendButtonState(subscriberTotal);
    if (sendConfirmMessage) {
      const noun = subscriberTotal === 1 ? 'subscriber' : 'subscribers';
      sendConfirmMessage.innerHTML = `You're about to send to <strong>${formatSubscriberCount(subscriberTotal)} ${noun}</strong>. This cannot be undone. Continue?`;
    }
    sendConfirmModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    if (typeof releaseSendConfirmFocusTrap === 'function') {
      releaseSendConfirmFocusTrap();
    }
    releaseSendConfirmFocusTrap = createFocusTrap(sendConfirmModal);
    window.setTimeout(() => {
      sendConfirmButton?.focus({ preventScroll: true });
    }, 50);
  }

  function hideSendConfirmModal({ restoreFocus = true, force = false } = {}) {
    if (!sendConfirmModal) {
      return;
    }
    if (isSendingNewsletter && !force) {
      return;
    }
    sendConfirmModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (typeof releaseSendConfirmFocusTrap === 'function') {
      releaseSendConfirmFocusTrap();
      releaseSendConfirmFocusTrap = null;
    }
    if (restoreFocus) {
      const fallbackTarget =
        lastFocusedBeforeSendConfirm && document.body.contains(lastFocusedBeforeSendConfirm)
          ? lastFocusedBeforeSendConfirm
          : sendButton;
      fallbackTarget?.focus({ preventScroll: true });
    }
    lastFocusedBeforeSendConfirm = null;
  }

  function loadDraft() {
    try {
      const rawDraft = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!rawDraft) {
        return;
      }
      const draft = JSON.parse(rawDraft);
      if (!draft || (!draft.title && !draft.previewText && !draft.content)) {
        return;
      }

      const savedAt = new Date(draft.updatedAt || draft.savedAt || Date.now());
      const now = Date.now();
      const minutesAgo = Math.max(0, Math.floor((now - savedAt.getTime()) / 60000));
      let whenText = 'just now';
      if (minutesAgo >= 60) {
        const hours = Math.floor(minutesAgo / 60);
        whenText = hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
      } else if (minutesAgo >= 1) {
        whenText = `${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago`;
      }

      const restoreDraft = () => {
        if (draft?.title) {
          titleInput.value = draft.title;
        }
        if (typeof draft?.previewText === 'string') {
          previewTextInput.value = draft.previewText;
          updatePreviewCounter();
        }
        if (typeof draft?.content === 'string') {
          editor.innerHTML = draft.content;
        }
        updateBestPractices();
        setSendStatus('Draft restored from your last session.', false, {
          variant: 'success',
          toast: {
            title: 'Draft restored',
            type: 'success',
            description: 'Picked up where you left off.',
          },
        });
      };

      showToast('Unsaved draft found', {
        type: 'warning',
        description: `Saved ${whenText}.`,
        actions: [
          {
            label: 'Restore draft',
            onClick: () => {
              restoreDraft();
            },
          },
          {
            label: 'Dismiss',
            dismissOnClick: true,
            onClick: () => {
              setSendStatus('');
            },
          },
        ],
      });
    } catch (error) {
      console.warn('Failed to load draft.', error);
    }
  }

  function saveDraft(options = {}) {
    const { announce = false, showIndicator = false } = options;
    const timestamp = new Date().toISOString();
    const draft = {
      title: titleInput.value,
      previewText: previewTextInput.value,
      content: editor.innerHTML,
      updatedAt: timestamp,
      savedAt: timestamp,
    };
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      if (announce) {
        setSendStatus('Draft saved locally.', false, {
            variant: 'success',
            toast: {
              title: 'Draft saved',
              type: 'success',
              description: 'Stored safely in this browser for you.',
            },
        });
      } else if (showIndicator) {
        showDraftSavedIndicator();
      }
    } catch (error) {
      console.warn('Failed to save draft.', error);
      if (announce) {
        setSendStatus('Could not save draft locally.', true, {
          variant: 'error',
          toast: {
            title: 'Draft not saved',
            type: 'error',
            description: 'Check storage permissions and try again.',
          },
        });
      }
    }
  }

  if (saveDraftButton) {
    saveDraftButton.addEventListener('click', () => {
      saveDraft({ announce: true });
    });
    saveDraftButton.dataset.enhancedSave = 'true';
  }

  if (sendButton) {
    sendButton.addEventListener('click', () => {
      if (sendButton.disabled || isSendingNewsletter) {
        return;
      }
      showSendConfirmModal();
    });
  }

  if (sendConfirmButton) {
    sendConfirmButton.addEventListener('click', () => {
      if (isSendingNewsletter) {
        return;
      }
      void executeSendNewsletter();
    });
  }

  sendConfirmCancel?.addEventListener('click', () => {
    hideSendConfirmModal();
  });

  sendConfirmClose?.addEventListener('click', () => {
    hideSendConfirmModal();
  });

  sendConfirmBackdrop?.addEventListener('click', () => {
    hideSendConfirmModal();
  });

  templateMenuButton?.addEventListener('click', () => {
    if (templateMenuOpen) {
      closeTemplateMenu();
    } else {
      openTemplateMenu();
    }
  });

  templateMenu?.addEventListener('click', handleTemplateMenuClick);
  document.addEventListener('click', handleDocumentClickForTemplateMenu);

  saveTemplateButton?.addEventListener('click', () => {
    openTemplateSaveModal();
  });

  templateSaveClose?.addEventListener('click', () => closeTemplateSaveModal());
  templateSaveCancel?.addEventListener('click', () => closeTemplateSaveModal());
  templateSaveBackdrop?.addEventListener('click', () => closeTemplateSaveModal());
  templateSaveConfirm?.addEventListener('click', () => handleTemplateSave());
  templateNameInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleTemplateSave();
    }
  });

  templateManageClose?.addEventListener('click', () => closeTemplateManageModal());
  templateManageCloseFooter?.addEventListener('click', () => closeTemplateManageModal());
  templateManageBackdrop?.addEventListener('click', () => closeTemplateManageModal());
  templateManageList?.addEventListener('click', (event) => {
    const actionButton = event.target.closest('button[data-template-action]');
    if (!actionButton) {
      return;
    }
    const container = actionButton.closest('[data-template-id]');
    const templateId = container?.dataset.templateId;
    if (!templateId) {
      return;
    }
    const action = actionButton.dataset.templateAction;
    if (action === 'load') {
      const template = findTemplateById(templateId);
      requestTemplateLoad(template, { source: 'manage' });
    } else if (action === 'delete') {
      deleteTemplateById(templateId);
    }
  });

  async function executeSendNewsletter() {
    const title = titleInput.value.trim();
    const rawContent = editor.innerHTML.trim();
    const content = sanitizeEditorHtml(rawContent);
    const previewText = previewTextInput.value.trim();

    if (!title || !content) {
      hideSendConfirmModal();
      setSendStatus('Sending failed: add a title and content first.', true, {
        toast: {
          title: 'Newsletter not ready',
          type: 'error',
          description: 'Add a subject line and some content before sending.',
        },
      });
      return;
    }

    isSendingNewsletter = true;
    updateSendButtonState(subscriberTotal);
    const recipientsLabel = subscriberTotal > 0
      ? `${formatSubscriberCount(subscriberTotal)} subscriber${subscriberTotal === 1 ? '' : 's'}`
      : 'your subscribers';
    setSendStatus(`Sending newsletter to ${recipientsLabel}...`);
    const buttonLoadingLabel = subscriberTotal > 0
      ? `Sending to ${formatSubscriberCount(subscriberTotal)}…`
      : 'Sending…';
    setButtonLoading(sendButton, true, buttonLoadingLabel);
    if (sendConfirmButton) {
      setButtonLoading(sendConfirmButton, true, buttonLoadingLabel);
    }
    sendConfirmCancel?.setAttribute('disabled', 'true');
    sendConfirmCancel?.setAttribute('aria-disabled', 'true');
    sendConfirmClose?.setAttribute('disabled', 'true');
    sendConfirmClose?.setAttribute('aria-disabled', 'true');

    try {
      const response = await fetch('/api/send-newsletter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          content,
          previewText,
        }),
      });

      if (handleUnauthorizedResponse(response)) {
        return;
      }

      const result = await response.json();

      if (!response.ok) {
        const detailText = result?.details ? ` (${result.details})` : '';
        const error = new Error((result?.message || 'Failed to send newsletter.') + detailText);
        if (Array.isArray(result?.suggestions) && result.suggestions.length > 0) {
          error.toastDescription = result.suggestions.join(' · ');
        }
        throw error;
      }

      const summary = result?.summary;
      if (summary) {
        const sent = Number(summary.sentCount ?? summary.successes?.length ?? 0);
        const failed = Number(summary.failedCount ?? summary.failures?.length ?? 0);
        const skipped = Number(summary.skippedCount ?? summary.skipped?.length ?? 0);
        const partial = failed > 0;
        const message = partial
          ? `Newsletter sent with ${failed} issue${failed === 1 ? '' : 's'}.`
          : `Newsletter sent successfully to ${sent} subscriber${sent === 1 ? '' : 's'}.`;
        const detailParts = [];
        if (sent > 0) {
          detailParts.push(`${sent.toLocaleString()} delivered`);
        }
        if (failed > 0) {
          detailParts.push(`${failed.toLocaleString()} failed`);
        }
        if (skipped > 0) {
          detailParts.push(`${skipped.toLocaleString()} skipped`);
        }
        if (result?.campaignId) {
          detailParts.push(`Campaign ${result.campaignId}`);
        }
        setSendStatus(message, false, {
          variant: 'success',
          toast: {
            title: partial ? 'Newsletter sent with warnings' : 'Newsletter sent',
            type: partial ? 'warning' : 'success',
            description: detailParts.join(' · '),
          },
        });
      } else {
        const toastDescription = result?.campaignId ? `Campaign ${result.campaignId}` : '';
        setSendStatus('Newsletter sent successfully!', false, {
          variant: 'success',
          toast: {
            title: 'Newsletter sent',
            type: 'success',
            description: toastDescription,
          },
        });
      }
      if (analyticsContent) {
        loadAnalytics({ silent: true }).catch(() => { });
      }
    } catch (error) {
      console.error(error);
      const toastDescription =
        typeof error?.toastDescription === 'string' ? error.toastDescription : '';
      setSendStatus(error.message || 'Could not send newsletter.', true, {
        variant: 'error',
        toast: {
          title: 'Send failed',
          type: 'error',
          description: toastDescription,
        },
      });
    } finally {
      isSendingNewsletter = false;
      setButtonLoading(sendButton, false);
      if (sendConfirmButton) {
        setButtonLoading(sendConfirmButton, false);
      }
      sendConfirmCancel?.removeAttribute('disabled');
      sendConfirmCancel?.removeAttribute('aria-disabled');
      sendConfirmClose?.removeAttribute('disabled');
      sendConfirmClose?.removeAttribute('aria-disabled');
      updateSendButtonState(subscriberTotal);
      hideSendConfirmModal({ force: true });
    }
  }

  // Subscribers ----------------------------------------------------------------
  function normalizeEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function getSubscribedDate(subscriber) {
    return (
      subscriber?.subscribedAt ||
      subscriber?.joinedAt ||
      subscriber?.joined_at ||
      subscriber?.createdAt ||
      null
    );
  }

  function formatDate(value) {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  function formatSource(value) {
    if (!value) {
      return 'Unknown';
    }
    const lower = value.toLowerCase();
    if (SOURCE_LABELS[lower]) {
      return SOURCE_LABELS[lower];
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  function matchesFilter(subscriber, filter) {
    if (!filter || filter === 'all') {
      return true;
    }
    const subscribedDate = getSubscribedDate(subscriber);
    const dateValue = subscribedDate ? new Date(subscribedDate) : null;
    const now = new Date();

    switch (filter) {
      case 'recent-7':
        if (!dateValue) return false;
        return now - dateValue <= 7 * 24 * 60 * 60 * 1000;
      case 'recent-30':
        if (!dateValue) return false;
        return now - dateValue <= 30 * 24 * 60 * 60 * 1000;
      case 'source-manual':
        return normalizeEmail(subscriber.source) === 'manual';
      case 'source-public-api':
        return ['public-api', 'public-form', 'public'].includes(
          normalizeEmail(subscriber.source),
        );
      case 'source-other':
        return !['manual', 'public-api', 'public-form', 'public'].includes(
          normalizeEmail(subscriber.source),
        );
      default:
        return true;
    }
  }

  function applySubscriberFilters() {
    if (!subscriberSearch || !subscriberFilter || !subscriberTableBody) {
      return;
    }
    const query = subscriberSearch.value.trim().toLowerCase();
    const filterValue = subscriberFilter.value;

    filteredSubscribers = subscribersCache.filter((subscriber) => {
      const matchesSearch =
        !query ||
        normalizeEmail(subscriber.email).includes(query) ||
        (subscriber.name || '').toLowerCase().includes(query);
      const matches = matchesSearch && matchesFilter(subscriber, filterValue);
      return matches;
    });

    currentSubscriberPage = 1;
    renderSubscribers();
  }

  function renderSubscribers() {
    if (!subscriberTableBody || !subscriberCount || !subscriberEmptyState) {
      return;
    }
    subscriberCount.textContent = subscribersCache.length;

    const totalItems = filteredSubscribers.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / SUBSCRIBER_PAGE_SIZE));
    currentSubscriberPage = Math.min(currentSubscriberPage, totalPages);

    const startIndex = (currentSubscriberPage - 1) * SUBSCRIBER_PAGE_SIZE;
    const currentItems = filteredSubscribers.slice(
      startIndex,
      startIndex + SUBSCRIBER_PAGE_SIZE,
    );

    subscriberTableBody.innerHTML = '';

    if (currentItems.length === 0) {
      subscriberEmptyState.hidden = false;
    } else {
      subscriberEmptyState.hidden = true;
      const fragment = document.createDocumentFragment();
      currentItems.forEach((subscriber) => {
        const row = subscriberRowTemplate.content.cloneNode(true);
        const emailCell = row.querySelector('.subscriber-email');
        const nameCell = row.querySelector('.subscriber-name');
        const dateCell = row.querySelector('.subscriber-date');
        const sourceCell = row.querySelector('.subscriber-source');
        const removeButton = row.querySelector('.remove-subscriber');

        emailCell.textContent = subscriber.email || 'Unknown';
        nameCell.textContent = subscriber.name || 'No Name provided';
        dateCell.textContent = formatDate(getSubscribedDate(subscriber));
        sourceCell.textContent = formatSource(subscriber.source);

        if (removeButton) {
          removeButton.dataset.email = subscriber.email;
        }

        fragment.appendChild(row);
      });
      subscriberTableBody.appendChild(fragment);
    }

    if (subscriberPrev && subscriberNext) {
      subscriberPrev.disabled = currentSubscriberPage <= 1 || totalItems === 0;
      subscriberNext.disabled =
        currentSubscriberPage >= totalPages || totalItems === 0;
    }

    if (subscriberPageInfo) {
      subscriberPageInfo.textContent =
        totalItems === 0
          ? 'Page 0 of 0'
          : `Page ${currentSubscriberPage} of ${totalPages}`;
    }
  }

  async function loadSubscribers(options = {}) {
    const { silent = false } = options;
    setSubscriberLoading(true);
    if (!silent) {
      setSubscriberStatus('');
    }
    try {
      const response = await fetch('/api/subscribers');
      if (handleUnauthorizedResponse(response)) {
        return false;
      }
      if (!response.ok) {
        throw new Error('Unable to load subscribers from the server.');
      }
      const data = await response.json();
      const storageMode = data?.storage || 'unknown';
      const storageHealthy =
        storageMode === 'kv' ? Boolean(data?.kvConnectionHealthy) : true;
      const list = Array.isArray(data?.subscribers) ? data.subscribers.slice() : [];
      subscribersCache = list.sort((a, b) => {
        const dateA = new Date(getSubscribedDate(a) || 0).getTime();
        const dateB = new Date(getSubscribedDate(b) || 0).getTime();
        return dateB - dateA;
      });
      applySubscriberFilters();

      const totalFromApi =
        typeof data?.count === 'number' ? data.count : subscribersCache.length;

      subscriberTotal = totalFromApi;
      updateSendButtonState(subscriberTotal);

      if (subscriberCount) {
        subscriberCount.textContent = totalFromApi;
      }

      if (storageModeBadge) {
        const backendLabel =
          storageMode === 'kv'
            ? storageHealthy
              ? 'Storage: Vercel KV'
              : 'Storage: Vercel KV (degraded)'
            : 'Storage: In-memory';
        storageModeBadge.textContent = backendLabel;
        storageModeBadge.dataset.mode = storageMode;
        storageModeBadge.dataset.healthy = storageHealthy ? 'true' : 'false';
        storageModeBadge.classList.toggle(
          'storage-pill--warning',
          storageMode !== 'kv' || !storageHealthy,
        );
        storageModeBadge.title =
          storageMode === 'kv'
            ? storageHealthy
              ? 'Connected to Vercel KV.'
              : 'KV connection unhealthy. Check server logs.'
            : 'In-memory storage resets when the server restarts.';
      }

      if (!silent) {
        const backendLabel =
          storageMode === 'kv'
            ? storageHealthy
              ? 'Vercel KV'
              : 'Vercel KV (degraded)'
            : 'in-memory';
        const storageNote = storageMode === 'kv' ? '' : ' (non-persistent)';
        setSubscriberStatus(
          `Loaded ${totalFromApi} subscriber(s) from ${backendLabel} storage${storageNote}.`,
          storageMode === 'kv' && !storageHealthy,
          { highlightSuccess: storageMode === 'kv' && storageHealthy },
        );
      }

      subscribersLoadedOnce = true;
      return true;
    } catch (error) {
      console.error(error);
      if (!silent) {
        setSubscriberStatus(error.message || 'Could not load subscribers.', true, {
          toast: {
            title: 'Subscriber list unavailable',
            type: 'error',
            description: 'Please try refreshing in a moment.',
          },
        });
      }
      subscriberTotal = subscribersCache.length;
      updateSendButtonState(subscriberTotal);
      return false;
    } finally {
      setSubscriberLoading(false);
    }
  }

  subscriberPrev?.addEventListener('click', () => {
    if (currentSubscriberPage > 1) {
      currentSubscriberPage -= 1;
      renderSubscribers();
    }
  });

  subscriberNext?.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredSubscribers.length / SUBSCRIBER_PAGE_SIZE));
    if (currentSubscriberPage < totalPages) {
      currentSubscriberPage += 1;
      renderSubscribers();
    }
  });

  subscriberSearch?.addEventListener('input', () => {
    window.clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = window.setTimeout(applySubscriberFilters, 200);
  });

  subscriberFilter?.addEventListener('change', applySubscriberFilters);

  function toggleAddSubscriberForm(forceOpen) {
    if (!toggleAddSubscriberButton || !addSubscriberForm) {
      return;
    }
    const shouldOpen =
      forceOpen ?? addSubscriberForm.classList.contains('hidden');
    addSubscriberForm.classList.toggle('hidden', !shouldOpen);
    toggleAddSubscriberButton.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      toggleAddSubscriberButton.innerHTML =
        '<span class="icon" aria-hidden="true">&#x2715;</span><span>Close form</span>';
      subscriberEmailInput?.focus({ preventScroll: true });
    } else {
      toggleAddSubscriberButton.innerHTML =
        toggleAddSubscriberButton.dataset.defaultContent ||
        toggleAddSubscriberButton.innerHTML;
      addSubscriberForm.reset();
    }
  }

  toggleAddSubscriberButton?.addEventListener('click', () => toggleAddSubscriberForm());
  cancelAddSubscriberButton?.addEventListener('click', () => toggleAddSubscriberForm(false));

  addSubscriberForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = subscriberEmailInput.value.trim();
    const name = subscriberNameInput.value.trim();

    if (!email) {
      setSubscriberStatus('Please enter an email address.', true, {
        toast: {
          title: 'Email required',
          type: 'error',
          description: 'Provide an email address before adding a subscriber.',
        },
      });
      subscriberEmailInput.focus();
      return;
    }

    const submitButton = addSubscriberForm.querySelector('button[type="submit"]');
    setSubscriberStatus('Adding subscriber...');
    setButtonLoading(submitButton, true, 'Adding');

    try {
      const response = await fetch('/api/subscribers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, ...(name ? { name } : {}) }),
      });

      if (handleUnauthorizedResponse(response)) {
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (response.status === 409) {
        throw new Error(result?.message || 'This email is already subscribed.');
      }

      if (!response.ok) {
        throw new Error(result?.message || result?.error || 'Could not add subscriber.');
      }

      const storageMode = result?.storage || 'unknown';
      const storageHealthy =
        storageMode === 'kv' ? Boolean(result?.kvConnectionHealthy) : true;
      const attempts = result?.verification?.attempts || 1;
      const backendLabel =
        storageMode === 'kv'
          ? storageHealthy
            ? 'Vercel KV'
            : 'Vercel KV (degraded)'
          : 'in-memory';

      if (typeof result?.count === 'number' && subscriberCount) {
        subscriberCount.textContent = result.count;
      }

      if (typeof result?.count === 'number') {
        subscriberTotal = result.count;
        updateSendButtonState(subscriberTotal);
      }

      const nonPersistentNote = storageMode === 'kv' ? '' : ' (non-persistent)';
      const toastType =
        storageMode === 'kv' && !storageHealthy ? 'warning' : 'success';
      const toastDetails = [
        `Stored via ${backendLabel}`,
        `Verification ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      ];
      if (storageMode !== 'kv') {
        toastDetails.push('Data resets on restart');
      } else if (!storageHealthy) {
        toastDetails.push('Check KV connection health');
      }
      setSubscriberStatus(
        `Subscriber saved to ${backendLabel} storage${nonPersistentNote} (verified in ${attempts} attempt${attempts === 1 ? '' : 's'
        }).`,
        storageMode === 'kv' && !storageHealthy,
        {
          highlightSuccess: storageMode === 'kv' && storageHealthy,
          toast: {
            title: `Subscriber added${email ? ` (${email})` : ''}`,
            type: toastType,
            description: toastDetails.join(' · '),
          },
        },
      );
      toggleAddSubscriberForm(false);
      await loadSubscribers({ silent: true });
    } catch (error) {
      console.error(error);
      setSubscriberStatus(error.message || 'Could not add subscriber.', true, {
        toast: {
          title: 'Could not add subscriber',
          type: 'error',
          description: email ? `There was an issue adding ${email}.` : '',
        },
      });
    } finally {
      setButtonLoading(submitButton, false);
    }
  });

  subscriberTableBody?.addEventListener('click', async (event) => {
    const target = event.target.closest('.remove-subscriber');
    if (!target) {
      return;
    }
    const email = target.dataset.email;
    if (!email) {
      return;
    }

    const confirmed = window.confirm(`Remove ${email} from the list?`);
    if (!confirmed) {
      return;
    }

    setSubscriberStatus(`Removing ${email}...`);
    setButtonLoading(target, true, 'Removing');

    try {
      const response = await fetch(`/api/subscribers/${encodeURIComponent(email)}`, {
        method: 'DELETE',
      });

      if (handleUnauthorizedResponse(response)) {
        return;
      }

      const result = await response.json().catch(() => ({}));

      if (response.status === 404) {
        throw new Error(result?.message || 'Subscriber not found.');
      }

      if (!response.ok) {
        throw new Error(result?.message || result?.error || 'Could not remove subscriber.');
      }

      const storageMode = result?.storage || 'unknown';
      const storageHealthy =
        storageMode === 'kv' ? Boolean(result?.kvConnectionHealthy) : true;
      const attempts = result?.verification?.attempts || 1;
      const backendLabel =
        storageMode === 'kv'
          ? storageHealthy
            ? 'Vercel KV'
            : 'Vercel KV (degraded)'
          : 'in-memory';

      if (typeof result?.count === 'number' && subscriberCount) {
        subscriberCount.textContent = result.count;
      }

      if (typeof result?.count === 'number') {
        subscriberTotal = result.count;
        updateSendButtonState(subscriberTotal);
      }

      const removalNote = storageMode === 'kv' ? '' : ' (non-persistent)';
      const toastType =
        storageMode === 'kv' && !storageHealthy ? 'warning' : 'success';
      const toastDetails = [
        `Removed from ${backendLabel}`,
        `Confirmed in ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      ];
      if (storageMode !== 'kv') {
        toastDetails.push('Data resets on restart');
      } else if (!storageHealthy) {
        toastDetails.push('KV connection degraded');
      }
      setSubscriberStatus(
        `Subscriber removed from ${backendLabel} storage${removalNote} (confirmed in ${attempts} attempt${attempts === 1 ? '' : 's'
        }).`,
        storageMode === 'kv' && !storageHealthy,
        {
          highlightSuccess: storageMode === 'kv' && storageHealthy,
          toast: {
            title: `Subscriber removed${email ? ` (${email})` : ''}`,
            type: toastType,
            description: toastDetails.join(' · '),
          },
        },
      );
      await loadSubscribers({ silent: true });
    } catch (error) {
      console.error(error);
      setSubscriberStatus(error.message || 'Could not remove subscriber.', true, {
        toast: {
          title: 'Could not remove subscriber',
          type: 'error',
          description: email ? `There was an issue removing ${email}.` : '',
        },
      });
    } finally {
      setButtonLoading(target, false);
    }
  });

  // Analytics ----------------------------------------------------------------
  /**
   * Toggle the loading state for the analytics view without disturbing other panes.
   * When we already have data rendered we keep the cards visible while the refresh happens.
   */
  function showAnalyticsLoading({ keepContentVisible = false } = {}) {
    if (!analyticsLoading || !analyticsContent || !analyticsError) {
      return;
    }
    analyticsError.classList.add('hidden');
    analyticsError.textContent = '';
    if (keepContentVisible && analyticsLoadedOnce) {
      analyticsLoading.classList.add('hidden');
      return;
    }
    analyticsLoading.classList.remove('hidden');
    analyticsContent.classList.add('hidden');
  }

  /**
   * Display a friendly error message when analytics cannot be fetched.
   * We hide the content area to avoid mixing stale data with the error state.
   */
  function showAnalyticsError(message) {
    if (!analyticsLoading || !analyticsContent || !analyticsError) {
      return;
    }
    analyticsLoading.classList.add('hidden');
    analyticsContent.classList.add('hidden');
    analyticsError.textContent = message;
    analyticsError.classList.remove('hidden');
  }

  /**
   * Reveal the analytics cards/table/chart once fresh data has been rendered.
   */
  function showAnalyticsReady() {
    if (!analyticsLoading || !analyticsContent || !analyticsError) {
      return;
    }
    analyticsLoading.classList.add('hidden');
    analyticsError.classList.add('hidden');
    analyticsContent.classList.remove('hidden');
  }

  function formatCampaignStatus(value) {
    if (!value) {
      return 'Unknown';
    }
    const normalized = value.toString().toLowerCase();
    if (normalized === 'success') {
      return 'Sent';
    }
    if (normalized === 'partial') {
      return 'Partial';
    }
    if (normalized === 'failed') {
      return 'Failed';
    }
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  /**
   * Render the high-level analytics cards with totals and the latest campaign summary.
   */
  function renderAnalyticsOverview(payload) {
    if (!payload) {
      return;
    }
    const totalSubscribers = Number(payload.totalSubscribers ?? payload.subscriberCount ?? 0);
    if (analyticsTotalSubscribers) {
      analyticsTotalSubscribers.textContent = totalSubscribers.toLocaleString();
    }

    const totalSent = Number(payload.totalSent ?? 0);
    if (analyticsTotalSent) {
      analyticsTotalSent.textContent = totalSent.toLocaleString();
    }

    if (analyticsLastCampaign && analyticsLastCampaignStatus) {
      if (payload.lastCampaign) {
        const delivered =
          Number(
            payload.lastCampaign.delivered ??
            payload.lastCampaign.successCount ??
            payload.lastCampaign.sentCount ??
            0,
          ) || 0;
        const failed =
          Number(payload.lastCampaign.failed ?? payload.lastCampaign.failureCount ?? 0) || 0;

        analyticsLastCampaign.textContent = payload.lastCampaign.title || 'Untitled campaign';

        const statusParts = [
          formatCampaignStatus(payload.lastCampaign.status),
          payload.lastCampaign.sentAt ? formatDate(payload.lastCampaign.sentAt) : null,
          `${delivered.toLocaleString()} sent`,
        ];
        if (failed > 0) {
          statusParts.push(`${failed.toLocaleString()} failed`);
        }
        analyticsLastCampaignStatus.textContent = statusParts.filter(Boolean).join(' · ');
      } else {
        analyticsLastCampaign.textContent = '--';
        analyticsLastCampaignStatus.textContent = 'No campaigns yet';
      }
    }

    renderRecentCampaigns(payload.recentCampaigns);
    renderSubscriberGrowthChart(payload.subscriberGrowth);
  }

  /**
   * Populate the recent campaigns table with delivery stats.
   */
  function renderRecentCampaigns(campaigns = []) {
    if (!analyticsCampaignsBody) {
      return;
    }

    analyticsCampaignsBody
      .querySelectorAll('tr[data-analytics-row="true"]')
      .forEach((row) => row.remove());

    const hasRows = Array.isArray(campaigns) && campaigns.length > 0;
    if (analyticsCampaignsEmpty) {
      analyticsCampaignsEmpty.classList.toggle('hidden', hasRows);
    }

    if (!hasRows) {
      return;
    }

    const fragment = document.createDocumentFragment();
    campaigns.forEach((campaign) => {
      const row = document.createElement('tr');
      row.dataset.analyticsRow = 'true';

      const titleCell = document.createElement('td');
      titleCell.textContent = campaign?.title || 'Untitled campaign';
      row.appendChild(titleCell);

      const dateCell = document.createElement('td');
      dateCell.textContent = formatDate(campaign?.sentAt);
      row.appendChild(dateCell);

      const recipientsCell = document.createElement('td');
      const recipients = Number(campaign?.recipients ?? 0);
      recipientsCell.textContent = recipients.toLocaleString();
      row.appendChild(recipientsCell);

      const statusCell = document.createElement('td');
      const delivered = Number(campaign?.delivered ?? campaign?.successCount ?? 0);
      const failed = Number(campaign?.failed ?? campaign?.failureCount ?? 0);
      const statusLabel = formatCampaignStatus(campaign?.status);
      if (failed > 0) {
        statusCell.textContent = `${statusLabel} · ${delivered.toLocaleString()} sent · ${failed.toLocaleString()} failed`;
      } else {
        statusCell.textContent = `${statusLabel} · ${delivered.toLocaleString()} sent`;
      }
      row.appendChild(statusCell);

      fragment.appendChild(row);
    });

    analyticsCampaignsBody.appendChild(fragment);
  }

  /**
   * Draw or update the subscriber growth chart using Chart.js.
   */
  function renderSubscriberGrowthChart(growth = []) {
    if (!analyticsGrowthCanvas || typeof window.Chart !== 'function') {
      return;
    }

    const hasData = Array.isArray(growth) && growth.length > 0;
    const labels = hasData ? growth.map((entry) => formatDate(entry.date)) : ['No data'];
    const dataPoints = hasData ? growth.map((entry) => Number(entry.count) || 0) : [0];

    if (analyticsChart) {
      analyticsChart.destroy();
      analyticsChart = null;
    }

    const context = analyticsGrowthCanvas.getContext('2d');
    analyticsChart = new window.Chart(context, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Subscribers',
            data: dataPoints,
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37, 99, 235, 0.15)',
            tension: 0.25,
            fill: true,
            pointRadius: 3,
            pointBackgroundColor: '#2563eb',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(context) {
                const value = Number(context.parsed.y || 0);
                return `${value.toLocaleString()} subscribers`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxRotation: 0, autoSkip: true },
          },
          y: {
            beginAtZero: true,
            ticks: {
              precision: 0,
              callback(value) {
                return Number(value).toLocaleString();
              },
            },
          },
        },
      },
    });
  }

  /**
   * Fetch analytics data from the backend endpoint and render the dashboard widgets.
   */
  async function loadAnalytics(options = {}) {
    if (!analyticsLoading || !analyticsContent || !analyticsError) {
      return;
    }
    const { silent = false } = options;
    showAnalyticsLoading({ keepContentVisible: silent && analyticsLoadedOnce });

    try {
      const response = await fetch('/api/analytics');
      if (handleUnauthorizedResponse(response)) {
        return;
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch (parseError) {
        payload = null;
      }

      if (!response.ok || !payload) {
        const message =
          payload?.message || payload?.error || 'Unable to fetch analytics data.';
        throw new Error(message);
      }

      renderAnalyticsOverview(payload);
      analyticsLoadedOnce = true;
      showAnalyticsReady();
    } catch (error) {
      console.error(error);
      const fallbackMessage = error?.message || 'Failed to load analytics. Please try again.';
      showAnalyticsError(fallbackMessage);
      if (!silent) {
        showToast('Analytics refresh failed', {
          type: 'error',
          description: fallbackMessage,
        });
      }
    }
  }

  if (refreshAnalyticsButton) {
    refreshAnalyticsButton.addEventListener('click', async () => {
      setButtonLoading(refreshAnalyticsButton, true, 'Refreshing…');
      try {
        await loadAnalytics();
      } finally {
        setButtonLoading(refreshAnalyticsButton, false);
      }
    });
  }

  const analyticsTab = document.getElementById('analytics-tab');
  if (analyticsTab) {
    analyticsTab.addEventListener('click', () => {
      if (!analyticsLoadedOnce) {
        loadAnalytics().catch(() => { });
      }
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      setButtonLoading(logoutButton, true, 'Logging out');
      try {
        const response = await fetch('/logout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: '{}',
        });

        if (response.ok) {
          const result = await response.json().catch(() => ({}));
          const redirectUrl =
            typeof result?.redirect === 'string' ? result.redirect : '/login?loggedOut=1';
          window.location.href = redirectUrl;
          return;
        }
      } catch (error) {
        console.error(error);
      }
      window.location.href = '/login';
    });
  }

  // Initialization -------------------------------------------------------------
  if (previewFrame && !previewFrame.srcdoc) {
    previewFrame.srcdoc =
      '<p style="font-family: Arial, sans-serif; padding: 16px;">Click "Preview email" to see the formatted newsletter.</p>';
  }

  loadDraft();
  if (subscriberRowTemplate && subscriberTableBody) {
    loadSubscribers().catch(() => { });
  }
  activateView('compose-view');
});

// ========================================
// PHASE 2: COMPOSING IMPROVEMENTS
// ========================================

// Spam trigger words list
const SPAM_WORDS = [
  'free', 'buy now', 'click here', 'limited time', 'act now',
  'urgent', 'guaranteed', 'winner', 'congratulations', 'cash',
  'prize', 'order now', 'call now', 'don\'t delete', 'earn money',
  'extra income', 'work from home', 'discount', '100% free',
  'limited offer', 'special promotion', 'no cost', 'risk-free'
];

// CTA keywords for detection
const CTA_KEYWORDS = [
  'click', 'buy', 'shop', 'learn more', 'read more', 'sign up',
  'subscribe', 'join', 'register', 'download', 'get started',
  'visit', 'check out', 'discover', 'explore', 'contact'
];

// Character counters
function initializeCharacterCounters() {
  const titleInput = document.getElementById('newsletter-title');
  const titleCounter = document.getElementById('title-char-counter');
  const previewInput = document.getElementById('newsletter-preview-text');
  const previewCounter = document.getElementById('preview-char-counter');

  if (titleInput && titleCounter) {
    titleInput.addEventListener('input', function () {
      const length = this.value.length;
      titleCounter.textContent = `${length} / 50`;

      // Color coding
      if (length > 50) {
        titleCounter.style.color = '#f87171';
        titleCounter.style.fontWeight = 'bold';
      } else if (length > 40) {
        titleCounter.style.color = '#fbbf24';
        titleCounter.style.fontWeight = 'normal';
      } else {
        titleCounter.style.color = '#6b7280';
        titleCounter.style.fontWeight = 'normal';
      }

      updateBestPractices();
      scheduleInlinePreviewUpdate({ reason: 'auto' });
    });

    if (titleInput.value) {
      titleInput.dispatchEvent(new Event('input'));
    }
  }

  if (previewInput && previewCounter) {
    previewInput.addEventListener('input', function () {
      const length = this.value.length;
      previewCounter.textContent = `${length} / 150`;

      if (length >= 40 && length <= 130) {
        previewCounter.style.color = '#10b981';
      } else if (length > 130) {
        previewCounter.style.color = '#f87171';
      } else {
        previewCounter.style.color = '#6b7280';
      }

      updateBestPractices();
      scheduleInlinePreviewUpdate({ reason: 'auto' });
    });

    if (previewInput.value) {
      previewInput.dispatchEvent(new Event('input'));
    }
  }
}

// Word count functionality
function initializeWordCount() {
  const contentEditor = document.getElementById('newsletter-content');
  const wordCountEl = document.getElementById('word-count');

  if (!contentEditor || !wordCountEl) return;

  function updateWordCount() {
    const text = contentEditor.innerText || '';
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    wordCountEl.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;

    // Update color based on length
    if (wordCount > 1000) {
      wordCountEl.style.color = '#f87171';
    } else if (wordCount > 800) {
      wordCountEl.style.color = '#fbbf24';
    } else {
      wordCountEl.style.color = '#6b7280';
    }

    updateBestPractices();
    updatePreviewMetricsDisplay();
  }

  contentEditor.addEventListener('input', updateWordCount);
  updateWordCount();
}

// Spam word detector
function initializeSpamDetector() {
  const titleInput = document.getElementById('newsletter-title');
  const previewInput = document.getElementById('newsletter-preview-text');
  const contentEditor = document.getElementById('newsletter-content');
  const spamWarning = document.getElementById('spam-warning');
  const spamWordsList = document.getElementById('spam-words-list');

  if (!spamWarning) return;

  function checkSpamWords() {
    const title = titleInput?.value.toLowerCase() || '';
    const preview = previewInput?.value.toLowerCase() || '';
    const content = contentEditor?.innerText.toLowerCase() || '';
    const allText = `${title} ${preview} ${content}`;

    const foundWords = SPAM_WORDS.filter(word =>
      allText.includes(word.toLowerCase())
    );

    if (foundWords.length > 0) {
      spamWarning.classList.remove('hidden');
      spamWordsList.textContent = foundWords.map(w =>
        `"${w}"`
      ).join(', ');
    } else {
      spamWarning.classList.add('hidden');
    }
  }

  if (titleInput) titleInput.addEventListener('input', checkSpamWords);
  if (previewInput) previewInput.addEventListener('input', checkSpamWords);
  if (contentEditor) contentEditor.addEventListener('input', checkSpamWords);

  checkSpamWords();
}

// Best practices checklist
function updateBestPractices() {
  const titleInput = document.getElementById('newsletter-title');
  const previewInput = document.getElementById('newsletter-preview-text');
  const contentEditor = document.getElementById('newsletter-content');

  const title = titleInput?.value || '';
  const preview = previewInput?.value || '';
  const content = contentEditor?.innerHTML || '';
  const text = contentEditor?.innerText || '';
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);

  // Check 1: Title filled and < 50 chars
  const checkTitle = document.getElementById('check-title');
  if (title.length > 0 && title.length <= 50) {
    checkTitle?.classList.add('complete');
    checkTitle.querySelector('.check-icon').textContent = '✓';
  } else {
    checkTitle?.classList.remove('complete');
    checkTitle.querySelector('.check-icon').textContent = '○';
  }

  // Check 2: Preview text 40-130 chars
  const checkPreview = document.getElementById('check-preview');
  if (preview.length >= 40 && preview.length <= 130) {
    checkPreview?.classList.add('complete');
    checkPreview.querySelector('.check-icon').textContent = '✓';
  } else {
    checkPreview?.classList.remove('complete');
    checkPreview.querySelector('.check-icon').textContent = '○';
  }

  // Check 3: Has image
  const checkImage = document.getElementById('check-image');
  const hasImage = content.includes('<img');
  if (hasImage) {
    checkImage?.classList.add('complete');
    checkImage.querySelector('.check-icon').textContent = '✓';
  } else {
    checkImage?.classList.remove('complete');
    checkImage.querySelector('.check-icon').textContent = '○';
  }

  // Check 4: Word count < 1000
  const checkLength = document.getElementById('check-length');
  if (words.length > 0 && words.length <= 1000) {
    checkLength?.classList.add('complete');
    checkLength.querySelector('.check-icon').textContent = '✓';
  } else {
    checkLength?.classList.remove('complete');
    checkLength.querySelector('.check-icon').textContent = '○';
  }

  // Check 5: Has CTA
  const checkCta = document.getElementById('check-cta');
  const textLower = text.toLowerCase();
  const hasCta = CTA_KEYWORDS.some(keyword => textLower.includes(keyword));
  if (hasCta) {
    checkCta?.classList.add('complete');
    checkCta.querySelector('.check-icon').textContent = '✓';
  } else {
    checkCta?.classList.remove('complete');
    checkCta.querySelector('.check-icon').textContent = '○';
  }
}

// Toggle checklist visibility
function initializeChecklistToggle() {
  const toggleBtn = document.getElementById('toggle-checklist');
  const checklistItems = document.getElementById('checklist-items');

  if (!toggleBtn || !checklistItems) return;

  toggleBtn.addEventListener('click', function () {
    if (checklistItems.classList.contains('hidden')) {
      checklistItems.classList.remove('hidden');
      toggleBtn.textContent = 'Hide';
    } else {
      checklistItems.classList.add('hidden');
      toggleBtn.textContent = 'Show';
    }
  });
}

// Auto-save draft functionality
let autoSaveTimeout;
const AUTOSAVE_INTERVAL = 30000;

function persistDraft(auto = false) {
  const title = document.getElementById('newsletter-title')?.value || '';
  const previewText = document.getElementById('newsletter-preview-text')?.value || '';
  const content = document.getElementById('newsletter-content')?.innerHTML || '';

  if (!title && !previewText && !content) {
    return;
  }

  saveDraft({ announce: false, showIndicator: auto });
}

function showDraftSavedIndicator() {
  const existing = document.getElementById('draft-saved-indicator');
  if (existing) existing.remove();

  const indicator = document.createElement('div');
  indicator.id = 'draft-saved-indicator';
  indicator.textContent = '✓ Draft saved';
  indicator.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    background: #10b981;
    color: white;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 14px;
    z-index: 9999;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    animation: slideIn 0.3s ease-out;
  `;

  document.body.appendChild(indicator);

  setTimeout(() => {
    indicator.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => indicator.remove(), 300);
  }, 2000);
}

function clearDraft() {
  try {
    localStorage.removeItem('newsletter-draft');

    const titleInput = document.getElementById('newsletter-title');
    const previewInput = document.getElementById('newsletter-preview-text');
    const contentEditor = document.getElementById('newsletter-content');

    if (titleInput) titleInput.value = '';
    if (previewInput) previewInput.value = '';
    if (contentEditor) contentEditor.innerHTML = '';

    if (titleInput) titleInput.dispatchEvent(new Event('input'));
    if (previewInput) previewInput.dispatchEvent(new Event('input'));
    if (contentEditor) contentEditor.dispatchEvent(new Event('input'));

    showToast('Draft cleared', {
      type: 'success',
      description: 'Local draft data has been removed from this browser.',
    });
  } catch (e) {
    console.error('Failed to clear draft:', e);
  }
}

function startAutoSave() {
  const titleInput = document.getElementById('newsletter-title');
  const previewInput = document.getElementById('newsletter-preview-text');
  const contentEditor = document.getElementById('newsletter-content');

  const debouncedSave = () => {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => persistDraft(true), 2000);
  };

  if (titleInput) titleInput.addEventListener('input', debouncedSave);
  if (previewInput) previewInput.addEventListener('input', debouncedSave);
  if (contentEditor) contentEditor.addEventListener('input', debouncedSave);

  setInterval(() => persistDraft(true), AUTOSAVE_INTERVAL);
}

// Send test email functionality
function initializeTestEmailButton() {
  const testEmailBtn = document.getElementById('test-email-button');
  if (!testEmailBtn) return;

  testEmailBtn.addEventListener('click', async function () {
    const titleInput = document.getElementById('newsletter-title');
    const previewInput = document.getElementById('newsletter-preview-text');
    const contentEditor = document.getElementById('newsletter-content');
    const statusEl = document.getElementById('send-status');

    const title = titleInput?.value || '';
    const previewText = previewInput?.value || '';
    const content = contentEditor?.innerHTML || '';

    if (!title || !content) {
      if (statusEl) {
        statusEl.textContent = 'Fill in the title and content before sending a test email.';
        statusEl.style.color = '#f87171';
      }
      showToast('Add content before testing', {
        type: 'error',
        description: 'Enter a title and body before sending yourself a preview.',
      });
      return;
    }

    testEmailBtn.disabled = true;
    testEmailBtn.innerHTML = '<span class="icon">⏳</span><span>Sending...</span>';
    showToast('Sending test email', {
      type: 'info',
      description: 'We’ll deliver it to your admin inbox in just a moment.',
      duration: 4000,
    });

    try {
      const response = await fetch('/api/preview-newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: title,
          previewText,
          content,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        if (statusEl) {
          statusEl.textContent = '✓ Test email sent successfully! Check your inbox.';
          statusEl.style.color = '#10b981';
        }
        showToast('Test email sent', {
          type: 'success',
          description: 'Check your inbox to review the message.',
        });
      } else {
        throw new Error(data?.message || data?.error || 'Test email failed to send.');
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `✗ Error: ${error.message}`;
        statusEl.style.color = '#f87171';
      }
      showToast(error.message || 'Test email failed to send.', {
        type: 'error',
      });
    } finally {
      testEmailBtn.disabled = false;
      testEmailBtn.innerHTML = '<span class="icon">✉️</span><span>Send test email</span>';
    }
  });
}

// Button handlers
function initializeClearDraftButton() {
  const clearButton = document.getElementById('clear-draft-button');
  if (clearButton) {
    clearButton.addEventListener('click', function () {
      if (confirm('Are you sure you want to clear the draft? This cannot be undone.')) {
        clearDraft();
      }
    });
  }
}

function initializeSaveDraftButton() {
  const saveButton = document.getElementById('save-draft-button');
  if (saveButton) {
    if (saveButton.dataset.enhancedSave === 'true') {
      return;
    }
    saveButton.addEventListener('click', function () {
      saveDraft();
    });
  }
}

// Initialize all Phase 2 improvements
function initializeComposingImprovements() {
  initializeCharacterCounters();
  initializeWordCount();
  initializeSpamDetector();
  initializeChecklistToggle();
  updateBestPractices();
  loadDraft();
  startAutoSave();
  initializeClearDraftButton();
  initializeSaveDraftButton();
  initializeTestEmailButton();

  // Update checklist when content changes
  const contentEditor = document.getElementById('newsletter-content');
  if (contentEditor) {
    contentEditor.addEventListener('input', updateBestPractices);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(initializeComposingImprovements, 100);
  });
} else {
  setTimeout(initializeComposingImprovements, 100);
}


