import { auth, db } from "./firebase-config.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import {
    collection,
    doc,
    query,
    where,
    getDocFromServer,
    getDocsFromServer
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";


const loading = document.getElementById("module-loading");
const content = document.getElementById("module-content");

const page = location.pathname.split("/").pop();

const pendingKey = "smart-campus.pending-teacher";

let adminUid = null;
let teachers = [];
let busy = false;
let authVersion = 0;
let initialized = false;


function element(tag, text, className = "") {
    const item = document.createElement(tag);

    if (text !== undefined && text !== null) {
        item.textContent = text;
    }

    if (className) {
        item.className = className;
    }

    return item;
}


function showMessage(id, text, success = false) {
    const target = document.getElementById(id) || loading;

    target.className =
        "ta-message " + (success ? "is-success" : "is-error");

    target.textContent = text;
    target.hidden = false;
}


function hideMessage(id) {
    const target = document.getElementById(id);

    if (target) {
        target.hidden = true;
    }
}


function errorText(error) {
    const messages = {
        "permission-denied":
            "Permission denied. Check the Firestore Rules and your active admin profile.",

        "unavailable":
            "Firebase is unavailable. Check your connection and try again.",

        "auth/network-request-failed":
            "The connection failed. Check your connection and try again."
    };

    return messages[error.code]
        || error.message
        || "The request could not be completed.";
}


function setBusy(value) {
    busy = value;

    content.querySelectorAll("button").forEach(button => {
        button.disabled = value;
    });
}


function formValues(form) {
    const result = {};

    for (const [key, value] of new FormData(form)) {
        result[key] = key.includes("password")
            ? value
            : value.trim();
    }

    return result;
}


function validateProfile(data) {
    if (!data.name || data.name.length > 100) {
        throw new Error(
            "Enter a full name using 1–100 characters."
        );
    }

    if (!data.teacher_no || data.teacher_no.length > 80) {
        throw new Error(
            "Enter a Teacher ID using 1–80 characters."
        );
    }

    if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
        || data.email.length > 254
    ) {
        throw new Error("Enter a valid email address.");
    }

    for (const key of ["department", "phone", "designation"]) {
        if ((data[key] || "").length > 150) {
            throw new Error(
                key + " must be within 150 characters."
            );
        }
    }
}


function validatePassword(data) {
    if (
        typeof data.new_password !== "string"
        || data.new_password.length < 8
        || data.new_password.length > 128
    ) {
        throw new Error(
            "Password must contain 8–128 characters."
        );
    }

    if (data.new_password !== data.confirm_password) {
        throw new Error("Passwords do not match.");
    }
}


function today() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const getPart = type =>
        parts.find(part => part.type === type).value;

    return [
        getPart("year"),
        getPart("month"),
        getPart("day")
    ].join("-");
}


document.getElementById("admin-date").textContent = today();


async function api(path, data) {
    const user = auth.currentUser;

    if (!user || user.uid !== adminUid) {
        throw new Error(
            "Please sign in with your administrator account again."
        );
    }

    const token = await user.getIdToken();

    const response = await fetch("/api/teachers" + path, {
        method: "POST",

        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },

        body: JSON.stringify(data)
    });

    const contentType =
        response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
        throw new Error(
            "The Python backend is not available here. " +
            "During local testing, open the application on port 5003."
        );
    }

    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error(
            result.message || "The server request failed."
        );
    }

    return result;
}


function creationRequestId() {
    let requestId = sessionStorage.getItem(pendingKey);

    if (!/^[a-f0-9]{32}$/.test(requestId || "")) {
        requestId = crypto.randomUUID().replaceAll("-", "");

        sessionStorage.setItem(pendingKey, requestId);
    }

    return requestId;
}


async function loadTeachers() {
    const snapshot = await getDocsFromServer(
        query(
            collection(db, "users"),
            where("role", "==", "teacher")
        )
    );

    teachers = snapshot.docs.map(item => ({
        ...item.data(),
        id: item.id
    }));

    teachers.sort((first, second) =>
        (first.name || "").localeCompare(second.name || "")
    );
}


