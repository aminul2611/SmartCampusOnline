import { auth, db } from "./firebase-config.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import {
    doc,
    getDocFromServer
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const loading = document.getElementById("loading");
const workspace = document.getElementById("workspace");
const logoutButton = document.getElementById("logout");
const message = document.getElementById("page-message");

onAuthStateChanged(auth, async user => {
    workspace.hidden = true;
    loading.hidden = false;

    if (!user) {
        location.replace("../login.html?role=admin");
        return;
    }

    try {
        const snapshot = await getDocFromServer(
            doc(db, "users", user.uid)
        );

        if (!snapshot.exists()) {
            throw new Error("Your campus profile was not found.");
        }

        const profile = snapshot.data();

        if (profile.active !== true || profile.role !== "admin") {
            throw new Error(
                "This page requires an active administrator account."
            );
        }

        // Do not show a profile if the account changed while loading.
        if (auth.currentUser?.uid !== user.uid) return;

        document.getElementById("welcome-name").textContent =
            `Welcome, ${profile.name || "Administrator"}!`;

        document.getElementById("profile-name").textContent =
            profile.name || "Administrator";

        document.getElementById("profile-email").textContent =
            user.email || "";

        loading.hidden = true;
        workspace.hidden = false;

    } catch (error) {
        loading.textContent = error.code
            ? `Could not load your profile (${error.code}). Check your connection and Firestore Rules.`
            : error.message;
    }
});

logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    message.hidden = true;

    try {
        await signOut(auth);
        // The authentication listener opens the login page.
    } catch {
        message.textContent =
            "Could not log out. Check your connection and try again.";

        message.hidden = false;
        logoutButton.disabled = false;
    }
});