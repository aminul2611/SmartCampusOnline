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
  character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character])
);

const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

const labels = {
  dashboard: "Dashboard",
  students: "Student Details",
  marks: "Student Marks",
  attendance: "Student Attendance",
  classes: "Daily Classes",
  notices: "Notices",
  "my-attendance": "My Attendance",
  profile: "Teacher Profile"
};

let state = null;
let profile = null;
let busy = false;
let version = 0;
let refreshNeeded = false;

let page = "dashboard";
let cid = "";
let lid = "";
let selectedDate = "";
let month = 0;
let classPage = 0;

function show(text, error = false) {
  $("status").textContent = text;
  $("status").className =
    "flash " + (error ? "danger" : "success");
  $("status").hidden = !text;
}

function lock(value) {
  busy = value;

  document.querySelectorAll("button").forEach(button => {
    button.disabled =
      value || button.hasAttribute("data-locked");
  });
}

function timeout(promise) {
  let timer;

  return Promise.race([
    promise,

    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          "Login check timed out. Check your connection."
        ));
      }, 25000);
    })
  ]).finally(() => clearTimeout(timer));
}

async function request(path = "", body, root = false) {
  if (!auth.currentUser) {
    throw new Error("Please sign in again.");
  }

  const token = await timeout(
    auth.currentUser.getIdToken()
  );

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 70000);

  try {
    const response = await fetch(
      "/api/teacher/profile" +
      (root ? "" : "/workspace") +
      path,
      {
        method: body === undefined ? "GET" : "POST",

        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },

        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) }),

        signal: controller.signal
      }
    );

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      throw new Error(
        "Teacher API unavailable. Restart the updated Node server."
      );
    }

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.message || "Request failed.");
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "Connection timed out. Refresh the saved list before retrying."
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

  state = data;
  profile = account.profile;

  if (!selectedDate) {
    selectedDate = state.today;
  }

  refreshNeeded = false;
}

function identity() {
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
}

