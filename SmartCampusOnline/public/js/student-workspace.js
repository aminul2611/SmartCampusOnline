import {
  auth
} from "./firebase-config.js";

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const $ = id => document.getElementById(id);

const h = value =>
  String(value ?? "").replace(
    /[&<>"']/g,
    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]
  );

const titles = {
  dashboard: "Dashboard",
  classes: "My Classes",
  tasks: "Tasks",
  attendance: "My Attendance",
  results: "My Results",
  notices: "My Notices",
  profile: "My Profile"
};

const descriptions = {
  dashboard:
    "Your classes, progress and campus updates.",

  classes:
    "Classes and routines assigned by your admin.",

  tasks:
    "Keep track of your assigned work.",

  attendance:
    "Attendance recorded by your teachers.",

  results:
    "Your assessment, midterm and final marks.",

  notices:
    "Updates sent directly to your account.",

  profile:
    "Manage your personal details and password."
};

const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

let state = null;
let busy = false;
let version = 0;
let semester = "";

function message(text, error = false) {
  $("student-message").textContent = text;

  $("student-message").className =
    "flash " + (error ? "danger" : "success");

  $("student-message").hidden = !text;
}

function lock(value) {
  busy = value;

  document.querySelectorAll("button")
    .forEach(button => {
      button.disabled = value;
    });
}

async function api(path, body) {
  const user = auth.currentUser;

  if (!user) {
    throw Error("Please sign in again.");
  }

  let tokenTimer;

  const token = await Promise.race([
    user.getIdToken(),

    new Promise((resolve, reject) => {
      tokenTimer = setTimeout(() => {
        reject(
          Error(
            "Login check timed out. Check your connection."
          )
        );
      }, 25000);
    })
  ]).finally(() => {
    clearTimeout(tokenTimer);
  });

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 70000);

  try {
    const response = await fetch(
      "/api/student" + path,
      {
        method: body === undefined
          ? "GET"
          : "POST",

        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },

        ...(
          body === undefined
            ? {}
            : {
              body: JSON.stringify(body)
            }
        ),

        signal: controller.signal
      }
    );

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      throw Error(
        "Student API unavailable. Restart the updated Node server."
      );
    }

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw Error(
        result.message || "Request failed."
      );
    }

    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw Error(
        "Connection timed out. Refresh your saved information and retry."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  const result = await api("/data");

  if (
    auth.currentUser?.uid !==
    result.profile.id
  ) {
    throw Error(
      "The signed-in account changed. Please reload."
    );
  }

  state = result;
}

