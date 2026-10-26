import { auth } from "./firebase-config.js";

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const $ = id => document.getElementById(id);

const h = value => String(value ?? "").replace(
  /[&<>"']/g,
  c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c])
);

const days = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
];

const labels = {
  dashboard: "Dashboard",
  students: "Student Details",
  attendance: "Student Attendance",
  marks: "Student Marks",
  notices: "Notices",
  "my-attendance": "My Attendance",
  profile: "Teacher Profile"
};

const attendanceDrafts = new Map();
const marksDrafts = new Map();

let state = null;
let profile = null;
let busy = false;
let version = 0;
let refreshNeeded = false;

let page = "dashboard";
let cid = "";
let lid = "";
let selectedDate = "";
let attendanceView = "take";
let activeUid = "";

/* Requests */

function show(message, error = false) {
  $("status").textContent = message;
  $("status").className = "flash " + (error ? "danger" : "success");
  $("status").hidden = !message;
}

function lock(value) {
  busy = value;

  document.querySelectorAll("button").forEach(button => {
    button.disabled = value || button.hasAttribute("data-locked");
  });

  $("content").setAttribute("aria-busy", String(value));
}

function timeout(promise, milliseconds = 25000) {
  let timer;

  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Connection timed out. Please try again.")),
        milliseconds
      );
    })
  ]).finally(() => clearTimeout(timer));
}

async function request(path = "", body, root = false) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please sign in again.");
  }

  const token = await timeout(user.getIdToken());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);

  try {
    const response = await fetch(
      "/api/teacher/profile" + (root ? "" : "/workspace") + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      }
    );

    if (
      !(response.headers.get("content-type") || "")
        .includes("application/json")
    ) {
      throw new Error("The Teacher API is unavailable. Please try again.");
    }

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.message || "Request failed.");
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "The request timed out. Refresh saved information before retrying."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  const [data, account] = await Promise.all([
    request("/data"),
    request("", undefined, true)
  ]);

  if (auth.currentUser?.uid !== account.profile.id) {
    throw new Error("The account changed. Please reload.");
  }

  state = data;
  profile = account.profile;
  selectedDate ||= state.today;
  refreshNeeded = false;
}

async function save(path, body, after = () => {}, root = false) {
  if (busy) return;

  if (refreshNeeded) {
    show(
      "Your previous change was saved. Refresh before making another change.",
      true
    );
    return;
  }

  lock(true);
  show("Saving…");

  try {
    const data = await request(path, body, root);

    refreshNeeded = true;
    after(data);

    if (/^\/classes\/[^/]+\/attendance$/.test(path)) {
      const lesson = state.lessons.find(
        item => item.id === body.lesson_id
      );

      const record = {
        class_id: lesson.class_id,
        lesson_id: body.lesson_id,
        student_id: body.student_id,
        status: body.status,
        session_date: lesson.lesson_date
      };

      const index = state.attendance.findIndex(item =>
        item.lesson_id === body.lesson_id &&
        item.student_id === body.student_id
      );

      if (index < 0) {
        state.attendance.push(record);
      } else {
        state.attendance[index] = {
          ...state.attendance[index],
          ...record
        };
      }

      attendanceDrafts.delete(
        JSON.stringify([body.lesson_id, body.student_id])
      );

      refreshNeeded = false;
    } else {
      await refresh();
    }

    render();
    show(data.message || "Saved successfully.");
  } catch (error) {
    show(
      (
        refreshNeeded
          ? "Saved, but the list could not refresh. Use Refresh. "
          : ""
      ) + error.message,
      true
    );
  } finally {
    lock(false);
  }
}

function reqid(type) {
  const key = "smart-campus.teacher." + activeUid + "." + type;
  let value = sessionStorage.getItem(key);

  if (!/^[a-f0-9]{32}$/.test(value || "")) {
    value = crypto.randomUUID().replaceAll("-", "");
    sessionStorage.setItem(key, value);
  }

  return value;
}

function clearid(type) {
  sessionStorage.removeItem(
    "smart-campus.teacher." + activeUid + "." + type
  );
}

/* Shared helpers */

function attendanceBadge(status, count) {
  const tones = {
    Present: "present",
    Attended: "present",
    Late: "late",
    Absent: "absent",
    Excused: "excused",
    "Not marked": "unmarked"
  };

  return `<span class="status ${tones[status] || "neutral"}">${
    count === undefined ? "" : h(count) + " "
  }${h(status)}</span>`;
}

function attendanceBadges(counts) {
  return `<span class="attendance-badges" role="group" aria-label="Saved attendance counts">${
    ["Present", "Late", "Absent", "Excused", "Not marked"]
      .map(status => attendanceBadge(status, counts[status] ?? 0))
      .join("")
  }</span>`;
}

function attendedBreakdown(counts) {
  return attendanceBadge("Attended", counts.Present + counts.Late) +
    `<span class="attendance-breakdown">${
      attendanceBadge("Present", counts.Present)
    }${attendanceBadge("Late", counts.Late)}</span>`;
}

const selected = () => state.classes.find(item => item.id === cid);

