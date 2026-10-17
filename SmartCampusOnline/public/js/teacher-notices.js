import { auth } from './firebase-config.js';

import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const $ = id => document.getElementById(id);

const escape = value => String(value ?? '').replace(
  /[&<>"']/g,
  character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character])
);

const storageKey = 'smart-campus.pending-teacher-notice';

let busy = false;

function show(text, error = false) {
  $('teacher-message').textContent = text;
  $('teacher-message').className =
    'message ' + (error ? 'error' : 'success');
}

function setBusy(value) {
  busy = value;

  document.querySelectorAll('button').forEach(button => {
    button.disabled = value;
  });
}

async function request(body) {
  let tokenTimer;

  const token = await Promise.race([
    auth.currentUser.getIdToken(),
    new Promise((resolve, reject) => {
      tokenTimer = setTimeout(() => {
        reject(new Error(
          'Login check timed out. Check your connection.'
        ));
      }, 25000);
    })
  ]).finally(() => clearTimeout(tokenTimer));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);

  try {
    const response = await fetch('/api/teacher/notices', {
      method: body === undefined ? 'GET' : 'POST',

      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },

      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),

      signal: controller.signal
    });

    if (
      !(response.headers.get('content-type') || '')
        .includes('application/json')
    ) {
      throw new Error(
        'Teacher notice API is unavailable. Restart the updated Node server.'
      );
    }

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.message || 'Request failed.');
    }

    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        'Connection timed out. Check Sent notices and retry with the same form values.'
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cards(notices) {
  return notices.map(notice => `
    <article class="notice">
      <span class="badge">
        ${escape(notice.author_name || 'Campus')}
      </span>
      <h3>${escape(notice.title)}</h3>
      <p class="pre">${escape(notice.body)}</p>
    </article>
  `).join('') || '<p class="empty">No notices yet.</p>';
}

async function refresh() {
  const data = await request();

  $('teacher-name').textContent = data.name;
  $('teacher-received').innerHTML = cards(data.received);
  $('teacher-sent').innerHTML = cards(data.sent);
  $('teacher-content').hidden = false;
}

$('teacher-notice-form').addEventListener(
  'submit',
  async event => {
    event.preventDefault();

    if (busy) return;

    const form = event.target;
    const body = Object.fromEntries(new FormData(form));

    body.title = body.title.trim();
    body.body = body.body.trim();

    let requestId = sessionStorage.getItem(storageKey);

    if (!/^[a-f0-9]{32}$/.test(requestId || '')) {
      requestId = crypto.randomUUID().replaceAll('-', '');
      sessionStorage.setItem(storageKey, requestId);
    }

    body.request_id = requestId;

    setBusy(true);
    show('Sending notice…');

    try {
      const result = await request(body);

      sessionStorage.removeItem(storageKey);
      form.reset();

      try {
        await refresh();
        show(result.message);
      } catch (error) {
        show(
          'Notice was sent, but the list could not refresh. ' +
          error.message,
          true
        );
      }
    } catch (error) {
      show(error.message, true);
    } finally {
      setBusy(false);
    }
  }
);

$('teacher-refresh').addEventListener('click', async () => {
  if (busy) return;

  setBusy(true);

  try {
    await refresh();
    show('Notices refreshed.');
  } catch (error) {
    show(error.message, true);
  } finally {
    setBusy(false);
  }
});

$('teacher-logout').addEventListener('click', async () => {
  if (busy) return;

  try {
    await signOut(auth);
  } catch (error) {
    show(error.message, true);
  }
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    location.replace('/login.html?role=teacher');
    return;
  }

  setBusy(true);

  try {
    await refresh();
    show('Teacher notices loaded.');
  } catch (error) {
    $('teacher-content').hidden = true;
    show(error.message, true);
  } finally {
    setBusy(false);
  }
});