function when(value) {
  const seconds =
    value?.seconds ??
    value?._seconds;

  const date = seconds != null
    ? new Date(seconds * 1000)
    : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "Date unavailable";
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function empty(icon, title, description) {
  return `
    <div class="sp-empty">
      <span>${icon}</span>
      <h3>${title}</h3>
      <p>${description}</p>
    </div>
  `;
}

function table(head, rows) {
  return `
    <div class="sp-table-wrap">
      <table>
        <thead>
          <tr>
            ${head.map(
              label => `<th>${label}</th>`
            ).join("")}
          </tr>
        </thead>

        <tbody>
          ${
            rows.join("") ||
            `
              <tr>
                <td colspan="${head.length}">
                  No records yet.
                </td>
              </tr>
            `
          }
        </tbody>
      </table>
    </div>
  `;
}

function notices(list) {
  return list.map(notice => `
    <details class="sp-notice">

      <summary>
        ${h(notice.title)}
      </summary>

      <small>
        ${h(notice.author_name || "Campus")}
        ·
        ${h(notice.author_role || "")}
        ·
        ${h(when(notice.created_at))}
      </small>

      <div class="sp-notice-body">
        ${h(notice.body)}
      </div>

    </details>
  `).join("") || empty(
    "▧",
    "Your inbox is clear",
    "Notices addressed to you will appear here."
  );
}

function stats(items) {
  return `
    <div class="sp-stats">
      ${items.map(
        ([label, value, icon, color]) => `
          <article class="sp-stat">

            ${
              icon
                ? `
                  <span class="sp-icon ${color}">
                    ${icon}
                  </span>
                `
                : ""
            }

            <div>
              <small>${label}</small>
              <strong>${h(value)}</strong>
            </div>

          </article>
        `
      ).join("")}
    </div>
  `;
}

function dashboard() {
  return `
    ${stats([
      [
        "Assigned classes",
        state.classes.length,
        "▤",
        "green"
      ],
      [
        "Attendance",
        state.percentage + "%",
        "◷",
        "blue"
      ],
      [
        "Pending tasks",
        state.tasks.length - state.completed,
        "✓",
        "purple"
      ],
      [
        "My notices",
        state.notices.length,
        "▧",
        "orange"
      ]
    ])}

    <div class="sp-two-columns">

      <section class="sp-card">

        <div class="sp-card-title">
          <h2>Today's classes</h2>

          <span class="sp-badge">
            ${state.daily.length}
          </span>
        </div>

        ${
          state.daily.map(lesson => `
            <article class="sp-session">

              <div>
                <span class="sp-code">
                  ${h(lesson.code)}
                </span>

                <h3>${h(lesson.name)}</h3>

                <p>
                  ${h(lesson.topic || "Class session")}
                  ·
                  ${h(lesson.room || "Room not set")}
                </p>
              </div>

              <span class="sp-time">
                ${h(lesson.start_time)}–${h(lesson.end_time)}
              </span>

            </article>
          `).join("") || empty(
            "◷",
            "No classes scheduled today",
            "Your scheduled sessions will appear here."
          )
        }

      </section>

      <section class="sp-card">

        <div class="sp-card-title">
          <h2>Latest notices</h2>
          <a href="#notices">View all →</a>
        </div>

        ${notices(state.notices.slice(0, 3))}

      </section>

    </div>

    <section class="sp-card">

      <div class="sp-card-title">
        <h2>My classes</h2>
        <a href="#classes">View all →</a>
      </div>

      <div class="sp-class-grid">

        ${
          state.classes.slice(0, 3)
            .map(classroom => `
              <article class="sp-class">

                <span class="sp-code">
                  ${h(classroom.code)}
                </span>

                <h3>${h(classroom.name)}</h3>

                <p>${h(classroom.semester)}</p>

                <small>
                  ${h(classroom.teacher_name)}
                </small>

              </article>
            `).join("") || empty(
              "▤",
              "No classes assigned",
              "Your admin will assign your classes."
            )
        }

      </div>

    </section>
  `;
}

function semesterFilter() {
  const semesters = [
    ...new Set(
      state.classes.map(
        classroom => classroom.semester
      )
    )
  ].sort();

  return `
    <form
      class="sp-filter"
      data-kind="semester"
    >

      <label for="sp-semester">
        Semester
      </label>

      <select
        id="sp-semester"
        name="semester"
      >
        <option value="">
          All semesters
        </option>

        ${semesters.map(item => `
          <option
            value="${h(item)}"
            ${semester === item ? "selected" : ""}
          >
            ${h(item)}
          </option>
        `).join("")}

      </select>

      <button
        class="sp-button"
        type="submit"
      >
        Apply
      </button>

    </form>
  `;
}

function classesPage() {
  const visible = state.classes.filter(
    classroom =>
      !semester ||
      classroom.semester === semester
  );

  return semesterFilter() + `
    <div class="sp-class-grid">

      ${
        visible.map(classroom => `
          <article class="sp-card sp-course">

            <div class="sp-card-title">

              <span class="sp-icon green">
                ▤
              </span>

              <span class="sp-badge">
                ${h(classroom.semester)}
              </span>

            </div>

            <span class="sp-code">
              ${h(classroom.code)}
            </span>

            <h2>${h(classroom.name)}</h2>

            <div class="sp-course-teacher">

              <small>TEACHER</small>

              <strong>
                ${h(classroom.teacher_name)}
              </strong>

            </div>

            <div class="sp-routine">

              <small>WEEKLY ROUTINE</small>

              ${
                classroom.weekly_slots
                  .map(slot => `
                    <p>
                      ◷ ${h(days[slot.day])}
                      ${h(slot.start)}–${h(slot.end)}
                      ${h(slot.room)}
                    </p>
                  `).join("") ||
                "<p>Weekly time not set.</p>"
              }

            </div>

            ${
              classroom.active
                ? ""
                : `
                  <p class="sp-note">
                    Closed for new assignments.
                    Your existing class record is retained.
                  </p>
                `
            }

          </article>
        `).join("") || `
          <section class="sp-card">
            ${empty(
              "▤",
              "No classes found",
              "Select another semester or contact your admin."
            )}
          </section>
        `
      }

    </div>
  `;
}

function resultsPage() {
  const keys = [
    "assessment",
    "mid",
    "final"
  ];

  const visible = state.classes.filter(
    classroom =>
      !semester ||
      classroom.semester === semester
  );

  return semesterFilter() + `
    <section class="sp-card">

      <div class="sp-card-title">

        <h2>Semester results</h2>

        <span class="sp-badge">
          ${visible.length} subjects
        </span>

      </div>

      ${table(
        [
          "Subject",
          "Semester",
          "Assessment",
          "Midterm",
          "Final",
          "Total"
        ],

        visible.map(classroom => `
          <tr>

            <td>
              <strong>
                ${h(classroom.name)}
              </strong>

              <small>
                ${h(classroom.code)}
              </small>
            </td>

            <td>
              ${h(classroom.semester)}
            </td>

            ${keys.map(name => `
              <td>
                ${h(classroom[name] ?? "—")}
                /
                ${h(classroom[name + "_max"])}
              </td>
            `).join("")}

            <td>
              ${
                keys.every(
                  name => classroom[name] != null
                )
                  ? `
                    <strong class="sp-result">
                      ${
                        Math.round(
                          keys.reduce(
                            (sum, name) =>
                              sum + Number(classroom[name]),
                            0
                          ) * 100
                        ) / 100
                      }
                      /
                      ${
                        keys.reduce(
                          (sum, name) =>
                            sum +
                            Number(classroom[name + "_max"]),
                          0
                        )
                      }
                    </strong>
                  `
                  : `
                    <span class="sp-badge">
                      Pending
                    </span>
                  `
              }
            </td>

          </tr>
        `)
      )}

      <p class="sp-note">
        Marks appear when your teacher saves them.
        Total appears after all three marks are entered.
      </p>

    </section>
  `;
}

function attendancePage() {
  return stats(
    [
      "Present",
      "Absent",
      "Late",
      "Excused"
    ].map(label => [
      label,
      state.counts[label]
    ])
  ) + `
    <section class="sp-card">

      <div class="sp-card-title">
        <div>
          <h2>Class attendance</h2>

          <p>
            Present + Late:
            ${h(state.percentage)}%
          </p>
        </div>
      </div>

      ${table(
        [
          "Date",
          "Subject",
          "Time",
          "Status"
        ],

        state.attendance.map(item => `
          <tr>

            <td>
              ${h(item.lesson_date)}
            </td>

            <td>
              <strong>${h(item.name)}</strong>
              <small>${h(item.code)}</small>
            </td>

            <td>
              ${h(item.start_time)}–${h(item.end_time)}
            </td>

            <td>
              <span
                class="sp-status ${
                  h(
                    (item.status || "unmarked")
                      .toLowerCase()
                  )
                }"
              >
                ${h(item.status || "Not marked")}
              </span>
            </td>

          </tr>
        `)
      )}

      <p class="sp-note">
        Includes sessions on or after your joining date,
        up to today.
        Not marked is separate from Absent.
      </p>

    </section>
  `;
}