async function save(
  path,
  body,
  after = () => {},
  root = false
) {
  if (busy) return;

  if (refreshNeeded) {
    show(
      "Your previous change was saved. " +
      "Use Refresh before saving another change.",
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

    await refresh();
    render();

    show(data.message || "Saved.");
  } catch (error) {
    show(
      (
        refreshNeeded
          ? "Your change was saved, but the list could not refresh. Use Refresh. "
          : ""
      ) + error.message,
      true
    );
  } finally {
    lock(false);
  }
}

function reqid(type) {
  const storageKey = "smart-campus.teacher-" + type;
  let value = sessionStorage.getItem(storageKey);

  if (!/^[a-f0-9]{32}$/.test(value || "")) {
    value = crypto.randomUUID().replaceAll("-", "");
    sessionStorage.setItem(storageKey, value);
  }

  return value;
}

function clearid(type) {
  sessionStorage.removeItem("smart-campus.teacher-" + type);
}

const selected = () =>
  state.classes.find(classroom => classroom.id === cid);

function roster() {
  const ids = new Set(
    state.enrolments
      .filter(record => record.class_id === cid)
      .map(record => record.student_id)
  );

  return state.students
    .filter(student => ids.has(student.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function url(name, classId = "", lesson = "", date = "") {
  const query = new URLSearchParams();

  if (classId) query.set("class", classId);
  if (lesson) query.set("lesson", lesson);
  if (date) query.set("date", date);

  return "#" + name + (query.size ? "?" + query : "");
}

function find(values) {
  return h(
    values.join(" ")
      .normalize("NFKC")
      .toLowerCase()
  );
}

function input(
  label,
  name,
  value = "",
  type = "text",
  extra = ""
) {
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

function table(headings, records) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            ${headings.map(text =>
              `<th>${text}</th>`
            ).join("")}
          </tr>
        </thead>

        <tbody>
          ${records.join("") || `
            <tr>
              <td colspan="${headings.length}" class="empty">
                No records yet.
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
    <header class="${prefix}-heading">
      <div>
        <span class="${prefix}-eyebrow">
          TEACHER WORKSPACE
        </span>
        <h1>${title}</h1>
        <p>${description}</p>
      </div>
    </header>
  `;
}

function picker(prefix) {
  return `
    <section class="${prefix}-class-panel panel">
      <h2>Your classroom</h2>

      <label>
        Select class

        <select data-class>
          <option value="">— Select a class —</option>

          ${state.classes.map(classroom => `
            <option
              value="${h(classroom.id)}"
              ${classroom.id === cid ? "selected" : ""}
            >
              ${h(classroom.code + " — " + classroom.name)}
            </option>
          `).join("")}
        </select>
      </label>

      ${selected()
        ? `<p>${h(selected().code + " · " + selected().name)}</p>`
        : '<p class="empty">Choose an assigned class to continue.</p>'}
    </section>
  `;
}

function stamp(value) {
  if (value == null) return null;

  const seconds = value.seconds ?? value._seconds;

  if (seconds != null) {
    return new Date(seconds * 1000);
  }

  return typeof value === "number"
    ? new Date(value * 1000)
    : new Date(value);
}

function time(value) {
  const parsed = stamp(value);

  if (!parsed || !Number.isFinite(parsed.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(parsed);
}

function duration(record) {
  if (!record?.check_in) return "—";
  if (!record.check_out) return "In progress";

  const minutes = Math.max(
    0,
    Math.floor(
      (
        stamp(record.check_out) -
        stamp(record.check_in)
      ) / 60000
    )
  );

  return Math.floor(minutes / 60) +
    "h " + minutes % 60 + "m";
}

function noticeCards(notices, sent = false) {
  return notices.map(notice => {
    const parsed = stamp(notice.created_at);

    const when = parsed && Number.isFinite(parsed.getTime())
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Shanghai",
          dateStyle: "medium",
          timeStyle: "short"
        }).format(parsed)
      : "Date unavailable";

    const by = sent
      ? notice.audience === "admins"
        ? "Admin"
        : `${notice.recipient_ids?.length || 0} recipients`
      : notice.author_name || "Campus";

    return `
      <details
        class="tn-notice ${sent ? "tn-sent" : ""}"
        data-search="${find([
          notice.title,
          notice.body,
          notice.author_name
        ])}"
        ${sent ? "" : "open"}
      >
        <summary>${h(notice.title)}</summary>

        <small class="tn-meta">
          ${h(by)} · ${h(when)}
          ${sent ? " · Published" : ""}
        </small>

        <div class="tn-body">${h(notice.body)}</div>
      </details>
    `;
  }).join("") || '<p class="empty">No notices yet.</p>';
}

function calendar() {
  const today = new Date(state.today + "T12:00:00Z");

  const current = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth() + month,
    1
  ));

  const first = current.getUTCDay();

  const count = new Date(Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth() + 1,
    0
  )).getUTCDate();

  return `
    <section class="td-calendar">
      <div class="td-calendar-heading">
        <button
          type="button"
          data-action="month-prev"
          class="td-calendar-arrow"
        >‹</button>

        <h2>
          ${h(
            new Intl.DateTimeFormat("en-GB", {
              timeZone: "UTC",
              month: "long",
              year: "numeric"
            }).format(current)
          )}
        </h2>

        <button
          type="button"
          data-action="month-next"
          class="td-calendar-arrow"
        >›</button>
      </div>

      <div class="td-calendar-grid">
        ${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
          .map(text => `
            <span class="td-weekday">${text}</span>
          `).join("")}

        ${"<span></span>".repeat(first)}

        ${Array.from({ length: count }, (_, index) => {
          const isToday =
            today.getUTCFullYear() === current.getUTCFullYear() &&
            today.getUTCMonth() === current.getUTCMonth() &&
            today.getUTCDate() === index + 1;

          return `
            <span class="td-day ${isToday ? "td-today" : ""}">
              ${index + 1}
            </span>
          `;
        }).join("")}
      </div>

      <div class="td-calendar-footer">
        <span>Highlighted: today</span>

        <button
          type="button"
          data-action="month-today"
          class="td-today-button"
        >
          Today
        </button>
      </div>
    </section>
  `;
}

function dashboard() {
  const lessons = state.lessons
    .filter(lesson => lesson.lesson_date === state.today)
    .sort((a, b) =>
      a.start_time.localeCompare(b.start_time)
    );

  const pages = Math.max(
    1,
    Math.ceil(state.classes.length / 3)
  );

  classPage = Math.min(classPage, pages - 1);

  return `
    <div class="td-dashboard">
      <div class="td-layout">

        <div class="td-content">

          <div class="td-heading">
            <div>
              <h1>Welcome, ${h(profile.name)}!</h1>
              <p>Your classes, students and teaching tools.</p>
            </div>

            <a class="button" href="#my-attendance">
              My attendance
            </a>
          </div>

          <h2 class="td-section-title">Teaching tools</h2>

          <div class="td-tools">
            ${[
              ["students", "Student Details", "S", "blue"],
              ["attendance", "Manual Attendance", "A", "green"],
              ["classes", "Daily Classes", "C", "orange"]
            ].map(([name, label, icon, color]) => `
              <a class="td-card" href="#${name}">
                <span class="td-icon ${color}">${icon}</span>
                <h3>${label}</h3>
                <span class="link">Open section →</span>
              </a>
            `).join("")}
          </div>

          <section class="td-panel">
            <div class="td-panel-heading">
              <div>
                <h2>My classes</h2>
                <p>Your assigned classes and subjects.</p>
              </div>

              <span class="td-badge">
                ${state.classes.length} classes
              </span>
            </div>

            <div class="td-class-grid">
              ${state.classes
                .slice(classPage * 3, classPage * 3 + 3)
                .map(classroom => `
                  <a
                    class="td-card"
                    href="${h(url("students", classroom.id))}"
                    data-search="${find([
                      classroom.code,
                      classroom.name,
                      classroom.semester
                    ])}"
                  >
                    <span class="td-icon">▤</span>
                    <small>${h(classroom.code)}</small>
                    <h3>${h(classroom.name)}</h3>
                    <span class="link">Open class →</span>
                  </a>
                `).join("") ||
                '<p class="td-empty">No classes assigned yet.</p>'}
            </div>

            ${pages > 1 ? `
              <div class="td-pagination">
                <button
                  type="button"
                  data-action="class-prev"
                  ${classPage === 0 ? "disabled data-locked" : ""}
                >‹ Previous</button>

                <span>Page ${classPage + 1} of ${pages}</span>

                <button
                  type="button"
                  data-action="class-next"
                  ${classPage === pages - 1
                    ? "disabled data-locked"
                    : ""}
                >Next ›</button>
              </div>
            ` : ""}
          </section>

          <section class="td-panel td-today-panel">
            <div class="td-panel-heading">
              <div>
                <h2>Today's classes</h2>
                <p>Your scheduled sessions for today.</p>
              </div>
            </div>

            ${lessons.map(lesson => `
              <a
                class="td-lesson"
                href="${h(url(
                  "attendance",
                  lesson.class_id,
                  lesson.id,
                  lesson.lesson_date
                ))}"
              >
                <span>
                  <strong>
                    ${h(
                      state.classes.find(classroom =>
                        classroom.id === lesson.class_id
                      )?.name
                    )}
                  </strong>

                  <small>
                    ${h(lesson.topic || "Class session")}
                    · ${h(lesson.room || "Room not set")}
                  </small>
                </span>

                <strong class="td-lesson-time">
                  ${h(lesson.start_time)}–${h(lesson.end_time)}
                </strong>
              </a>
            `).join("") ||
              '<p class="td-empty">No classes scheduled for today.</p>'}
          </section>

          <section class="td-panel td-dashboard-notices">
            <h2>Campus notices</h2>
            ${noticeCards(state.received)}
          </section>

        </div>

        <aside class="td-side">
          <div class="td-widget">
            <div class="td-clock">
              <p class="td-clock-label">Campus time</p>
              <time
                id="dashboard-clock"
                class="td-clock-time"
              ></time>
              <p class="td-clock-date">${h(state.today)}</p>
            </div>

            ${calendar()}
          </div>
        </aside>

      </div>
    </div>
  `;
}

