import {
  auth,
  db
} from './firebase-config.js';

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

import {
  doc,
  getDocFromServer
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

import {
  queueLoginFeedback,
  consumeLogoutFeedback
} from './auth-feedback.js?v=1';

const $ = id => document.getElementById(id);

const form = $('login-form');
const email = $('email');
const password = $('password');

const submit = $('signin-button');
const message = $('login-message');
const toggle = $('toggle-password');

const roleButtons = [
  ...document.querySelectorAll(
    '.role-tabs [data-role]'
  )
];

const roles = [
  'admin',
  'teacher',
  'student'
];

const requested = new URLSearchParams(location.search)
  .get('role');

let selectedRole = roles.includes(requested)
  ? requested
  : 'admin';

let busy = true;
let processing = false;
let redirecting = false;
let version = 0;

const roleName = role =>
  role[0].toUpperCase() + role.slice(1);

function showMessage(text, success = false) {
  message.textContent = text;

  message.className =
    'message ' + (success ? 'success' : 'error');

  message.setAttribute(
    'role',
    success ? 'status' : 'alert'
  );

  message.setAttribute(
    'aria-live',
    success ? 'polite' : 'assertive'
  );

  message.hidden = false;

  if (!success) {
    message.focus();
  }
}

function setBusy(
  value,
  label = 'Checking your session…'
) {
  busy = value;

  form.setAttribute(
    'aria-busy',
    String(value)
  );

  [
    submit,
    email,
    password,
    toggle,
    ...roleButtons
  ].forEach(element => {
    element.disabled = value;
  });

  submit.classList.toggle('is-busy', value);

  submit.textContent = value
    ? label
    : `Sign in as ${roleName(selectedRole)} →`;
}

function updateRole() {
  document.body.dataset.role = selectedRole;

  $('workspace-label').textContent =
    roleName(selectedRole) + ' workspace';

  $('theme-color').content = {
    admin: '#142840',
    teacher: '#153c30',
    student: '#30244f'
  }[selectedRole];

  roleButtons.forEach(button => {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.role === selectedRole)
    );
  });

  const url = new URL(location.href);
  url.searchParams.set('role', selectedRole);

  history.replaceState(
    null,
    '',
    url.pathname + url.search + url.hash
  );

  if (!busy) {
    setBusy(false);
  }
}

async function readProfile(user) {
  let timer;

  const snapshot = await Promise.race([
    getDocFromServer(
      doc(db, 'users', user.uid)
    ),

    new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(
          Error(
            'Account check timed out. Please try again.'
          )
        ),
        25000
      );
    })
  ]).finally(() => clearTimeout(timer));

  if (auth.currentUser?.uid !== user.uid) {
    throw Error(
      'Your session changed. Please sign in again.'
    );
  }

  if (!snapshot.exists()) {
    throw Error(
      'Your campus profile is not available. Contact the administrator.'
    );
  }

  const profile = snapshot.data();

  if (profile.active !== true) {
    throw Error(
      'Your campus account is disabled. Contact the administrator.'
    );
  }

  if (profile.provisioning === 'pending') {
    throw Error(
      'Your account setup is incomplete. Contact the administrator.'
    );
  }

  if (!roles.includes(profile.role)) {
    throw Error(
      'Your account workspace is invalid. Contact the administrator.'
    );
  }

  return profile;
}

function openWorkspace(user, profile) {
  queueLoginFeedback(user, profile);

  redirecting = true;
  password.value = '';

  setBusy(
    true,
    'Signed in. Opening your workspace…'
  );

  location.replace(
    '/' + profile.role + '/index.html'
  );
}

function friendly(error) {
  const messages = {
    'auth/invalid-credential':
      'Email or password is incorrect.',

    'auth/wrong-password':
      'Email or password is incorrect.',

    'auth/user-not-found':
      'Email or password is incorrect.',

    'auth/invalid-email':
      'Enter a valid email address.',

    'auth/missing-password':
      'Enter your password.',

    'auth/user-disabled':
      'This login account is disabled. Contact the administrator.',

    'auth/too-many-requests':
      'Too many attempts. Please try again later.',

    'auth/network-request-failed':
      'Connection failed. Check your internet and try again.',

    'permission-denied':
      'Your account profile could not be accessed. Contact the administrator.',

    'unavailable':
      'The campus service is temporarily unavailable. Please try again.'
  };

  return messages[error.code] ||
    (
      error.code
        ? 'Could not sign in. Please try again.'
        : error.message
    ) ||
    'Could not sign in. Please try again.';
}

roleButtons.forEach(button => {
  button.addEventListener('click', () => {
    if (
      busy ||
      !roles.includes(button.dataset.role)
    ) {
      return;
    }

    selectedRole = button.dataset.role;
    message.hidden = true;

    updateRole();
  });
});

toggle.addEventListener('click', () => {
  if (busy) return;

  const visible = password.type === 'password';

  password.type = visible
    ? 'text'
    : 'password';

  toggle.textContent = visible
    ? 'Hide'
    : 'Show';

  toggle.setAttribute(
    'aria-pressed',
    String(visible)
  );

  toggle.setAttribute(
    'aria-label',
    visible ? 'Hide password' : 'Show password'
  );
});

form.addEventListener('submit', async event => {
  event.preventDefault();

  if (busy || !form.reportValidity()) return;

  processing = true;
  ++version;

  message.hidden = true;
  setBusy(true, 'Signing in…');

  try {
    const credential =
      await signInWithEmailAndPassword(
        auth,
        email.value.trim(),
        password.value
      );

    const profile = await readProfile(
      credential.user
    );

    if (profile.role !== selectedRole) {
      throw Error(
        `This is a ${roleName(profile.role)} account. ` +
        `Select the ${roleName(profile.role)} workspace.`
      );
    }

    openWorkspace(
      credential.user,
      profile
    );
  } catch (error) {
    try {
      await signOut(auth);
    } catch {}

    showMessage(
      friendly(error)
    );
  } finally {
    processing = false;

    if (!redirecting) {
      setBusy(false);
    }
  }
});

updateRole();
setBusy(true);

onAuthStateChanged(auth, async user => {
  if (processing || redirecting) return;

  const current = ++version;

  if (!user) {
    setBusy(false);

    if (consumeLogoutFeedback()) {
      showMessage(
        'You have been logged out successfully.',
        true
      );
    }

    return;
  }

  processing = true;
  setBusy(true);

  try {
    const profile = await readProfile(user);

    if (current !== version) return;

    selectedRole = profile.role;

    updateRole();
    openWorkspace(user, profile);
  } catch (error) {
    try {
      await signOut(auth);
    } catch {}

    if (current === version) {
      showMessage(
        friendly(error)
      );
    }
  } finally {
    processing = false;

    if (
      !redirecting &&
      current === version
    ) {
      setBusy(false);
    }
  }
});