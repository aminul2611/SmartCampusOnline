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

const dayNames = [
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
  teachers: "Teacher Details",
  students: "Student Details",
  classes: "Class Setup",
  notices: "Notices",
  profile: "Profile"
};

let state = {
  users: [],
  classes: [],
  enrolments: [],
  notices: [],
  received: [],
  profile: null,
  overview: null
};

let page = "dashboard";
let busy = false;
let ready = false;
let authVersion = 0;
let selectedClass = "";

const edits = {
  teacher: null,
  student: null,
  class: null,
  notice: null
};

function campusDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  return ["year", "month", "day"]
    .map(type => parts.find(part => part.type === type).value)
    .join("-");
}

function message(text, error = false) {
  const element = $("message");

  element.textContent = text;
  element.className =
    "message " + (error ? "error" : "success");
  element.hidden = !text;

  if (text) {
    element.scrollIntoView({
      block: "nearest",
      behavior: "smooth"
    });
  }
}

function withDeadline(promise, milliseconds = 25000) {
  let timer;

  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          "Connection timed out. Check your internet and retry."
        ));
      }, milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

async function api(path, body) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please sign in again.");
  }

  const token = await withDeadline(user.getIdToken());
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 70000);

  try {
    const response = await fetch("/api" + path, {
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
        "Admin API is unavailable. Open port 5003 locally, " +
        "or deploy Functions and Hosting together."
      );
    }

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(
        result.message || "The request failed."
      );
    }

    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "The server did not respond in time. " +
        "Keep the same values and retry; check the saved list " +
        "before creating another record."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  const [
    directory,
    classes,
    notices,
    profile,
    overview
  ] = await Promise.all([
    api("/directory"),
    api("/classes"),
    api("/notices"),
    api("/profile"),
    api("/overview?date=" + campusDate())
  ]);

  state = {
    users: directory.users,
    classes: classes.classes,
    enrolments: classes.enrolments,
    notices: notices.notices,
    received: notices.received || [],
    profile: profile.profile,
    overview
  };

  for (const collection of ["users", "classes", "notices"]) {
    state[collection].sort((a, b) =>
      (a.name || a.title || "").localeCompare(
        b.name || b.title || ""
      )
    );
  }

  $("admin-name").textContent = state.profile.name;
  $("admin-email").textContent = state.profile.email;
}

function setBusy(value) {
  busy = value;
  $("working").hidden = !value;

  document.querySelectorAll("button").forEach(button => {
    button.disabled = value;
  });

  $("content").setAttribute("aria-busy", String(value));
}

async function mutate(path, data, after = () => {}) {
  if (busy) return;

  setBusy(true);
  message("Saving changes…");

  try {
    const result = await api(path, data);

    after(result);

    try {
      await refresh();
      render();
      message(result.message || "Saved successfully.");
    } catch (error) {
      message(
        "Your change was saved, but the list could not refresh. " +
        "Use Refresh. " + error.message,
        true
      );
    }
  } catch (error) {
    message(error.message, true);
  } finally {
    setBusy(false);
  }
}

function values(form) {
  const data = Object.fromEntries(new FormData(form));

  for (const field of Object.keys(data)) {
    if (!field.includes("password")) {
      data[field] = data[field].trim();
    }
  }

  return data;
}

function input(
  label,
  name,
  value = "",
  type = "text",
  required = true,
  maximum = 150
) {
  return `
    <label>
      ${h(label)}
      <input
        name="${h(name)}"
        type="${h(type)}"
        value="${h(value)}"
        maxlength="${maximum}"
        ${required ? "required" : ""}
        ${type === "password"
          ? 'minlength="8" autocomplete="new-password"'
          : ""}
      >
    </label>
  `;
}

