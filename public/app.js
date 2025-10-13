﻿/**
 * Frontend logic for the redesigned newsletter builder.
 * Handles navigation, compose workflow, preview modal, subscriber management,
 * image uploads, draft persistence, and sending newsletters.
 */

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
        loadSubscribers({ silent: subscribersLoadedOnce }).catch(() => {});
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

  function setSendStatus(message, isError = false) {
    if (!sendStatus) {
      return;
    }
    sendStatus.textContent = message;
    sendStatus.classList.toggle('is-error', isError);
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
    const { highlightSuccess = false } = options;
    if (isError) {
      subscriberStatus.classList.add('is-error');
    } else if (highlightSuccess) {
      subscriberStatus.classList.add('is-success');
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

  function setSubscriberLoading(isLoading) {
    if (!subscriberLoading) {
      return;
    }
    subscriberLoading.classList.toggle('hidden', !isLoading);
  }

  function setButtonLoading(button, isLoading, loadingLabel = 'Loadingâ€¦') {
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
    previewModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    setTimeout(() => {
      previewClose?.focus({ preventScroll: true });
    }, 50);
  }

  function hidePreviewModal() {
    if (!previewModal) {
      return;
    }
    previewModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    previewButton?.focus({ preventScroll: true });
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

      setInlineStatus(imageUploadStatus, 'Uploading imageâ€¦');
      setButtonLoading(uploadTrigger, true, 'Uploadingâ€¦');

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
    if (event.key === 'Escape' && !previewModal.classList.contains('hidden')) {
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

  function saveDraft() {
    const draft = {
      title: titleInput.value,
      previewText: previewTextInput.value,
      content: editor.innerHTML,
      updatedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      setSendStatus('Draft saved locally.');
    } catch (error) {
      console.warn('Failed to save draft.', error);
      setSendStatus('Could not save draft locally.', true);
    }
  }

  saveDraftButton?.addEventListener('click', () => {
    saveDraft();
  });

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
    setButtonLoading(sendButton, true, 'Sendingâ€¦');

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
        throw new Error((result?.message || 'Failed to send newsletter.') + detailText);
      }

      const summary = result?.summary;
      if (summary) {
        const sent = summary.sentCount ?? summary.successes?.length ?? 0;
        const failed = summary.failedCount ?? summary.failures?.length ?? 0;
        const partialNote = failed > 0 ? ` (with ${failed} issues)` : '';
        setSendStatus(`Newsletter sent successfully to ${sent} subscriber(s)${partialNote}.`);
      } else {
        setSendStatus('Newsletter sent successfully!');
      }
      if (analyticsContent) {
        loadAnalytics({ silent: true }).catch(() => {});
      }
    } catch (error) {
      console.error(error);
      setSendStatus(error.message || 'Could not send newsletter.', true);
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
      return 'â€”';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'â€”';
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
        nameCell.textContent = subscriber.name || 'â€”';
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
        setSubscriberStatus(error.message || 'Could not load subscribers.', true);
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
        '<span class="icon" aria-hidden="true">âœ–ï¸</span><span>Close form</span>';
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
      setSubscriberStatus('Please enter an email address.', true);
      subscriberEmailInput.focus();
      return;
    }

    const submitButton = addSubscriberForm.querySelector('button[type="submit"]');
    setSubscriberStatus('Adding subscriber...');
    setButtonLoading(submitButton, true, 'Addingâ€¦');

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
      setSubscriberStatus(
        `Subscriber saved to ${backendLabel} storage${nonPersistentNote} (verified in ${attempts} attempt${
          attempts === 1 ? '' : 's'
        }).`,
        storageMode === 'kv' && !storageHealthy,
        { highlightSuccess: storageMode === 'kv' && storageHealthy },
      );
      toggleAddSubscriberForm(false);
      await loadSubscribers({ silent: true });
    } catch (error) {
      console.error(error);
      setSubscriberStatus(error.message || 'Could not add subscriber.', true);
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
    setButtonLoading(target, true, 'Removingâ€¦');

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
      setSubscriberStatus(
        `Subscriber removed from ${backendLabel} storage${removalNote} (confirmed in ${attempts} attempt${
          attempts === 1 ? '' : 's'
        }).`,
        storageMode === 'kv' && !storageHealthy,
        { highlightSuccess: storageMode === 'kv' && storageHealthy },
      );
      await loadSubscribers({ silent: true });
    } catch (error) {
      console.error(error);
      setSubscriberStatus(error.message || 'Could not remove subscriber.', true);
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
        loadAnalytics().catch(() => {});
      }
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      setButtonLoading(logoutButton, true, 'Logging outâ€¦');
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
    loadSubscribers().catch(() => {});
  }
  activateView('compose-view');
});

