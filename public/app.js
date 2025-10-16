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
let toastCounter = 0;

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

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'toast-close';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
  closeButton.textContent = '\u2715';
  toast.appendChild(closeButton);

  container.appendChild(toast);

  let dismissalTimeout = null;

  const dismiss = () => {
    window.clearTimeout(dismissalTimeout);
    removeToastElement(toast);
  };

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

  return { id: toastId, dismiss };
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
  const saveDraftButton = document.getElementById('save-draft-button');
  const sendStatus = document.getElementById('send-status');
  const modalBackdrop = previewModal?.querySelector('[data-close-modal]');

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
  let releasePreviewFocusTrap = null;
  let previouslyFocusedElement = null;

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
    previouslyFocusedElement =
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
      previouslyFocusedElement && document.body.contains(previouslyFocusedElement)
        ? previouslyFocusedElement
        : previewButton;
    fallbackTarget?.focus({ preventScroll: true });
    previouslyFocusedElement = null;
  }

  // Compose interactions -------------------------------------------------------
  if (previewTextInput) {
    previewTextInput.addEventListener('input', () => {
      if (previewTextInput.value.length > PREVIEW_MAX_LENGTH) {
        previewTextInput.value = previewTextInput.value.slice(0, PREVIEW_MAX_LENGTH);
      }
      updatePreviewCounter();
    });
    updatePreviewCounter();
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
        setInlineStatus(imageUploadStatus, 'Please select an image file.', true);
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

        if (!response.ok) {
          throw new Error('Upload failed.');
        }

        const result = await response.json();
        if (!result?.imageUrl) {
          throw new Error('Upload failed.');
        }

        document.execCommand(
          'insertHTML',
          false,
          `<img src="${result.imageUrl}" alt="Newsletter image" />`,
        );
        setInlineStatus(imageUploadStatus, 'Image added to the editor.');
      } catch (error) {
        console.error(error);
        setInlineStatus(imageUploadStatus, 'Could not upload image.', true);
      } finally {
        setButtonLoading(uploadTrigger, false);
        uploadInput.value = '';
      }
    });
  }

  function renderPreview(showModal = true) {
    const title = titleInput.value.trim();
    const rawContent = editor.innerHTML.trim();
    const content = sanitizeEditorHtml(rawContent);
    const previewText = previewTextInput.value.trim();

    if (!title || !content) {
      setSendStatus('Title and content are required for preview.', true);
      return false;
    }

    if (previewFrame) {
      previewFrame.srcdoc = buildEmailTemplate(title, content, previewText);
    }
    if (showModal) {
      showPreviewModal();
    }
    return true;
  }

  previewButton?.addEventListener('click', () => {
    renderPreview(true);
  });

  previewClose?.addEventListener('click', hidePreviewModal);
  modalBackdrop?.addEventListener('click', hidePreviewModal);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && previewModal && !previewModal.classList.contains('hidden')) {
      hidePreviewModal();
    }
  });

  function loadDraft() {
    try {
      const rawDraft = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!rawDraft) {
        return;
      }
      const draft = JSON.parse(rawDraft);
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
      setSendStatus('Draft restored from your last session.');
    } catch (error) {
      console.warn('Failed to load draft.', error);
    }
  }

  function saveDraft(options = {}) {
    const { announce = false } = options;
    const draft = {
      title: titleInput.value,
      previewText: previewTextInput.value,
      content: editor.innerHTML,
      updatedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      const statusOptions = announce
        ? {
            variant: 'success',
            toast: {
              title: 'Draft saved',
              type: 'success',
              description: 'Stored safely in this browser for you.',
            },
          }
        : {};
      setSendStatus('Draft saved locally.', false, statusOptions);
    } catch (error) {
      console.warn('Failed to save draft.', error);
      const errorOptions = {
        variant: 'error',
        ...(announce
          ? {
            toast: {
              title: 'Draft not saved',
              type: 'error',
              description: 'Check storage permissions and try again.',
            },
          }
          : {}),
      };
      setSendStatus('Could not save draft locally.', true, errorOptions);
    }
  }

  if (saveDraftButton) {
    saveDraftButton.addEventListener('click', () => {
      saveDraft({ announce: true });
    });
    saveDraftButton.dataset.enhancedSave = 'true';
  }

  sendButton?.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const rawContent = editor.innerHTML.trim();
    const content = sanitizeEditorHtml(rawContent);
    const previewText = previewTextInput.value.trim();

    if (!title || !content) {
      setSendStatus('Title and content are required.', true);
      return;
    }

    setSendStatus('Sending newsletter...');
    setButtonLoading(sendButton, true, 'Sending');

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
      setButtonLoading(sendButton, false);
    }
  });

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
        throw new Error('Failed to load subscribers.');
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
        throw new Error(result?.message || result?.error || 'Failed to add subscriber.');
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
        throw new Error(result?.message || result?.error || 'Failed to remove subscriber.');
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
          payload?.message || payload?.error || 'Failed to load analytics.';
        throw new Error(message);
      }

      renderAnalyticsOverview(payload);
      analyticsLoadedOnce = true;
      showAnalyticsReady();
    } catch (error) {
      console.error(error);
      const fallbackMessage = error?.message || 'Failed to load analytics. Please try again.';
      showAnalyticsError(fallbackMessage);
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

function saveDraft() {
  const title = document.getElementById('newsletter-title')?.value || '';
  const previewText = document.getElementById('newsletter-preview-text')?.value || '';
  const content = document.getElementById('newsletter-content')?.innerHTML || '';

  if (!title && !previewText && !content) {
    return;
  }

  const draft = {
    title,
    previewText,
    content,
    savedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem('newsletter-draft', JSON.stringify(draft));
    showDraftSavedIndicator();
  } catch (e) {
    console.error('Failed to save draft:', e);
  }
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

function loadDraft() {
  try {
    const saved = localStorage.getItem('newsletter-draft');
    if (!saved) return;

    const draft = JSON.parse(saved);
    const savedDate = new Date(draft.savedAt);
    const minutesAgo = Math.floor((Date.now() - savedDate.getTime()) / 60000);

    let timeText;
    if (minutesAgo < 1) {
      timeText = 'just now';
    } else if (minutesAgo === 1) {
      timeText = '1 minute ago';
    } else if (minutesAgo < 60) {
      timeText = `${minutesAgo} minutes ago`;
    } else {
      const hoursAgo = Math.floor(minutesAgo / 60);
      timeText = hoursAgo === 1 ? '1 hour ago' : `${hoursAgo} hours ago`;
    }

    if (confirm(`Found unsaved draft from ${timeText}. Restore it?`)) {
      const titleInput = document.getElementById('newsletter-title');
      const previewInput = document.getElementById('newsletter-preview-text');
      const contentEditor = document.getElementById('newsletter-content');

      if (titleInput) titleInput.value = draft.title;
      if (previewInput) previewInput.value = draft.previewText;
      if (contentEditor) contentEditor.innerHTML = draft.content;

      if (titleInput) titleInput.dispatchEvent(new Event('input'));
      if (previewInput) previewInput.dispatchEvent(new Event('input'));
      if (contentEditor) contentEditor.dispatchEvent(new Event('input'));
    }
  } catch (e) {
    console.error('Failed to load draft:', e);
  }
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
    autoSaveTimeout = setTimeout(saveDraft, 2000);
  };

  if (titleInput) titleInput.addEventListener('input', debouncedSave);
  if (previewInput) previewInput.addEventListener('input', debouncedSave);
  if (contentEditor) contentEditor.addEventListener('input', debouncedSave);

  setInterval(saveDraft, AUTOSAVE_INTERVAL);
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

    if (!confirm('Send a test email to yourself? This will be sent to your admin email.')) {
      return;
    }

    testEmailBtn.disabled = true;
    testEmailBtn.innerHTML = '<span class="icon">⏳</span><span>Sending...</span>';

    try {
      const response = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testEmail: 'delivered@resend.dev', // Will use admin email from server
          subject: title,
          previewText: previewText,
          content: content
        })
      });

      const data = await response.json();

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
        throw new Error(data.error || 'Failed to send test email');
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `✗ Error: ${error.message}`;
        statusEl.style.color = '#f87171';
      }
      showToast(error.message || 'Failed to send test email.', {
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


