const KEY = 'smart-campus.auth-feedback.v1';
const roles = ['admin', 'teacher', 'student'];
const pageRole = location.pathname.split('/')[1];

function save(record) {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        ...record,
        at: Date.now()
      })
    );
  } catch {}
}

function take(kind) {
  try {
    const record = JSON.parse(
      sessionStorage.getItem(KEY) || 'null'
    );

    if (!record) return null;

    if (
      !Number.isFinite(record.at) ||
      Date.now() - record.at > 60000 ||
      record.at > Date.now()
    ) {
      sessionStorage.removeItem(KEY);
      return null;
    }

    if (record.kind !== kind) return null;

    sessionStorage.removeItem(KEY);
    return record;
  } catch {
    return null;
  }
}

export function queueLoginFeedback(user, profile) {
  save({
    kind: 'login',
    uid: user.uid,
    role: profile.role,
    name: profile.name || ''
  });
}

export function consumeLogoutFeedback() {
  return take('logout');
}

function toast(text, error = false) {
  document.getElementById('campus-auth-toast')?.remove();

  if (!document.getElementById('campus-auth-toast-style')) {
    const style = document.createElement('style');
    style.id = 'campus-auth-toast-style';

    style.textContent = `
      .campus-auth-toast {
        position: fixed;
        z-index: 10000;
        top: 18px;
        right: 18px;
        width: min(410px, calc(100vw - 36px));
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 17px 18px;
        border: 1px solid #dcd4ee;
        border-left: 4px solid #6950ac;
        border-radius: 12px;
        background: #fff;
        color: #352e46;
        box-shadow: 0 12px 45px #241b3b22;
        font: 14px/1.6 'Segoe UI', Arial, sans-serif;
        overflow-wrap: anywhere;
      }

      .campus-auth-toast[data-role=admin] {
        border-left-color: #285fb9;
      }

      .campus-auth-toast[data-role=teacher] {
        border-left-color: #27734f;
      }

      .campus-auth-toast[data-error=true] {
        border-left-color: #ae3c49;
        background: #fff7f8;
        color: #8b2837;
      }

      .campus-auth-toast span {
        flex: 1;
        min-width: 0;
      }

      .campus-auth-toast button {
        flex: none;
        display: grid;
        place-items: center;
        min-width: 32px;
        min-height: 32px;
        margin: -3px -5px 0 0;
        padding: 0;
        border: 0;
        border-radius: 7px;
        background: #f2eff7;
        color: inherit;
        font: 22px/1 Arial, sans-serif;
        cursor: pointer;
      }

      .campus-auth-toast button:focus-visible {
        outline: 3px solid #b39add;
        outline-offset: 2px;
      }
    `;

    document.head.append(style);
  }

  const box = document.createElement('div');

  box.id = 'campus-auth-toast';
  box.className = 'campus-auth-toast';
  box.dataset.role = pageRole;
  box.dataset.error = String(error);

  box.setAttribute(
    'role',
    error ? 'alert' : 'status'
  );

  box.setAttribute(
    'aria-live',
    error ? 'assertive' : 'polite'
  );

  const copy = document.createElement('span');
  copy.textContent = text;

  const close = document.createElement('button');

  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss message');

  close.addEventListener('click', () => box.remove());

  box.append(copy, close);
  document.body.append(box);

  if (!error) {
    const dismiss = () => {
      if (box.contains(document.activeElement)) {
        setTimeout(dismiss, 2000);
      } else {
        box.remove();
      }
    };

    setTimeout(dismiss, 6000);
  }
}

export function installAuthFeedback({
  auth,
  signOut,
  onAuthStateChanged
}) {
  if (!roles.includes(pageRole)) return;

  let loggingOut = false;

  const selectors = pageRole === 'admin'
    ? '#logout'
    : pageRole === 'student'
      ? '#student-logout'
      : '#logout, #teacher-logout-form, #teacher-logout';

  // Store feedback before the portal redirects after sign-out.
  onAuthStateChanged(auth, user => {
    if (!user) {
      if (loggingOut) {
        save({
          kind: 'logout',
          role: pageRole
        });
      }

      return;
    }

    const record = take('login');

    if (
      record?.uid === user.uid &&
      record.role === pageRole
    ) {
      toast(
        record.name
          ? `Welcome back, ${record.name}! You have signed in successfully.`
          : 'You have signed in successfully.'
      );
    }
  });

  async function logout(event) {
    const control = event.type === 'submit'
      ? event.target
      : event.target.closest?.(
          'button, a, input[type="submit"]'
        );

    const owner = control?.closest(selectors);

    if (!owner) return;

    if (
      event.type === 'click' &&
      owner.tagName === 'FORM'
    ) {
      return;
    }

    if (
      event.type === 'submit' &&
      owner.tagName !== 'FORM'
    ) {
      return;
    }

    const button = owner.tagName === 'FORM'
      ? owner.querySelector(
          'button[type="submit"], button:not([type]), input[type="submit"]'
        )
      : owner;

    if (button?.disabled && !loggingOut) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (loggingOut) return;

    loggingOut = true;

    const oldLabel = button?.textContent;

    if (button) {
      button.disabled = true;
      button.textContent = 'Logging out…';
    }

    owner.setAttribute('aria-busy', 'true');

    try {
      await signOut(auth);

      save({
        kind: 'logout',
        role: pageRole
      });

      location.replace(
        '/login.html?role=' + pageRole
      );
    } catch {
      loggingOut = false;

      if (button) {
        button.disabled = false;
        button.textContent = oldLabel;
      }

      owner.setAttribute('aria-busy', 'false');

      toast(
        'Could not log out. Please check your connection and try again.',
        true
      );
    }
  }

  document.addEventListener('click', logout, true);
  document.addEventListener('submit', logout, true);
}