function roster() {
  const ids = new Set(
    state.enrolments
      .filter(item => item.class_id === cid && item.active !== false)
      .map(item => item.student_id)
  );

  return state.students
    .filter(item => ids.has(item.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function url(name, classId = "", lesson = "", date = "", view = "") {
  if (name === "classes") {
    name = "attendance";
    view = "sessions";
  }

  const query = new URLSearchParams();

  if (classId) query.set("class", classId);
  if (lesson) query.set("lesson", lesson);
  if (date) query.set("date", date);
  if (view) query.set("view", view);

  return "#" + name + (query.size ? "?" + query : "");
}

function find(values) {
  return h(values.join(" ").normalize("NFKC").toLowerCase());
}

function input(label, name, value = "", type = "text", extra = "") {
  return `
    <label>
      ${label}
      <input
        name="${name}"
        type="${type}"
        value="${h(value)}"
        ${extra}
      >
    </label>
  `;
}

function table(headings, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            ${headings.map(label =>
              `<th scope="col">${h(label)}</th>`
            ).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.join("") || `
            <tr>
              <td colspan="${headings.length}" class="empty-state">
                No records to display.
              </td>
            </tr>
          `}
        </tbody>
      </table>
    </div>
  `;
}

function heading(prefix, title, description) {
  return `
    <header class="page-intro ${prefix}-heading">
      <div>
        <span class="eyebrow">TEACHER WORKSPACE</span>
        <h1>${title}</h1>
        <p>${description}</p>
      </div>
    </header>
  `;
}

function picker(prefix) {
  return `
    <section class="panel classroom-selector ${prefix}-class-panel">
      <div>
        <h2>Your classroom</h2>
        <p>
          ${
            selected()
              ? h(selected().semester || "Assigned class")
              : "Choose an assigned class to continue."
          }
        </p>
      </div>

      <label>
        <span class="sr-only">Select class</span>

        <select data-class aria-label="Select class">
          <option value="" ${cid ? "" : "selected"}>
            Select a class
          </option>

          ${state.classes.map(item => `
            <option
              value="${h(item.id)}"
              ${item.id === cid ? "selected" : ""}
            >
              ${h(item.code + " — " + item.name)}
            </option>
          `).join("")}
        </select>
      </label>
    </section>
  `;
}

function stamp(value) {
  if (value == null) return null;

  const seconds = value.seconds ?? value._seconds;

  const parsed = new Date(
    seconds != null
      ? seconds * 1000
      : typeof value === "number"
        ? value * 1000
        : value
  );

  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function time(value) {
  const date = stamp(value);

  return date
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(date)
    : "—";
}

function duration(record) {
  if (!record?.check_in) return "—";
  if (!record.check_out) return "In progress";

  const minutes = Math.max(
    0,
    Math.floor(
      (stamp(record.check_out) - stamp(record.check_in)) / 60000
    )
  );

  return Math.floor(minutes / 60) + "h " + minutes % 60 + "m";
}

/* Student details */

function studentsPage() {
  return `
    <div>
      ${heading(
        "ts",
        "Student Details",
        "View the students enrolled in your assigned classes."
      )}

      ${picker("ts")}

      ${selected() ? `
        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Enrolled students</h2>
              <p>${h(selected().name)}</p>
            </div>
            <span class="badge">${roster().length} students</span>
          </div>

          ${table(
            [
              "Student",
              "Student ID",
              "Email",
              "Department / semester",
              "Account"
            ],
            roster().map(item => `
              <tr data-search="${find([
                item.name,
                item.student_no,
                item.email,
                item.department,
                item.semester
              ])}">
                <td><strong>${h(item.name)}</strong></td>
                <td>${h(item.student_no || "—")}</td>
                <td>${h(item.email || "—")}</td>
                <td>
                  ${h(item.department || "—")}
                  <small>${h(item.semester)}</small>
                </td>
                <td>
                  <span class="status ${item.active ? "present" : "absent"}">
                    ${item.active ? "Active" : "Disabled"}
                  </span>
                </td>
              </tr>
            `)
          )}
        </section>
      ` : `
        <section class="panel empty-state">
          Select a classroom to view its students.
        </section>
      `}
    </div>
  `;
}

/* Marks */

function marksPage() {
  const classroom = selected();
  const keys = ["assessment", "mid", "final"];

  return `
    <div>
      ${heading(
        "tm",
        "Student Marks",
        "Enter assessment, midterm and final marks."
      )}

      ${picker("tm")}

      ${classroom ? `
        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Marks register</h2>
              <p>
                Leave ungraded marks blank.
                Each row is saved separately.
              </p>
            </div>
          </div>

          <div class="badge-row">
            ${keys.map(key => `
              <span class="badge">
                ${key}: ${h(classroom.limits[key])}
              </span>
            `).join("")}

            <span class="badge">
              Total:
              ${keys.reduce(
                (sum, key) => sum + Number(classroom.limits[key]),
                0
              )}
            </span>
          </div>

          ${roster().map(item => `
            <form
              id="mark-${h(item.id)}"
              data-kind="marks"
              data-student="${h(item.id)}"
            ></form>
          `).join("")}

          ${table(
            [
              "Student",
              "Assessment",
              "Midterm",
              "Final",
              "Saved total",
              "Action"
            ],
            roster().map(student => {
              const saved = state.marks.find(item =>
                item.class_id === cid &&
                item.student_id === student.id
              ) || {};

              const draft = marksDrafts.get(
                JSON.stringify([cid, student.id])
              ) || saved;

              const total = keys.every(key => saved[key] != null)
                ? Math.round(
                    keys.reduce(
                      (sum, key) => sum + Number(saved[key]),
                      0
                    ) * 100
                  ) / 100
                : "Incomplete";

              return `
                <tr data-search="${find([
                  student.name,
                  student.student_no
                ])}">
                  <td>
                    <strong>${h(student.name)}</strong>
                    <small>${h(student.student_no)}</small>
                  </td>

                  ${keys.map(key => `
                    <td>
                      <input
                        class="score-input"
                        name="${key}"
                        type="number"
                        min="0"
                        max="${h(classroom.limits[key])}"
                        step="any"
                        value="${h(draft[key] ?? "")}"
                        placeholder="—"
                        form="mark-${h(student.id)}"
                        aria-label="${key} for ${h(student.name)}"
                        ${student.active ? "" : "disabled"}
                      >
                    </td>
                  `).join("")}

                  <td><strong>${h(total)}</strong></td>

                  <td>
                    <button
                      type="submit"
                      form="mark-${h(student.id)}"
                      ${student.active ? "" : "disabled data-locked"}
                    >
                      Save
                    </button>
                  </td>
                </tr>
              `;
            })
          )}
        </section>
      ` : `
        <section class="panel empty-state">
          Select a classroom to enter marks.
        </section>
      `}
    </div>
  `;
}

/* Notices */

function noticeCards(items, sent = false) {
  return items.map(item => {
    const date = stamp(item.created_at);

    const when = date
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Shanghai",
          dateStyle: "medium",
          timeStyle: "short"
        }).format(date)
      : "Date unavailable";

    return `
      <details
        class="notice-card"
        data-search="${find([
          item.title,
          item.body,
          item.author_name
        ])}"
      >
        <summary>${h(item.title)}</summary>

        <small>
          ${h(sent ? "Sent notice" : item.author_name || "Campus")}
          · ${h(when)}
        </small>

        <div class="notice-body">${h(item.body)}</div>
      </details>
    `;
  }).join("") || `
    <div class="empty-state">No notices yet.</div>
  `;
}

function noticesPage() {
  return `
    <div>
      ${heading(
        "tn",
        "Notices",
        "Read campus updates and send notices to your classes."
      )}

      <div class="notice-layout">
        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Send a notice</h2>
              <p>Choose who should receive your message.</p>
            </div>
          </div>

          <form data-kind="notice">
            <label>
              Send to

              <select id="tn-audience" name="audience" required>
                <option value="">Choose recipients</option>
                <option value="admin">Admin</option>
                <option value="class">A class / section</option>
                <option value="students">Selected students</option>
              </select>
            </label>

            <div id="tn-class-field" hidden>
              <label>
                Class / section

                <select name="class_id">
                  <option value="">Select your class</option>

                  ${state.classes.map(item => `
                    <option value="${h(item.id)}">
                      ${h(item.code + " — " + item.name)}
                    </option>
                  `).join("")}
                </select>
              </label>
            </div>

            <fieldset id="tn-student-field" hidden>
              <legend>Select students</legend>

              <div class="recipient-list">
                ${state.students
                  .filter(item => item.active)
                  .map(item => `
                    <label class="checkbox-row">
                      <input
                        type="checkbox"
                        name="student_ids"
                        value="${h(item.id)}"
                      >

                      <span>
                        ${h(item.name)}
                        <small>${h(item.student_no)}</small>
                      </span>
                    </label>
                  `).join("") || `
                    <p>No eligible students.</p>
                  `}
              </div>
            </fieldset>

            <label class="checkbox-row">
              <input type="checkbox" name="also_admin">
              <span>Also send to Admin</span>
            </label>

            ${input(
              "Notice title",
              "title",
              "",
              "text",
              'required maxlength="140"'
            )}

            <label>
              Message

              <textarea
                name="body"
                maxlength="5000"
                rows="7"
                required
                placeholder="Write your notice…"
              ></textarea>
            </label>

            <div class="form-footer">
              <button type="submit">Send notice →</button>
            </div>
          </form>
        </section>

        <div>
          <section class="panel">
            <div class="section-heading">
              <h2>Received notices</h2>
              <span class="badge">${state.received.length}</span>
            </div>

            ${noticeCards(state.received)}
          </section>

          <section class="panel">
            <div class="section-heading">
              <h2>Sent notices</h2>
              <span class="badge">${state.sent.length}</span>
            </div>

            ${noticeCards(state.sent, true)}
          </section>
        </div>
      </div>
    </div>
  `;
}

/* Teacher attendance */

function myAttendance() {
  const record = state.work.find(item => item.work_date === state.today);
  const done = record?.check_out != null;

  return `
    <div>
      ${heading(
        "ma",
        "My Attendance",
        "Record your workday and review recent check-ins."
      )}

      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Today's workday</h2>
            <p>${h(state.today)}</p>
          </div>

          <span class="status ${done ? "present" : "neutral"}">
            ${done ? "Completed" : record ? "Working" : "Not checked in"}
          </span>
        </div>

        <div class="overview-grid">
          ${[
            ["Check-in", time(record?.check_in)],
            ["Check-out", time(record?.check_out)],
            ["Duration", duration(record)]
          ].map(([label, value]) => `
            <article class="metric">
              <span>${label}</span>
              <strong class="time-value">${h(value)}</strong>
            </article>
          `).join("")}
        </div>

        <div class="form-footer">
          <p>
            ${
              done
                ? "Your workday is complete."
                : record
                  ? "Check out when your workday ends."
                  : "Check in to start your workday."
            }
          </p>

          <div class="button-row">
            <button
              type="button"
              data-action="check-in"
              ${record ? "disabled data-locked" : ""}
            >
              Check in
            </button>

            <button
              type="button"
              class="secondary"
              data-action="check-out"
              ${!record || done ? "disabled data-locked" : ""}
            >
              Check out
            </button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="section-heading">
          <h2>Recent work attendance</h2>
        </div>

        ${table(
          ["Date", "Check-in", "Check-out", "Duration"],
          state.work.map(item => `
            <tr>
              <td>${h(item.work_date)}</td>
              <td>${h(time(item.check_in))}</td>
              <td>${h(time(item.check_out))}</td>
              <td>${h(duration(item))}</td>
            </tr>
          `)
        )}
      </section>
    </div>
  `;
}

/* Profile */

function profilePage() {
  return `
    <div>
      ${heading(
        "tp",
        "Teacher Profile",
        "Manage your personal information and account security."
      )}

      <section class="panel profile-banner">
        <span class="profile-avatar">
          ${h((profile.name || "T").slice(0, 1))}
        </span>

        <div>
          <span class="eyebrow">TEACHER ACCOUNT</span>
          <h2>${h(profile.name)}</h2>
          <p>${h(profile.email)}</p>
        </div>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Personal information</h2>
            <p>Your email address is managed by the administrator.</p>
          </div>
        </div>

        <form data-kind="profile">
          <div class="form-grid">
            ${input(
              "Full name", "name", profile.name,
              "text", 'required maxlength="100"'
            )}

            ${input(
              "Email address", "email", profile.email,
              "email", "readonly"
            )}

            ${input(
              "Phone number", "phone", profile.phone,
              "tel", 'maxlength="150"'
            )}

            ${input(
              "Department", "department", profile.department,
              "text", 'maxlength="150"'
            )}

            ${input(
              "Designation", "designation", profile.designation,
              "text", 'maxlength="150"'
            )}
          </div>

          <div class="form-footer">
            <button type="submit">Save profile →</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Change password</h2>
            <p>Confirm your current password to choose a new one.</p>
          </div>
        </div>

        <form data-kind="password">
          <div class="form-grid">
            ${input(
              "Current password",
              "current_password",
              "",
              "password",
              'required autocomplete="current-password"'
            )}

            ${input(
              "New password",
              "new_password",
              "",
              "password",
              'required minlength="8" maxlength="128" autocomplete="new-password"'
            )}

            ${input(
              "Confirm new password",
              "confirm_password",
              "",
              "password",
              'required minlength="8" maxlength="128" autocomplete="new-password"'
            )}
          </div>

          <div class="form-footer">
            <p>Sign in again after changing your password.</p>
            <button type="submit">Change password →</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