function filterTeachers() {
    const search = document.getElementById("teacher-search");

    const queryText = search.value.trim().toLocaleLowerCase();

    let visible = 0;

    document.querySelectorAll("[data-teacher-row]").forEach(row => {
        const matches = row.dataset.search.includes(queryText);

        row.hidden = !matches;

        if (matches) {
            visible++;
        }
    });

    document.getElementById("teacher-empty-row").hidden =
        visible > 0;

    document.getElementById("teacher-visible-count").textContent =
        "Showing " + visible + " of " + teachers.length + " teachers";
}


function renderTeachers() {
    const list = document.getElementById("teacher-list");

    list.replaceChildren();

    document.getElementById("teacher-total").textContent =
        teachers.length;

    for (const teacher of teachers) {
        const row = element("tr");

        row.dataset.teacherRow = "";

        row.dataset.search = [
            teacher.name || "",
            teacher.teacher_no || "",
            teacher.email || "",
            teacher.department || ""
        ].join(" ").toLocaleLowerCase();

        const nameCell = element("td");
        const person = element("div", null, "ta-person");

        const avatar = element(
            "span",
            (teacher.name || "?").slice(0, 1).toUpperCase(),
            "ta-avatar"
        );

        avatar.setAttribute("aria-hidden", "true");

        const personCopy = element("div");

        personCopy.append(
            element("strong", teacher.name || "Teacher"),
            element("small", "Teacher account")
        );

        person.append(avatar, personCopy);
        nameCell.append(person);
        row.append(nameCell);

        row.append(
            element("td", teacher.teacher_no || "—"),
            element("td", teacher.email || "—"),
            element("td", teacher.department || "—")
        );

        const accountCell = element("td");

        const settings = element(
            "a",
            "Settings →",
            "ta-settings"
        );

        settings.href =
            "./teacher-account.html?teacher_id="
            + encodeURIComponent(teacher.id);

        accountCell.append(settings);
        row.append(accountCell);

        const statusCell = element("td");

        const status = element(
            "button",
            teacher.active === true ? "● Active" : "● Inactive",
            "ta-status " + (
                teacher.active === true
                    ? "is-active"
                    : "is-inactive"
            )
        );

        status.type = "button";
        status.disabled = busy;

        status.setAttribute(
            "aria-label",
            (teacher.active === true ? "Disable " : "Enable ")
            + (teacher.name || "teacher")
        );

        status.addEventListener("click", async () => {
            if (busy) {
                return;
            }

            const active = teacher.active !== true;

            setBusy(true);
            hideMessage("teacher-status-message");

            try {
                await api(
                    "/" + encodeURIComponent(teacher.id) + "/status",
                    { active }
                );

                teacher.active = active;

                renderTeachers();

                showMessage(
                    "teacher-status-message",
                    active
                        ? "Teacher account enabled."
                        : "Teacher account disabled.",
                    true
                );
            } catch (error) {
                showMessage(
                    "teacher-status-message",
                    errorText(error)
                );
            } finally {
                setBusy(false);
            }
        });

        statusCell.append(status);
        row.append(statusCell);
        list.append(row);
    }

    const emptyRow = element("tr");
    emptyRow.id = "teacher-empty-row";

    const emptyCell = element(
        "td",
        "No teachers found. Add a teacher or try another search.",
        "ta-empty"
    );

    emptyCell.colSpan = 6;

    emptyRow.append(emptyCell);
    list.append(emptyRow);

    filterTeachers();
}