function studentsPage() {
  return `
    <div class="ts-page">
      ${heading(
        "ts",
        "Student Details",
        "Choose a class to view its enrolled students."
      )}

      ${picker("ts")}

      ${selected() ? `
        <section class="ts-students-panel panel">
          <div class="ts-list-heading">
            <div>
              <h2>Enrolled students</h2>
              <p>
                Student information for ${h(selected().name)}.
              </p>
            </div>
          </div>

          ${table(
            [
              "Student",
              "Student ID",
              "Email address",
              "Registered",
              "Account"
            ],
            roster().map(student => `
              <tr data-search="${find([
                student.name,
                student.student_no,
                student.email,
                student.semester,
                student.department
              ])}">
                <td>
                  <div class="ts-person">
                    <span class="ts-avatar">
                      ${h((student.name || "S").slice(0, 1))}
                    </span>
                    <strong>${h(student.name)}</strong>
                  </div>
                </td>

                <td>
                  <span class="ts-student-id">
                    ${h(student.student_no || "—")}
                  </span>
                </td>

                <td>${h(student.email)}</td>

                <td>
                  ${h(
                    stamp(student.created_at)
                      ?.toISOString().slice(0, 10) || "—"
                  )}
                </td>

                <td>
                  <span class="ts-status ${
                    student.active ? "is-active" : "is-disabled"
                  }">
                    ${student.active ? "Active" : "Disabled"}
                  </span>
                </td>
              </tr>
            `)
          )}
        </section>
      ` : ""}
    </div>
  `;
}

