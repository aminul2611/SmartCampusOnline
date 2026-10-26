import { auth } from './firebase-config.js';

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const $ = id => document.getElementById(id);

const h = value => String(value ?? '')
  .replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));

const labels = {
  dashboard: 'Dashboard',
  teachers: 'Teacher Management',
  students: 'Student Management',
  classes: 'Class Setup',
  reports: 'Student Academic Reports',
  notices: 'Notices',
  profile: 'Admin Profile'
};

const days = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
];

let state = {
  users: [],
  classes: [],
  enrolments: [],
  notices: [],
  received: [],
  conflicts: [],
  profile: null,
  overview: null
};

let busy = false;
let ready = false;
let version = 0;
let uid = '';
let page = 'dashboard';
let selectedClass = '';
let report = null;
let work = null;
let refreshNeeded = false;

let edits = {
  teacher: null,
  student: null,
  class: null,
  notice: null
};

let directorySearch = '';
let classSearch = '';

let reportFilter = {
  semester: '',
  class_id: '',
  from: '',
  to: ''
};

function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  return ['year', 'month', 'day']
    .map(name => parts.find(part => part.type === name).value)
    .join('-');
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').className =
    'flash ' + (error ? 'danger' : 'success');

  $('message').hidden = !text;
}

function lock(value) {
  busy = value;
  $('working').hidden = !value;

  document.querySelectorAll('button')
    .forEach(button => button.disabled = value);

  $('content').setAttribute(
    'aria-busy',
    String(value)
  );
}

