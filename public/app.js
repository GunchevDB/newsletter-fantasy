/**
 * Frontend logic for the newsletter builder.
 * Handles rich text editing, preview, subscriber management,
 * sending newsletters, and image uploads.
 */
document.addEventListener('DOMContentLoaded', () => {
  const titleInput = document.getElementById('newsletter-title');
  const previewTextInput = document.getElementById('newsletter-preview-text');
  const editor = document.getElementById('newsletter-content');
  const previewFrame = document.getElementById('email-preview');
  const previewButton = document.getElementById('preview-button');
  const sendButton = document.getElementById('send-button');
  const sendStatus = document.getElementById('send-status');
  const toolbarButtons = document.querySelectorAll('.toolbar button[data-command]');
  const uploadTrigger = document.getElementById('upload-image-trigger');
  const uploadInput = document.getElementById('image-upload-input');

  const subscriberList = document.getElementById('subscriber-items');
  const subscriberTemplate = document.getElementById('subscriber-item-template');
  const addSubscriberForm = document.getElementById('add-subscriber-form');
  const subscriberEmailInput = document.getElementById('subscriber-email');
  const subscriberStatus = document.getElementById('subscriber-status');
  const DOMPURIFY_CONFIG = {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(https?:|mailto:)/i,
  };

  function sanitizeEditorHtml(raw) {
    if (!window.DOMPurify) {
      console.warn('DOMPurify not found; skipping client-side sanitization.');
      return raw;
    }
    return window.DOMPurify.sanitize(raw, DOMPURIFY_CONFIG);
  }

  /**
   * Helper to show status messages beside send button.
   */
  function setSendStatus(message, isError = false) {
    sendStatus.textContent = message;
    sendStatus.style.color = isError ? '#b91c1c' : '#2563eb';
  }

  /**
   * Helper to show subscriber related status messages.
   */
  function setSubscriberStatus(message, isError = false) {
    subscriberStatus.textContent = message;
    subscriberStatus.style.color = isError ? '#b91c1c' : '#2563eb';
  }

  /**
   * Create the same HTML template used by the server so preview matches sent email.
   */
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
              color: #374151;
            }
            .footer {
              background: #f9fafb;
              padding: 24px 32px 32px 32px;
              font-size: 12px;
              text-align: center;
              color: #6b7280;
            }
            img {
              max-width: 100%;
              height: auto;
              border-radius: 6px;
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
              ${previewText}
            </div>
            <div class="container">
              <h1>${title}</h1>
              <div class="content">${content}</div>
              <div class="footer">
                <p style="margin:0;">You are receiving this email because you subscribed to our newsletter.</p>
                <p style="margin:8px 0 0 0;">If this was a mistake you can ignore this message or unsubscribe.</p>
                ${
                  unsubscribeLink
                    ? `<p style="margin:12px 0 0 0;"><a href="${unsubscribeLink}" style="color:#2563eb;">Unsubscribe from this list</a></p>`
                    : ''
                }
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  /**
   * Update the preview iframe using the current editor state.
   */
  function renderPreview() {
    const title = titleInput.value.trim() || 'Your Newsletter Title';
    const rawContent = editor.innerHTML || '<p>Start writing your content...</p>';
    const sanitizedContent = sanitizeEditorHtml(rawContent);
    const previewText = previewTextInput.value.trim() || 'Thank you for reading our newsletter!';
    const previewUnsubscribeLink = `${window.location.origin}/unsubscribe?email={{EMAIL}}`;
    const html = buildEmailTemplate(title, sanitizedContent, previewText, previewUnsubscribeLink);
    previewFrame.srcdoc = html;
    setSendStatus('Preview updated.', false);
  }

  /**
   * Fetch and render subscribers on load.
   */
  async function loadSubscribers() {
    try {
      const response = await fetch('/api/subscribers');
      if (!response.ok) {
        throw new Error('Failed to fetch subscribers.');
      }
      const data = await response.json();
      renderSubscribers(data.subscribers || []);
    } catch (error) {
      console.error(error);
      setSubscriberStatus('Could not load subscribers.', true);
    }
  }

  /**
   * Render subscribers into the list using the document template.
   */
  function renderSubscribers(subscribers) {
    subscriberList.innerHTML = '';

    if (!subscribers.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No subscribers yet.';
      empty.style.color = '#6b7280';
      subscriberList.appendChild(empty);
      return;
    }

    subscribers.forEach((subscriber) => {
      const item = subscriberTemplate.content.cloneNode(true);
      const emailSpan = item.querySelector('.subscriber-email');
      const removeButton = item.querySelector('.remove-subscriber');

      emailSpan.textContent = subscriber.email;
      removeButton.dataset.email = subscriber.email;

      subscriberList.appendChild(item);
    });
  }

  /**
   * Upload image to the server and insert into the editor.
   */
  async function uploadImage(file) {
    const formData = new FormData();
    formData.append('image', file);

    setSendStatus('Uploading image...');

    try {
      const response = await fetch('/api/upload-image', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.message || 'Upload failed.');
      }

      document.execCommand('insertImage', false, data.imageUrl);
      setSendStatus('Image uploaded and added to the editor.');
    } catch (error) {
      console.error(error);
      setSendStatus(error.message || 'Could not upload the image.', true);
    }
  }

  // Toolbar controls using document.execCommand for simple rich text functionality.
  toolbarButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      if (command === 'createLink') {
        const url = window.prompt('Enter the link URL:');
        if (!url) {
          return;
        }
        document.execCommand(command, false, url);
      } else {
        document.execCommand(command, false, null);
      }
      editor.focus();
    });
  });

  uploadTrigger.addEventListener('click', () => uploadInput.click());

  uploadInput.addEventListener('change', () => {
    const [file] = uploadInput.files;
    if (!file) {
      return;
    }
    uploadImage(file);
    uploadInput.value = ''; // Reset input so the same file can be uploaded twice if needed
  });

  // Add new subscriber via API.
  addSubscriberForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = subscriberEmailInput.value.trim();

    if (!email) {
      setSubscriberStatus('Please enter an email address.', true);
      return;
    }

    try {
      const response = await fetch('/api/subscribers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      if (response.status === 409) {
        setSubscriberStatus('This email is already subscribed.', true);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to add subscriber.');
      }

      subscriberEmailInput.value = '';
      setSubscriberStatus('Subscriber added successfully.');
      await loadSubscribers();
    } catch (error) {
      console.error(error);
      setSubscriberStatus('Could not add subscriber.', true);
    }
  });

  // Handle subscriber removal using event delegation.
  subscriberList.addEventListener('click', async (event) => {
    if (!event.target.matches('.remove-subscriber')) {
      return;
    }

    const email = event.target.dataset.email;
    const confirmed = window.confirm(`Remove ${email} from the list?`);
    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/subscribers/${encodeURIComponent(email)}`, {
        method: 'DELETE',
      });

      if (response.status === 404) {
        setSubscriberStatus('Subscriber not found.', true);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to remove subscriber.');
      }

      setSubscriberStatus('Subscriber removed.');
      await loadSubscribers();
    } catch (error) {
      console.error(error);
      setSubscriberStatus('Could not remove subscriber.', true);
    }
  });

  // Preview the email in the iframe.
  previewButton.addEventListener('click', () => {
    renderPreview();
  });

  // Send newsletter via backend API.
  sendButton.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const rawContent = editor.innerHTML.trim();
    const sanitizedContent = sanitizeEditorHtml(rawContent);
    const previewText = previewTextInput.value.trim();

    if (!title || !sanitizedContent) {
      setSendStatus('Title and content are required.', true);
      return;
    }

    setSendStatus('Sending newsletter...');
    sendButton.disabled = true;

    try {
      const response = await fetch('/api/send-newsletter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          content: sanitizedContent,
          previewText,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        const detailText = result?.details ? ` (${result.details})` : '';
        throw new Error((result.message || 'Failed to send newsletter.') + detailText);
      }

      setSendStatus('Newsletter sent successfully!');
    } catch (error) {
      console.error(error);
      setSendStatus(error.message || 'Could not send newsletter.', true);
    } finally {
      sendButton.disabled = false;
    }
  });

  // Initialize view.
  previewFrame.srcdoc = '<p style="font-family: Arial, sans-serif; padding: 16px;">Click "Preview Email" to see the formatted email.</p>';
  loadSubscribers();
});