function marksPage() {
  const classroom = selected();
  const students = roster();
  const keys = ["assessment", "mid", "final"];

  return `
    <div class="tm-page">
      ${heading(
        "tm",
        "Student Marks",
        "Manage assessment, midterm and final marks."
      )}

      ${picker("tm")}

      ${classroom ? `
        <section class="tm-marks-panel panel">
          <h2>Student marks</h2>
          <p>Leave an ungraded mark blank.</p>

          <div class="tm-limits">
            ${keys.map(name => `
              <span>
                ${name}
                <strong>${h(classroom.limits[name])}</strong>
              </span>
            `).join("")}

            <span>
              Total
              <strong>
                ${keys.reduce(
                  (sum, name) =>
                    sum + Number(classroom.limits[name]),
                  0
                )}
              </strong>
            </span>
          </div>

          ${students.map(student => `
            <form
              id="mark-${h(student.id)}"
              data-kind="marks"
              data-student="${h(student.id)}"
            ></form>
          `).join("")}

          ${table(
            [
              "Student",
              "Assessment",
              "Midterm",
              "Final",
              "Total",
              "Action"
            ],

            students.map(student => {
              const marks = state.marks.find(record =>
                record.class_id === cid &&
                record.student_id === student.id
              ) || {};

              return `
                <tr data-search="${find([
                  student.name,
                  student.student_no
                ])}">
                  <td>
                    <div class="tm-person">
                      <span class="tm-avatar">
                        ${h((student.name || "S").slice(0, 1))}
                      </span>
                      <div>
                        <strong>${h(student.name)}</strong>
                        <small>${h(student.student_no)}</small>
                      </div>
                    </div>
                  </td>

                  ${keys.map(name => `
                    <td>
                      <input
                        class="tm-score-input"
                        name="${name}"
                        type="number"
                        min="0"
                        max="${h(classroom.limits[name])}"
                        step="any"
                        placeholder="—"
                        value="${h(marks[name] ?? "")}"
                        form="mark-${h(student.id)}"
                        aria-label="${name} for ${h(student.name)}"
                        ${student.active ? "" : "disabled"}
                      >
                    </td>
                  `).join("")}

                  <td class="tm-score-total">
                    ${keys.every(name => marks[name] != null)
                      ? h(Math.round(
                          keys.reduce(
                            (sum, name) =>
                              sum + Number(marks[name]),
                            0
                          ) * 100
                        ) / 100)
                      : "Incomplete"}
                  </td>

                  <td>
                    <button
                      class="tm-save"
                      type="submit"
                      form="mark-${h(student.id)}"
                      ${student.active
                        ? ""
                        : "disabled data-locked"}
                    >
                      Save
                    </button>
                  </td>
                </tr>
              `;
            })
          )}
        </section>
      ` : ""}
    </div>
  `;
}

function sessionForm(prefix, attendance = false) {
  return `
    <form data-kind="lesson">
      <div class="${prefix}-picker-grid form-grid">
        ${input(
          "Date",
          "lesson_date",
          attendance ? selectedDate : state.today,
          "date",
          `required ${
            attendance ? 'max="' + state.today + '"' : ""
          }`
        )}

        ${input(
          "Start time", "start_time", "", "time", "required"
        )}

        ${input(
          "End time", "end_time", "", "time", "required"
        )}

        ${input(
          "Room", "room", "", "text", 'maxlength="100"'
        )}

        ${input(
          "Topic", "topic", "", "text", 'maxlength="200"'
        )}
      </div>

      <button type="submit" class="${prefix}-button">
        ${attendance
          ? "Create session & open attendance"
          : "Schedule class session"} →
      </button>
    </form>
  `;
}