function tasksPage() {
  return `
    <section class="sp-card">

      <div class="sp-card-title">

        <h2>Assigned tasks</h2>

        <span class="sp-badge">
          ${state.completed}
          /
          ${state.tasks.length}
          completed
        </span>

      </div>

      ${
        state.tasks.map(task => `
          <article class="sp-task">

            <div class="sp-task-copy">

              <h3>${h(task.title)}</h3>

              ${
                task.description
                  ? `
                    <p class="sp-task-description">
                      ${h(task.description)}
                    </p>
                  `
                  : ""
              }

              <small>
                Due:
                ${h(task.due_date || "No deadline")}
                ·
                ${h(task.priority)} priority
              </small>

            </div>

            <form
              class="sp-task-form"
              data-kind="task"
              data-id="${h(task.id)}"
            >

              <select
                name="status"
                aria-label="Status for ${h(task.title)}"
              >

                ${
                  [
                    "Pending",
                    "In Progress",
                    "Completed"
                  ].map(status => `
                    <option
                      ${status === task.status ? "selected" : ""}
                    >
                      ${status}
                    </option>
                  `).join("")
                }

              </select>

              <button
                class="sp-button"
                type="submit"
              >
                Save
              </button>

            </form>

          </article>
        `).join("") || empty(
          "✓",
          "No tasks assigned",
          "Your assigned work will appear here."
        )
      }

    </section>
  `;
}