/* Dashboard */

function dashboard() {
  const lessons = state.lessons
    .filter(item => item.lesson_date === state.today)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  const students = new Set(
    state.enrolments
      .filter(item => item.active !== false)
      .map(item => item.student_id)
  );

  return `
    <div class="td-dashboard">
      <header class="page-intro">
        <div>
          <span class="eyebrow">YOUR TEACHING DAY</span>
          <h1>Welcome back, ${h(profile.name)}.</h1>
          <p>Your classes, students and updates in one workspace.</p>
        </div>

        <a class="button secondary" href="#my-attendance">
          My attendance →
        </a>
      </header>

      <div class="overview-grid">
        ${[
          ["Assigned classes", state.classes.length],
          ["Enrolled students", students.size],
          ["Sessions today", lessons.length]
        ].map(([label, value]) => `
          <article class="metric">
            <span>${label}</span>
            <strong>${value}</strong>
          </article>
        `).join("")}
      </div>

      <div class="dashboard-grid">
        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Today's sessions</h2>
              <p>${h(state.today)}</p>
            </div>

            <a
              class="text-link"
              href="${h(url(
                "attendance", cid, "", state.today, "sessions"
              ))}"
            >
              Manage sessions →
            </a>
          </div>

          ${lessons.map(item => `
            <a
              class="session-row"
              href="${h(url(
                "attendance",
                item.class_id,
                item.id,
                item.lesson_date
              ))}"
            >
              <span class="session-time">
                ${h(item.start_time)}
                <small>${h(item.end_time)}</small>
              </span>

              <span class="session-copy">
                <strong>
                  ${h(
                    state.classes.find(c => c.id === item.class_id)?.name ||
                    "Class session"
                  )}
                </strong>

                <small>
                  ${h(item.topic || "Class session")}
                  · ${h(item.room || "Room not set")}
                </small>
              </span>

              <span class="text-link">Attendance →</span>
            </a>
          `).join("") || `
            <div class="empty-state">
              No sessions scheduled for today.
              Open Daily Classes to schedule a session.
            </div>
          `}
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Campus updates</h2>
              <p>Latest notices</p>
            </div>

            <a class="text-link" href="#notices">View all →</a>
          </div>

          ${state.received.slice(0, 3).map(item => `
            <a class="notice-preview" href="#notices">
              <strong>${h(item.title)}</strong>

              <p>
                ${h(String(item.body || "").slice(0, 125))}
                ${String(item.body || "").length > 125 ? "…" : ""}
              </p>

              <small>${h(item.author_name || "Campus Office")}</small>
            </a>
          `).join("") || `
            <div class="empty-state">No campus updates yet.</div>
          `}
        </section>
      </div>

      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Your classrooms</h2>
            <p>Open a class to view its students.</p>
          </div>
        </div>

        <div class="class-grid">
          ${state.classes.map(item => `
            <a
              class="class-card"
              href="${h(url("students", item.id))}"
              data-search="${find([
                item.code,
                item.name,
                item.semester
              ])}"
            >
              <span class="badge">${h(item.code)}</span>
              <h3>${h(item.name)}</h3>
              <p>${h(item.semester)}</p>
              <span class="text-link">View students →</span>
            </a>
          `).join("") || `
            <div class="empty-state">No classes assigned yet.</div>
          `}
        </div>
      </section>
    </div>
  `;
}