function classesPage() {
  const classroom = selected();

  return `
    <div class="tc-page">
      ${heading(
        "tc",
        "Daily Classes",
        "Your weekly routine and scheduled class sessions."
      )}

      <section class="tc-panel panel">
        <h2>Weekly Class Schedule</h2>

        <div class="tc-weekly-grid">
          ${state.classes.map(item => `
            <article
              class="tc-class-card"
              data-search="${find([
                item.code,
                item.name,
                item.semester
              ])}"
            >
              <div class="tc-card-top">
                <span class="tc-code">${h(item.code)}</span>
              </div>

              <h3>${h(item.name)}</h3>
              <p class="tc-semester">${h(item.semester)}</p>

              <div class="tc-routine">
                ${(item.weekly_slots || []).map(slot => `
                  <div class="tc-routine-line">
                    ◷ ${h(days[slot.day])}
                    ${h(slot.start)}–${h(slot.end)}
                    ${h(slot.room)}
                  </div>
                `).join("") ||
                  "<p>Weekly time not set.</p>"}
              </div>

              <a
                class="tc-open-class"
                href="${h(url("classes", item.id))}"
              >
                Open class →
              </a>
            </article>
          `).join("") ||
            '<p class="empty">No classes assigned yet.</p>'}
        </div>
      </section>

      ${picker("tc")}

      ${classroom ? `
        <section class="tc-panel panel">
          <h2>Schedule a class session</h2>
          ${sessionForm("tc")}
        </section>

        <section class="tc-panel panel">
          <h2>Scheduled sessions</h2>

          <div class="tc-session-list">
            ${state.lessons
              .filter(lesson => lesson.class_id === cid)
              .sort((a, b) =>
                b.lesson_date.localeCompare(a.lesson_date) ||
                a.start_time.localeCompare(b.start_time)
              )
              .map(lesson => `
                <a
                  class="tc-session"
                  href="${h(url(
                    "attendance",
                    cid,
                    lesson.id,
                    lesson.lesson_date
                  ))}"
                >
                  <span class="tc-date-tile">
                    <strong>
                      ${h(lesson.lesson_date.slice(8))}
                    </strong>
                    <small>
                      ${h(lesson.lesson_date.slice(0, 7))}
                    </small>
                  </span>

                  <span class="tc-session-info">
                    <strong>${h(classroom.name)}</strong>

                    <small>
                      ${h(lesson.lesson_date)}
                      · ${h(lesson.start_time)}–${h(lesson.end_time)}
                      · ${h(lesson.room || "Room not set")}
                    </small>

                    <small>${h(lesson.topic)}</small>
                  </span>

                  <span class="tc-attendance-link">
                    Attendance →
                  </span>
                </a>
              `).join("") ||
              '<p class="empty">No sessions scheduled.</p>'}
          </div>
        </section>
      ` : ""}
    </div>
  `;
}