function noticesPage() {
  return `
    <section class="sp-card">

      <div class="sp-card-title">

        <h2>My inbox</h2>

        <span class="sp-badge">
          ${state.notices.length} notices
        </span>

      </div>

      ${notices(state.notices)}

    </section>
  `;
}

function field(
  label,
  name,
  value = "",
  extra = ""
) {
  return `
    <label>
      ${label}

      <input
        name="${name}"
        value="${h(value)}"
        ${extra}
      >
    </label>
  `;
}

function profilePage() {
  const student = state.profile;

  return `
    <div class="sp-two-columns">

      <form
        class="sp-card sp-profile-form"
        data-kind="profile"
      >

        <div class="sp-card-title">

          <h2>Personal information</h2>

          <span class="sp-icon green">
            ◎
          </span>

        </div>

        ${field(
          "Full name",
          "name",
          student.name,
          'maxlength="100" autocomplete="name" required'
        )}

        ${field(
          "Student ID",
          "student_no",
          student.student_no,
          "readonly"
        )}

        ${field(
          "Email address",
          "email",
          student.email,
          'type="email" readonly'
        )}

        ${field(
          "Department",
          "department",
          student.department,
          "readonly"
        )}

        ${field(
          "Phone",
          "phone",
          student.phone,
          'type="tel" maxlength="150" autocomplete="tel"'
        )}

        <p class="sp-note">
          Contact your admin to change your ID,
          email or department.
        </p>

        <button
          class="sp-button"
          type="submit"
        >
          Save profile →
        </button>

      </form>

      <form
        class="sp-card sp-profile-form"
        data-kind="password"
      >

        <div class="sp-card-title">

          <h2>Change password</h2>

          <span class="sp-icon purple">
            ⚿
          </span>

        </div>

        ${field(
          "Current password",
          "current_password",
          "",
          'type="password" autocomplete="current-password" required'
        )}

        ${field(
          "New password",
          "new_password",
          "",
          'type="password" minlength="8" maxlength="128" autocomplete="new-password" required'
        )}

        ${field(
          "Confirm new password",
          "confirm_password",
          "",
          'type="password" minlength="8" maxlength="128" autocomplete="new-password" required'
        )}

        <p class="sp-note">
          After changing your password,
          sign in again with the new password.
        </p>

        <button
          class="sp-button"
          type="submit"
        >
          Change password →
        </button>

      </form>

    </div>
  `;
}

function render() {
  if (!state) {
    return;
  }

  const name = location.hash.slice(1);

  const page = Object.hasOwn(titles, name)
    ? name
    : "dashboard";

  state.completed = state.tasks.filter(
    task => task.status === "Completed"
  ).length;

  const student = state.profile;

  $("page-title").textContent = titles[page];
  $("today").textContent = state.today;

  document.querySelectorAll("[data-student-name]")
    .forEach(element => {
      element.textContent = student.name;
    });

  document.querySelectorAll("[data-initial]")
    .forEach(element => {
      element.textContent = (
        student.name || "S"
      ).slice(0, 1).toUpperCase();
    });

  document.querySelectorAll(".campus-nav a")
    .forEach(link => {
      const active = link.hash === "#" + page;

      link.classList.toggle("selected", active);

      if (active) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });

  const pages = {
    dashboard,
    classes: classesPage,
    tasks: tasksPage,
    attendance: attendancePage,
    results: resultsPage,
    notices: noticesPage,
    profile: profilePage
  };

  $("student-content").innerHTML = `
    <div class="sp-page">

      <header class="sp-heading">

        <div>

          <span class="sp-eyebrow">
            STUDENT WORKSPACE
          </span>

          <h1>
            ${
              page === "dashboard"
                ? "Welcome, " + h(student.name) + "!"
                : titles[page]
            }
          </h1>

          <p>
            ${descriptions[page]}
          </p>

        </div>

        <span class="sp-id">
          ID:
          ${h(student.student_no || "Not assigned")}
        </span>

      </header>

      ${pages[page]()}

    </div>
  `;

  $("student-content").hidden = false;

  if (busy) {
    lock(true);
  }
}

