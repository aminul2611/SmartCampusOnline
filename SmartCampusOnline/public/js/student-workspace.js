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

const ZONE = "Asia/Shanghai";

const days = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
];

const titles = {
  dashboard: "Dashboard",
  classes: "My Classes",
  attendance: "My Attendance",
  results: "My Results",
  notices: "My Notices",
  profile: "My Profile"
};

const descriptions = {
  dashboard:
    "Your class schedule, attendance and results at a glance.",

  classes:
    "Your current subjects, teachers and previous class records.",

  attendance:
    "Review attendance by subject, semester and date.",

  results:
    "Overall progress, running semester marks and semester history.",

  notices:
    "Updates from your teachers and campus office.",

  profile:
    "Manage your personal information and account security."
};

let state = null;
let busy = false;
let version = 0;
let activeUid = "";
let filters = freshFilters();

function freshFilters() {
  return {
    classes: {
      scope: "all",
      semester: "",
      search: ""
    },

    attendance: {
      semester: "",
      class_id: "",
      from: "",
      to: ""
    },

    notices: {
      search: ""
    }
  };
}

function message(text, error = false) {
  $("student-message").textContent = text;

  $("student-message").className =
    "flash " + (error ? "danger" : "success");

  $("student-message").hidden = !text;
}

function lock(value) {
  busy = value;

  document.querySelectorAll("button").forEach(button => {
    button.disabled = value;
  });

  $("student-content").setAttribute(
    "aria-busy",
    String(value)
  );
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
      tokenTimer = setTimeout(
        () => reject(
          Error("Login check timed out. Please retry.")
        ),
        25000
      );
    })
  ]).finally(() => clearTimeout(tokenTimer));

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    70000
  );

  try {
    const response = await fetch(
      "/api/student" + path,
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

    if (
      !(response.headers.get("content-type") || "")
        .includes("application/json")
    ) {
      throw Error(
        "Student information is unavailable. Please retry."
      );
    }

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw Error(result.message || "Request failed.");
    }

    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw Error(
        "Connection timed out. Please refresh and retry."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  const result = await api("/data");

  if (auth.currentUser?.uid !== result.profile.id) {
    throw Error("The account changed. Please reload.");
  }

  if (
    !result.summary ||
    !Array.isArray(result.attendance)
  ) {
    throw Error(
      "The Student Portal update is incomplete. Deploy the updated Student API as well."
    );
  }

  state = result;
}

/* Shared helpers */

function number(value) {
  return Number(value).toLocaleString("en-GB", {
    maximumFractionDigits: 2
  });
}

function percent(value) {
  return value == null ? "—" : number(value) + "%";
}

function currentSemester() {
  return String(state.current_semester || "").trim();
}

function isCurrent(c) {
  return (
    c.active &&
    c.enrolment_active &&
    (
      !currentSemester() ||
      c.semester === currentSemester()
    )
  );
}

function semesters() {
  return [
    ...new Set(
      state.classes.map(c => c.semester)
    )
  ].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function options(items, selected, all) {
  return (
    `<option value="">${h(all)}</option>` +
    items.map(([value, label]) => `
      <option
        value="${h(value)}"
        ${value === selected ? "selected" : ""}
      >
        ${h(label)}
      </option>
    `).join("")
  );
}

function semesterOptions(selected) {
  return options(
    semesters().map(s => [s, s]),
    selected,
    "All semesters"
  );
}

function empty(
  title,
  copy = "Your saved information will appear here."
) {
  return `
    <div class="empty-state">
      <span class="empty-icon">▦</span>
      <h3>${h(title)}</h3>
      <p>${h(copy)}</p>
    </div>
  `;
}

function panel(title, copy, body, extra = "") {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${h(title)}</h2>
          ${copy ? `<p>${h(copy)}</p>` : ""}
        </div>
        ${extra}
      </div>

      ${body}
    </section>
  `;
}

function stats(items) {
  return `
    <div class="metrics">
      ${items.map(([label, value, tone = ""]) => `
        <article class="metric ${tone}">
          <span>${h(label)}</span>
          <strong>${h(value)}</strong>
        </article>
      `).join("")}
    </div>
  `;
}

function table(headings, rows) {
  return `
    <div
      class="table-wrap"
      role="region"
      aria-label="Scrollable data table"
      tabindex="0"
    >
      <table>
        <thead>
          <tr>
            ${headings.map(label => `
              <th scope="col">${h(label)}</th>
            `).join("")}
          </tr>
        </thead>

        <tbody>
          ${rows.join("") || `
            <tr>
              <td
                colspan="${headings.length}"
                class="empty-cell"
              >
                No records match this selection.
              </td>
            </tr>
          `}
        </tbody>
      </table>
    </div>
  `;
}

function badge(text, tone = "neutral") {
  return `<span class="badge ${tone}">${h(text)}</span>`;
}

function statusBadge(status) {
  const tones = {
    Present: "present",
    Late: "late",
    Absent: "absent",
    Excused: "excused"
  };

  return badge(status, tones[status] || "neutral");
}

/* Attendance totals */

function attendanceSummary(history) {
  const rows = history.filter(item => item.counted);

  const counts = {
    Present: 0,
    Late: 0,
    Absent: 0,
    Excused: 0,
    "Not marked": 0
  };

  for (const row of rows) {
    counts[
      Object.hasOwn(counts, row.status)
        ? row.status
        : "Not marked"
    ]++;
  }

  const attended = counts.Present + counts.Late;

  return {
    total: rows.length,
    attended,
    counts,
    pending: history.length - rows.length,

    percentage: rows.length
      ? Math.round(attended * 1000 / rows.length) / 10
      : null
  };
}

/* Results */

function courseResult(c) {
  const keys = ["assessment", "mid", "final"];

  const complete = keys.every(k =>
    c[k] != null &&
    c[k] !== "" &&
    Number.isFinite(Number(c[k])) &&
    Number(c[k]) >= 0 &&
    Number.isFinite(Number(c[k + "_max"])) &&
    Number(c[k + "_max"]) >= 0 &&
    Number(c[k]) <= Number(c[k + "_max"])
  );

  const maximum = keys.reduce(
    (sum, k) => sum + Number(c[k + "_max"]),
    0
  );

  const earned = complete
    ? keys.reduce((sum, k) => sum + Number(c[k]), 0)
    : null;

  return {
    complete: complete && maximum > 0,
    earned,
    maximum
  };
}

function resultSummary(classes) {
  const graded = classes
    .map(courseResult)
    .filter(r => r.complete);

  const earned = graded.reduce(
    (sum, r) => sum + r.earned,
    0
  );

  const maximum = graded.reduce(
    (sum, r) => sum + r.maximum,
    0
  );

  return {
    count: graded.length,
    subjects: classes.length,
    earned,
    maximum,

    average: maximum
      ? earned * 100 / maximum
      : null,

    complete:
      classes.length > 0 &&
      graded.length === classes.length
  };
}

function semesterResults() {
  return semesters().map(name => {
    const classes = state.classes.filter(
      c => c.semester === name
    );

    return {
      name,
      classes,
      ...resultSummary(classes)
    };
  });
}

function overallResult() {
  const eligible = semesterResults().filter(term =>
    currentSemester() &&
    term.name !== currentSemester() &&
    term.name !== "Semester not assigned" &&
    term.complete
  );

  return {
    ...resultSummary(
      eligible.flatMap(term => term.classes)
    ),

    semesters: eligible.length
  };
}

function when(value) {
  if (value == null) return "Date unavailable";

  const seconds = value?.seconds ?? value?._seconds;

  const date = new Date(
    seconds != null ? seconds * 1000 : value
  );

  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: ZONE,
        dateStyle: "medium",
        timeStyle: "short"
      }).format(date)
    : "Date unavailable";
}

function noticeCards(items) {
  return items.map(n => `
    <details class="notice-card">
      <summary>${h(n.title)}</summary>

      <small>
        ${h(n.author_name || "Campus Office")}
        · ${h(when(n.created_at))}
      </small>

      <div class="notice-body">${h(n.body)}</div>
    </details>
  `).join("") || empty("No notices yet");
}

function resultTable(classes) {
  return table(
    [
      "Subject",
      "Assessment",
      "Midterm",
      "Final",
      "Total",
      "Result"
    ],

    classes.map(c => {
      const r = courseResult(c);

      return `
        <tr>
          <td>
            <strong>${h(c.name)}</strong>
            <small>${h(c.code)}</small>
          </td>

          ${["assessment", "mid", "final"].map(k => `
            <td>
              ${c[k] == null ? "—" : h(number(c[k]))}
              / ${h(number(c[k + "_max"]))}
            </td>
          `).join("")}

          <td>
            ${
              r.complete
                ? `${number(r.earned)} / ${number(r.maximum)}`
                : "—"
            }
          </td>

          <td>
            ${
              r.complete
                ? badge(
                    percent(r.earned * 100 / r.maximum),
                    "present"
                  )
                : badge("Pending")
            }
          </td>
        </tr>
      `;
    })
  );
}

/* Dashboard */

function dashboard() {
  const overall = overallResult();

  const running = state.classes.filter(
    c => c.semester === currentSemester()
  );

  const result = resultSummary(running);

  return stats([
    [
      "Current subjects",
      state.classes.filter(isCurrent).length
    ],
    [
      "Attendance",
      percent(state.summary.percentage),
      "green"
    ],
    [
      "Completed semesters average",
      percent(overall.average),
      "blue"
    ],
    [
      "Campus notices",
      state.notices.length
    ]
  ]) + `
    <div class="two-columns">
      ${panel(
        "Today's classes",
        state.today,

        state.daily.map(s => `
          <article class="session-row">
            <span class="time-tile">
              ${h(s.start_time)}
              <small>${h(s.end_time)}</small>
            </span>

            <div class="session-copy">
              <strong>${h(s.name)}</strong>
              <small>
                ${h(s.code)}
                · ${h(s.room || "Room not set")}
              </small>
              <p>${h(s.topic || "Class session")}</p>
            </div>
          </article>
        `).join("") || empty("No classes scheduled today"),

        '<a class="text-link" href="#classes">My classes →</a>'
      )}

      ${panel(
        "Running semester",
        currentSemester() || "Not assigned by Admin",

        currentSemester() ? `
          <div class="result-highlight">
            <span>Average of fully graded subjects</span>
            <strong>${percent(result.average)}</strong>
            <p>
              ${result.count} of ${result.subjects}
              subjects fully graded
            </p>
          </div>

          <p class="info-note">
            ${
              result.complete
                ? "All listed subject marks are available."
                : "Result is in progress. Missing marks are not treated as zero."
            }
          </p>
        ` : empty(
          "Semester not assigned",
          "Ask your Admin to set your current semester."
        ),

        '<a class="text-link" href="#results">View results →</a>'
      )}
    </div>

    ${panel(
      "Latest notices",
      "Updates from your campus",
      noticeCards(state.notices.slice(0, 3)),
      '<a class="text-link" href="#notices">View all →</a>'
    )}
  `;
}

/* Classes */

function classesPage() {
  const f = filters.classes;

  const terms = f.search
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const visible = state.classes.filter(c =>
    (!f.semester || c.semester === f.semester) &&
    (
      f.scope === "all" ||
      (
        f.scope === "current"
          ? isCurrent(c)
          : !isCurrent(c)
      )
    ) &&
    terms.every(term =>
      [c.code, c.name, c.teacher_name]
        .join(" ")
        .toLocaleLowerCase()
        .includes(term)
    )
  );

  return `
    <form
      class="panel filter-form"
      data-kind="filter-classes"
    >
      <label>
        Classes

        <select name="scope">
          ${[
            ["all", "All classes"],
            ["current", "Current classes"],
            ["previous", "Previous classes"]
          ].map(([v, label]) => `
            <option
              value="${v}"
              ${f.scope === v ? "selected" : ""}
            >
              ${label}
            </option>
          `).join("")}
        </select>
      </label>

      <label>
        Semester

        <select name="semester">
          ${semesterOptions(f.semester)}
        </select>
      </label>

      <label>
        Search

        <input
          name="search"
          value="${h(f.search)}"
          placeholder="Subject, code or teacher"
        >
      </label>

      <button type="submit">Apply filters</button>
    </form>

    <div class="class-grid">
      ${visible.map(c => {
        const a = attendanceSummary(
          state.attendance.filter(
            s => s.class_id === c.id
          )
        );

        return `
          <article class="panel class-card">
            <div class="section-heading">
              ${badge(c.code)}

              ${badge(
                isCurrent(c) ? "Current" : "Previous",
                isCurrent(c) ? "present" : "neutral"
              )}
            </div>

            <h2>${h(c.name)}</h2>
            <p class="muted">${h(c.semester)}</p>

            <div class="teacher-line">
              <small>TEACHER</small>
              <strong>${h(c.teacher_name)}</strong>
            </div>

            <div class="routine">
              ${c.weekly_slots.map(slot => `
                <p>
                  <strong>${h(days[slot.day])}</strong>
                  <span>${h(slot.start)}–${h(slot.end)}</span>
                  <small>${h(slot.room || "Room not set")}</small>
                </p>
              `).join("") || `
                <p class="muted">
                  Weekly routine not assigned.
                </p>
              `}
            </div>

            <p class="course-summary">
              ${a.attended} attended /
              ${a.total} recorded classes
              · ${percent(a.percentage)}
            </p>

            <a
              class="button secondary"
              href="#attendance?class=${encodeURIComponent(c.id)}"
            >
              View class records →
            </a>
          </article>
        `;
      }).join("") || empty(
        "No classes match your selection"
      )}
    </div>
  `;
}

/* Attendance */

function attendancePage() {
  const f = filters.attendance;

  const classes = state.classes.filter(c =>
    (!f.semester || c.semester === f.semester) &&
    (!f.class_id || c.id === f.class_id)
  );

  const ids = new Set(classes.map(c => c.id));

  const rows = state.attendance.filter(s =>
    ids.has(s.class_id) &&
    (!f.from || s.lesson_date >= f.from) &&
    (!f.to || s.lesson_date <= f.to)
  );

  const a = attendanceSummary(rows);

  return `
    <form
      class="panel filter-form"
      data-kind="filter-attendance"
    >
      <label>
        Semester

        <select name="semester">
          ${semesterOptions(f.semester)}
        </select>
      </label>

      <label>
        Subject

        <select name="class_id">
          ${options(
            state.classes.map(c => [
              c.id,
              c.code + " — " + c.name + " · " + c.semester
            ]),
            f.class_id,
            "All subjects"
          )}
        </select>
      </label>

      <label>
        From

        <input
          type="date"
          name="from"
          value="${h(f.from)}"
        >
      </label>

      <label>
        To

        <input
          type="date"
          name="to"
          value="${h(f.to)}"
          max="${h(state.today)}"
        >
      </label>

      <button type="submit">Apply filters</button>

      <button
        type="button"
        class="secondary"
        data-reset="attendance"
      >
        Reset
      </button>
    </form>

    ${stats([
      ["Recorded classes", a.total],
      ["Attended", a.attended, "green"],
      ["Absent", a.counts.Absent, "red"],
      ["Excused", a.counts.Excused],
      ["Not marked", a.counts["Not marked"]],
      ["Attendance", percent(a.percentage), "blue"]
    ])}

    <p class="info-note">
      Only ended sessions with saved attendance count towards totals.
      Present + Late = Attended.
      Excused and Not marked remain in the recorded-class total
      and are shown separately from Absent.
      ${a.pending} past session(s) are awaiting attendance
      and are excluded from the total.
    </p>

    ${panel(
      "Attendance by subject",
      "Totals follow the selected filters",

      table(
        [
          "Subject",
          "Semester",
          "Classes",
          "Attended",
          "Absent",
          "Excused",
          "Not marked",
          "%"
        ],

        classes.map(c => {
          const s = attendanceSummary(
            rows.filter(row => row.class_id === c.id)
          );

          return `
            <tr>
              <td>
                <strong>${h(c.name)}</strong>
                <small>${h(c.code)}</small>
              </td>

              <td>${h(c.semester)}</td>
              <td>${s.total}</td>

              <td>
                ${s.attended}
                <small>
                  ${s.counts.Present} present
                  · ${s.counts.Late} late
                </small>
              </td>

              <td>${s.counts.Absent}</td>
              <td>${s.counts.Excused}</td>
              <td>${s.counts["Not marked"]}</td>
              <td>${percent(s.percentage)}</td>
            </tr>
          `;
        })
      )
    )}

    ${panel(
      "Class records",
      "Date and saved status for each past session",

      table(
        ["Date", "Subject", "Time", "Topic", "Status"],

        rows.map(s => `
          <tr>
            <td>${h(s.lesson_date)}</td>

            <td>
              <strong>${h(s.name)}</strong>
              <small>
                ${h(s.code)} · ${h(s.semester)}
              </small>
            </td>

            <td class="nowrap">
              ${h(s.start_time)}–${h(s.end_time)}
            </td>

            <td>${h(s.topic || "Class session")}</td>

            <td>
              ${statusBadge(
                s.counted
                  ? s.status
                  : "Awaiting attendance"
              )}
            </td>
          </tr>
        `)
      )
    )}
  `;
}

/* Results page */

function resultsPage() {
  const overall = overallResult();

  const running = state.classes.filter(
    c => c.semester === currentSemester()
  );

  const runningResult = resultSummary(running);

  return panel(
    "Overall result",
    "Fully graded previous semesters",

    stats([
      ["Completed semesters", overall.semesters],
      ["Graded subjects", overall.count],

      [
        "Total marks",
        overall.count
          ? number(overall.earned) + " / " + number(overall.maximum)
          : "—"
      ],

      [
        "Average percentage",
        percent(overall.average),
        "green"
      ]
    ]) + `
      <p class="info-note">
        Average = total earned marks ÷ total maximum marks × 100.
        The running semester and incomplete semesters are excluded.
        GPA/CGPA is not calculated.
      </p>

      ${!currentSemester() ? `
        <p class="warning-note">
          Admin has not assigned your running semester.
          Overall average will be available after it is set.
        </p>
      ` : ""}
    `
  ) + panel(
    "Running semester result",
    currentSemester() || "Not assigned",

    currentSemester()
      ? `
        <p class="info-note">
          ${runningResult.count} of
          ${runningResult.subjects} subjects fully graded.

          ${
            runningResult.complete
              ? "All listed marks are available."
              : "Result is in progress. Missing marks are not zero."
          }
        </p>

        ${resultTable(running)}
      `
      : empty(
          "Running semester not assigned",
          "Ask your Admin to set your current semester."
        )
  ) + panel(
    "Semester history",
    "Open a semester to see its subject marks",

    semesterResults()
      .filter(term => term.name !== currentSemester())
      .map(term => `
        <details class="semester-record">
          <summary>
            <span>
              <strong>${h(term.name)}</strong>
              <small>
                ${term.count} / ${term.subjects}
                subjects fully graded
              </small>
            </span>

            ${
              term.complete
                ? badge(percent(term.average), "present")
                : badge("In progress")
            }
          </summary>

          ${resultTable(term.classes)}
        </details>
      `).join("") || empty(
        "No previous semester results"
      )
  );
}

/* Notices */

function noticesPage() {
  const query = filters.notices.search
    .toLocaleLowerCase()
    .trim();

  const visible = state.notices.filter(n =>
    [n.title, n.body, n.author_name]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query)
  );

  return `
    <form
      class="panel filter-form"
      data-kind="filter-notices"
    >
      <label>
        Search notices

        <input
          name="search"
          value="${h(filters.notices.search)}"
          placeholder="Title, message or sender"
        >
      </label>

      <button type="submit">Search</button>
    </form>

    ${panel(
      "My inbox",
      visible.length + " notices",
      noticeCards(visible)
    )}
  `;
}

/* Profile */

function field(label, name, value = "", extra = "") {
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
  const p = state.profile;

  return `
    <section class="panel profile-banner">
      <span class="profile-avatar">
        ${h((p.name || "S").slice(0, 1))}
      </span>

      <div>
        <span class="eyebrow">STUDENT ACCOUNT</span>
        <h2>${h(p.name)}</h2>
        <p>${h(p.email)}</p>
      </div>
    </section>

    <div class="two-columns">
      <form
        class="panel profile-form"
        data-kind="profile"
      >
        <div class="section-heading">
          <h2>Personal information</h2>
        </div>

        ${field(
          "Full name",
          "name",
          p.name,
          'required maxlength="100" autocomplete="name"'
        )}

        ${field(
          "Student ID",
          "student_no",
          p.student_no,
          "readonly"
        )}

        ${field(
          "Email",
          "email",
          p.email,
          'type="email" readonly'
        )}

        ${field(
          "Department",
          "department",
          p.department,
          "readonly"
        )}

        ${field(
          "Current semester",
          "semester",
          p.semester,
          "readonly"
        )}

        ${field(
          "Phone",
          "phone",
          p.phone,
          'type="tel" maxlength="150" autocomplete="tel"'
        )}

        <p class="muted">
          Contact Admin to change academic information or email.
        </p>

        <button type="submit">Save profile →</button>
      </form>

      <form
        class="panel profile-form"
        data-kind="password"
      >
        <div class="section-heading">
          <h2>Change password</h2>
        </div>

        ${field(
          "Current password",
          "current_password",
          "",
          'type="password" required autocomplete="current-password"'
        )}

        ${field(
          "New password",
          "new_password",
          "",
          'type="password" required minlength="8" maxlength="128" autocomplete="new-password"'
        )}

        ${field(
          "Confirm new password",
          "confirm_password",
          "",
          'type="password" required minlength="8" maxlength="128" autocomplete="new-password"'
        )}

        <p class="muted">
          Sign in again after changing your password.
        </p>

        <button type="submit">Change password →</button>
      </form>
    </div>
  `;
}

/* Navigation */

function render() {
  if (!state) return;

  const [route, query = ""] = location.hash
    .slice(1)
    .split("?");

  const page = Object.hasOwn(titles, route)
    ? route
    : "dashboard";

  const params = new URLSearchParams(query);

  if (
    page === "attendance" &&
    params.has("class")
  ) {
    const selected = params.get("class");

    if (state.classes.some(c => c.id === selected)) {
      filters.attendance.class_id = selected;
      filters.attendance.semester = "";
    }
  }

  $("page-title").textContent = titles[page];
  $("today").textContent = state.today;

  document.querySelectorAll("[data-student-name]")
    .forEach(el => {
      el.textContent = state.profile.name;
    });

  document.querySelectorAll("[data-initial]")
    .forEach(el => {
      el.textContent = (
        state.profile.name || "S"
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
    attendance: attendancePage,
    results: resultsPage,
    notices: noticesPage,
    profile: profilePage
  };

  $("student-content").innerHTML = `
    <header class="page-intro">
      <div>
        <span class="eyebrow">STUDENT WORKSPACE</span>

        <h1>
          ${
            page === "dashboard"
              ? "Welcome back, " + h(state.profile.name) + "."
              : titles[page]
          }
        </h1>

        <p>${descriptions[page]}</p>
      </div>

      ${badge(
        "ID: " + (
          state.profile.student_no || "Not assigned"
        )
      )}
    </header>

    ${pages[page]()}
  `;

  $("student-content").hidden = false;

  if (busy) lock(true);
}

function friendly(error) {
  return ({
    "auth/invalid-credential":
      "Current password is incorrect.",

    "auth/wrong-password":
      "Current password is incorrect.",

    "auth/weak-password":
      "Choose a stronger password.",

    "auth/too-many-requests":
      "Too many attempts. Please try later.",

    "auth/requires-recent-login":
      "Please sign in again before changing your password."
  })[error.code] ||
    error.message ||
    "Something went wrong. Please retry.";
}

/* Forms */

$("student-content").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy) return;

    const form = event.target;

    const data = Object.fromEntries(
      new FormData(form)
    );

    const kind = form.dataset.kind;

    if (kind?.startsWith("filter-")) {
      const key = kind.slice(7);

      if (
        key === "attendance" &&
        data.from &&
        data.to &&
        data.from > data.to
      ) {
        message(
          "Choose an end date on or after the start date.",
          true
        );
        return;
      }

      filters[key] = data;

      if (
        key === "attendance" &&
        location.hash.includes("?")
      ) {
        history.replaceState(
          null,
          "",
          "#attendance"
        );
      }

      render();
      message("");
      return;
    }

    if (!["profile", "password"].includes(kind)) {
      return;
    }

    if (
      kind === "password" &&
      (
        data.new_password.length < 8 ||
        data.new_password.length > 128 ||
        data.new_password !== data.confirm_password
      )
    ) {
      message(
        "Use matching new passwords of 8–128 characters.",
        true
      );
      return;
    }

    lock(true);
    message("Saving…");

    let changed = false;

    try {
      if (kind === "profile") {
        const result = await api("/profile", {
          name: data.name.trim(),
          phone: data.phone.trim()
        });

        state.profile = result.profile;
        render();
        message(result.message);
      } else {
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
      }
    } catch (error) {
      message(
        changed
          ? "Password changed. Sign in again with the new password."
          : friendly(error),
        true
      );
    } finally {
      lock(false);
    }
  }
);

/* Reset attendance filters */

$("student-content").addEventListener(
  "click",
  event => {
    if (
      busy ||
      !event.target.closest(
        "[data-reset='attendance']"
      )
    ) {
      return;
    }

    filters.attendance = freshFilters().attendance;

    history.replaceState(
      null,
      "",
      "#attendance"
    );

    render();
    message("");
  }
);

/* Refresh */

$("student-refresh").addEventListener(
  "click",
  async () => {
    if (busy) return;

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

/* Logout */

$("student-logout").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy) return;

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
    if (!busy) render();
  }
);

/* Authentication */

onAuthStateChanged(auth, async user => {
  const current = ++version;

  state = null;
  $("student-content").hidden = true;
  $("student-retry").hidden = true;

  if (activeUid !== user?.uid) {
    filters = freshFilters();
    activeUid = user?.uid || "";
  }

  if (!user) {
    location.replace(
      "/login.html?role=student"
    );
    return;
  }

  lock(true);
  message("Loading your student workspace…");

  try {
    await refresh();

    if (current !== version) return;

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