function attendancePage() {
  const classroom = selected();

  const lessons = state.lessons.filter(lesson =>
    lesson.class_id === cid &&
    lesson.lesson_date === selectedDate
  );

  if (!lessons.some(lesson => lesson.id === lid)) {
    lid = lessons.length === 1 ? lessons[0].id : "";
  }

  const canSave = !!lid && selectedDate <= state.today;

  const students = roster().filter(student =>
    student.active &&
    state.enrolments.some(record =>
      record.class_id === cid &&
      record.student_id === student.id &&
      record.joined_on <= selectedDate
    )
  );

  return `
    <div class="ta-page">
      ${heading(
        "ta",
        "Student Attendance",
        "Select a class and date to view its students."
      )}

      ${picker("ta")}

      <section class="ta-picker-panel panel">
        <label>
          Attendance date
          <input
            id="attendance-date"
            type="date"
            value="${h(selectedDate)}"
            max="${h(state.today)}"
          >
        </label>
      </section>

      ${classroom ? `
        <section class="ta-picker-panel panel">
          <h2>Attendance session</h2>

          <select id="lesson-select">
            <option value="">— Select a session —</option>

            ${lessons.map(lesson => `
              <option
                value="${h(lesson.id)}"
                ${lesson.id === lid ? "selected" : ""}
              >
                ${h(
                  lesson.start_time + "–" + lesson.end_time +
                  " · " + (lesson.topic || "Class session")
                )}
              </option>
            `).join("")}
          </select>

          ${selectedDate <= state.today ? `
            <details
              class="ta-create-session"
              ${lessons.length ? "" : "open"}
            >
              <summary>
                ＋ Create a session for this date
              </summary>

              ${sessionForm("ta", true)}
            </details>
          ` : ""}
        </section>

        <section class="ta-list-panel panel">
          <h2>Student attendance</h2>

          ${canSave ? "" : `
            <p class="ta-warning">
              Create or select a session above.
              Future attendance cannot be recorded.
            </p>
          `}

          ${students.map(student => `
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

            students.map(student => {
              const attendance = state.attendance.find(record =>
                record.lesson_id === lid &&
                record.student_id === student.id
              );

              return `
                <tr data-search="${find([
                  student.name,
                  student.student_no
                ])}">
                  <td>
                    <div class="ta-person">
                      <span class="ta-avatar">
                        ${h((student.name || "S").slice(0, 1))}
                      </span>
                      <strong>${h(student.name)}</strong>
                    </div>
                  </td>

                  <td>
                    <span class="ta-student-id">
                      ${h(student.student_no)}
                    </span>
                  </td>

                  <td>
                    <span class="ta-status ta-${h(
                      (attendance?.status || "unmarked")
                        .toLowerCase()
                    )}">
                      ${h(attendance?.status || "Not marked")}
                    </span>
                  </td>

                  <td>
                    <select
                      name="status"
                      form="attendance-${h(student.id)}"
                      ${canSave ? "" : "disabled"}
                    >
                      <option value="">Select…</option>

                      ${[
                        "Present",
                        "Absent",
                        "Late",
                        "Excused"
                      ].map(status => `
                        <option
                          ${attendance?.status === status
                            ? "selected"
                            : ""}
                        >
                          ${status}
                        </option>
                      `).join("")}
                    </select>
                  </td>

                  <td>
                    <button
                      class="ta-save"
                      type="submit"
                      form="attendance-${h(student.id)}"
                      ${canSave ? "" : "disabled data-locked"}
                    >
                      Save
                    </button>
                  </td>
                </tr>
              `;
            })
          )}
        </section>
      ` : ""}
    </div>
  `;
}

function myAttendance() {
  const record = state.work.find(item =>
    item.work_date === state.today
  );

  const done = record?.check_out != null;

  return `
    <div class="ma-page">
      ${heading(
        "ma",
        "My Attendance",
        "Your daily check-in, check-out and attendance history."
      )}

      <section class="ma-card">
        <div class="ma-card-heading">
          <div>
            <span class="ma-eyebrow">DAILY ATTENDANCE</span>
            <h2>Today's attendance</h2>
            <p>${h(state.today)}</p>
          </div>

          <span class="ma-badge ${
            done ? "completed" : record ? "working" : ""
          }">
            ${done
              ? "Completed"
              : record ? "Checked in" : "Not checked in"}
          </span>
        </div>

        <div class="ma-time-grid">
          ${[
            [
              "↘",
              "Check-in time",
              time(record?.check_in),
              "Start of your workday"
            ],
            [
              "↗",
              "Check-out time",
              time(record?.check_out),
              "End of your workday"
            ],
            [
              "◷",
              "Working duration",
              duration(record),
              "Calculated after check-out"
            ]
          ].map(([icon, label, value, description]) => `
            <article class="ma-time-box">
              <span class="ma-time-icon">${icon}</span>

              <div>
                <span class="ma-label">${label}</span>
                <strong>${h(value)}</strong>
                <small>${description}</small>
              </div>
            </article>
          `).join("")}
        </div>

        <div class="ma-action-bar">
          <p>
            ${done
              ? "Your attendance has been recorded for today."
              : record
                ? "Check out when your workday ends."
                : "Ready to begin? Record your check-in below."}
          </p>

          <div class="ma-actions">
            <button
              class="ma-button"
              type="button"
              data-action="check-in"
              ${record ? "disabled data-locked" : ""}
            >
              ↘ Check in
            </button>

            <button
              class="ma-button secondary"
              type="button"
              data-action="check-out"
              ${!record || done ? "disabled data-locked" : ""}
            >
              ↗ Check out
            </button>
          </div>
        </div>
      </section>

      <section class="ma-card ma-history">
        <div class="ma-card-heading">
          <div>
            <h2>Recent attendance</h2>
            <p>Your latest recorded working days.</p>
          </div>
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