function friendly(error) {
  const messages = {
    "auth/invalid-credential":
      "Current password is incorrect.",

    "auth/wrong-password":
      "Current password is incorrect.",

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

$("student-content").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const form = event.target;

    const data = Object.fromEntries(
      new FormData(form)
    );

    const kind = form.dataset.kind;

    if (kind === "semester") {
      semester = data.semester;
      render();
      return;
    }

    if (kind === "password") {
      if (
        data.new_password.length < 8 ||
        data.new_password.length > 128 ||
        data.new_password !== data.confirm_password
      ) {
        message(
          "Use matching new passwords of 8–128 characters.",
          true
        );

        return;
      }

      lock(true);
      message("Checking current password…");

      let changed = false;

      try {
        await api("/profile");

        const user = auth.currentUser;

        await reauthenticateWithCredential(
          user,
          EmailAuthProvider.credential(
            user.email,
            data.current_password
          )
        );

        await updatePassword(
          user,
          data.new_password
        );

        changed = true;

        form.reset();

        await signOut(auth);

        location.replace(
          "/login.html?role=student"
        );
      } catch (error) {
        message(
          changed
            ? "Password changed successfully. Log out, then sign in with your new password."
            : friendly(error),
          !changed
        );
      } finally {
        lock(false);
      }

      return;
    }

    lock(true);
    message("Saving…");

    try {
      if (kind === "profile") {
        const result = await api("/profile", {
          name: data.name.trim(),
          phone: data.phone.trim()
        });

        state.profile = result.profile;

        render();
        message(result.message);
      }

      if (kind === "task") {
        const result = await api(
          "/tasks/" +
          encodeURIComponent(form.dataset.id) +
          "/status",
          {
            status: data.status
          }
        );

        state.tasks.find(
          task => task.id === form.dataset.id
        ).status = result.status;

        render();
        message(result.message);
      }
    } catch (error) {
      message(friendly(error), true);
    } finally {
      lock(false);
    }
  }
);

$("student-refresh").addEventListener(
  "click",
  async () => {
    if (busy) {
      return;
    }

    lock(true);

    try {
      await refresh();
      render();
      message("Workspace refreshed.");
    } catch (error) {
      message(friendly(error), true);
    } finally {
      lock(false);
    }
  }
);

$("student-logout").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy) {
      return;
    }

    lock(true);

    try {
      await signOut(auth);

      location.replace(
        "/login.html?role=student"
      );
    } catch (error) {
      message(friendly(error), true);
    } finally {
      lock(false);
    }
  }
);

$("student-retry").addEventListener(
  "click",
  () => location.reload()
);

window.addEventListener(
  "hashchange",
  () => {
    if (!busy) {
      render();
    }
  }
);

onAuthStateChanged(auth, async user => {
  const current = ++version;

  state = null;

  $("student-content").hidden = true;
  $("student-retry").hidden = true;

  if (!user) {
    location.replace(
      "/login.html?role=student"
    );

    return;
  }

  lock(true);

  message(
    "Checking Student account and loading data…"
  );

  try {
    await refresh();

    if (current !== version) {
      return;
    }

    render();
    message("");
  } catch (error) {
    if (current === version) {
      message(friendly(error), true);
      $("student-retry").hidden = false;
    }
  } finally {
    if (current === version) {
      lock(false);
    }
  }
});