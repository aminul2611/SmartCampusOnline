import { auth } from "./firebase-config.js";

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const $ = id => document.getElementById(id);

let busy = false;
let version = 0;

function show(text, error = false) {
  $("teacher-status").textContent = text;

  $("teacher-status").className =
    "flash " + (error ? "danger" : "success");

  $("teacher-status").hidden = !text;
}

function setBusy(value) {
  busy = value;

  document.querySelectorAll("button").forEach(button => {
    button.disabled = value;
  });
}

function deadline(promise, milliseconds = 25000) {
  let timer;

  return Promise.race([
    promise,

    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          "Connection timed out. Check your connection and retry."
        ));
      }, milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

async function api(body) {
  if (!auth.currentUser) {
    throw new Error("Please sign in again.");
  }

  const token = await deadline(
    auth.currentUser.getIdToken()
  );

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 60000);

  try {
    const response = await fetch("/api/teacher/profile", {
      method: body === undefined ? "GET" : "POST",

      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },

      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),

      signal: controller.signal
    });

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      throw new Error(
        "Teacher Profile API is unavailable. " +
        "Restart the updated Node server."
      );
    }

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        data.message || "The request failed."
      );
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "Request timed out. Reload your profile before retrying."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function fill(profile) {
  const form = $("teacher-profile-form");

  for (const name of [
    "name",
    "email",
    "phone",
    "department",
    "designation"
  ]) {
    form.elements.namedItem(name).value =
      profile[name] || "";
  }

  document.querySelectorAll("[data-teacher-name]")
    .forEach(element => {
      element.textContent = profile.name;
    });

  document.querySelectorAll("[data-initial]")
    .forEach(element => {
      element.textContent = (profile.name || "T")
        .slice(0, 1)
        .toUpperCase();
    });

  $("teacher-email").textContent = profile.email;
}

function friendly(error) {
  const messages = {
    "auth/invalid-credential":
      "Current password is incorrect. Please try again.",

    "auth/wrong-password":
      "Current password is incorrect. Please try again.",

    "auth/weak-password":
      "Choose a stronger password.",

    "auth/password-does-not-meet-requirements":
      "The password does not meet the account password policy.",

    "auth/too-many-requests":
      "Too many attempts. Please wait before trying again.",

    "auth/network-request-failed":
      "Could not connect to Firebase. Check your connection.",

    "auth/requires-recent-login":
      "Please sign in again before changing your password."
  };

  return messages[error.code] || error.message;
}

$("teacher-profile-form").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy) return;

    const form = event.target;
    const body = {};

    for (const name of [
      "name",
      "phone",
      "department",
      "designation"
    ]) {
      body[name] = form.elements
        .namedItem(name)
        .value
        .trim();
    }

    setBusy(true);
    show("Saving profile…");

    try {
      const result = await api(body);

      fill(result.profile);
      show(result.message);
    } catch (error) {
      show(friendly(error), true);
    } finally {
      setBusy(false);
    }
  }
);

$("teacher-password-form").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy) return;

    const form = event.target;

    const current = form.elements
      .namedItem("current_password").value;

    const password = form.elements
      .namedItem("new_password").value;

    const confirm = form.elements
      .namedItem("confirm_password").value;

    if (
      password.length < 8 ||
      password.length > 128
    ) {
      show(
        "Use 8–128 characters for the new password.",
        true
      );
      return;
    }

    if (password !== confirm) {
      show("New passwords do not match.", true);
      return;
    }

    const user = auth.currentUser;

    if (!user) {
      location.replace("/login.html?role=teacher");
      return;
    }

    setBusy(true);
    show("Checking current password…");

    let changed = false;

    try {
      // Confirm that the account is still an active Teacher.
      await api();

      // Firebase checks the current password.
      await reauthenticateWithCredential(
        user,
        EmailAuthProvider.credential(
          user.email,
          current
        )
      );

      // Store the new password in Firebase Authentication.
      await updatePassword(user, password);

      changed = true;
      form.reset();

      show(
        "Password changed successfully. Signing out…"
      );

      await signOut(auth);

      location.replace("/login.html?role=teacher");
    } catch (error) {
      show(
        changed
          ? "Password changed successfully. Use Log out, " +
            "then sign in with your new password."
          : friendly(error),
        !changed
      );
    } finally {
      setBusy(false);
    }
  }
);

$("teacher-logout-form").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy) return;

    setBusy(true);

    try {
      await signOut(auth);
      location.replace("/login.html?role=teacher");
    } catch (error) {
      show(friendly(error), true);
    } finally {
      setBusy(false);
    }
  }
);

$("profile-retry").addEventListener("click", () => {
  location.reload();
});

function tick() {
  const now = new Date();

  $("live-date").textContent =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(now);

  $("live-time").textContent =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(now);
}

tick();
setInterval(tick, 1000);

onAuthStateChanged(auth, async user => {
  const currentVersion = ++version;

  $("teacher-profile-content").hidden = true;
  $("profile-retry").hidden = true;

  if (!user) {
    location.replace("/login.html?role=teacher");
    return;
  }

  setBusy(true);
  show("Checking Teacher account…");

  try {
    const result = await api();

    if (currentVersion !== version) return;

    fill(result.profile);

    $("teacher-profile-content").hidden = false;

    show("");
  } catch (error) {
    if (currentVersion === version) {
      show(friendly(error), true);
      $("profile-retry").hidden = false;
    }
  } finally {
    if (currentVersion === version) {
      setBusy(false);
    }
  }
});