function noticesPage() {
  return `
    <div class="tn-page">
      <header class="tn-heading">
        <span>TEACHER WORKSPACE</span>
        <h1>Notice Centre</h1>
        <p>
          Read campus updates and share notices with your students.
        </p>
      </header>

      <div class="tn-layout">

        <section class="tn-panel">
          <div class="tn-panel-heading">
            <span class="tn-icon">↗</span>

            <div>
              <h2>Send a notice</h2>
              <p>Choose your recipients before sending.</p>
            </div>
          </div>

          <form data-kind="notice">

            <label for="tn-audience">Send to</label>

            <select id="tn-audience" name="audience" required>
              <option value="">Choose recipients</option>
              <option value="admin">Admin</option>
              <option value="class">A class / section</option>
              <option value="students">Selected students</option>
            </select>

            <div id="tn-class-field" hidden>
              <label>
                Class / section

                <select name="class_id">
                  <option value="">Select your class</option>

                  ${state.classes.map(classroom => `
                    <option value="${h(classroom.id)}">
                      ${h(
                        classroom.code + " — " + classroom.name
                      )}
                    </option>
                  `).join("")}
                </select>
              </label>

              <p class="tn-help">
                Sends to the active students currently enrolled.
              </p>
            </div>

            <fieldset id="tn-student-field" hidden>
              <legend>Select students</legend>

              <div class="tn-students">
                ${state.students
                  .filter(student => student.active)
                  .map(student => `
                    <label class="tn-student">
                      <input
                        type="checkbox"
                        name="student_ids"
                        value="${h(student.id)}"
                      >

                      <span>
                        <strong>${h(student.name)}</strong>
                        <small>
                          ${h(student.student_no || "No Student ID")}
                        </small>
                      </span>
                    </label>
                  `).join("") ||
                  '<p class="tn-help">No eligible students in your classes.</p>'}
              </div>
            </fieldset>

            <label class="tn-student tn-also-admin">
              <input type="checkbox" name="also_admin">

              <span>
                <strong>Also send to Admin</strong>
                <small>
                  Send this notice to Admin along with your selected students.
                </small>
              </span>
            </label>

            <label for="tn-title">Notice title</label>

            <input
              id="tn-title"
              name="title"
              maxlength="140"
              placeholder="Enter a clear, short title"
              required
            >

            <label for="tn-body">Message</label>

            <textarea
              id="tn-body"
              name="body"
              maxlength="5000"
              rows="7"
              placeholder="Write your notice here..."
              required
            ></textarea>

            <div class="tn-form-footer">
              <p>Delivered to selected recipients.</p>
              <button type="submit">Send notice →</button>
            </div>

          </form>
        </section>

        <div class="tn-feed">

          <section class="tn-panel">
            <div class="tn-list-heading">
              <h2>Received notices</h2>
              <span class="tn-count">${state.received.length}</span>
            </div>

            ${noticeCards(state.received)}
          </section>

          <section class="tn-panel">
            <div class="tn-list-heading">
              <h2>Sent notices</h2>
              <span class="tn-count">${state.sent.length}</span>
            </div>

            ${noticeCards(state.sent, true)}
          </section>

        </div>

      </div>
    </div>
  `;
}

function profilePage() {
  return `
    <div class="tp-page">

      <header class="tp-heading">
        <span>ACCOUNT SETTINGS</span>
        <h1>Teacher Profile</h1>
        <p>Manage your personal information and account security.</p>
      </header>

      <section class="tp-profile-card">
        <div class="tp-profile-person">
          <span class="tp-avatar">
            ${h((profile.name || "T").slice(0, 1))}
          </span>

          <div>
            <span class="tp-role">TEACHER ACCOUNT</span>
            <h2>${h(profile.name)}</h2>
            <p>${h(profile.email)}</p>
          </div>
        </div>

        <span class="tp-account-badge">● Teacher workspace</span>
      </section>

      <section class="tp-panel">
        <div class="tp-section-heading">
          <span class="tp-section-icon">◎</span>

          <div>
            <h2>Personal information</h2>
            <p>
              Keep your contact and professional details up to date.
            </p>
          </div>
        </div>

        <form data-kind="profile">
          <div class="tp-fields">
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

          <div class="tp-form-footer">
            <p>Your email address is managed by the administrator.</p>
            <button class="tp-button" type="submit">
              Save changes →
            </button>
          </div>
        </form>
      </section>

      <section class="tp-panel tp-security">
        <div class="tp-section-heading">
          <span class="tp-section-icon">⚿</span>

          <div>
            <h2>Change password</h2>
            <p>Choose a strong password to protect your account.</p>
          </div>
        </div>

        <form data-kind="password">
          <div class="tp-fields">
            ${input(
              "Current password", "current_password", "",
              "password", 'required autocomplete="current-password"'
            )}

            ${input(
              "New password", "new_password", "",
              "password",
              'required minlength="8" maxlength="128" autocomplete="new-password"'
            )}

            ${input(
              "Confirm new password", "confirm_password", "",
              "password",
              'required minlength="8" maxlength="128" autocomplete="new-password"'
            )}
          </div>

          <div class="tp-security-note">
            ⓘ After changing your password, you will need to log in again.
          </div>

          <div class="tp-form-footer">
            <button
              class="tp-button tp-password-button"
              type="submit"
            >
              Change password →
            </button>
          </div>
        </form>
      </section>

    </div>
  `;
}