function select(
  label,
  name,
  items,
  value = "",
  required = true
) {
  return `
    <label>
      ${h(label)}
      <select
        name="${h(name)}"
        ${required ? "required" : ""}
      >
        <option value="">Select…</option>

        ${items.map(([id, text]) => `
          <option
            value="${h(id)}"
            ${id === value ? "selected" : ""}
          >
            ${h(text)}
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

function textarea(
  label,
  name,
  value = "",
  maximum = 5000,
  required = false
) {
  return `
    <label class="full">
      ${h(label)}
      <textarea
        name="${h(name)}"
        maxlength="${maximum}"
        rows="4"
        ${required ? "required" : ""}
      >${h(value)}</textarea>
    </label>
  `;
}

function button(
  text,
  action,
  id = "",
  kind = "secondary"
) {
  return `
    <button
      type="button"
      class="${kind}"
      data-action="${action}"
      data-id="${h(id)}"
    >
      ${h(text)}
    </button>
  `;
}

function who(uid) {
  return state.users.find(user => user.id === uid)?.name ||
    "Account unavailable";
}

function className(id) {
  const classroom = state.classes.find(item => item.id === id);

  return classroom
    ? `${classroom.code} · ${classroom.name}`
    : "Class unavailable";
}

function badge(active) {
  return `
    <span class="badge ${active ? "" : "off"}">
      ${active ? "Active" : "Disabled"}
    </span>
  `;
}

function table(headings, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            ${headings.map(text =>
              `<th scope="col">${h(text)}</th>`
            ).join("")}
          </tr>
        </thead>

        <tbody>
          ${rows.join("") || `
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

function searchBox(placeholder = "Type to filter…") {
  return `
    <label class="search">
      Search
      <input
        id="directory-search"
        type="search"
        placeholder="${h(placeholder)}"
      >
    </label>

    <p id="search-empty" class="empty" hidden>
      No matching records.
    </p>
  `;
}

function resetButton(type) {
  return button("Cancel editing", "cancel", type);
}

function render() {
  if (!ready) return;

  const requested = location.hash.slice(1);

  page = Object.hasOwn(labels, requested)
    ? requested
    : "dashboard";

  $("page-title").textContent = labels[page];
  $("page-date").textContent = campusDate();

  document.querySelectorAll("nav a").forEach(link => {
    const active = link.hash === "#" + page;

    link.classList.toggle("active", active);

    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  const renderers = {
    dashboard,
    teachers: () => accounts("teacher"),
    students: () => accounts("student"),
    classes: classesPage,
    notices: noticesPage,
    profile: profilePage
  };

  $("content").innerHTML = renderers[page]();

  connectSpecialInputs();
}

function dashboard() {
  const { totals, attendance, date } = state.overview;

  return `
    <section class="welcome">
      <span class="eyebrow">CAMPUS OVERVIEW</span>
      <h1>Welcome, ${h(state.profile.name)}</h1>
      <p>
        Manage your campus accounts, classes and announcements.
      </p>
    </section>

    <div class="stats">
      ${Object.entries(totals).map(([name, value]) => `
        <a class="stat" href="#${name}">
          <span>${h(labels[name] || name)}</span>
          <strong>${h(value)}</strong>
        </a>
      `).join("")}
    </div>

    <section class="card">
      <h2>Attendance · ${h(date)}</h2>

      <div class="stats small">
        <div class="stat">
          <span>Teacher check-ins</span>
          <strong>${attendance.teacher_checkins}</strong>
        </div>

        <div class="stat">
          <span>Student present records</span>
          <strong>${attendance.student_present}</strong>
        </div>

        <div class="stat">
          <span>Student absent records</span>
          <strong>${attendance.student_absent}</strong>
        </div>
      </div>

      <p class="muted">
        Counts reflect saved records for this date.
        Attendance entry will be connected with
        the Teacher and Student workspaces.
      </p>
    </section>

    <section class="card">
      <h2>Recent notices</h2>

      ${state.overview.recent_notices.map(notice => `
        <article class="notice">
          <h3>${h(notice.title)}</h3>
          <p class="pre">${h(notice.body)}</p>
        </article>
      `).join("") ||
        '<p class="empty">No notices published yet.</p>'}
    </section>
  `;
}

function accounts(role) {
  const person = edits[role];
  const teacher = role === "teacher";
  const title = teacher ? "Teacher" : "Student";

  const users = state.users.filter(user => user.role === role);

  const placeholder = teacher
    ? "Teacher ID, name, email or department"
    : "Semester, Student ID, name, email, program or department";

  const rows = users.map(user => {
    const search = [
      user.student_no,
      user.teacher_no,
      user.name,
      user.semester,
      user.email,
      user.department,
      user.program,
      user.phone,
      user.designation
    ]
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC")
      .toLowerCase();

    const actions = user.provisioning === "pending"
      ? '<span class="muted">Retry the original creation form with the same values.</span>'
      : button("Edit", "edit-" + role, user.id) +
        button(
          user.active ? "Disable" : "Enable",
          "status-" + role,
          user.id
        ) +
        button("Reset password", "password-" + role, user.id);

    return `
      <tr data-search="${h(search)}">
        <td>
          <span class="directory-id">
            ${h(user[role + "_no"] || "—")}
          </span>
        </td>

        <td>
          <div class="directory-person">
            <span class="directory-avatar">
              ${h(
                (user.name || title).slice(0, 1).toUpperCase()
              )}
            </span>

            <div>
              <strong>${h(user.name)}</strong>
              <small>
                ${h(user.designation || user.program || title)}
              </small>
            </div>
          </div>
        </td>

        ${teacher ? "" : `
          <td>
            <span class="semester-tag">
              ${h(user.semester || "—")}
            </span>
          </td>
        `}

        <td>${h(user.email)}</td>
        <td>${h(user.department || "—")}</td>

        <td>
          ${user.provisioning === "pending"
            ? '<span class="badge off">Creation incomplete</span>'
            : badge(user.active)}
        </td>

        <td>
          <div class="row-actions">${actions}</div>
        </td>
      </tr>
    `;
  });

  return `
    <div class="directory-heading">
      <div>
        <span class="eyebrow">
          ${teacher ? "TEACHING TEAM" : "STUDENT DIRECTORY"}
        </span>

        <h1>${title} Details</h1>

        <p>
          ${teacher
            ? "Manage your teaching team and account access."
            : "Find students by semester, ID, name and campus details."}
        </p>
      </div>

      <div class="directory-total">
        <strong>${users.length}</strong>
        <span>Total ${role}s</span>
      </div>
    </div>

    <details class="card" ${person ? "open" : ""}>
      <summary>
        ${person ? "Edit " + title : "＋ Add " + role}
      </summary>

      <form
        id="account-form"
        data-role="${role}"
        data-id="${h(person?.id || "")}"
      >
        <div class="fields">
          ${input(
            title + " ID",
            role + "_no",
            person?.[role + "_no"] || "",
            "text",
            true,
            80
          )}

          ${input(
            "Full name", "name",
            person?.name || "",
            "text", true, 100
          )}

          ${input(
            "Email address", "email",
            person?.email || "",
            "email", true, 254
          )}

          ${input(
            "Department", "department",
            person?.department || "",
            "text", false
          )}

          ${input(
            "Phone", "phone",
            person?.phone || "",
            "tel", false
          )}

          ${teacher
            ? input(
                "Designation", "designation",
                person?.designation || "",
                "text", false
              )
            : input(
                "Program", "program",
                person?.program || "",
                "text", false
              ) +
              input(
                "Semester", "semester",
                person?.semester || "",
                "text", false, 80
              )}

          ${person
            ? select(
                "Account status",
                "active",
                [["1", "Active"], ["0", "Disabled"]],
                person.active ? "1" : "0"
              )
            : input(
                "Initial password", "new_password",
                "", "password", true, 128
              ) +
              input(
                "Confirm password", "confirm_password",
                "", "password", true, 128
              )}
        </div>

        <div class="actions">
          <button type="submit">
            ${person ? "Save changes" : "Create " + role} →
          </button>

          ${person ? resetButton(role) : ""}
        </div>
      </form>
    </details>

    <section class="card directory-card">
      <div class="heading">
        <h2>All ${role}s</h2>
        ${searchBox(placeholder)}
      </div>

      ${table(
        teacher
          ? [
              "Teacher ID",
              "Teacher name",
              "Email",
              "Department",
              "Status",
              "Actions"
            ]
          : [
              "Student ID",
              "Student name",
              "Semester",
              "Email",
              "Department",
              "Status",
              "Actions"
            ],
        rows
      )}
    </section>

    <dialog id="password-dialog">
      <form id="reset-password-form" data-role="${role}">
        <h2>Reset ${role} password</h2>

        <p id="password-person"></p>
        <input type="hidden" name="uid">

        ${input(
          "New password", "new_password",
          "", "password", true, 128
        )}

        ${input(
          "Confirm password", "confirm_password",
          "", "password", true, 128
        )}

        <div class="actions">
          <button type="submit">Reset password</button>
          ${button("Cancel", "close-password")}
        </div>
      </form>
    </dialog>

    ${teacher ? `
      <section class="card">
        <h2>Teacher attendance</h2>
        <a href="./teachers.html">
          Open monthly teacher attendance →
        </a>
      </section>
    ` : ""}
  `;
}

function slotRow(
  slot = {
    day: 1,
    start: "09:00",
    end: "10:00",
    room: ""
  }
) {
  return `
    <div class="slot">
      ${select(
        "Day",
        "day",
        dayNames.map((name, index) => [String(index), name]),
        String(slot.day)
      )}

      ${input("Start", "start", slot.start, "time")}
      ${input("End", "end", slot.end, "time")}
      ${input("Room", "room", slot.room, "text", false, 80)}

      ${button("Remove", "remove-slot")}
    </div>
  `;
}

function classesPage() {
  const classroom = edits.class;

  const teachers = state.users
    .filter(user =>
      user.role === "teacher" &&
      user.active &&
      user.provisioning !== "pending"
    )
    .map(user => [user.id, user.name]);

  const current = state.classes.find(
    item => item.id === selectedClass
  );

  const enrolled = state.enrolments.filter(item =>
    item.class_id === selectedClass &&
    item.active !== false
  );

  const students = state.users.filter(user =>
    user.role === "student" &&
    user.active &&
    user.provisioning !== "pending" &&
    !enrolled.some(item => item.student_id === user.id)
  );

  const classRows = state.classes.map(item => `
    <tr data-search="${h([
      item.code,
      item.name,
      item.semester,
      who(item.teacher_id)
    ].join(" ").toLowerCase())}">
      <td>
        <strong>${h(item.code)}</strong>
        <br>
        ${h(item.name)}
        <br>
        ${badge(item.active !== false)}
      </td>

      <td>${h(item.semester)}</td>
      <td>${h(who(item.teacher_id))}</td>

      <td>
        ${(item.weekly_slots || []).map(slot =>
          `${h(dayNames[slot.day])} ` +
          `${h(slot.start)}–${h(slot.end)} ${h(slot.room)}`
        ).join("<br>")}
      </td>

      <td>
        ${state.enrolments.filter(enrolment =>
          enrolment.class_id === item.id &&
          enrolment.active !== false
        ).length}
      </td>

      <td class="row-actions">
        ${button("Edit", "edit-class", item.id)}
        ${button("Students", "roster", item.id)}

        ${button(
          item.active === false ? "Restore" : "Archive",
          "status-class",
          item.id
        )}
      </td>
    </tr>
  `);

  return `
    <div class="heading">
      <div>
        <span class="eyebrow">COURSE DIRECTORY</span>
        <h1>Class Setup</h1>
        <p>
          Assign teachers, weekly routines and student enrolments.
        </p>
      </div>
    </div>

    <section class="card">
      <h2>${classroom ? "Edit class" : "Create class"}</h2>

      <form
        id="class-form"
        data-id="${h(classroom?.id || "")}"
      >
        <div class="fields">
          ${input(
            "Unique class code", "code",
            classroom?.code || "",
            "text", true, 80
          )}

          ${input(
            "Subject name", "name",
            classroom?.name || ""
          )}

          ${input(
            "Semester", "semester",
            classroom?.semester || "",
            "text", true, 80
          )}

          ${select(
            "Assigned teacher", "teacher_id",
            teachers,
            classroom?.teacher_id || ""
          )}
        </div>

        <h3>Weekly routine</h3>

        <div id="slots">
          ${(classroom?.weekly_slots || [undefined])
            .map(slotRow).join("")}
        </div>

        ${button("＋ Add time slot", "add-slot")}

        <div class="actions">
          <button type="submit">Save class →</button>
          ${classroom ? resetButton("class") : ""}
        </div>
      </form>
    </section>

    <section class="card">
      <div class="heading">
        <h2>Saved classes</h2>
        ${searchBox()}
      </div>

      ${table(
        [
          "Class",
          "Semester",
          "Teacher",
          "Weekly routine",
          "Students",
          "Actions"
        ],
        classRows
      )}
    </section>

    <section class="card" id="roster">
      <h2>Student enrolment</h2>

      <label>
        Choose class

        <select id="roster-class">
          <option value="">Select…</option>

          ${state.classes.map(item => `
            <option
              value="${h(item.id)}"
              ${item.id === selectedClass ? "selected" : ""}
            >
              ${h(item.code + " · " + item.name)}
              ${item.active === false ? " (archived)" : ""}
            </option>
          `).join("")}
        </select>
      </label>

      ${current ? `
        <h3>${h(className(current.id))}</h3>

        ${current.active === false
          ? `
            <p class="muted">
              Restore this class before adding students.
            </p>
          `
          : `
            <form
              id="enrolment-form"
              data-id="${h(current.id)}"
            >
              <div class="fields">
                ${select(
                  "Student",
                  "student_id",
                  students.map(user => [
                    user.id,
                    `${user.name} · ${user.student_no || user.email}`
                  ])
                )}
              </div>

              <button type="submit">Enrol student</button>
            </form>
          `}

        ${table(
          ["Student", "Student ID", "Action"],
          enrolled.map(enrolment => `
            <tr>
              <td>${h(who(enrolment.student_id))}</td>

              <td>
                ${h(
                  state.users.find(user =>
                    user.id === enrolment.student_id
                  )?.student_no || "—"
                )}
              </td>

              <td>
                ${button(
                  "Remove enrolment",
                  "unenrol",
                  enrolment.student_id,
                  "danger"
                )}
              </td>
            </tr>
          `)
        )}
      ` : `
        <p class="empty">
          Select a class to manage its students.
        </p>
      `}
    </section>
  `;
}

function noticeDate(value) {
  const seconds = value?.seconds ?? value?._seconds;

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

function noticesPage() {
  const notice = edits.notice;
  const received = state.received || [];

  const incoming = received.map(item => {
    const teacher = state.users.find(
      user => user.id === item.created_by
    );

    const search = [
      item.title,
      item.body,
      item.author_name,
      teacher?.teacher_no
    ]
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC")
      .toLowerCase();

    return `
      <article
        class="notice received-notice"
        data-search="${h(search)}"
      >
        <div class="notice-meta">
          <span class="badge">From teacher</span>
          <span>${h(noticeDate(item.created_at))}</span>
        </div>

        <h3>${h(item.title)}</h3>

        <p class="notice-sender">
          ${h(item.author_name || teacher?.name || "Teacher")}
          ${teacher?.teacher_no
            ? " · " + h(teacher.teacher_no)
            : ""}
        </p>

        <p class="pre">${h(item.body)}</p>
      </article>
    `;
  }).join("");

  return `
    <div class="heading">
      <div>
        <h1>Notices</h1>
        <p>
          Read teacher messages and manage campus announcements.
        </p>
      </div>

      ${searchBox("Title, message, teacher name or Teacher ID")}
    </div>

    <section class="card">
      <div class="heading">
        <h2>Received from teachers</h2>
        <span class="badge">${received.length} notices</span>
      </div>

      <p class="muted">
        Messages teachers sent to Admin appear here.
        Use Refresh above to load new notices.
      </p>

      ${incoming ||
        '<p class="empty">No teacher notices received yet.</p>'}
    </section>

    <section class="card">
      <h2>${notice ? "Edit notice" : "Publish notice"}</h2>

      <form
        id="notice-form"
        data-id="${h(notice?.id || "")}"
      >
        <div class="fields">
          ${input(
            "Title", "title",
            notice?.title || "",
            "text", true, 140
          )}

          ${select(
            "Audience",
            "audience",
            [
              ["all", "All campus users"],
              ["teachers", "All teachers"],
              ["students", "All students"],
              ["selected", "Selected people"]
            ],
            notice?.audience || "all"
          )}

          ${textarea(
            "Message", "body",
            notice?.body || "",
            10000, true
          )}

          <label class="full" id="recipient-field">
            Selected recipients
            (Ctrl / Cmd to select several)

            <select name="recipient_ids" multiple size="7">
              ${state.users
                .filter(user =>
                  user.active &&
                  user.provisioning !== "pending"
                )
                .map(user => `
                  <option
                    value="${h(user.id)}"
                    ${notice?.recipient_ids?.includes(user.id)
                      ? "selected"
                      : ""}
                  >
                    ${h(
                      `${user.name} · ${user.role} · ${user.email}`
                    )}
                  </option>
                `).join("")}
            </select>
          </label>
        </div>

        <div class="actions">
          <button type="submit">
            ${notice ? "Save changes" : "Publish notice"} →
          </button>

          ${notice ? resetButton("notice") : ""}
        </div>
      </form>
    </section>

    <section class="card">
      <h2>Published by Admin</h2>

      ${state.notices.map(item => `
        <article
          class="notice"
          data-search="${h(
            [item.title, item.body, item.audience]
              .join(" ")
              .normalize("NFKC")
              .toLowerCase()
          )}"
        >
          <span class="badge">
            ${h(
              item.audience === "selected"
                ? `${item.recipient_ids.length} selected people`
                : item.audience
            )}
          </span>

          <h3>${h(item.title)}</h3>
          <p class="pre">${h(item.body)}</p>

          <div class="actions">
            ${button("Edit", "edit-notice", item.id)}

            ${button(
              "Remove", "remove-notice", item.id, "danger"
            )}
          </div>
        </article>
      `).join("") ||
        '<p class="empty">No Admin notices published yet.</p>'}
    </section>
  `;
}

function profilePage() {
  const profile = state.profile;

  return `
    <h1>Administrator profile</h1>

    <section class="card">
      <h2>Account details</h2>
      <p>${h(profile.email)} · Administrator</p>

      <form id="profile-form">
        <div class="fields">
          ${input(
            "Full name", "name",
            profile.name,
            "text", true, 100
          )}

          ${input(
            "Phone", "phone",
            profile.phone || "",
            "tel", false
          )}

          ${input(
            "Department", "department",
            profile.department || "",
            "text", false
          )}
        </div>

        <div class="actions">
          <button type="submit">Save profile →</button>
        </div>
      </form>
    </section>

    <section class="card">
      <h2>Change your password</h2>

      <p class="muted">
        Confirm your current password.
        After a successful change you will sign in again.
      </p>

      <form id="own-password-form">
        <div class="fields">
          ${input(
            "Current password", "current_password",
            "", "password", true, 128
          )}

          ${input(
            "New password", "new_password",
            "", "password", true, 128
          )}

          ${input(
            "Confirm new password", "confirm_password",
            "", "password", true, 128
          )}
        </div>

        <div class="actions">
          <button type="submit">Change password →</button>
        </div>
      </form>
    </section>
  `;
}

function connectSpecialInputs() {
  if (edits.class && $("class-form")) {
    $("class-form").elements.code.readOnly = true;
  }

  const passwordForm = $("own-password-form");

  if (passwordForm) {
    passwordForm.elements.current_password.autocomplete =
      "current-password";

    passwordForm.elements.current_password
      .removeAttribute("minlength");
  }

  const noticeForm = $("notice-form");

  if (noticeForm) {
    const toggle = () => {
      $("recipient-field").hidden =
        noticeForm.elements.audience.value !== "selected";
    };

    noticeForm.elements.audience.addEventListener(
      "change",
      toggle
    );

    toggle();
  }

  $("roster-class")?.addEventListener("change", event => {
    selectedClass = event.target.value;
    render();
    $("roster").scrollIntoView({ block: "start" });
  });

  $("directory-search")?.addEventListener("input", event => {
    const terms = event.target.value
      .normalize("NFKC")
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    let count = 0;

    document.querySelectorAll("[data-search]").forEach(row => {
      const value = row.dataset.search
        .normalize("NFKC")
        .toLowerCase();

      row.hidden = !terms.every(term => value.includes(term));

      if (!row.hidden) count++;
    });

    $("search-empty").hidden =
      count > 0 || terms.length === 0;
  });
}

function requestId(type) {
  const storageKey = "smart-campus.pending-" + type;
  let value = sessionStorage.getItem(storageKey);

  if (!/^[a-f0-9]{32}$/.test(value || "")) {
    value = crypto.randomUUID().replaceAll("-", "");
    sessionStorage.setItem(storageKey, value);
  }

  return value;
}

function validPassword(data) {
  if (
    data.new_password.length < 8 ||
    data.new_password.length > 128
  ) {
    throw new Error(
      "Use 8–128 characters for the password."
    );
  }

  if (data.new_password !== data.confirm_password) {
    throw new Error("Passwords do not match.");
  }
}

$("content").addEventListener("submit", async event => {
  event.preventDefault();

  if (busy) return;

  const form = event.target;
  const data = values(form);
  const record = form.dataset.id;

  try {
    if (form.id === "account-form") {
      const role = form.dataset.role;

      if (record) {
        data.active = data.active === "1";

        await mutate(
          `/${role}s/${encodeURIComponent(record)}/account`,
          data,
          () => {
            edits[role] = null;
          }
        );
      } else {
        validPassword(data);
        data.request_id = requestId(role);

        await mutate("/" + role + "s", data, () => {
          sessionStorage.removeItem(
            "smart-campus.pending-" + role
          );
        });
      }
    } else if (form.id === "reset-password-form") {
      validPassword(data);

      await mutate(
        `/${form.dataset.role}s/${encodeURIComponent(data.uid)}/password`,
        data,
        () => {
          $("password-dialog").close();
        }
      );
    } else if (form.id === "class-form") {
      data.weekly_slots = [
        ...document.querySelectorAll(".slot")
      ].map(row => ({
        day: Number(row.querySelector('[name="day"]').value),
        start: row.querySelector('[name="start"]').value,
        end: row.querySelector('[name="end"]').value,
        room: row.querySelector('[name="room"]').value.trim()
      }));

      await mutate(
        record
          ? `/classes/${encodeURIComponent(record)}/save`
          : "/classes",
        data,
        () => {
          edits.class = null;
        }
      );
    } else if (form.id === "enrolment-form") {
      await mutate(
        `/classes/${encodeURIComponent(record)}/enrolments`,
        data
      );
    } else if (form.id === "notice-form") {
      if (!record) {
        data.request_id = requestId("notice");
      }

      data.recipient_ids = [
        ...form.elements.recipient_ids.selectedOptions
      ].map(option => option.value);

      await mutate(
        record
          ? `/notices/${encodeURIComponent(record)}/save`
          : "/notices",
        data,
        () => {
          edits.notice = null;
          sessionStorage.removeItem(
            "smart-campus.pending-notice"
          );
        }
      );
    } else if (form.id === "profile-form") {
      await mutate("/profile", data);
    } else if (form.id === "own-password-form") {
      validPassword(data);

      setBusy(true);
      message("Updating password…");

      try {
        const user = auth.currentUser;

        await withDeadline(
          reauthenticateWithCredential(
            user,
            EmailAuthProvider.credential(
              user.email,
              data.current_password
            )
          )
        );

        await withDeadline(
          updatePassword(user, data.new_password)
        );

        await signOut(auth);
        location.replace("/login.html?role=admin");
      } finally {
        setBusy(false);
      }
    }
  } catch (error) {
    message(error.message, true);
  }
});

$("content").addEventListener("click", async event => {
  const target = event.target.closest("[data-action]");

  if (!target || busy) return;

  const action = target.dataset.action;
  const uid = target.dataset.id;

  if (action === "cancel") {
    edits[uid] = null;
    render();
    return;
  }

  if (action === "add-slot") {
    if (document.querySelectorAll(".slot").length < 21) {
      $("slots").insertAdjacentHTML("beforeend", slotRow());
    }

    return;
  }

  if (action === "remove-slot") {
    if (document.querySelectorAll(".slot").length > 1) {
      target.closest(".slot").remove();
    } else {
      message("Keep at least one weekly time slot.", true);
    }

    return;
  }

  if (action === "roster") {
    selectedClass = uid;
    render();
    $("roster").scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (action === "close-password") {
    $("password-dialog").close();
    return;
  }

  if (action === "unenrol") {
    if (confirm(
      "Remove this enrolment? Previous records will remain."
    )) {
      await mutate(
        `/classes/${encodeURIComponent(selectedClass)}/enrolments/${encodeURIComponent(uid)}/remove`,
        {}
      );
    }

    return;
  }

  for (const role of ["teacher", "student"]) {
    const person = state.users.find(user =>
      user.id === uid && user.role === role
    );

    if (action === "edit-" + role && person) {
      edits[role] = person;
      render();
      $("account-form").scrollIntoView({
        behavior: "smooth"
      });
      return;
    }

    if (action === "status-" + role && person) {
      if (confirm(
        `${person.active ? "Disable" : "Enable"} ${person.name}?`
      )) {
        await mutate(
          `/${role}s/${encodeURIComponent(uid)}/status`,
          { active: !person.active }
        );
      }

      return;
    }

    if (action === "password-" + role && person) {
      const form = $("reset-password-form");

      form.reset();
      form.elements.uid.value = uid;

      $("password-person").textContent =
        person.name + " · " + person.email;

      $("password-dialog").showModal();
      return;
    }
  }

  for (const type of ["class", "notice"]) {
    const collection =
      type === "class" ? "classes" : type + "s";

    const record = state[collection].find(
      item => item.id === uid
    );

    if (action === "edit-" + type && record) {
      edits[type] = record;
      render();

      $(type + "-form").scrollIntoView({
        behavior: "smooth"
      });

      return;
    }

    if (action === "remove-" + type && record) {
      if (confirm(`Remove this ${type}?`)) {
        await mutate(
          `/${collection}/${encodeURIComponent(uid)}/remove`,
          {}
        );
      }

      return;
    }

    if (
      action === "status-class" &&
      type === "class" &&
      record
    ) {
      if (confirm(
        `${record.active === false ? "Restore" : "Archive"} this class?`
      )) {
        await mutate(
          `/classes/${encodeURIComponent(uid)}/status`,
          { active: record.active === false }
        );
      }

      return;
    }
  }
});

window.addEventListener("hashchange", () => {
  if (busy) {
    message("Wait for the current save to finish.", true);
    return;
  }

  message("");
  render();
});

$("refresh").addEventListener("click", async () => {
  if (busy) return;

  setBusy(true);

  try {
    await refresh();
    render();
    message("Workspace refreshed.");
  } catch (error) {
    message(error.message, true);
  } finally {
    setBusy(false);
  }
});

$("logout").addEventListener("click", async () => {
  if (busy) return;

  try {
    await signOut(auth);
  } catch (error) {
    message(error.message, true);
  }
});

$("retry").addEventListener("click", () => {
  location.reload();
});

onAuthStateChanged(auth, async user => {
  const version = ++authVersion;

  ready = false;
  $("workspace").hidden = true;
  $("loading").hidden = false;

  if (!user) {
    location.replace("/login.html?role=admin");
    return;
  }

  try {
    $("loading-text").textContent =
      "Checking administrator and loading campus data…";

    await refresh();

    if (version !== authVersion) return;

    ready = true;
    $("loading").hidden = true;
    $("workspace").hidden = false;

    render();
  } catch (error) {
    $("loading-text").textContent = error.message;
    $("retry").hidden = false;
  }
});