async function api(path, body) {
  const user = auth.currentUser;
  if (!user) throw Error('Please sign in again.');

  let tokenTimer;

  const token = await Promise.race([
    user.getIdToken(),

    new Promise((resolve, reject) => {
      tokenTimer = setTimeout(
        () => reject(
          Error('Login check timed out. Please retry.')
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
    const response = await fetch('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',

      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },

      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),

      signal: controller.signal
    });

    if (
      !(response.headers.get('content-type') || '')
        .includes('application/json')
    ) {
      throw Error(
        'Admin information is unavailable. Please retry.'
      );
    }

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw Error(data.message || 'Request failed.');
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Error(
        'Request timed out. Refresh saved information before retrying.'
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function identity() {
  document.querySelectorAll('[data-admin-name]')
    .forEach(element => {
      element.textContent =
        state.profile?.name || 'Administrator';
    });

  document.querySelectorAll('[data-admin-initial]')
    .forEach(element => {
      element.textContent =
        (state.profile?.name || 'A')
          .slice(0, 1)
          .toUpperCase();
    });

  $('admin-email').textContent =
    state.profile?.email || '';
}

async function refresh() {
  const account = await api('/profile');

  if (account.profile.id !== auth.currentUser?.uid) {
    throw Error('Account changed. Please reload.');
  }

  state.profile = account.profile;
  identity();

  const [
    directory,
    classes,
    notices,
    overview,
    conflicts
  ] = await Promise.all([
    api('/directory'),
    api('/classes'),
    api('/notices'),
    api('/overview?date=' + today()),
    api('/schedule-conflicts')
  ]);

  if (account.profile.id !== auth.currentUser?.uid) {
    throw Error('Account changed. Please reload.');
  }

  state = {
    ...state,
    users: directory.users,
    classes: classes.classes,
    enrolments: classes.enrolments,
    notices: notices.notices,
    received: notices.received || [],
    overview,
    conflicts: conflicts.conflicts
  };

  state.users.sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );

  refreshNeeded = false;
}

async function mutate(
  path,
  data,
  after = () => {}
) {
  if (busy) return;

  if (refreshNeeded) {
    message(
      'The last change was saved. Use Refresh before making another change.',
      true
    );
    return;
  }

  lock(true);
  message('Saving…');

  let saved = false;

  try {
    const result = await api(path, data);

    saved = true;
    refreshNeeded = true;

    after(result);
    await refresh();

    render();
    message(result.message || 'Saved.');
  } catch (error) {
    message(
      (
        saved
          ? 'Saved, but the workspace could not refresh. Use Refresh. '
          : ''
      ) + error.message,
      true
    );
  } finally {
    lock(false);
  }
}

function requestId(type) {
  const storageKey =
    'smart-campus.admin.' + uid + '.' + type;

  let value = sessionStorage.getItem(storageKey);

  if (!/^[a-f0-9]{32}$/.test(value || '')) {
    value = crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(storageKey, value);
  }

  return value;
}

function clearId(type) {
  sessionStorage.removeItem(
    'smart-campus.admin.' + uid + '.' + type
  );
}

const nameOf = id =>
  state.users.find(user => user.id === id)?.name ||
  'Account unavailable';

const classOf = id =>
  state.classes.find(classroom => classroom.id === id);

const number = value =>
  Number(value).toLocaleString('en-GB', {
    maximumFractionDigits: 2
  });

const percentage = value =>
  value == null ? '—' : number(value) + '%';

function badge(text, tone = 'neutral') {
  return `<span class="badge ${tone}">${h(text)}</span>`;
}

function button(
  text,
  action,
  id = '',
  danger = false
) {
  return `
    <button
      type="button"
      class="${danger ? 'danger' : 'secondary'}"
      data-action="${action}"
      data-id="${h(id)}"
    >${h(text)}</button>
  `;
}

function field(
  label,
  name,
  value = '',
  type = 'text',
  extra = ''
) {
  return `
    <label>
      ${h(label)}
      <input
        name="${name}"
        type="${type}"
        value="${h(value)}"
        ${extra}
      >
    </label>
  `;
}

function select(
  label,
  name,
  items,
  value = '',
  required = false
) {
  return `
    <label>
      ${h(label)}
      <select name="${name}" ${required ? 'required' : ''}>
        <option value="">Select…</option>
        ${items.map(([id, text]) => `
          <option
            value="${h(id)}"
            ${id === value ? 'selected' : ''}
          >${h(text)}</option>
        `).join('')}
      </select>
    </label>
  `;
}

function panel(
  title,
  body,
  copy = '',
  extra = ''
) {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>${h(title)}</h2>
          ${copy ? `<p>${h(copy)}</p>` : ''}
        </div>
        ${extra}
      </div>
      ${body}
    </section>
  `;
}

function table(head, rows) {
  return `
    <div
      class="table-wrap"
      tabindex="0"
      role="region"
      aria-label="Scrollable data table"
    >
      <table>
        <thead>
          <tr>
            ${head.map(text =>
              `<th scope="col">${h(text)}</th>`
            ).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.join('') || `
            <tr>
              <td colspan="${head.length}" class="empty-state">
                No records to display.
              </td>
            </tr>
          `}
        </tbody>
      </table>
    </div>
  `;
}

function metrics(items) {
  return `
    <div class="metrics">
      ${items.map(([label, value]) => `
        <article class="metric">
          <span>${h(label)}</span>
          <strong>${h(value)}</strong>
        </article>
      `).join('')}
    </div>
  `;
}

function termList() {
  return [
    ...new Set([
      ...state.classes.map(classroom => classroom.semester),
      ...state.users.map(user => user.semester)
    ].filter(Boolean))
  ].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function dateTime(value) {
  if (value == null) return '—';

  const seconds = value?.seconds ?? value?._seconds;
  const parsed = new Date(
    seconds != null ? seconds * 1000 : value
  );

  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit'
      }).format(parsed)
    : '—';
}

function noticeCards(items) {
  return items.map(notice => `
    <details class="notice-card">
      <summary>${h(notice.title)}</summary>
      <small>${h(notice.author_name || 'Campus')}</small>
      <div class="notice-body">${h(notice.body)}</div>
    </details>
  `).join('') || '<p class="empty-state">No notices yet.</p>';
}

function dashboard() {
  const overview = state.overview;
  const attendance = overview.attendance;

  return metrics(
    Object.entries(overview.totals).map(
      ([name, value]) => [labels[name] || name, value]
    )
  ) +

  panel(
    'Attendance · ' + overview.date,

    metrics([
      ['Teacher check-ins', attendance.teacher_checkins],
      ['Sessions', attendance.sessions],
      ['Present records', attendance.Present],
      ['Late records', attendance.Late],
      ['Absent records', attendance.Absent],
      ['Excused records', attendance.Excused]
    ]) +

    `<p class="info-note">
      Student figures count saved attendance records,
      not unique people. Open Academic Reports for student totals.
    </p>`
  ) +

  panel(
    'Schedule checks',

    state.conflicts.length
      ? `
        <p class="warning-note">
          ${state.conflicts.length} existing conflict(s) need attention.
        </p>
        <a class="button secondary" href="#classes">
          Review conflicts →
        </a>
      `
      : `
        <p class="info-note">
          No conflicts found in the current active timetable.
        </p>
      `
  ) +

  panel(
    'Latest notices',
    noticeCards(overview.recent_notices)
  );
}

function accounts(role) {
  const edit = edits[role];
  const isStudent = role === 'student';

  const users = state.users.filter(
    user => user.role === role
  );

  const visible = users.filter(user =>
    [
      user.name,
      user.email,
      user[role + '_no'],
      user.semester,
      user.department
    ]
      .join(' ')
      .toLowerCase()
      .includes(directorySearch.toLowerCase())
  );

  return `
    <details class="panel" ${edit ? 'open' : ''}>
      <summary>
        ${edit ? 'Edit ' + role : '＋ Create ' + role}
      </summary>

      <form
        data-kind="account"
        data-role="${role}"
        data-id="${h(edit?.id || '')}"
      >
        <div class="form-grid">
          ${field(
            isStudent ? 'Student ID' : 'Teacher ID',
            role + '_no',
            edit?.[role + '_no'],
            'text',
            'required maxlength="80"'
          )}

          ${field(
            'Full name',
            'name',
            edit?.name,
            'text',
            'required maxlength="100"'
          )}

          ${field(
            'Email',
            'email',
            edit?.email,
            'email',
            'required maxlength="254"'
          )}

          ${field(
            'Department',
            'department',
            edit?.department,
            'text',
            'maxlength="150"'
          )}

          ${field(
            'Phone',
            'phone',
            edit?.phone,
            'tel',
            'maxlength="150"'
          )}

          ${
            isStudent
              ? field(
                  'Program',
                  'program',
                  edit?.program,
                  'text',
                  'maxlength="150"'
                ) +
                select(
                  'Current semester',
                  'semester',
                  termList().map(term => [term, term]),
                  edit?.semester
                )
              : field(
                  'Designation',
                  'designation',
                  edit?.designation,
                  'text',
                  'maxlength="150"'
                )
          }

          ${
            edit
              ? select(
                  'Account status',
                  'active',
                  [['1', 'Active'], ['0', 'Disabled']],
                  edit.active ? '1' : '0',
                  true
                )
              : field(
                  'Initial password',
                  'new_password',
                  '',
                  'password',
                  'required minlength="8" maxlength="128" autocomplete="new-password"'
                ) +
                field(
                  'Confirm password',
                  'confirm_password',
                  '',
                  'password',
                  'required minlength="8" maxlength="128" autocomplete="new-password"'
                )
          }
        </div>

        ${
          isStudent
            ? `
              <p class="info-note">
                Semester choices come from Class Setup and existing
                student profiles. Create the class semester first
                when adding a new term.
              </p>
            `
            : ''
        }

        <div class="form-footer">
          <button type="submit">
            ${edit ? 'Save changes' : 'Create account'}
          </button>

          ${edit ? button('Cancel', 'cancel', role) : ''}
        </div>
      </form>
    </details>
  ` +

  panel(
    'All ' + role + 's',

    `
      <form class="filter-form" data-kind="directory-search">
        ${field(
          'Search ID, name, email or semester',
          'search',
          directorySearch
        )}
        <button type="submit">Search</button>
      </form>
    ` +

    table(
      [
        isStudent ? 'Student ID' : 'Teacher ID',
        'Name',
        'Email',
        isStudent ? 'Current semester' : 'Department',
        'Status',
        'Actions'
      ],

      visible.map(user => `
        <tr>
          <td>${h(user[role + '_no'] || '—')}</td>
          <td><strong>${h(user.name)}</strong></td>
          <td>${h(user.email)}</td>
          <td>${h(isStudent ? user.semester : user.department)}</td>

          <td>
            ${badge(
              user.provisioning === 'pending'
                ? 'Provisioning'
                : user.active
                  ? 'Active'
                  : 'Disabled',

              user.active ? 'present' : 'neutral'
            )}
          </td>

          <td class="actions">
            ${
              user.provisioning === 'pending'
                ? '<small>Retry the original creation request.</small>'
                : button('Edit', 'edit-' + role, user.id) +
                  button(
                    user.active ? 'Disable' : 'Enable',
                    'status-' + role,
                    user.id
                  ) +
                  button(
                    'Reset password',
                    'password-' + role,
                    user.id
                  ) +
                  (
                    isStudent
                      ? button('Academic report', 'report', user.id)
                      : button('Classes', 'teacher-classes', user.id)
                  )
            }
          </td>
        </tr>
      `)
    ),

    users.length + ' accounts'
  ) +

  (isStudent ? '' : teacherAttendance());
}

function teacherAttendance() {
  const month = work?.month || today().slice(0, 7);

  const records = (work?.records || []).filter(record =>
    !work?.teacher ||
    record.teacher_id === work.teacher
  );

  const rows = records.map(record => {
    const checkIn =
      record.check_in?.seconds ??
      record.check_in?._seconds;

    const checkOut =
      record.check_out?.seconds ??
      record.check_out?._seconds;

    const minutes =
      checkIn != null && checkOut != null
        ? Math.max(0, Math.floor((checkOut - checkIn) / 60))
        : null;

    return `
      <tr>
        <td>${h(record.work_date)}</td>
        <td>${h(nameOf(record.teacher_id))}</td>
        <td>${h(dateTime(record.check_in))}</td>
        <td>${h(dateTime(record.check_out))}</td>
        <td>
          ${
            minutes == null
              ? '—'
              : Math.floor(minutes / 60) +
                'h ' +
                minutes % 60 +
                'm'
          }
        </td>
      </tr>
    `;
  });

  return panel(
    'Monthly teacher attendance',

    `
      <form data-kind="teacher-attendance" class="filter-form">
        ${field('Month', 'month', month, 'month', 'required')}

        ${select(
          'Teacher (blank = all)',
          'teacher_id',

          state.users
            .filter(user => user.role === 'teacher')
            .map(user => [user.id, user.name]),

          work?.teacher || ''
        )}

        <button type="submit">View attendance</button>
      </form>
    ` +

    (
      work
        ? table(
            ['Date', 'Teacher', 'Check-in', 'Check-out', 'Duration'],
            rows
          )
        : `
          <p class="empty-state">
            Select a month to load saved work attendance.
          </p>
        `
    )
  );
}

function slot(value = {
  day: 0,
  start: '09:00',
  end: '10:00',
  room: ''
}) {
  return `
    <div class="slot">
      ${select(
        'Day',
        'day',
        days.map((name, index) => [String(index), name]),
        String(value.day),
        true
      )}

      ${field('Start', 'start', value.start, 'time', 'required')}
      ${field('End', 'end', value.end, 'time', 'required')}

      ${field(
        'Room',
        'room',
        value.room,
        'text',
        'maxlength="80"'
      )}

      ${button('Remove', 'remove-slot')}
    </div>
  `;
}

function conflictsTable() {
  return state.conflicts.length
    ? table(
        [
          'Person',
          'Date',
          'First class',
          'Time',
          'Second class',
          'Time'
        ],

        state.conflicts.map(conflict => `
          <tr>
            <td>
              ${h(conflict.person_name)}
              <small>${h(conflict.kind)}</small>
            </td>
            <td>${h(conflict.date)}</td>
            <td>${h(conflict.name_a)}</td>
            <td>${h(conflict.time_a)}</td>
            <td>${h(conflict.name_b)}</td>
            <td>${h(conflict.time_b)}</td>
          </tr>
        `)
      )
    : `
      <p class="info-note">
        No active schedule conflicts found.
      </p>
    `;
}

function classesPage() {
  const edit = edits.class;
  const current = classOf(selectedClass);

  const enrolled = state.enrolments.filter(
    enrolment => enrolment.class_id === selectedClass
  );

  const active = enrolled.filter(
    enrolment => enrolment.active !== false
  );

  const eligible = state.users.filter(user =>
    user.role === 'student' &&
    user.active &&
    user.provisioning !== 'pending' &&
    !active.some(
      enrolment => enrolment.student_id === user.id
    )
  );

  const visible = state.classes.filter(classroom =>
    [
      classroom.code,
      classroom.name,
      classroom.semester,
      classroom.academic_session,
      classroom.section,
      nameOf(classroom.teacher_id)
    ]
      .join(' ')
      .toLowerCase()
      .includes(classSearch.toLowerCase())
  );

  return panel(
    'Existing schedule conflicts',
    conflictsTable(),
    'Resolve these by changing future routines, teacher assignment or enrolments.'
  ) +

  `
    <details class="panel" ${edit ? 'open' : ''}>
      <summary>${edit ? 'Edit class' : '＋ Create class'}</summary>

      <form data-kind="class" data-id="${h(edit?.id || '')}">
        <div class="form-grid">
          ${field(
            'Subject code',
            'code',
            edit?.code,
            'text',
            `required maxlength="80" ${edit ? 'readonly' : ''}`
          )}

          ${field(
            'Subject name',
            'name',
            edit?.name,
            'text',
            'required maxlength="150"'
          )}

          ${
            edit
              ? field(
                  'Semester',
                  'semester',
                  edit.semester,
                  'text',
                  'required readonly'
                )
              : select(
                  'Semester',
                  'semester',
                  [
                    ...termList().map(term => [term, term]),
                    ['__new', '＋ New semester']
                  ],
                  '',
                  true
                ) +
                field(
                  'New semester name (when New semester is selected)',
                  'new_semester',
                  '',
                  'text',
                  'maxlength="80"'
                )
          }

          ${field(
            'Academic session',
            'academic_session',
            edit?.academic_session,
            'text',
            `maxlength="80" ${edit ? 'readonly' : ''}`
          )}

          ${field(
            'Section',
            'section',
            edit?.section,
            'text',
            `maxlength="80" ${edit ? 'readonly' : ''}`
          )}

          ${select(
            'Assigned teacher',
            'teacher_id',

            state.users
              .filter(user =>
                user.role === 'teacher' &&
                (user.active || user.id === edit?.teacher_id)
              )
              .map(user => [
                user.id,
                user.name + (user.active ? '' : ' (disabled)')
              ]),

            edit?.teacher_id,
            true
          )}

          ${field(
            'Class starts (optional)',
            'start_date',
            edit?.start_date,
            'date'
          )}

          ${field(
            'Class ends (optional)',
            'end_date',
            edit?.end_date,
            'date'
          )}

          ${field(
            'Assessment maximum',
            'assessment_max',
            edit?.assessment_max ?? 20,
            'number',
            'required min="0" max="10000" step="any"'
          )}

          ${field(
            'Midterm maximum',
            'mid_max',
            edit?.mid_max ?? 30,
            'number',
            'required min="0" max="10000" step="any"'
          )}

          ${field(
            'Final maximum',
            'final_max',
            edit?.final_max ?? 50,
            'number',
            'required min="0" max="10000" step="any"'
          )}
        </div>

        <p class="info-note">
          Use class dates to separate different teaching terms.
          When dates are blank, the routine is treated as open-ended.
          Subject code, semester, session and section are fixed after creation.
        </p>

        <h3>Weekly routine</h3>

        <div id="slots">
          ${(edit?.weekly_slots || [undefined]).map(slot).join('')}
        </div>

        ${button('＋ Add weekly slot', 'add-slot')}

        <div class="form-footer">
          <button type="submit">Save class</button>
          ${edit ? button('Cancel', 'cancel', 'class') : ''}
        </div>
      </form>
    </details>
  ` +

  panel(
    'Saved classes',

    `
      <form data-kind="class-search" class="filter-form">
        ${field(
          'Search subject, semester or teacher',
          'search',
          classSearch
        )}
        <button type="submit">Search</button>
      </form>
    ` +

    table(
      [
        'Class',
        'Semester / session',
        'Teacher',
        'Routine',
        'Status',
        'Actions'
      ],

      visible.map(classroom => `
        <tr>
          <td>
            <strong>${h(classroom.code)}</strong>
            ${h(classroom.name)}
            <small>${h(classroom.section)}</small>
          </td>

          <td>
            ${h(classroom.semester)}
            <small>${h(classroom.academic_session)}</small>
          </td>

          <td>${h(nameOf(classroom.teacher_id))}</td>

          <td>
            ${(classroom.weekly_slots || []).map(value =>
              `${h(days[value.day])} ${h(value.start)}–${h(value.end)}`
            ).join('<br>')}
          </td>

          <td>
            ${badge(
              classroom.active === false ? 'Archived' : 'Active',
              classroom.active === false ? 'neutral' : 'present'
            )}
          </td>

          <td class="actions">
            ${button('Edit', 'edit-class', classroom.id)}
            ${button('Students', 'roster', classroom.id)}

            ${button(
              classroom.active === false ? 'Restore' : 'Archive',
              'status-class',
              classroom.id
            )}
          </td>
        </tr>
      `)
    )
  ) +

  panel(
    'Student enrolment',

    select(
      'Choose class',
      'roster_class',

      state.classes.map(classroom => [
        classroom.id,

        classroom.code +
          ' — ' +
          classroom.name +
          ' · ' +
          classroom.semester +
          (classroom.active === false ? ' (archived)' : '')
      ]),

      selectedClass
    ) +

    (
      current
        ? `
          <h3 class="roster-heading">${h(current.name)}</h3>

          ${
            current.active === false
              ? `
                <p class="info-note">
                  Restore the class before adding students.
                </p>
              `
              : `
                <form
                  data-kind="enrolment"
                  data-id="${h(current.id)}"
                  class="filter-form"
                >
                  ${select(
                    'Student',
                    'student_id',

                    eligible.map(user => [
                      user.id,
                      (user.student_no || '—') + ' — ' + user.name
                    ]),

                    '',
                    true
                  )}

                  ${field(
                    'Joining date',
                    'joined_on',
                    today(),
                    'date',
                    `required max="${today()}"`
                  )}

                  <button type="submit">Enrol student</button>
                </form>
              `
          }

          ${table(
            ['Student', 'ID', 'Joining date', 'Action'],

            active.map(enrolment => `
              <tr>
                <td>${h(nameOf(enrolment.student_id))}</td>

                <td>
                  ${h(
                    state.users.find(user =>
                      user.id === enrolment.student_id
                    )?.student_no || '—'
                  )}
                </td>

                <td>
                  ${h(
                    enrolment.periods?.at(-1)?.from ||
                    enrolment.joined_on ||
                    '—'
                  )}
                </td>

                <td>
                  ${button(
                    'Close enrolment',
                    'unenrol',
                    enrolment.student_id,
                    true
                  )}
                </td>
              </tr>
            `)
          )}

          <details class="semester-record">
            <summary>Enrolment history</summary>

            ${table(
              ['Student', 'Joined', 'Left', 'Status'],

              enrolled.flatMap(enrolment =>
                (enrolment.periods || []).map(period => `
                  <tr>
                    <td>${h(nameOf(enrolment.student_id))}</td>

                    <td>
                      ${h(period.from)}
                      ${
                        period.inferred
                          ? '<small>Legacy dates</small>'
                          : ''
                      }
                    </td>

                    <td>${h(period.to || '—')}</td>
                    <td>${badge(period.to ? 'Closed' : 'Current')}</td>
                  </tr>
                `)
              )
            )}
          </details>
        `
        : `
          <p class="empty-state">
            Select a class to manage enrolments.
          </p>
        `
    )
  );
}

function courseResult(course) {
  const keys = ['assessment', 'mid', 'final'];

  const complete = keys.every(name =>
    course[name] != null &&
    course[name] !== '' &&
    Number.isFinite(Number(course[name])) &&
    Number(course[name]) >= 0 &&
    Number(course[name]) <= Number(course[name + '_max'])
  );

  const maximum = keys.reduce(
    (sum, name) => sum + Number(course[name + '_max']),
    0
  );

  return {
    complete: complete && maximum > 0,

    earned: complete
      ? keys.reduce(
          (sum, name) => sum + Number(course[name]),
          0
        )
      : null,

    max: maximum
  };
}

function resultSummary(classes) {
  const results = classes
    .map(courseResult)
    .filter(result => result.complete);

  const earned = results.reduce(
    (sum, result) => sum + result.earned,
    0
  );

  const maximum = results.reduce(
    (sum, result) => sum + result.max,
    0
  );

  return {
    count: results.length,
    total: classes.length,
    earned,
    max: maximum,
    average: maximum ? earned * 100 / maximum : null,

    complete:
      classes.length > 0 &&
      results.length === classes.length
  };
}

function marksTable(classes) {
  return table(
    [
      'Subject',
      'Semester',
      'Assessment',
      'Midterm',
      'Final',
      'Total',
      '%'
    ],

    classes.map(course => {
      const result = courseResult(course);

      return `
        <tr>
          <td>
            <strong>${h(course.name)}</strong>
            <small>
              ${h(course.code)} ·
              ${h(course.academic_session)} ·
              ${h(course.section)}
            </small>
          </td>

          <td>${h(course.semester)}</td>

          ${['assessment', 'mid', 'final'].map(name => `
            <td>
              ${
                course[name] == null
                  ? '—'
                  : h(number(course[name]))
              }
              / ${h(number(course[name + '_max']))}
            </td>
          `).join('')}

          <td>
            ${
              result.complete
                ? number(result.earned) + ' / ' + number(result.max)
                : badge('Pending')
            }
          </td>

          <td>
            ${percentage(
              result.complete
                ? result.earned * 100 / result.max
                : null
            )}
          </td>
        </tr>
      `;
    })
  );
}

function attendanceSummary(rows) {
  const summary = {
    Present: 0,
    Late: 0,
    Absent: 0,
    Excused: 0,
    'Not marked': 0
  };

  rows
    .filter(row => row.counted)
    .forEach(row => summary[row.status]++);

  const total = Object.values(summary)
    .reduce((sum, value) => sum + value, 0);

  return {
    ...summary,
    total,
    attended: summary.Present + summary.Late,
    pending: rows.filter(row => !row.counted).length,

    percentage: total
      ? (summary.Present + summary.Late) * 100 / total
      : null
  };
}

function reportsPage() {
  const students = state.users.filter(
    user => user.role === 'student'
  );

  const body = `
    <form data-kind="load-report" class="filter-form">
      ${field(
        'Find Student ID, name or email',
        'student_search',
        '',
        'search',
        'id="student-search"'
      )}

      ${select(
        'Student',
        'student_id',

        students.map(user => [
          user.id,
          (user.student_no || '—') + ' — ' + user.name
        ]),

        report?.profile.id || '',
        true
      )}

      <button type="submit">View academic report</button>
    </form>
  `;

  if (!report) {
    return panel(
      'Student academic reports',
      body,
      'Select a student to view marks, semester averages and attendance.'
    );
  }

  const profile = report.profile;
  const current = report.current_semester;

  const terms = [
    ...new Set(
      report.classes.map(course => course.semester)
    )
  ].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  const previous = terms.filter(term =>
    current &&
    term !== current &&
    term !== 'Semester not assigned' &&
    resultSummary(
      report.classes.filter(course => course.semester === term)
    ).complete
  );

  const overall = resultSummary(
    report.classes.filter(course =>
      previous.includes(course.semester)
    )
  );

  const running = report.classes.filter(
    course => course.semester === current
  );

  const filteredClasses = report.classes.filter(course =>
    (
      !reportFilter.semester ||
      course.semester === reportFilter.semester
    ) &&
    (
      !reportFilter.class_id ||
      course.id === reportFilter.class_id
    )
  );

  const ids = new Set(
    filteredClasses.map(course => course.id)
  );

  const rows = report.attendance.filter(session =>
    ids.has(session.class_id) &&
    (!reportFilter.from || session.lesson_date >= reportFilter.from) &&
    (!reportFilter.to || session.lesson_date <= reportFilter.to)
  );

  const attendance = attendanceSummary(rows);

  return panel(
    'Student academic reports',
    body
  ) +

  panel(
    profile.name,

    `
      <p class="muted">
        ${h(profile.student_no)} ·
        ${h(profile.email)} ·
        ${h(profile.department)} ·
        Running: ${h(current || 'Not assigned')}
      </p>
    `
  ) +

  panel(
    'Overall result',

    metrics([
      ['Completed earlier semesters', previous.length],
      ['Fully graded subjects', overall.count],

      [
        'Earned / maximum',
        overall.count
          ? number(overall.earned) + ' / ' + number(overall.max)
          : '—'
      ],

      ['Weighted average', percentage(overall.average)]
    ]) +

    `
      <p class="info-note">
        Only fully graded previous semesters are included.
        Average = total earned ÷ total maximum × 100.
        Running and incomplete semesters are excluded;
        no GPA/CGPA is inferred.
      </p>
    `
  ) +

  panel(
    'Running semester result',

    current
      ? marksTable(running)
      : `
        <p class="warning-note">
          Assign the student’s current semester in Student Management.
        </p>
      `,

    current || 'Not assigned'
  ) +

  panel(
    'Semester history',

    terms
      .filter(term => term !== current)
      .map(term => {
        const classes = report.classes.filter(
          course => course.semester === term
        );

        const summary = resultSummary(classes);

        return `
          <details class="semester-record">
            <summary>
              ${h(term)}
              ${badge(
                summary.complete
                  ? percentage(summary.average)
                  : 'In progress'
              )}
            </summary>

            ${marksTable(classes)}
          </details>
        `;
      })
      .join('') ||

      '<p class="empty-state">No previous semester records.</p>'
  ) +

  panel(
    'Attendance filters',

    `
      <form data-kind="report-filter" class="filter-form">
        ${select(
          'Semester (blank = all)',
          'semester',
          terms.map(term => [term, term]),
          reportFilter.semester
        )}

        ${select(
          'Subject (blank = all)',
          'class_id',

          report.classes.map(course => [
            course.id,
            course.code + ' — ' + course.name + ' · ' + course.semester
          ]),

          reportFilter.class_id
        )}

        ${field('From', 'from', reportFilter.from, 'date')}

        ${field(
          'To',
          'to',
          reportFilter.to,
          'date',
          `max="${today()}"`
        )}

        <button type="submit">Apply</button>
        ${button('Reset', 'reset-report')}
      </form>
    `
  ) +

  panel(
    'Student attendance',

    metrics([
      ['Recorded classes', attendance.total],
      ['Attended', attendance.attended],
      ['Absent', attendance.Absent],
      ['Excused', attendance.Excused],
      ['Not marked', attendance['Not marked']],
      ['Attendance', percentage(attendance.percentage)]
    ]) +

    `
      <p class="info-note">
        Present + Late count as attended.
        Excused and Not marked remain in the recorded-class total.
        ${attendance.pending} past sessions awaiting attendance are excluded.
      </p>
    ` +

    table(
      [
        'Subject',
        'Recorded',
        'Attended',
        'Absent',
        'Excused',
        'Not marked',
        '%'
      ],

      filteredClasses.map(course => {
        const summary = attendanceSummary(
          rows.filter(row => row.class_id === course.id)
        );

        return `
          <tr>
            <td>
              <strong>${h(course.name)}</strong>
              <small>${h(course.semester)} · ${h(course.code)}</small>
            </td>
            <td>${summary.total}</td>
            <td>${summary.attended}</td>
            <td>${summary.Absent}</td>
            <td>${summary.Excused}</td>
            <td>${summary['Not marked']}</td>
            <td>${percentage(summary.percentage)}</td>
          </tr>
        `;
      })
    )
  ) +

  panel(
    'Dated class records',

    table(
      ['Date', 'Subject', 'Time', 'Status'],

      rows.map(session => `
        <tr>
          <td>${h(session.lesson_date)}</td>

          <td>
            ${h(session.name)}
            <small>
              ${h(session.semester)} · ${h(session.code)}
            </small>
          </td>

          <td>
            ${h(session.start_time)}–${h(session.end_time)}
          </td>

          <td>
            ${badge(
              session.counted
                ? session.status
                : 'Awaiting attendance',

              session.status === 'Present'
                ? 'present'
                : session.status === 'Absent'
                  ? 'absent'
                  : 'neutral'
            )}
          </td>
        </tr>
      `)
    )
  );
}

function noticesPage() {
  const edit = edits.notice;

  return panel(
    edit ? 'Edit notice' : 'Publish notice',

    `
      <form data-kind="notice" data-id="${h(edit?.id || '')}">
        <div class="form-grid">
          ${field(
            'Title',
            'title',
            edit?.title,
            'text',
            'required maxlength="140"'
          )}

          ${select(
            'Audience',
            'audience',

            [
              ['all', 'Everyone'],
              ['teachers', 'All teachers'],
              ['students', 'All students'],
              ['selected', 'Selected recipients']
            ],

            edit?.audience || 'all',
            true
          )}

          <label class="full">
            Selected recipients
            <select name="recipient_ids" multiple size="6">
              ${
                state.users
                  .filter(user =>
                    user.active &&
                    user.provisioning !== 'pending'
                  )
                  .map(user => `
                    <option
                      value="${h(user.id)}"
                      ${
                        edit?.recipient_ids?.includes(user.id)
                          ? 'selected'
                          : ''
                      }
                    >
                      ${h(user.name)} ·
                      ${h(user.role)} ·
                      ${h(user.student_no || user.teacher_no || user.email)}
                    </option>
                  `)
                  .join('')
              }
            </select>
            <small>Used only for Selected recipients.</small>
          </label>

          <label class="full">
            Message
            <textarea
              name="body"
              rows="6"
              required
              maxlength="10000"
            >${h(edit?.body)}</textarea>
          </label>
        </div>

        <div class="form-footer">
          <button type="submit">
            ${edit ? 'Save notice' : 'Publish notice'}
          </button>

          ${edit ? button('Cancel', 'cancel', 'notice') : ''}
        </div>
      </form>
    `
  ) +

  panel(
    'Published notices',

    state.notices.map(notice => `
      <article class="notice-card">
        <h3>${h(notice.title)}</h3>
        <small>${h(notice.audience)}</small>
        <div class="notice-body">${h(notice.body)}</div>

        <div class="actions">
          ${button('Edit', 'edit-notice', notice.id)}
          ${button('Remove', 'remove-notice', notice.id, true)}
        </div>
      </article>
    `).join('') ||

    '<p class="empty-state">No published notices.</p>'
  ) +

  panel(
    'Received teacher notices',
    noticeCards(state.received),
    'Received messages are read-only.'
  );
}

function profilePage() {
  const profile = state.profile;

  return panel(
    'Account information',

    `
      <p class="muted">${h(profile.email)}</p>

      <form data-kind="profile">
        <div class="form-grid">
          ${field(
            'Full name',
            'name',
            profile.name,
            'text',
            'required maxlength="100"'
          )}

          ${field(
            'Phone',
            'phone',
            profile.phone,
            'tel',
            'maxlength="150"'
          )}

          ${field(
            'Department',
            'department',
            profile.department,
            'text',
            'maxlength="150"'
          )}
        </div>

        <div class="form-footer">
          <button type="submit">Save profile</button>
        </div>
      </form>
    `
  ) +

  panel(
    'Change password',

    `
      <form data-kind="own-password">
        <div class="form-grid">
          ${field(
            'Current password',
            'current_password',
            '',
            'password',
            'required autocomplete="current-password"'
          )}

          ${field(
            'New password',
            'new_password',
            '',
            'password',
            'required minlength="8" maxlength="128" autocomplete="new-password"'
          )}

          ${field(
            'Confirm password',
            'confirm_password',
            '',
            'password',
            'required minlength="8" maxlength="128" autocomplete="new-password"'
          )}
        </div>

        <div class="form-footer">
          <p>Sign in again after changing your password.</p>
          <button type="submit">Change password</button>
        </div>
      </form>
    `
  );
}

function render() {
  if (!ready) return;

  const [name, query = ''] =
    location.hash.slice(1).split('?');

  page = Object.hasOwn(labels, name)
    ? name
    : 'dashboard';

  const params = new URLSearchParams(query);

  if (page === 'teachers' && params.has('edit')) {
    edits.teacher = state.users.find(user =>
      user.role === 'teacher' &&
      user.id === params.get('edit')
    ) || null;
  }

  $('page-title').textContent = labels[page];
  $('page-date').textContent = today();

  identity();

  document.querySelectorAll('.tsb-nav a')
    .forEach(link => {
      const active = link.hash === '#' + page;

      link.classList.toggle('active', active);

      if (active) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

  const pages = {
    dashboard,
    teachers: () => accounts('teacher'),
    students: () => accounts('student'),
    classes: classesPage,
    reports: reportsPage,
    notices: noticesPage,
    profile: profilePage
  };

  $('content').innerHTML = `
    <div class="page-intro">
      <div>
        <span class="eyebrow">CAMPUS ADMINISTRATION</span>
        <h1>
          ${
            page === 'dashboard'
              ? 'Welcome back, ' + h(state.profile.name) + '.'
              : labels[page]
          }
        </h1>
      </div>
    </div>
  ` + pages[page]();

  if (busy) lock(true);
}

function passwordValid(data) {
  if (
    data.new_password.length < 8 ||
    data.new_password.length > 128 ||
    data.new_password !== data.confirm_password
  ) {
    throw Error(
      'Use matching passwords of 8–128 characters.'
    );
  }
}

function closeModal() {
  $('modal').close();
}

function openModal(body) {
  $('modal').innerHTML = body;
  $('modal').showModal();
}

async function loadReport(studentId) {
  lock(true);

  try {
    report = await api(
      '/student-reports/' + encodeURIComponent(studentId)
    );

    reportFilter = {
      semester: '',
      class_id: '',
      from: '',
      to: ''
    };

    location.hash = '#reports';

    render();
    message('');
  } catch (error) {
    message(error.message, true);
  } finally {
    lock(false);
  }
}

document.addEventListener('submit', async event => {
  const form = event.target;
  const kind = form.dataset.kind;

  if (!kind) return;

  event.preventDefault();
  if (busy) return;

  const data = Object.fromEntries(new FormData(form));

  for (const name of Object.keys(data)) {
    if (!name.includes('password')) {
      data[name] = data[name].trim();
    }
  }

  const record = form.dataset.id;

  try {
    if (kind === 'directory-search') {
      directorySearch = data.search;
      render();
      return;
    }

    if (kind === 'class-search') {
      classSearch = data.search;
      render();
      return;
    }

    if (kind === 'account') {
      const role = form.dataset.role;

      if (record) {
        data.active = data.active === '1';

        await mutate(
          '/' + role + 's/' + encodeURIComponent(record) + '/account',
          data,
          () => edits[role] = null
        );
      } else {
        passwordValid(data);
        data.request_id = requestId(role);

        await mutate(
          '/' + role + 's',
          data,
          () => clearId(role)
        );
      }

      return;
    }

    if (kind === 'class') {
      if (data.semester === '__new') {
        data.semester = data.new_semester;
      }

      delete data.new_semester;

      data.weekly_slots = [
        ...document.querySelectorAll('.slot')
      ].map(element => ({
        day: Number(
          element.querySelector('[name="day"]').value
        ),

        start:
          element.querySelector('[name="start"]').value,

        end:
          element.querySelector('[name="end"]').value,

        room:
          element.querySelector('[name="room"]').value.trim()
      }));

      await mutate(
        record
          ? '/classes/' + encodeURIComponent(record) + '/save'
          : '/classes',

        data,
        () => edits.class = null
      );

      return;
    }

    if (kind === 'enrolment') {
      await mutate(
        '/classes/' + encodeURIComponent(record) + '/enrolments',
        data
      );
      return;
    }

    if (kind === 'close-enrolment') {
      await mutate(
        '/classes/' +
          encodeURIComponent(selectedClass) +
          '/enrolments/' +
          encodeURIComponent(record) +
          '/remove',

        data,
        closeModal
      );

      return;
    }

    if (kind === 'reset-password') {
      passwordValid(data);

      await mutate(
        '/' +
          form.dataset.role +
          's/' +
          encodeURIComponent(record) +
          '/password',

        data,
        closeModal
      );

      return;
    }

    if (kind === 'notice') {
      data.recipient_ids =
        new FormData(form).getAll('recipient_ids');

      if (!record) {
        data.request_id = requestId('notice');
      }

      await mutate(
        record
          ? '/notices/' + encodeURIComponent(record) + '/save'
          : '/notices',

        data,

        () => {
          edits.notice = null;
          clearId('notice');
        }
      );

      return;
    }

    if (kind === 'report-filter') {
      if (
        data.from &&
        data.to &&
        data.from > data.to
      ) {
        throw Error(
          'End date must be on or after start date.'
        );
      }

      reportFilter = data;
      render();
      return;
    }

    if (kind === 'load-report') {
      await loadReport(data.student_id);
      return;
    }

    if (kind === 'teacher-attendance') {
      lock(true);

      try {
        work = {
          ...await api(
            '/teacher-attendance?month=' +
            encodeURIComponent(data.month)
          ),

          teacher: data.teacher_id
        };

        render();
      } finally {
        lock(false);
      }

      return;
    }

    if (kind === 'profile') {
      lock(true);

      try {
        const result = await api('/profile', data);

        state.profile = {
          ...state.profile,
          ...result.profile
        };

        identity();
        render();
        message(result.message);

        if (auth.currentUser?.reload) {
          auth.currentUser.reload().catch(() => {});
        }
      } finally {
        lock(false);
      }

      return;
    }

    if (kind === 'own-password') {
      passwordValid(data);
      lock(true);

      try {
        const user = auth.currentUser;

        await reauthenticateWithCredential(
          user,
          EmailAuthProvider.credential(
            user.email,
            data.current_password
          )
        );

        await updatePassword(user, data.new_password);
        await signOut(auth);

        location.replace('/login.html?role=admin');
      } finally {
        lock(false);
      }
    }
  } catch (error) {
    message(error.message, true);
  }
});

document.addEventListener('click', async event => {
  const element = event.target.closest('[data-action]');

  if (!element || busy) return;

  const action = element.dataset.action;
  const id = element.dataset.id;

  if (action === 'close-modal') {
    closeModal();
    return;
  }

  if (action === 'cancel') {
    edits[id] = null;

    if (location.hash.includes('?')) {
      history.replaceState(null, '', '#' + page);
    }

    render();
    return;
  }

  if (action === 'add-slot') {
    if (document.querySelectorAll('.slot').length < 21) {
      $('slots').insertAdjacentHTML(
        'beforeend',
        slot()
      );
    }

    return;
  }

  if (action === 'remove-slot') {
    if (document.querySelectorAll('.slot').length > 1) {
      element.closest('.slot').remove();
    } else {
      message('Keep at least one routine slot.', true);
    }

    return;
  }

  if (action === 'roster') {
    selectedClass = id;
    render();
    return;
  }

  if (action === 'reset-report') {
    reportFilter = {
      semester: '',
      class_id: '',
      from: '',
      to: ''
    };

    render();
    return;
  }

  if (action === 'report') {
    await loadReport(id);
    return;
  }

  if (action === 'teacher-classes') {
    classSearch = nameOf(id);
    location.hash = '#classes';
    render();
    return;
  }

  if (action === 'unenrol') {
    openModal(`
      <form data-kind="close-enrolment" data-id="${h(id)}">
        <h2>Close enrolment</h2>
        <p>${h(nameOf(id))}</p>

        ${field(
          'Leaving date',
          'left_on',
          today(),
          'date',
          `required max="${today()}"`
        )}

        <div class="actions">
          <button type="submit">Close enrolment</button>
          ${button('Cancel', 'close-modal')}
        </div>
      </form>
    `);

    return;
  }

  for (const role of ['teacher', 'student']) {
    const user = state.users.find(item =>
      item.id === id &&
      item.role === role
    );

    if (!user) continue;

    if (action === 'edit-' + role) {
      edits[role] = user;
      render();
      return;
    }

    if (
      action === 'status-' + role &&
      confirm(
        (user.active ? 'Disable ' : 'Enable ') +
        user.name +
        '?'
      )
    ) {
      await mutate(
        '/' + role + 's/' + encodeURIComponent(id) + '/status',
        { active: !user.active }
      );

      return;
    }

    if (action === 'password-' + role) {
      openModal(`
        <form
          data-kind="reset-password"
          data-role="${role}"
          data-id="${h(id)}"
        >
          <h2>Reset password</h2>
          <p>${h(user.name)}</p>

          ${field(
            'New password',
            'new_password',
            '',
            'password',
            'required minlength="8" maxlength="128" autocomplete="new-password"'
          )}

          ${field(
            'Confirm password',
            'confirm_password',
            '',
            'password',
            'required minlength="8" maxlength="128" autocomplete="new-password"'
          )}

          <div class="actions">
            <button type="submit">Reset password</button>
            ${button('Cancel', 'close-modal')}
          </div>
        </form>
      `);

      return;
    }
  }

  if (action === 'edit-class') {
    edits.class = classOf(id);
    render();
    return;
  }

  if (action === 'status-class') {
    const classroom = classOf(id);

    if (
      classroom &&
      confirm(
        (
          classroom.active === false
            ? 'Restore'
            : 'Archive'
        ) + ' this class?'
      )
    ) {
      await mutate(
        '/classes/' + encodeURIComponent(id) + '/status',
        { active: classroom.active === false }
      );
    }

    return;
  }

  if (action === 'edit-notice') {
    edits.notice = state.notices.find(
      notice => notice.id === id
    );

    render();
    return;
  }

  if (
    action === 'remove-notice' &&
    confirm('Remove this notice?')
  ) {
    await mutate(
      '/notices/' + encodeURIComponent(id) + '/remove',
      {}
    );
  }
});

document.addEventListener('change', event => {
  if (
    !busy &&
    event.target.name === 'roster_class'
  ) {
    selectedClass = event.target.value;
    render();
  }
});

document.addEventListener('input', event => {
  if (event.target.id !== 'student-search') return;

  const query = event.target.value.toLowerCase();

  const studentSelect = document.querySelector(
    '[data-kind="load-report"] [name="student_id"]'
  );

  studentSelect.innerHTML =
    '<option value="">Select…</option>' +

    state.users
      .filter(user =>
        user.role === 'student' &&
        [
          user.name,
          user.student_no,
          user.email
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)
      )
      .map(user => `
        <option value="${h(user.id)}">
          ${h(user.student_no || '—')} — ${h(user.name)}
        </option>
      `)
      .join('');
});

window.addEventListener('hashchange', () => {
  if (!busy) {
    message('');
    render();
  }
});

$('refresh').addEventListener('click', async () => {
  if (busy) return;

  lock(true);

  try {
    await refresh();

    if (report) {
      report = await api(
        '/student-reports/' +
        encodeURIComponent(report.profile.id)
      );
    }

    if (work) {
      work = {
        ...await api(
          '/teacher-attendance?month=' + work.month
        ),

        teacher: work.teacher
      };
    }

    render();
    message('Workspace refreshed.');
  } catch (error) {
    message(error.message, true);
  } finally {
    lock(false);
  }
});

$('logout').addEventListener('click', async () => {
  if (busy) return;

  lock(true);

  try {
    await signOut(auth);
    location.replace('/login.html?role=admin');
  } catch (error) {
    message(error.message, true);
  } finally {
    lock(false);
  }
});

$('retry').addEventListener('click', () => {
  location.reload();
});

onAuthStateChanged(auth, async user => {
  const current = ++version;

  ready = false;
  $('workspace').hidden = true;
  $('loading').hidden = false;

  if (uid !== user?.uid) {
    uid = user?.uid || '';

    edits = {
      teacher: null,
      student: null,
      class: null,
      notice: null
    };

    report = null;
    work = null;
    selectedClass = '';
  }

  if (!user) {
    location.replace('/login.html?role=admin');
    return;
  }

  try {
    await refresh();

    if (current !== version) return;

    ready = true;
    $('loading').hidden = true;
    $('workspace').hidden = false;

    render();
  } catch (error) {
    if (current === version) {
      $('loading-text').textContent = error.message;
      $('retry').hidden = false;
    }
  }
});