async function renderChart() {
    const month =
        document.getElementById("attendance-month").value;

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error("Select a valid month.");
    }

    const [year, monthNumber] = month.split("-").map(Number);

    if (year < 1 || year > 9998) {
        throw new Error("Select a valid year.");
    }

    const start = month + "-01";

    const nextYear =
        monthNumber === 12 ? year + 1 : year;

    const nextMonth =
        monthNumber === 12 ? 1 : monthNumber + 1;

    const end =
        String(nextYear).padStart(4, "0")
        + "-"
        + String(nextMonth).padStart(2, "0")
        + "-01";

    const snapshot = await getDocsFromServer(
        query(
            collection(db, "teacher_work_attendance"),
            where("work_date", ">=", start),
            where("work_date", "<", end)
        )
    );

    const days = new Map();

    for (const item of snapshot.docs) {
        const record = item.data();

        if (record.check_in == null) {
            continue;
        }

        if (!days.has(record.teacher_id)) {
            days.set(record.teacher_id, new Set());
        }

        days.get(record.teacher_id).add(record.work_date);
    }

    const counts = teachers.map(teacher => ({
        name: teacher.name || "Teacher",
        count: days.get(teacher.id)?.size || 0
    }));

    counts.sort((first, second) =>
        second.count - first.count
        || first.name.localeCompare(second.name)
    );

    const maximum = Math.max(
        1,
        ...counts.map(teacher => teacher.count)
    );

    document.getElementById("month-label").textContent =
        new Intl.DateTimeFormat("en", {
            month: "long",
            year: "numeric",
            timeZone: "UTC"
        }).format(new Date(start + "T00:00:00Z"));

    const chart = document.getElementById("monthly-chart-bars");

    chart.replaceChildren();

    for (const teacher of counts) {
        const row = element("div", null, "ta-chart-row");

        row.setAttribute("role", "listitem");

        row.setAttribute(
            "aria-label",
            teacher.name + ": " + teacher.count + " check-in days"
        );

        const name = element(
            "span",
            teacher.name,
            "ta-chart-name"
        );

        const track = element("div", null, "ta-chart-track");
        const fill = element("div", null, "ta-chart-fill");

        track.setAttribute("aria-hidden", "true");

        fill.style.width =
            (teacher.count / maximum * 100) + "%";

        track.append(fill);

        const count = element(
            "strong",
            teacher.count + (
                teacher.count === 1 ? " day" : " days"
            ),
            "ta-chart-count"
        );

        row.append(name, track, count);
        chart.append(row);
    }

    if (!counts.length) {
        chart.append(
            element(
                "p",
                "No teacher accounts found.",
                "ta-empty"
            )
        );
    }
}


async function refreshChart() {
    hideMessage("chart-message");

    try {
        await renderChart();
    } catch (error) {
        document.getElementById(
            "monthly-chart-bars"
        ).replaceChildren();

        showMessage(
            "chart-message",
            "Attendance could not be loaded. " + errorText(error)
        );
    }
}


function connectCreateForm() {
    const form = document.getElementById("create-teacher");

    form.addEventListener("submit", async event => {
        event.preventDefault();

        if (busy || !adminUid) {
            return;
        }

        const data = formValues(form);

        data.email = data.email.toLowerCase();

        try {
            validateProfile(data);
            validatePassword(data);
        } catch (error) {
            showMessage(
                "teacher-create-message",
                errorText(error)
            );

            return;
        }

        setBusy(true);
        hideMessage("teacher-create-message");

        try {
            data.request_id = creationRequestId();

            const result = await api("", data);

            sessionStorage.removeItem(pendingKey);

            form.reset();

            showMessage(
                "teacher-create-message",
                result.message || "Teacher account created.",
                true
            );

            try {
                await loadTeachers();
                renderTeachers();
                await refreshChart();
            } catch (error) {
                showMessage(
                    "teacher-status-message",
                    "The account was saved, but the list could not refresh. "
                    + "Reload the page. "
                    + errorText(error)
                );
            }
        } catch (error) {
            showMessage(
                "teacher-create-message",
                errorText(error)
                + " If the connection was interrupted, retry using "
                + "the same form values."
            );
        } finally {
            setBusy(false);
        }
    });
}


async function teachersPage() {
    await loadTeachers();

    renderTeachers();

    document.getElementById("teacher-search").addEventListener(
        "input",
        filterTeachers
    );

    connectCreateForm();

    document.getElementById("attendance-month").value =
        today().slice(0, 7);

    document.getElementById(
        "monthly-chart-filter"
    ).addEventListener("submit", async event => {
        event.preventDefault();

        if (busy) {
            return;
        }

        setBusy(true);

        try {
            await refreshChart();
        } finally {
            setBusy(false);
        }
    });

    await refreshChart();
}