function render() {
  if (!state) return;

  const [name, query = ""] =
    location.hash.slice(1).split("?");

  page = Object.hasOwn(labels, name)
    ? name
    : "dashboard";

  const parameters = new URLSearchParams(query);

  if (parameters.has("class")) {
    cid = parameters.get("class");
  }

  if (!selected()) {
    cid = "";
  }

  if (parameters.has("lesson")) {
    lid = parameters.get("lesson");
  }

  if (
    parameters.has("date") &&
    /^\d{4}-\d{2}-\d{2}$/.test(parameters.get("date"))
  ) {
    selectedDate = parameters.get("date");
  }

  $("page-title").textContent = labels[page];

  document.querySelectorAll(".tsb-nav a").forEach(link => {
    const active = link.hash === "#" + page;

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
    marks: marksPage,
    classes: classesPage,
    attendance: attendancePage,
    "my-attendance": myAttendance,
    notices: noticesPage,
    profile: profilePage
  };

  $("content").innerHTML = pages[page]();
  $("content").hidden = false;

  identity();
  $("page-search").value = "";

  connect();

  if (busy) lock(true);

  tick();
}

function connect() {
  document.querySelectorAll("[data-class]").forEach(element => {
    element.addEventListener("change", () => {
      if (busy) return;

      cid = element.value;
      lid = "";

      location.hash = url(page, cid);
      render();
    });
  });

  $("attendance-date")?.addEventListener("change", event => {
    if (busy) return;

    selectedDate = event.target.value || state.today;
    lid = "";

    location.hash = url(
      "attendance",
      cid,
      "",
      selectedDate
    );

    render();
  });

  $("lesson-select")?.addEventListener("change", event => {
    if (busy) return;

    lid = event.target.value;

    location.hash = url(
      "attendance",
      cid,
      lid,
      selectedDate
    );

    render();
  });

  const audience = $("tn-audience");

  if (audience) {
    audience.addEventListener("change", () => {
      $("tn-class-field").hidden =
        audience.value !== "class";

      $("tn-student-field").hidden =
        audience.value !== "students";

      const select = $("tn-class-field").querySelector("select");
      select.required = audience.value === "class";
    });
  }
}

$("content").addEventListener("submit", async event => {
  event.preventDefault();

  if (busy) return;

  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const kind = form.dataset.kind;

  if (kind === "password") {
    if (
      data.new_password.length < 8 ||
      data.new_password.length > 128 ||
      data.new_password !== data.confirm_password
    ) {
      show(
        "Use matching new passwords of 8–128 characters.",
        true
      );
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
          ? "Password changed. Log out, then sign in with the new password."
          : [
              "auth/invalid-credential",
              "auth/wrong-password"
            ].includes(error.code)
            ? "Current password is incorrect."
            : error.message,
        !changed
      );
    } finally {
      lock(false);
    }

    return;
  }

  if (kind === "profile") {
    delete data.email;
    await save("", data, () => {}, true);
    return;
  }

  if (kind === "marks") {
    data.student_id = form.dataset.student;

    await save(
      "/classes/" + encodeURIComponent(cid) + "/marks",
      data
    );
    return;
  }

  if (kind === "attendance") {
    data.student_id = form.dataset.student;
    data.lesson_id = lid;

    await save(
      "/classes/" + encodeURIComponent(cid) + "/attendance",
      data
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

        if (page === "attendance") {
          location.hash = url(
            "attendance",
            cid,
            lid,
            selectedDate
          );
        }
      }
    );
    return;
  }

  if (kind === "notice") {
    data.request_id = reqid("notice");

    data.student_ids = new FormData(form)
      .getAll("student_ids");

    data.also_admin = form.elements.also_admin.checked;

    await save("/notices", data, () => {
      clearid("notice");
    });
  }
});

$("content").addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");

  if (!button || busy) return;

  const action = button.dataset.action;

  if (action === "check-in" || action === "check-out") {
    await save("/work-attendance", {
      action: action === "check-in" ? "in" : "out"
    });
    return;
  }

  if (action === "month-prev") month--;
  if (action === "month-next") month++;
  if (action === "month-today") month = 0;
  if (action === "class-prev") classPage--;
  if (action === "class-next") classPage++;

  render();
});

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

$("retry").addEventListener("click", () => {
  location.reload();
});

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

function tick() {
  const now = new Date();

  const options = {
    timeZone: "Asia/Shanghai"
  };

  $("live-date").textContent =
    new Intl.DateTimeFormat("en-GB", {
      ...options,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(now);

  const currentTime =
    new Intl.DateTimeFormat("en-GB", {
      ...options,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(now);

  $("live-time").textContent = currentTime;

  if ($("dashboard-clock")) {
    $("dashboard-clock").textContent = currentTime;
  }
}

tick();
setInterval(tick, 1000);

onAuthStateChanged(auth, async user => {
  const currentVersion = ++version;

  state = null;
  $("content").hidden = true;

  if (!user) {
    location.replace("/login.html?role=teacher");
    return;
  }

  lock(true);
  show("Checking Teacher account and loading data…");

  try {
    await refresh();

    if (currentVersion !== version) return;

    render();
    show("");
    $("retry").hidden = true;
  } catch (error) {
    if (currentVersion === version) {
      show(error.message, true);
      $("retry").hidden = false;
    }
  } finally {
    if (currentVersion === version) {
      lock(false);
    }
  }
});