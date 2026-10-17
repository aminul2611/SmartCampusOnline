import {
  auth,
  db
} from "./firebase-config.js";

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import {
  doc,
  getDocFromServer
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";


const form = document.getElementById("login-form");
const email = document.getElementById("email");
const password = document.getElementById("password");
const submit = document.getElementById("signin-button");
const message = document.getElementById("login-message");

const roleButtons = [
  ...document.querySelectorAll("[data-role]")
];

const roles = [
  "admin",
  "teacher",
  "student"
];

const requestedRole = new URLSearchParams(
  location.search
).get("role");

let selectedRole = roles.includes(requestedRole)
  ? requestedRole
  : "admin";

let busy = false;
let submitting = false;


// --------------------------------------------------
// Messages
// --------------------------------------------------

function showMessage(text, success = false) {
  message.textContent = text;

  message.className = success
    ? "message success"
    : "message";

  message.hidden = false;
}


// --------------------------------------------------
// Button and role selection
// --------------------------------------------------

function setBusy(value) {
  busy = value;

  submit.disabled = value;

  roleButtons.forEach(button => {
    button.disabled = value;
  });

  const roleName =
    selectedRole[0].toUpperCase() +
    selectedRole.slice(1);

  submit.textContent = value
    ? "Checking account…"
    : `Sign in as ${roleName} →`;
}

function updateRole() {
  roleButtons.forEach(button => {
    button.setAttribute(
      "aria-pressed",
      String(
        button.dataset.role === selectedRole
      )
    );
  });

  setBusy(busy);
}


// --------------------------------------------------
// Read and validate campus profile
// --------------------------------------------------

async function readProfile(user) {
  const snapshot = await getDocFromServer(
    doc(db, "users", user.uid)
  );

  if (!snapshot.exists()) {
    throw new Error(
      "Your campus profile has not been created. Contact the administrator."
    );
  }

  const profile = snapshot.data();

  if (profile.active !== true) {
    throw new Error(
      "Your campus account is disabled. Contact the administrator."
    );
  }

  if (profile.provisioning === "pending") {
    throw new Error(
      "Your account setup is not complete. Contact the administrator."
    );
  }

  if (!roles.includes(profile.role)) {
    throw new Error(
      "Your account role is invalid."
    );
  }

  return profile;
}


// --------------------------------------------------
// Open the correct workspace
// --------------------------------------------------

function displayAccount(user, profile) {
  const destinations = {
    admin: "/admin/index.html",
    teacher: "/teacher/index.html",
    student: "/student/index.html"
  };

  const destination = destinations[profile.role];

  if (!destination) {
    throw new Error(
      "Your account role is invalid."
    );
  }

  location.replace(destination);
}


// --------------------------------------------------
// Error messages
// --------------------------------------------------

function friendlyError(error) {
  const messages = {
    "auth/invalid-credential":
      "Email or password is incorrect.",

    "auth/wrong-password":
      "Email or password is incorrect.",

    "auth/user-not-found":
      "Email or password is incorrect.",

    "auth/invalid-email":
      "Enter a valid email address.",

    "auth/missing-password":
      "Enter your password.",

    "auth/user-disabled":
      "This login account is disabled.",

    "auth/too-many-requests":
      "Too many attempts. Please try again later.",

    "auth/network-request-failed":
      "Network connection failed. Check your connection and VPN.",

    "permission-denied":
      "Profile access was denied. Check that the Firestore Rules were published.",

    "unavailable":
      "Firestore is unavailable. Check your connection and try again."
  };

  return messages[error.code] ||
    (
      error.code
        ? `Could not sign in (${error.code}).`
        : error.message
    ) ||
    "Could not sign in. Please try again.";
}


// --------------------------------------------------
// Role buttons
// --------------------------------------------------

roleButtons.forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const role = button.dataset.role;

    if (!roles.includes(role)) {
      return;
    }

    selectedRole = role;

    message.hidden = true;

    updateRole();
  });
});


// --------------------------------------------------
// Show / hide password
// --------------------------------------------------

document.getElementById(
  "toggle-password"
)?.addEventListener("click", event => {
  event.preventDefault();

  const visible = password.type === "password";

  password.type = visible
    ? "text"
    : "password";

  event.currentTarget.textContent = visible
    ? "Hide"
    : "Show";

  event.currentTarget.setAttribute(
    "aria-pressed",
    String(visible)
  );
});


// --------------------------------------------------
// Sign in
// --------------------------------------------------

form.addEventListener("submit", async event => {
  event.preventDefault();

  if (busy) {
    return;
  }

  submitting = true;

  setBusy(true);

  message.hidden = true;

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
      throw new Error(
        `This is a ${profile.role} account. Select the correct workspace.`
      );
    }

    password.value = "";

    displayAccount(
      credential.user,
      profile
    );

  } catch (error) {
    try {
      await signOut(auth);
    } catch {
      // Keep the original login error.
    }

    showMessage(
      friendlyError(error)
    );

  } finally {
    submitting = false;

    setBusy(false);
  }
});


// --------------------------------------------------
// Sign out from an older account confirmation screen
// --------------------------------------------------

document.getElementById(
  "logout-button"
)?.addEventListener("click", async event => {
  event.preventDefault();

  if (busy) {
    return;
  }

  const button = event.currentTarget;

  const logoutMessage = document.getElementById(
    "logout-message"
  );

  button.disabled = true;

  if (logoutMessage) {
    logoutMessage.hidden = true;
  }

  try {
    await signOut(auth);

    const accountSection = document.getElementById(
      "account-section"
    );

    const signinSection = document.getElementById(
      "signin-section"
    );

    if (accountSection) {
      accountSection.hidden = true;
    }

    if (signinSection) {
      signinSection.hidden = false;
    }

    password.value = "";

    showMessage(
      "Logged out successfully.",
      true
    );

  } catch (error) {
    if (logoutMessage) {
      logoutMessage.textContent =
        friendlyError(error);

      logoutMessage.hidden = false;
    } else {
      showMessage(
        friendlyError(error)
      );
    }

  } finally {
    button.disabled = false;
  }
});


// --------------------------------------------------
// Restore an existing login
// --------------------------------------------------

updateRole();

setBusy(true);

onAuthStateChanged(auth, async user => {
  if (submitting) {
    return;
  }

  if (!user) {
    const accountSection = document.getElementById(
      "account-section"
    );

    const signinSection = document.getElementById(
      "signin-section"
    );

    if (accountSection) {
      accountSection.hidden = true;
    }

    if (signinSection) {
      signinSection.hidden = false;
    }

    setBusy(false);

    return;
  }

  setBusy(true);

  try {
    const profile = await readProfile(user);

    displayAccount(user, profile);

  } catch (error) {
    try {
      await signOut(auth);
    } catch {
      // Keep the profile error visible.
    }

    showMessage(
      friendlyError(error)
    );

  } finally {
    setBusy(false);
  }
});