// ========================================
// COMPOSING IMPROVEMENTS
// ========================================

// Character counters
function initializeCharacterCounters() {
  const titleInput = document.getElementById('newsletter-title');
  const titleCounter = document.getElementById('title-char-counter');
  const previewInput = document.getElementById('newsletter-preview-text');
  const previewCounter = document.getElementById('preview-char-counter');
  
  if (titleInput && titleCounter) {
    titleInput.addEventListener('input', function() {
      const length = this.value.length;
      titleCounter.textContent = `${length} / 50`;
      
      // Color coding
      if (length > 50) {
        titleCounter.style.color = '#f87171'; // Red
        titleCounter.style.fontWeight = 'bold';
      } else if (length > 40) {
        titleCounter.style.color = '#fbbf24'; // Orange
        titleCounter.style.fontWeight = 'normal';
      } else {
        titleCounter.style.color = '#6b7280'; // Gray
        titleCounter.style.fontWeight = 'normal';
      }
    });
    
    // Trigger on load if there's content
    if (titleInput.value) {
      titleInput.dispatchEvent(new Event('input'));
    }
  }
  
  if (previewInput && previewCounter) {
    previewInput.addEventListener('input', function() {
      const length = this.value.length;
      previewCounter.textContent = `${length} / 150`;
      
      // Ideal range is 40-130
      if (length >= 40 && length <= 130) {
        previewCounter.style.color = '#10b981'; // Green
      } else if (length > 130) {
        previewCounter.style.color = '#f87171'; // Red
      } else {
        previewCounter.style.color = '#6b7280'; // Gray
      }
    });
    
    // Trigger on load if there's content
    if (previewInput.value) {
      previewInput.dispatchEvent(new Event('input'));
    }
  }
}

// Auto-save draft functionality
let autoSaveTimeout;
const AUTOSAVE_INTERVAL = 30000; // 30 seconds

function saveDraft() {
  const title = document.getElementById('newsletter-title')?.value || '';
  const previewText = document.getElementById('newsletter-preview-text')?.value || '';
  const content = document.getElementById('newsletter-content')?.innerHTML || '';
  
  if (!title && !previewText && !content) {
    // Don't save empty drafts
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
  // Remove existing indicator if present
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
      
      // Trigger input events to update counters
      if (titleInput) titleInput.dispatchEvent(new Event('input'));
      if (previewInput) previewInput.dispatchEvent(new Event('input'));
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
    
    // Trigger input events
    if (titleInput) titleInput.dispatchEvent(new Event('input'));
    if (previewInput) previewInput.dispatchEvent(new Event('input'));
    
    alert('Draft cleared!');
  } catch (e) {
    console.error('Failed to clear draft:', e);
  }
}

function startAutoSave() {
  // Auto-save on input with debounce
  const titleInput = document.getElementById('newsletter-title');
  const previewInput = document.getElementById('newsletter-preview-text');
  const contentEditor = document.getElementById('newsletter-content');
  
  const debouncedSave = () => {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(saveDraft, 2000); // Save 2 seconds after last edit
  };
  
  if (titleInput) titleInput.addEventListener('input', debouncedSave);
  if (previewInput) previewInput.addEventListener('input', debouncedSave);
  if (contentEditor) contentEditor.addEventListener('input', debouncedSave);
  
  // Also save every 30 seconds
  setInterval(saveDraft, AUTOSAVE_INTERVAL);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  // Wait a bit for other scripts to initialize
  setTimeout(() => {
    initializeCharacterCounters();
    loadDraft();
    startAutoSave();
  }, 100);
});

// Clear draft after successful send
// Find your existing send button handler and add this:
const existingSendButton = document.getElementById('send-button');
if (existingSendButton) {
  existingSendButton.addEventListener('click', function() {
    // After successful send, clear the draft
    // You'll need to add this inside your existing send success callback
    // localStorage.removeItem('newsletter-draft');
  });
}