async function accountPage() {
    const teacherId = new URLSearchParams(
        location.search
    ).get("teacher_id");

    if (!teacherId || teacherId.includes("/")) {
        throw new Error(
            "Open a teacher's Settings from Teacher Details."
        );
    }

    const snapshot = await getDocFromServer(
        doc(db, "users", teacherId)
    );

    if (
        !snapshot.exists()
        || snapshot.data().role !== "teacher"
    ) {
        throw new Error("Teacher account was not found.");
    }

    const teacher = snapshot.data();

    const nameHeading = document.getElementById(
        "selected-teacher-name"
    );

    nameHeading.textContent = teacher.name || "Teacher account";

    const form = document.getElementById(
        "teacher-account-form"
    );

    for (const key of [
        "teacher_no",
        "name",
        "email",
        "department",
        "designation",
        "phone"
    ]) {
        form.elements.namedItem(key).value =
            teacher[key] || "";
    }

    form.elements.namedItem("active").value =
        teacher.active === true ? "1" : "0";

    form.addEventListener("submit", async event => {
        event.preventDefault();

        if (busy) {
            return;
        }

        const data = formValues(form);

        data.email = data.email.toLowerCase();

        try {
            validateProfile(data);
        } catch (error) {
            showMessage(
                "teacher-account-message",
                errorText(error)
            );

            return;
        }

        data.active = data.active === "1";

        setBusy(true);
        hideMessage("teacher-account-message");

        try {
            const result = await api(
                "/" + encodeURIComponent(teacherId) + "/account",
                data
            );

            nameHeading.textContent = data.name;

            showMessage(
                "teacher-account-message",
                result.message || "Teacher account updated.",
                true
            );
        } catch (error) {
            showMessage(
                "teacher-account-message",
                errorText(error)
            );
        } finally {
            setBusy(false);
        }
    });

    const passwordForm = document.getElementById(
        "teacher-password-form"
    );

    passwordForm.addEventListener("submit", async event => {
        event.preventDefault();

        if (busy) {
            return;
        }

        const data = formValues(passwordForm);

        try {
            validatePassword(data);
        } catch (error) {
            showMessage(
                "teacher-password-message",
                errorText(error)
            );

            return;
        }

        setBusy(true);
        hideMessage("teacher-password-message");

        try {
            const result = await api(
                "/" + encodeURIComponent(teacherId) + "/password",
                data
            );

            passwordForm.reset();

            showMessage(
                "teacher-password-message",
                result.message || "Teacher password reset.",
                true
            );
        } catch (error) {
            showMessage(
                "teacher-password-message",
                errorText(error)
            );
        } finally {
            setBusy(false);
        }
    });
}


document.getElementById(
    "admin-logout"
).addEventListener("submit", async event => {
    event.preventDefault();

    if (busy) {
        return;
    }

    try {
        await signOut(auth);

        location.replace("../login.html?role=admin");
    } catch (error) {
        showMessage("module-loading", errorText(error));
    }
});


onAuthStateChanged(auth, async user => {
    const version = ++authVersion;

    adminUid = null;
    content.hidden = true;

    loading.hidden = false;
    loading.textContent = "Checking administrator account…";

    if (!user) {
        location.replace("../login.html?role=admin");
        return;
    }

    try {
        const snapshot = await getDocFromServer(
            doc(db, "users", user.uid)
        );

        if (version !== authVersion) {
            return;
        }

        if (
            !snapshot.exists()
            || snapshot.data().role !== "admin"
            || snapshot.data().active !== true
        ) {
            throw new Error(
                "An active administrator account is required."
            );
        }

        adminUid = user.uid;

        document.querySelectorAll(
            "[data-admin-name]"
        ).forEach(target => {
            target.textContent =
                snapshot.data().name || "Administrator";
        });

        if (!initialized) {
            if (page === "teachers.html") {
                await teachersPage();
            } else if (page === "teacher-account.html") {
                await accountPage();
            } else {
                throw new Error("Unknown teacher management page.");
            }

            initialized = true;
        }

        if (version !== authVersion) {
            return;
        }

        loading.hidden = true;
        content.hidden = false;
    } catch (error) {
        if (version === authVersion) {
            showMessage(
                "module-loading",
                errorText(error)
            );
        }
    }
});