/* Session form */

function sessionForm() {
  return `
    <form data-kind="lesson">
      <div class="form-grid">
        ${input(
          "Date", "lesson_date",
          selectedDate || state.today,
          "date", "required"
        )}

        ${input("Room", "room", "", "text", 'maxlength="100"')}
        ${input("Start time", "start_time", "", "time", "required")}
        ${input("End time", "end_time", "", "time", "required")}
        ${input("Topic", "topic", "", "text", 'maxlength="200"')}
      </div>

      <div class="form-footer">
        <p>Choose a start and end time for this class.</p>
        <button type="submit">Schedule session →</button>
      </div>
    </form>
  `;
}

/* Attendance calculations */

function attendanceReport(data, classId, now = new Date()) {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(now);

  const accounts = new Map(
    data.students.map(item => [item.id, item])
  );

  const enrolled = new Map(
    data.enrolments
      .filter(item =>
        item.class_id === classId &&
        item.active !== false
      )
      .map(item => [item.student_id, item])
  );

  const lessons = data.lessons
    .filter(item =>
      item.class_id === classId &&
      item.cancelled !== true
    )
    .sort((a, b) =>
      b.lesson_date.localeCompare(a.lesson_date) ||
      b.start_time.localeCompare(a.start_time)
    );

  const lessonIds = new Set(lessons.map(item => item.id));
  const saved = new Map();

  for (const record of data.attendance) {
    if (
      record.class_id !== classId ||
      !lessonIds.has(record.lesson_id)
    ) {
      continue;
    }

    if (!saved.has(record.lesson_id)) {
      saved.set(record.lesson_id, new Map());
    }

    saved.get(record.lesson_id).set(record.student_id, record);
  }

  const activeStudents = [...enrolled.keys()]
    .map(uid => accounts.get(uid))
    .filter(item => item?.active === true);

  function studentsOn(date) {
    return activeStudents.filter(item =>
      (enrolled.get(item.id).joined_on || "0000-01-01") <= date
    );
  }

  function forLesson(lesson) {
    const records = saved.get(lesson.id) || new Map();

    const eligible = new Set(
      studentsOn(lesson.lesson_date).map(item => item.id)
    );

    const ids = new Set([...eligible, ...records.keys()]);

    const counts = {
      Present: 0,
      Late: 0,
      Absent: 0,
      Excused: 0,
      "Not marked": 0
    };

    const students = [...ids]
      .map(uid => {
        const account = accounts.get(uid);
        const candidate = records.get(uid)?.status;

        const status = [
          "Present", "Late", "Absent", "Excused"
        ].includes(candidate)
          ? candidate
          : "Not marked";

        counts[status]++;

        return {
          ...(account || {
            name: "Previous enrolment",
            student_no: "—"
          }),
          id: uid,
          status,
          can_mark: eligible.has(uid)
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      students,
      counts,
      total: students.length
    };
  }

  function ended(lesson) {
    return (
      lesson.lesson_date < data.today ||
      (
        lesson.lesson_date === data.today &&
        lesson.end_time <= clock
      )
    );
  }

  function stage(lesson) {
    if (ended(lesson)) return "Past session";

    if (
      lesson.lesson_date === data.today &&
      lesson.start_time <= clock
    ) {
      return "In progress";
    }

    return "Upcoming";
  }

  const past = lessons.filter(ended);

  const recorded = past.filter(item => {
    const counts = forLesson(item).counts;

    return (
      counts.Present +
      counts.Late +
      counts.Absent +
      counts.Excused
    ) > 0;
  });

  const cumulative = new Map();

  for (const lesson of recorded) {
    for (const student of forLesson(lesson).students) {
      if (!cumulative.has(student.id)) {
        cumulative.set(student.id, {
          ...student,
          total: 0,
          Present: 0,
          Late: 0,
          Absent: 0,
          Excused: 0,
          "Not marked": 0
        });
      }

      const item = cumulative.get(student.id);
      item.total++;
      item[student.status]++;
    }
  }

  for (const student of activeStudents) {
    if (!cumulative.has(student.id)) {
      cumulative.set(student.id, {
        ...student,
        total: 0,
        Present: 0,
        Late: 0,
        Absent: 0,
        Excused: 0,
        "Not marked": 0
      });
    }
  }

  return {
    lessons,
    past,
    recorded,
    pending: past.length - recorded.length,
    activeStudents,
    studentsOn,
    forLesson,
    stage,
    students: [...cumulative.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

/* Daily Classes */

function sessionCards(classroom, lessons, report) {
  return lessons.map(lesson => {
    const summary = report.forLesson(lesson);
    const marked = summary.total - summary.counts["Not marked"];

    return `
      <a
        class="session-row"
        href="${h(url(
          "attendance",
          classroom.id,
          lesson.id,
          lesson.lesson_date
        ))}"
        data-search="${find([
          classroom.name,
          lesson.lesson_date,
          lesson.topic
        ])}"
      >
        <span class="date-tile">
          <strong>${h(lesson.lesson_date.slice(8))}</strong>
          <small>${h(lesson.lesson_date.slice(0, 7))}</small>
        </span>

        <span class="session-copy">
          <strong>${h(lesson.topic || classroom.name)}</strong>

          <small>
            ${h(lesson.start_time)}–${h(lesson.end_time)}
            · ${h(lesson.room || "Room not set")}
          </small>

          <span class="badge-row">
            <span class="badge">${h(report.stage(lesson))}</span>

            <span class="badge">
              ${
                marked
                  ? `${marked}/${summary.total} marked`
                  : "Attendance pending"
              }
            </span>
          </span>
        </span>

        <span class="text-link">
          ${lesson.lesson_date > state.today ? "View" : "Attendance"} →
        </span>
      </a>
    `;
  }).join("") || `
    <div class="empty-state">No sessions in this list.</div>
  `;
}

function attendanceSessions(classroom, report) {
  return `
    <div class="classroom-grid">
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Schedule a session</h2>
            <p>Create a session, then record its attendance.</p>
          </div>
        </div>

        ${sessionForm()}
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Weekly routine</h2>
            <p>${h(classroom.name)}</p>
          </div>

          <span class="badge">${h(classroom.semester)}</span>
        </div>

        <div class="routine-list">
          ${(classroom.weekly_slots || []).map(slot => `
            <div class="routine-row">
              <strong>${h(days[slot.day])}</strong>
              <span>${h(slot.start)}–${h(slot.end)}</span>
              <small>${h(slot.room || "Room not set")}</small>
            </div>
          `).join("") || `
            <div class="empty-state">No weekly routine assigned yet.</div>
          `}
        </div>
      </section>
    </div>

    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Today & upcoming</h2>
          <p>Your scheduled class sessions.</p>
        </div>
      </div>

      ${sessionCards(
        classroom,
        report.lessons
          .filter(item => item.lesson_date >= state.today)
          .sort((a, b) =>
            a.lesson_date.localeCompare(b.lesson_date) ||
            a.start_time.localeCompare(b.start_time)
          ),
        report
      )}
    </section>

    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Session history</h2>
          <p>Open a session to review saved attendance.</p>
        </div>
      </div>

      ${sessionCards(
        classroom,
        report.lessons.filter(item => item.lesson_date < state.today),
        report
      )}
    </section>
  `;
}

/* Student Reports */

function attendanceReports(classroom, report) {
  return `
    <div class="overview-grid">
      <article class="metric">
        <span>Classes with attendance</span>
        <strong>${report.recorded.length}</strong>
      </article>

      <article class="metric">
        <span>Past sessions awaiting attendance</span>
        <strong>${report.pending}</strong>
      </article>

      <article class="metric">
        <span>Currently enrolled</span>
        <strong>${report.activeStudents.length}</strong>
      </article>
    </div>

    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Student attendance totals</h2>
          <p>${h(classroom.name)} · One row per student</p>
        </div>
      </div>

      <p class="info-note">
        Totals include past classes with saved attendance,
        from each student's joining date.
        Attended = Present + Late.
        Unmarked attendance and excused leave are separate from Absent.
      </p>

      ${table(
        [
          "Student",
          "Student ID",
          "Total classes",
          "Attended",
          "Absent",
          "Excused",
          "Not marked"
        ],
        report.students.map(item => `
          <tr data-search="${find([item.name, item.student_no])}">
            <td><strong>${h(item.name)}</strong></td>
            <td>${h(item.student_no || "—")}</td>
            <td>${item.total}</td>

            <td>
              ${attendedBreakdown(item)}
            </td>

            <td>
              ${attendanceBadge("Absent", item.Absent)}
            </td>

            <td>${attendanceBadge("Excused", item.Excused)}</td>
            <td>${attendanceBadge("Not marked", item["Not marked"])}</td>
          </tr>
        `)
      )}
    </section>

    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Session attendance report</h2>
          <p>Attendance for each past scheduled session.</p>
        </div>
      </div>

      ${table(
        [
          "Date / session",
          "Students",
          "Attended",
          "Absent",
          "Excused",
          "Not marked",
          "Action"
        ],
        report.past.map(item => {
          const totals = report.forLesson(item);

          return `
            <tr data-search="${find([item.lesson_date, item.topic])}">
              <td>
                <strong>${h(item.lesson_date)}</strong>
                <small>${h(item.start_time)}–${h(item.end_time)}</small>
              </td>

              <td>${totals.total}</td>
              <td>${attendedBreakdown(totals.counts)}</td>
              <td>${attendanceBadge("Absent", totals.counts.Absent)}</td>
              <td>${attendanceBadge("Excused", totals.counts.Excused)}</td>
              <td>${attendanceBadge("Not marked", totals.counts["Not marked"])}</td>

              <td>
                <a
                  class="text-link"
                  href="${h(url(
                    "attendance",
                    cid,
                    item.id,
                    item.lesson_date
                  ))}"
                >
                  Open →
                </a>
              </td>
            </tr>
          `;
        })
      )}
    </section>

    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Individual student class records</h2>
          <p>
            Open a student to see the date, time and saved status
            for each recorded class.
          </p>
        </div>
      </div>

      ${report.students.map(student => `
        <details
          class="student-record"
          data-search="${find([student.name, student.student_no])}"
        >
          <summary>
            <span>
              <strong>${h(student.name)}</strong>
              <small>${h(student.student_no || "—")}</small>
            </span>

            <span class="student-record-summary">
              ${attendanceBadges(student)}
              <small>${student.total} classes · View records</small>
            </span>
          </summary>

          ${table(
            ["Date", "Time", "Topic", "Status", "Action"],
            report.recorded.flatMap(lesson => {
              const record = report.forLesson(lesson).students.find(
                item => item.id === student.id
              );

              if (!record) return [];

              return [`
                <tr>
                  <td>${h(lesson.lesson_date)}</td>
                  <td>${h(lesson.start_time)}–${h(lesson.end_time)}</td>
                  <td>${h(lesson.topic || classroom.name)}</td>

                  <td>
                    ${attendanceBadge(record.status)}
                  </td>

                  <td>
                    <a
                      class="text-link"
                      href="${h(url(
                        "attendance",
                        classroom.id,
                        lesson.id,
                        lesson.lesson_date
                      ))}"
                    >
                      Open session →
                    </a>
                  </td>
                </tr>
              `];
            })
          )}
        </details>
      `).join("") || `
        <p class="empty-state">
          No student records available for this class.
        </p>
      `}
    </section>
  `;
}

/* Take attendance */

function attendanceTake(classroom, report) {
  const lessons = report.lessons
    .filter(item => item.lesson_date === selectedDate)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  if (!lessons.some(item => item.id === lid)) {
    lid = lessons.length === 1 ? lessons[0].id : "";
  }

  const lesson = lessons.find(item => item.id === lid);
  const summary = lesson ? report.forLesson(lesson) : null;
  const canSave = !!lesson && selectedDate <= state.today;

  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Choose a session</h2>
          <p>Select the date and class time.</p>
        </div>
      </div>

      <div class="selection-grid">
        <label>
          Attendance date

          <input
            id="attendance-date"
            type="date"
            value="${h(selectedDate)}"
            max="${h(state.today)}"
          >
        </label>

        <label>
          Attendance session

          <select
            id="lesson-select"
            ${lessons.length ? "" : "disabled"}
          >
            <option value="">Select a session</option>

            ${lessons.map(item => `
              <option
                value="${h(item.id)}"
                ${item.id === lid ? "selected" : ""}
              >
                ${h(item.start_time)}–${h(item.end_time)}
                · ${h(item.topic || "Class session")}
              </option>
            `).join("")}
          </select>
        </label>
      </div>

      ${!lessons.length ? `
        <div class="empty-state">
          No session scheduled for this date.
          <br>

          <a
            class="text-link"
            href="${h(url(
              "attendance", cid, "", selectedDate, "sessions"
            ))}"
          >
            Schedule a session →
          </a>
        </div>
      ` : ""}
    </section>

    ${summary ? `
      <div class="attendance-metrics">
        ${[
          ["Students", summary.total, "neutral"],
          [
            "Attended",
            summary.counts.Present + summary.counts.Late,
            "present"
          ],
          ["Absent", summary.counts.Absent, "absent"],
          ["Excused", summary.counts.Excused, "excused"],
          ["Not marked", summary.counts["Not marked"], "unmarked"]
        ].map(([label, count, tone]) => `
          <article class="metric ${tone}">
            <span>${label}</span>
            <strong>${count}</strong>
          </article>
        `).join("")}
      </div>

      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Student attendance</h2>

            <p>
              ${h(selectedDate)}
              · ${h(lesson.start_time)}–${h(lesson.end_time)}
              · ${h(classroom.name)}
            </p>
          </div>

          ${attendanceBadges(summary.counts)}
        </div>

        <p class="info-note">
          Counts show saved attendance.
          Save each changed row.
          Present and Late both count as attended.
        </p>

        ${!canSave ? `
          <p class="warning-note">Future attendance is read only.</p>
        ` : ""}

        ${summary.students.map(student => `
          <form
            id="attendance-${h(student.id)}"
            data-kind="attendance"
            data-student="${h(student.id)}"
          ></form>
        `).join("")}

        ${table(
          [
            "Student",
            "Student ID",
            "Saved status",
            "Mark attendance",
            "Action"
          ],
          summary.students.map(student => {
            const editable = canSave && student.can_mark;

            const value = attendanceDrafts.get(
              JSON.stringify([lid, student.id])
            ) ?? student.status;

            return `
              <tr data-search="${find([
                student.name,
                student.student_no
              ])}">
                <td>
                  <strong>${h(student.name)}</strong>

                  ${!student.can_mark ? `
                    <small>Previous enrolment · read only</small>
                  ` : ""}
                </td>

                <td>${h(student.student_no || "—")}</td>

                <td>
                  ${attendanceBadge(student.status)}
                </td>

                <td>
                  <select
                    name="status"
                    form="attendance-${h(student.id)}"
                    aria-label="Attendance for ${h(student.name)}"
                    required
                    ${editable ? "" : "disabled"}
                  >
                    <option value="">Select…</option>

                    ${[
                      "Present", "Late", "Absent", "Excused"
                    ].map(status => `
                      <option
                        value="${status}"
                        ${value === status ? "selected" : ""}
                      >
                        ${status}
                      </option>
                    `).join("")}
                  </select>
                </td>

                <td>
                  <button
                    type="submit"
                    form="attendance-${h(student.id)}"
                    ${editable ? "" : "disabled data-locked"}
                  >
                    Save
                  </button>
                </td>
              </tr>
            `;
          })
        )}
      </section>
    ` : `
      <section class="panel empty-state">
        Select a session above to view students and record attendance.
      </section>
    `}
  `;
}

/* One page per task */

function attendancePage() {
  const classroom = selected();
  const report = attendanceReport(state, cid);

  const title = attendanceView === "reports"
    ? "Student Reports"
    : attendanceView === "sessions"
      ? "Daily Classes"
      : "Student Attendance";

  const description = attendanceView === "reports"
    ? "Review totals and each student's session history."
    : attendanceView === "sessions"
      ? "Schedule classes and open a session to take attendance."
      : "Choose a class, date and session, then save each student's attendance.";

  return `
    <div class="attendance-page">
      ${heading("ta", title, description)}
      ${picker("ta")}

      ${classroom ? `
        ${
          attendanceView === "sessions"
            ? attendanceSessions(classroom, report)
            : attendanceView === "reports"
              ? attendanceReports(classroom, report)
              : attendanceTake(classroom, report)
        }
      ` : `
        <section class="panel empty-state">
          <span class="empty-icon">▦</span>
          <h2>Choose your classroom</h2>
          <p>
            Select an assigned class to manage its sessions,
            attendance and student reports.
          </p>
        </section>
      `}
    </div>
  `;
}

/* Navigation */

function identity() {
  document.querySelectorAll("[data-teacher-name]").forEach(el => {
    el.textContent = profile.name;
  });

  document.querySelectorAll("[data-initial]").forEach(el => {
    el.textContent = (profile.name || "T").slice(0, 1).toUpperCase();
  });
}

function render() {
  if (!state) return;

  const [name, query = ""] = location.hash.slice(1).split("?");

  const route = ["classes", "reports"].includes(name)
    ? "attendance"
    : name;

  page = Object.hasOwn(labels, route) ? route : "dashboard";

  const params = new URLSearchParams(query);

  if (params.has("class")) {
    cid = params.get("class");
  }

  if (!selected()) {
    cid = "";
    lid = "";
  }

  if (params.has("lesson")) {
    lid = params.get("lesson");
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "")) {
    selectedDate = params.get("date");
  }

  attendanceView = ["take", "sessions", "reports"].includes(
    params.get("view")
  )
    ? params.get("view")
    : name === "classes"
      ? "sessions"
      : name === "reports"
        ? "reports"
        : "take";

  const sectionHash = page === "attendance"
    ? attendanceView === "sessions"
      ? "#classes"
      : attendanceView === "reports"
        ? "#reports"
        : "#attendance"
    : "#" + page;

  $("page-title").textContent = sectionHash === "#classes"
    ? "Daily Classes"
    : sectionHash === "#reports"
      ? "Student Reports"
      : labels[page];

  document.querySelectorAll(".tsb-nav a").forEach(link => {
    const active = link.hash === sectionHash;
    link.classList.toggle("active", active);

    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  const pages = {
    dashboard,
    students: studentsPage,
    attendance: attendancePage,
    marks: marksPage,
    notices: noticesPage,
    "my-attendance": myAttendance,
    profile: profilePage
  };

  $("content").innerHTML = pages[page]();
  $("content").hidden = false;
  $("page-search").value = "";

  identity();
  connect();
  tick();

  if (busy) lock(true);
}

function connect() {
  document.querySelectorAll("[data-class]").forEach(el => {
    el.addEventListener("change", () => {
      if (busy) return;

      cid = el.value;
      lid = "";

      location.hash = url(
        page,
        cid,
        "",
        selectedDate,
        page === "attendance" ? attendanceView : ""
      );

      render();
    });
  });

  $("attendance-date")?.addEventListener("change", event => {
    if (busy) return;

    selectedDate = event.target.value || state.today;
    lid = "";

    location.hash = url("attendance", cid, "", selectedDate);
    render();
  });

  $("lesson-select")?.addEventListener("change", event => {
    if (busy) return;

    lid = event.target.value;

    location.hash = url("attendance", cid, lid, selectedDate);
    render();
  });

  $("tn-audience")?.addEventListener("change", event => {
    $("tn-class-field").hidden = event.target.value !== "class";
    $("tn-student-field").hidden = event.target.value !== "students";

    $("tn-class-field").querySelector("select").required =
      event.target.value === "class";
  });
}

/* Drafts */

$("content").addEventListener("input", event => {
  const form = event.target.form;

  if (form?.dataset.kind === "marks") {
    marksDrafts.set(
      JSON.stringify([cid, form.dataset.student]),
      Object.fromEntries(new FormData(form))
    );
  }
});

$("content").addEventListener("change", event => {
  const form = event.target.form;

  if (form?.dataset.kind === "attendance") {
    attendanceDrafts.set(
      JSON.stringify([lid, form.dataset.student]),
      event.target.value
    );
  }
});

/* Form submissions */

$("content").addEventListener("submit", async event => {
  event.preventDefault();

  if (busy) return;

  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const kind = form.dataset.kind;

  if (kind === "attendance") {
    await save(
      "/classes/" + encodeURIComponent(cid) + "/attendance",
      {
        ...data,
        student_id: form.dataset.student,
        lesson_id: lid
      }
    );
    return;
  }

  if (kind === "marks") {
    const key = JSON.stringify([cid, form.dataset.student]);

    await save(
      "/classes/" + encodeURIComponent(cid) + "/marks",
      {
        ...data,
        student_id: form.dataset.student
      },
      () => marksDrafts.delete(key)
    );
    return;
  }

  if (kind === "lesson") {
    data.request_id = reqid("lesson-" + cid);

    await save(
      "/classes/" + encodeURIComponent(cid) + "/lessons",
      data,
      result => {
        clearid("lesson-" + cid);

        lid = result.id;
        selectedDate = data.lesson_date;

        location.hash = url(
          "attendance", cid, lid, selectedDate
        );
      }
    );
    return;
  }

  if (kind === "notice") {
    data.request_id = reqid("notice");
    data.student_ids = new FormData(form).getAll("student_ids");
    data.also_admin = form.elements.also_admin.checked;

    await save("/notices", data, () => clearid("notice"));
    return;
  }

  if (kind === "profile") {
    delete data.email;
    await save("", data, () => {}, true);
    return;
  }

  if (kind === "password") {
    if (
      data.new_password.length < 8 ||
      data.new_password.length > 128 ||
      data.new_password !== data.confirm_password
    ) {
      show("Use matching new passwords of 8–128 characters.", true);
      return;
    }

    lock(true);
    show("Checking current password…");

    let changed = false;

    try {
      await request("", undefined, true);

      const user = auth.currentUser;

      await reauthenticateWithCredential(
        user,
        EmailAuthProvider.credential(
          user.email,
          data.current_password
        )
      );

      await updatePassword(user, data.new_password);

      changed = true;
      form.reset();

      await signOut(auth);
      location.replace("/login.html?role=teacher");
    } catch (error) {
      show(
        changed
          ? "Password changed. Sign in again with the new password."
          : [
              "auth/invalid-credential",
              "auth/wrong-password"
            ].includes(error.code)
            ? "Current password is incorrect."
            : error.message,
        true
      );
    } finally {
      lock(false);
    }
  }
});

/* Check-in and check-out */

$("content").addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");

  if (!button || busy) return;

  if (["check-in", "check-out"].includes(button.dataset.action)) {
    await save("/work-attendance", {
      action: button.dataset.action === "check-in" ? "in" : "out"
    });
  }
});

/* Search */

$("page-search").addEventListener("input", event => {
  const terms = event.target.value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  document.querySelectorAll("[data-search]").forEach(row => {
    row.hidden = !terms.every(term =>
      row.dataset.search.includes(term)
    );
  });
});

/* Refresh */

$("refresh").addEventListener("click", async () => {
  if (busy) return;

  lock(true);

  try {
    await refresh();
    render();
    show("Workspace refreshed.");
  } catch (error) {
    show(error.message, true);
  } finally {
    lock(false);
  }
});

$("retry").addEventListener("click", () => location.reload());

/* Logout */

$("logout").addEventListener("submit", async event => {
  event.preventDefault();

  if (busy) return;

  lock(true);

  try {
    await signOut(auth);
    location.replace("/login.html?role=teacher");
  } catch (error) {
    show(error.message, true);
  } finally {
    lock(false);
  }
});

window.addEventListener("hashchange", () => {
  if (!busy) render();
});

/* Clock */

function tick() {
  const now = new Date();

  $("live-date").textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(now);

  $("live-time").textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(now);
}

tick();
setInterval(tick, 1000);

/* Authentication */

onAuthStateChanged(auth, async user => {
  const current = ++version;

  state = null;
  $("content").hidden = true;

  if (activeUid !== user?.uid) {
    attendanceDrafts.clear();
    marksDrafts.clear();

    cid = "";
    lid = "";
    selectedDate = "";

    activeUid = user?.uid || "";
  }

  if (!user) {
    location.replace("/login.html?role=teacher");
    return;
  }

  lock(true);
  show("Loading your workspace…");

  try {
    await refresh();

    if (current !== version) return;

    render();
    show("");
    $("retry").hidden = true;
  } catch (error) {
    if (current === version) {
      show(error.message, true);
      $("retry").hidden = false;
    }
  } finally {
    if (current === version) {
      lock(false);
    }
  }
});