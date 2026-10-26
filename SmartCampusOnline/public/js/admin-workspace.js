import { auth } from './firebase-config.js';

import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const $ = id => document.getElementById(id);

const h = value => String(value ?? '').replace(
  /[&<>"']/g,
  c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c])
);

const labels = {
  dashboard: 'Dashboard',
  teachers: 'Teacher Management',
  students: 'Student Management',
  classes: 'Class Setup',
  reports: 'Student Academic Reports',
  history: 'Semester & Class History',
  notices: 'Notices',
  profile: 'Admin Profile'
};

const days = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday'
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
let activeFeedbackKey = '';

const formFeedback = new Map();

let edits = {
  teacher: null,
  student: null,
  class: null,
  notice: null
};

let directorySearch = '';
let classSearch = '';
let directoryFilter = { year: '', season: '' };
let classFilter = { year: '', season: '' };

let reportFilter = {
  year: '',
  season: '',
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

/* Feedback */

function feedbackKey(form) {
  if (!form?.dataset?.kind) return '';

  const kind = form.dataset.kind;
  const detail = kind === 'enrolment' || kind === 'close-enrolment'
    ? selectedClass
    : form.dataset.role || '';

  return [page, kind, detail].join(':');
}

function successFeedbackKey(form) {
  if (form?.dataset.kind === 'close-enrolment') {
    return ['classes', 'enrolment', selectedClass].join(':');
  }

  if (form?.dataset.kind === 'reset-password') {
    return [page, 'account', form.dataset.role || ''].join(':');
  }

  return feedbackKey(form);
}

function installFeedback() {
  document.querySelectorAll('form[data-kind]').forEach(form => {
    const key = feedbackKey(form);
    let node = form.querySelector('[data-form-feedback]');

    if (!node) {
      node = document.createElement('p');
      node.dataset.formFeedback = '';
      node.tabIndex = -1;
      form.append(node);
    }

    node.dataset.feedbackKey = key;

    const value = formFeedback.get(key);

    node.textContent = value?.text || '';
    node.className =
      'flash form-feedback ' + (value?.error ? 'danger' : 'success');

    node.setAttribute('role', value?.error ? 'alert' : 'status');
    node.setAttribute('aria-live', value?.error ? 'assertive' : 'polite');
    node.hidden = !value?.text;
  });
}

function message(text, error = false, target = null) {
  const key = typeof target === 'string'
    ? target
    : feedbackKey(target);

  if (key) {
    if (text) {
      formFeedback.set(key, { text, error });
    } else {
      formFeedback.delete(key);
    }

    $('message').textContent = '';
    $('message').hidden = true;

    installFeedback();

    const node = [
      ...document.querySelectorAll('[data-form-feedback]')
    ].find(item =>
      item.dataset.feedbackKey === key && !item.hidden
    );

    if (node) {
      const details = node.closest('details');
      if (details) details.open = true;

      node.scrollIntoView?.({
        block: 'nearest',
        behavior: 'smooth'
      });
    }

    return;
  }

  $('message').textContent = text;
  $('message').className = 'flash ' + (error ? 'danger' : 'success');
  $('message').hidden = !text;
}

function lock(value) {
  busy = value;
  $('working').hidden = !value || !!activeFeedbackKey;

  document.querySelectorAll('button')
    .forEach(button => button.disabled = value);

  $('content').setAttribute('aria-busy', String(value));
}

/* API */

async function api(path, body) {
  const user = auth.currentUser;
  if (!user) throw Error('Please sign in again.');

  let tokenTimer;

  const token = await Promise.race([
    user.getIdToken(),
    new Promise((resolve, reject) => {
      tokenTimer = setTimeout(
        () => reject(Error('Login check timed out. Please retry.')),
        25000
      );
    })
  ]).finally(() => clearTimeout(tokenTimer));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);

  try {
    const response = await fetch('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });

    if (
      !(response.headers.get('content-type') || '')
        .includes('application/json')
    ) {
      throw Error('Admin information is unavailable. Please retry.');
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
  document.querySelectorAll('[data-admin-name]').forEach(element => {
    element.textContent = state.profile?.name || 'Administrator';
  });

  document.querySelectorAll('[data-admin-initial]').forEach(element => {
    element.textContent = (state.profile?.name || 'A')
      .slice(0, 1)
      .toUpperCase();
  });

  $('admin-email').textContent = state.profile?.email || '';
}

async function refresh() {
  const account = await api('/profile');

  if (account.profile.id !== auth.currentUser?.uid) {
    throw Error('Account changed. Please reload.');
  }

  state.profile = account.profile;
  identity();

  const [directory, classes, notices, overview, conflicts] =
    await Promise.all([
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

async function mutate(path, data, after = () => {}, form = null) {
  if (busy) return;

  if (refreshNeeded) {
    message(
      'The last change was saved. Use Refresh before making another change.',
      true,
      form
    );
    return;
  }

  activeFeedbackKey = feedbackKey(form);

  lock(true);
  message('Saving…', false, form);

  let saved = false;

  try {
    const result = await api(path, data);

    saved = true;
    refreshNeeded = true;

    after(result);
    await refresh();
    render();

    message(
      result.message || 'Saved.',
      false,
      successFeedbackKey(form)
    );
  } catch (error) {
    message(
      (
        saved
          ? 'Saved, but the workspace could not refresh. Use Refresh. '
          : ''
      ) + error.message,
      true,
      saved ? successFeedbackKey(form) : feedbackKey(form)
    );
  } finally {
    lock(false);
    activeFeedbackKey = '';
  }
}

function requestId(type) {
  const key = 'smart-campus.admin.' + uid + '.' + type;
  let value = sessionStorage.getItem(key);

  if (!/^[a-f0-9]{32}$/.test(value || '')) {
    value = crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(key, value);
  }

  return value;
}

function clearId(type) {
  sessionStorage.removeItem(
    'smart-campus.admin.' + uid + '.' + type
  );
}

/* UI helpers */

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

function button(text, action, id = '', danger = false) {
  return `
    <button
      type="button"
      class="${danger ? 'danger' : 'secondary'}"
      data-action="${action}"
      data-id="${h(id)}"
    >${h(text)}</button>
  `;
}

function field(label, name, value = '', type = 'text', extra = '') {
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

function select(label, name, items, value = '', required = false) {
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

function panel(title, body, copy = '', extra = '') {
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

/* Semester names and legacy Summar spelling */

function displayTerm(value) {
  return termInfo(value)?.label || String(value || '');
}

function termSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\bsummar(?=\s|[-/]|\d|$)/gi, 'summer')
    .replace(/\b(summer|spring)\s*[-/]?\s*(\d{4})\b/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function termInfo(value) {
  const match = /^(summer|summar|spring)\s*[-/]?\s*(\d{4})$/i.exec(
    String(value || '').normalize('NFKC').trim()
  );

  if (!match) return null;

  const year = Number(match[2]);
  if (year < 1900 || year > 9999) return null;

  const season = match[1].toLowerCase() === 'spring'
    ? 'Spring'
    : 'Summer';

  return {
    season,
    year,
    label: season + ' ' + year,
    start: year + (season === 'Summer' ? '-01-01' : '-07-01'),
    end: year + (season === 'Summer' ? '-06-30' : '-12-31')
  };
}

function currentTerm() {
  const date = today();

  return termInfo(
    (Number(date.slice(5, 7)) <= 6 ? 'Summer ' : 'Spring ') +
    date.slice(0, 4)
  );
}

function termFields(value = '') {
  const existing = String(value || '').trim();
  const info = termInfo(existing) || currentTerm();
  const legacy = existing && !termInfo(existing);

  return `
    <div
      class="term-fields"
      data-term-fields
      data-original="${h(existing)}"
      data-value="${h(existing || info.label)}"
    >
      ${select(
        'Semester',
        'term_name',
        [
          ['Summer', 'Summer · January–June'],
          ['Spring', 'Spring · July–December'],
          ...(legacy
            ? [['__legacy', 'Keep existing: ' + existing]]
            : [])
        ],
        legacy ? '__legacy' : info.season,
        true
      )}

      ${field(
        'Year',
        'term_year',
        legacy ? '' : info.year,
        'number',
        `min="1900" max="9999" step="1" ${
          legacy ? 'disabled' : 'required'
        }`
      )}

      <small class="term-preview" data-term-preview>
        ${h(legacy ? existing : info.label)}
      </small>
    </div>
  `;
}

function buildTerm(data, original = '') {
  if (
    data.term_name === '__legacy' &&
    original &&
    !termInfo(original)
  ) {
    return original;
  }

  const year = String(data.term_year || '');

  if (
    !['Summer', 'Spring'].includes(data.term_name) ||
    !/^\d{4}$/.test(year) ||
    Number(year) < 1900 ||
    Number(year) > 9999
  ) {
    throw Error(
      'Choose Summer or Spring and enter a four-digit year between 1900 and 9999.'
    );
  }

  return data.term_name + ' ' + Number(year);
}

function termFilterFields(filter) {
  return field(
    'Year (blank = all)',
    'year',
    filter.year,
    'number',
    'min="1900" max="9999" step="1"'
  ) +
  select(
    'Semester (blank = all)',
    'season',
    [
      ['Summer', 'Summer · January–June'],
      ['Spring', 'Spring · July–December']
    ],
    filter.season
  );
}

function checkTermFilter(data) {
  if (
    data.year &&
    (
      !/^\d{4}$/.test(data.year) ||
      Number(data.year) < 1900 ||
      Number(data.year) > 9999
    )
  ) {
    throw Error(
      'Enter a four-digit year between 1900 and 9999, or leave Year blank.'
    );
  }

  if (
    data.season &&
    !['Summer', 'Spring'].includes(data.season)
  ) {
    throw Error('Choose Summer, Spring, or all semesters.');
  }
}

function matchesTerm(value, filter) {
  if (!filter.year && !filter.season) return true;

  const info = termInfo(value);

  return !!info &&
    (!filter.year || info.year === Number(filter.year)) &&
    (!filter.season || info.season === filter.season);
}

function studentMatchesTerm(user, filter) {
  return [
    user.semester,
    ...state.enrolments
      .filter(item => item.student_id === user.id)
      .map(item =>
        item.semester || classOf(item.class_id)?.semester
      )
  ].some(term => matchesTerm(term, filter));
}

function earlierTerm(term, current) {
  const a = termInfo(term);
  const b = termInfo(current);

  if (a && b) {
    return (
      a.year * 2 + (a.season === 'Spring' ? 1 : 0)
    ) < (
      b.year * 2 + (b.season === 'Spring' ? 1 : 0)
    );
  }

  const aNumber = /^semester (\d+)$/.exec(semesterKey(term));
  const bNumber = /^semester (\d+)$/.exec(semesterKey(current));

  return !!aNumber &&
    !!bNumber &&
    Number(aNumber[1]) < Number(bNumber[1]);
}

function syncTermFields(group) {
  const form = group.closest('form');
  const season = group.querySelector('[name="term_name"]');
  const year = group.querySelector('[name="term_year"]');
  const legacy = season.value === '__legacy';

  year.disabled = legacy;
  year.required = !legacy;

  let value;

  try {
    value = buildTerm(
      {
        term_name: season.value,
        term_year: year.value
      },
      group.dataset.original
    );
  } catch {
    group.querySelector('[data-term-preview]').textContent =
      'Enter a four-digit year.';
    return;
  }

  group.querySelector('[data-term-preview]').textContent = value;

  if (
    semesterKey(value) !== semesterKey(group.dataset.value) &&
    form.dataset.kind === 'class'
  ) {
    const info = termInfo(value);
    const old = termInfo(group.dataset.value);

    if (info) {
      form.querySelector('[name="start_date"]').value = info.start;
      form.querySelector('[name="end_date"]').value = info.end;

      const session = form.querySelector('[name="academic_session"]');

      if (
        !session.value ||
        (old && session.value === String(old.year))
      ) {
        session.value = String(info.year);
      } else if (
        old &&
        semesterKey(session.value) === semesterKey(old.label)
      ) {
        session.value = info.label;
      }
    }
  }

  group.dataset.value = value;
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

/* Dashboard */

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

/* Accounts */

function accounts(role) {
  const edit = edits[role];
  const isStudent = role === 'student';
  const users = state.users.filter(user => user.role === role);

  const visible = users.filter(user =>
    termSearch([
      user.name,
      user.email,
      user[role + '_no'],
      user.semester,
      user.department
    ].join(' ')).includes(termSearch(directorySearch)) &&
    (!isStudent || studentMatchesTerm(user, directoryFilter))
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
            'Full name', 'name', edit?.name,
            'text', 'required maxlength="100"'
          )}

          ${field(
            'Email', 'email', edit?.email,
            'email', 'required maxlength="254"'
          )}

          ${field(
            'Department', 'department', edit?.department,
            'text', 'maxlength="150"'
          )}

          ${field(
            'Phone', 'phone', edit?.phone,
            'tel', 'maxlength="150"'
          )}

          ${
            isStudent
              ? field(
                  'Program', 'program', edit?.program,
                  'text', 'maxlength="150"'
                ) +
                termFields(edit?.semester)
              : field(
                  'Designation', 'designation', edit?.designation,
                  'text', 'maxlength="150"'
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
                Summer runs January–June; Spring runs July–December.
                Year is editable. Updating the current semester does not move previous class records.
                Enrol an existing student in the new class through Class Setup.
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
        ${isStudent ? termFilterFields(directoryFilter) : ''}
        <button type="submit">Search</button>
        ${isStudent ? button('Reset', 'reset-directory') : ''}
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
          <td>${h(
            isStudent
              ? displayTerm(user.semester)
              : user.department
          )}</td>

          <td>
            ${badge(
              user.provisioning === 'pending'
                ? 'Provisioning'
                : user.active ? 'Active' : 'Disabled',
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
    !work?.teacher || record.teacher_id === work.teacher
  );

  const rows = records.map(record => {
    const checkIn =
      record.check_in?.seconds ?? record.check_in?._seconds;

    const checkOut =
      record.check_out?.seconds ?? record.check_out?._seconds;

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
        <td>${
          minutes == null
            ? '—'
            : Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm'
        }</td>
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

/* Classes */

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
      ${field('Room', 'room', value.room, 'text', 'maxlength="80"')}
      ${button('Remove', 'remove-slot')}
    </div>
  `;
}

function conflictsTable() {
  return state.conflicts.length
    ? table(
        ['Person', 'Date', 'First class', 'Time', 'Second class', 'Time'],
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
    : '<p class="info-note">No active schedule conflicts found.</p>';
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
    !active.some(enrolment => enrolment.student_id === user.id)
  );

  const visible = state.classes.filter(classroom =>
    termSearch([
      classroom.code,
      classroom.name,
      classroom.semester,
      classroom.academic_session,
      classroom.section,
      nameOf(classroom.teacher_id)
    ].join(' ')).includes(termSearch(classSearch)) &&
    matchesTerm(classroom.semester, classFilter)
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
            'Subject code', 'code', edit?.code, 'text',
            `required maxlength="80" ${edit ? 'readonly' : ''}`
          )}

          ${field(
            'Subject name', 'name', edit?.name,
            'text', 'required maxlength="150"'
          )}

          ${termFields(edit?.semester)}

          ${field(
            'Academic session',
            'academic_session',
            displayTerm(
              edit?.academic_session ?? String(currentTerm().year)
            ),
            'text',
            `maxlength="80" ${edit ? 'readonly' : ''}`
          )}

          ${field(
            'Section', 'section', edit?.section, 'text',
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
            edit ? edit.start_date : currentTerm().start,
            'date'
          )}

          ${field(
            'Class ends (optional)',
            'end_date',
            edit ? edit.end_date : currentTerm().end,
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
          Summer: January–June. Spring: July–December. Year is editable.
          Semester and Year set the suggested class dates; adjust dates if needed.
          Changing an existing class's Semester or Year saves a new class for that term.
          The original class, enrolments, attendance and marks remain in their original term.
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

        ${termFilterFields(classFilter)}

        <button type="submit">Search</button>
        ${button('Reset', 'reset-classes')}
      </form>
    ` +
    table(
      ['Class', 'Semester / session', 'Teacher', 'Routine', 'Status', 'Actions'],
      visible.map(classroom => `
        <tr>
          <td>
            <strong>${h(classroom.code)}</strong>
            ${h(classroom.name)}
            <small>${h(classroom.section)}</small>
          </td>

          <td>
            ${h(displayTerm(classroom.semester))}
            <small>${h(displayTerm(classroom.academic_session))}</small>
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
      state.classes
        .filter(classroom =>
          matchesTerm(classroom.semester, classFilter)
        )
        .map(classroom => [
          classroom.id,
          classroom.code + ' — ' + classroom.name + ' · ' +
          displayTerm(classroom.semester) +
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
                <td>${h(
                  state.users.find(user =>
                    user.id === enrolment.student_id
                  )?.student_no || '—'
                )}</td>

                <td>${h(
                  enrolment.periods?.at(-1)?.from ||
                  enrolment.joined_on ||
                  '—'
                )}</td>

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

/* Academic results */

function semesterKey(value) {
  const calendar = termInfo(value);

  if (calendar) {
    return calendar.label.toLowerCase();
  }

  const name = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  const numeric =
    /^(?:semester\s*)?([1-9]\d?)(?:st|nd|rd|th)?(?:\s*semester)?$/
      .exec(name);

  if (numeric) {
    return 'semester ' + Number(numeric[1]);
  }

  return name.replace(
    /^(spring|summer|autumn|fall|winter)\s*[-/]?\s*(\d{4})$/,
    '$1 $2'
  );
}

function resultNumber(value) {
  return Number(Number(value).toPrecision(15))
    .toLocaleString('en-GB', {
      maximumFractionDigits: 12
    });
}

function courseResult(course) {
  const keys = ['assessment', 'mid', 'final'];

  const valid = value =>
    ['number', 'string'].includes(typeof value) &&
    String(value).trim() !== '' &&
    Number.isFinite(Number(value));

  const maximum = keys.reduce(
    (sum, name) => sum + Number(course[name + '_max']),
    0
  );

  const complete =
    Number.isFinite(maximum) &&
    maximum > 0 &&
    keys.every(name =>
      valid(course[name]) &&
      valid(course[name + '_max']) &&
      Number(course[name + '_max']) >= 0 &&
      Number(course[name]) >= 0 &&
      Number(course[name]) <= Number(course[name + '_max'])
    );

  const earned = complete
    ? Number(
        keys.reduce(
          (sum, name) => sum + Number(course[name]),
          0
        ).toPrecision(15)
      )
    : null;

  return {
    complete,
    earned,
    max: maximum,
    passed: complete && earned >= maximum * 0.4
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
    complete: classes.length > 0 && results.length === classes.length
  };
}

function marksTable(classes) {
  return table(
    ['Subject', 'Semester', 'Assessment', 'Midterm', 'Final', 'Total', '%'],
    classes.map(course => {
      const result = courseResult(course);

      return `
        <tr>
          <td>
            <strong>${h(course.name)}</strong>
            <small>${h([
              course.code,
              displayTerm(course.academic_session),
              course.section
            ].filter(Boolean).join(' · '))}</small>
          </td>

          <td>${h(displayTerm(course.semester))}</td>

          ${['assessment', 'mid', 'final'].map(name => `
            <td>
              ${
                course[name] == null ||
                String(course[name]).trim() === ''
                  ? '—'
                  : h(number(course[name]))
              }
              / ${h(number(course[name + '_max']))}
            </td>
          `).join('')}

          <td>
            ${
              result.complete
                ? badge(
                    resultNumber(result.earned) +
                    ' / ' + resultNumber(result.max) +
                    ' · ' + (result.passed ? 'Pass' : 'Fail'),
                    result.passed ? 'present' : 'absent'
                  )
                : badge('Incomplete', 'unmarked')
            }
          </td>

          <td>${percentage(
            result.complete
              ? result.earned * 100 / result.max
              : null
          )}</td>
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

  rows.filter(row => row.counted)
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
  const students = state.users.filter(user => user.role === 'student');

  const chooser = `
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
      chooser,
      'Select a student to view marks, semester averages and attendance.'
    );
  }

  const all = report.classes;
  const profile = report.profile;
  const declared = report.current_semester || profile.semester || '';

  const current = displayTerm(
    all.find(course =>
      semesterKey(course.semester) === semesterKey(declared)
    )?.semester || declared
  );

  const visible = all.filter(course =>
    matchesTerm(course.semester, reportFilter) &&
    (!reportFilter.class_id || course.id === reportFilter.class_id)
  );

  const allTermClasses = term => all.filter(course =>
    semesterKey(course.semester) === semesterKey(term)
  );

  const termClasses = term => visible.filter(course =>
    semesterKey(course.semester) === semesterKey(term)
  );

  const terms = [
    ...new Map(
      visible.map(course => [
        semesterKey(course.semester),
        displayTerm(course.semester)
      ])
    ).values()
  ].sort((a, b) => {
    const x = termInfo(a);
    const y = termInfo(b);

    return x && y
      ? x.year - y.year ||
        (x.season === y.season ? 0 : x.season === 'Summer' ? -1 : 1)
      : a.localeCompare(b, undefined, { numeric: true });
  });

  const previous = terms.filter(term =>
    earlierTerm(term, current) &&
    resultSummary(allTermClasses(term)).complete
  );

  const overall = resultSummary(
    visible.filter(course =>
      previous.some(term =>
        semesterKey(term) === semesterKey(course.semester)
      )
    )
  );

  const ids = new Set(visible.map(course => course.id));

  const rows = report.attendance.filter(session =>
    ids.has(session.class_id) &&
    (!reportFilter.from || session.lesson_date >= reportFilter.from) &&
    (!reportFilter.to || session.lesson_date <= reportFilter.to)
  );

  const attendance = attendanceSummary(rows);
  const running = termClasses(current);

  const hasFilters = !!(
    reportFilter.year || reportFilter.season || reportFilter.class_id
  );

  const runningBody = running.length
    ? marksTable(running)
    : `
      <p class="${hasFilters ? 'info-note' : 'warning-note'}">
        ${
          !current
            ? 'No current semester is assigned. Set Semester and Year in Student Management.'
            : !allTermClasses(current).length
              ? `The profile's current semester is ${h(current)}, but no enrolled subjects match it. Check the student's Semester/Year and Class Setup enrolments. Available terms: ${h(
                  [...new Set(
                    all.map(course => displayTerm(course.semester))
                  )].join(', ') || 'none'
                )}.`
              : 'The current semester has no subjects matching the selected filters. Matching terms are shown in Semester history below.'
        }
      </p>
    `;

  return panel('Student academic reports', chooser) +
  panel(
    profile.name,
    `<p class="muted">
      ${h([
        profile.student_no,
        profile.email,
        profile.department
      ].filter(Boolean).join(' · '))}
      · Running: ${h(current || 'Not assigned')}
    </p>`
  ) +
  panel(
    'Report filters',
    `
      <form data-kind="report-filter" class="filter-form">
        ${termFilterFields(reportFilter)}

        ${select(
          'Subject (blank = all)',
          'class_id',
          all.map(course => [
            course.id,
            course.code + ' — ' + course.name +
            ' · ' + displayTerm(course.semester)
          ]),
          reportFilter.class_id
        )}

        ${field(
          'Attendance from', 'from', reportFilter.from, 'date'
        )}

        ${field(
          'Attendance to', 'to', reportFilter.to,
          'date', `max="${today()}"`
        )}

        <button type="submit">Apply filters</button>
        ${button('Reset', 'reset-report')}
      </form>

      <p class="muted">
        Year and Semester filter subject results and attendance together.
        Date filters apply to attendance.
        Leave Year or Semester blank to include all.
        Older term names remain available when both are blank.
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
    `<p class="info-note">
      Only fully graded semesters earlier than the profile's current semester are eligible.
      Selected Year, Semester and Subject filters limit the displayed subjects.
      Average = total earned ÷ total maximum × 100.
      Running, future and incomplete semesters are excluded.
      No GPA/CGPA is inferred.
    </p>`
  ) +
  panel(
    'Running semester result',
    `<p class="info-note">
      Pass: 40% or above.
      Fail: below 40% after all marks are entered.
      Missing marks stay Incomplete.
    </p>` + runningBody,
    current || 'Not assigned'
  ) +
  panel(
    'Semester history',
    terms
      .filter(term => semesterKey(term) !== semesterKey(current))
      .map(term => {
        const courses = termClasses(term);
        const summary = resultSummary(courses);

        return `
          <details class="semester-record" ${hasFilters ? 'open' : ''}>
            <summary>
              ${h(displayTerm(term))}
              ${badge(
                summary.complete
                  ? percentage(summary.average) + ' average'
                  : `${summary.count} / ${summary.total} graded`
              )}
            </summary>
            ${marksTable(courses)}
          </details>
        `;
      }).join('') ||
    '<p class="empty-state">No other semester records match these filters.</p>'
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
    `<p class="info-note">
      Present + Late count as attended.
      Excused and Not marked remain in the recorded-class total.
      ${attendance.pending} past sessions awaiting attendance are excluded.
    </p>` +
    table(
      ['Subject', 'Recorded', 'Attended', 'Absent', 'Excused', 'Not marked', '%'],
      visible.map(course => {
        const summary = attendanceSummary(
          rows.filter(row => row.class_id === course.id)
        );

        return `
          <tr>
            <td>
              <strong>${h(course.name)}</strong>
              <small>
                ${h(displayTerm(course.semester))} · ${h(course.code)}
              </small>
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
              ${h(displayTerm(session.semester))} · ${h(session.code)}
            </small>
          </td>
          <td>${h(session.start_time)}–${h(session.end_time)}</td>
          <td>
            ${badge(
              session.counted ? session.status : 'Awaiting attendance',
              session.counted
                ? ({
                    Present: 'present',
                    Late: 'late',
                    Absent: 'absent',
                    Excused: 'excused',
                    'Not marked': 'unmarked'
                  }[session.status] || 'neutral')
                : 'unmarked'
            )}
          </td>
        </tr>
      `)
    )
  );
}

/* Notices */

function noticesPage() {
  const edit = edits.notice;

  return panel(
    edit ? 'Edit notice' : 'Publish notice',
    `
      <form data-kind="notice" data-id="${h(edit?.id || '')}">
        <div class="form-grid">
          ${field(
            'Title', 'title', edit?.title,
            'text', 'required maxlength="140"'
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
              ${state.users
                .filter(user =>
                  user.active && user.provisioning !== 'pending'
                )
                .map(user => `
                  <option
                    value="${h(user.id)}"
                    ${edit?.recipient_ids?.includes(user.id) ? 'selected' : ''}
                  >
                    ${h(user.name)} · ${h(user.role)} ·
                    ${h(user.student_no || user.teacher_no || user.email)}
                  </option>
                `).join('')}
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

/* Profile */

function profilePage() {
  const profile = state.profile;

  return panel(
    'Account information',
    `
      <p class="muted">${h(profile.email)}</p>

      <form data-kind="profile">
        <div class="form-grid">
          ${field(
            'Full name', 'name', profile.name,
            'text', 'required maxlength="100"'
          )}
          ${field(
            'Phone', 'phone', profile.phone,
            'tel', 'maxlength="150"'
          )}
          ${field(
            'Department', 'department', profile.department,
            'text', 'maxlength="150"'
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

/* Rendering */

function render() {
  if (!ready) return;

  const [name, query = ''] = location.hash.slice(1).split('?');
  const nextPage = Object.hasOwn(labels, name) ? name : 'dashboard';

  if (nextPage !== page) {
    formFeedback.clear();
    message('');
  }

  page = nextPage;

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

  document.querySelectorAll('.tsb-nav a').forEach(link => {
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
    history: () => '',
    notices: noticesPage,
    profile: profilePage
  };

  $('content').hidden = page === 'history';

  $('content').innerHTML = `
    <div class="page-intro">
      <div>
        <span class="eyebrow">CAMPUS ADMINISTRATION</span>
        <h1>${
          page === 'dashboard'
            ? 'Welcome back, ' + h(state.profile.name) + '.'
            : labels[page]
        }</h1>
      </div>
    </div>
  ` + pages[page]();

  installFeedback();

  if (busy) lock(true);
}

function passwordValid(data) {
  if (
    data.new_password.length < 8 ||
    data.new_password.length > 128 ||
    data.new_password !== data.confirm_password
  ) {
    throw Error('Use matching passwords of 8–128 characters.');
  }
}

function closeModal() {
  $('modal').close();
}

function openModal(body) {
  $('modal').innerHTML = body;
  installFeedback();
  $('modal').showModal();
}

async function loadReport(studentId, form = null) {
  activeFeedbackKey = feedbackKey(form);

  lock(true);
  message('Loading report…', false, form);

  try {
    report = await api(
      '/student-reports/' + encodeURIComponent(studentId)
    );

    reportFilter = {
      year: '',
      season: '',
      semester: '',
      class_id: '',
      from: '',
      to: ''
    };

    location.hash = '#reports';
    render();

    message(form ? 'Academic report loaded.' : '', false, form);
  } catch (error) {
    message(error.message, true, form);
  } finally {
    lock(false);
    activeFeedbackKey = '';
  }
}

/* Submissions */

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
  const submit = (path, body, after) =>
    mutate(path, body, after, form);

  try {
    if (kind === 'directory-search') {
      checkTermFilter(data);
      directorySearch = data.search;

      if (page === 'students') {
        directoryFilter = {
          year: data.year || '',
          season: data.season || ''
        };
      }

      render();
      return;
    }

    if (kind === 'class-search') {
      checkTermFilter(data);
      classSearch = data.search;

      classFilter = {
        year: data.year || '',
        season: data.season || ''
      };

      if (
        selectedClass &&
        !matchesTerm(classOf(selectedClass)?.semester, classFilter)
      ) {
        selectedClass = '';
      }

      render();
      return;
    }

    if (kind === 'account') {
      const role = form.dataset.role;

      if (role === 'student') {
        data.semester = buildTerm(
          data,
          edits.student?.semester || ''
        );

        delete data.term_name;
        delete data.term_year;

        if (
          record &&
          semesterKey(data.semester) ===
            semesterKey(edits.student?.semester)
        ) {
          data.semester = edits.student.semester;
        }
      }

      if (record) {
        data.active = data.active === '1';

        await submit(
          '/' + role + 's/' + encodeURIComponent(record) + '/account',
          data,
          () => edits[role] = null
        );
      } else {
        passwordValid(data);
        data.request_id = requestId(role);

        await submit(
          '/' + role + 's',
          data,
          () => clearId(role)
        );
      }

      return;
    }

    if (kind === 'class') {
      data.semester = buildTerm(
        data,
        edits.class?.semester || ''
      );

      delete data.term_name;
      delete data.term_year;

      const newTerm =
        !!record &&
        semesterKey(data.semester) !== semesterKey(edits.class?.semester);

      if (record && !newTerm) {
        data.semester = edits.class.semester;
        data.academic_session = edits.class.academic_session || '';
      }

      if (!record || newTerm) {
        const duplicate = state.classes.some(course =>
          String(course.code).trim().toLowerCase() ===
            String(data.code).trim().toLowerCase() &&
          semesterKey(course.semester) === semesterKey(data.semester) &&
          termSearch(course.academic_session) ===
            termSearch(data.academic_session) &&
          String(course.section || '').trim().toLowerCase() ===
            String(data.section || '').trim().toLowerCase()
        );

        if (duplicate) {
          throw Error(
            'This subject/session/semester/section already exists. Edit or restore the saved class.'
          );
        }
      }

      const bounds = termInfo(data.semester);

      if ((!record || newTerm) && bounds) {
        data.start_date ||= bounds.start;
        data.end_date ||= bounds.end;
      }

      data.weekly_slots = [
        ...document.querySelectorAll('.slot')
      ].map(element => ({
        day: Number(element.querySelector('[name="day"]').value),
        start: element.querySelector('[name="start"]').value,
        end: element.querySelector('[name="end"]').value,
        room: element.querySelector('[name="room"]').value.trim()
      }));

      await submit(
        record && !newTerm
          ? '/classes/' + encodeURIComponent(record) + '/save'
          : '/classes',
        data,
        result => {
          edits.class = null;

          if (!record || newTerm) {
            selectedClass = result.id;
            classSearch = '';
            classFilter = { year: '', season: '' };
          }
        }
      );

      return;
    }

    if (kind === 'enrolment') {
      await submit(
        '/classes/' + encodeURIComponent(record) + '/enrolments',
        data
      );
      return;
    }

    if (kind === 'close-enrolment') {
      await submit(
        '/classes/' + encodeURIComponent(selectedClass) +
        '/enrolments/' + encodeURIComponent(record) + '/remove',
        data,
        closeModal
      );
      return;
    }

    if (kind === 'reset-password') {
      passwordValid(data);

      await submit(
        '/' + form.dataset.role + 's/' +
        encodeURIComponent(record) + '/password',
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

      await submit(
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
      checkTermFilter(data);

      if (data.from && data.to && data.from > data.to) {
        throw Error('End date must be on or after start date.');
      }

      reportFilter = data;
      render();
      message('Report filters applied.', false, form);
      return;
    }

    if (kind === 'load-report') {
      await loadReport(data.student_id, form);
      return;
    }

    if (kind === 'teacher-attendance') {
      activeFeedbackKey = feedbackKey(form);
      lock(true);
      message('Loading attendance…', false, form);

      try {
        work = {
          ...await api(
            '/teacher-attendance?month=' +
            encodeURIComponent(data.month)
          ),
          teacher: data.teacher_id
        };

        render();
        message('Work attendance loaded.', false, form);
      } finally {
        lock(false);
        activeFeedbackKey = '';
      }

      return;
    }

    if (kind === 'profile') {
      activeFeedbackKey = feedbackKey(form);
      lock(true);
      message('Saving profile…', false, form);

      try {
        const result = await api('/profile', data);

        state.profile = {
          ...state.profile,
          ...result.profile
        };

        identity();
        render();
        message(result.message, false, form);

        if (auth.currentUser?.reload) {
          auth.currentUser.reload().catch(() => {});
        }
      } finally {
        lock(false);
        activeFeedbackKey = '';
      }

      return;
    }

    if (kind === 'own-password') {
      passwordValid(data);
      activeFeedbackKey = feedbackKey(form);
      lock(true);
      message('Updating password…', false, form);

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
        activeFeedbackKey = '';
      }
    }
  } catch (error) {
    message(error.message, true, form);
  }
});

/* Actions */

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
      $('slots').insertAdjacentHTML('beforeend', slot());
    }
    return;
  }

  if (action === 'remove-slot') {
    if (document.querySelectorAll('.slot').length > 1) {
      element.closest('.slot').remove();
    } else {
      message(
        'Keep at least one routine slot.',
        true,
        element.closest('form')
      );
    }
    return;
  }

  if (action === 'roster') {
    selectedClass = id;
    render();
    return;
  }

  if (action === 'reset-directory') {
    directorySearch = '';
    directoryFilter = { year: '', season: '' };
    render();
    return;
  }

  if (action === 'reset-classes') {
    classSearch = '';
    classFilter = { year: '', season: '' };
    render();
    return;
  }

  if (action === 'reset-report') {
    reportFilter = {
      year: '',
      season: '',
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
      item.id === id && item.role === role
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
        (user.active ? 'Disable ' : 'Enable ') + user.name + '?'
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
        (classroom.active === false ? 'Restore' : 'Archive') +
        ' this class?'
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
    edits.notice = state.notices.find(notice => notice.id === id);
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

/* Live controls */

document.addEventListener('change', event => {
  if (
    !busy &&
    ['term_name', 'term_year'].includes(event.target.name)
  ) {
    const group = event.target.closest('[data-term-fields]');
    if (group) syncTermFields(group);
    return;
  }

  if (!busy && event.target.name === 'roster_class') {
    selectedClass = event.target.value;
    render();
  }
});

document.addEventListener('input', event => {
  if (!busy && event.target.name === 'term_year') {
    const group = event.target.closest('[data-term-fields]');
    if (group) syncTermFields(group);
    return;
  }

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
        [user.name, user.student_no, user.email]
          .join(' ')
          .toLowerCase()
          .includes(query)
      )
      .map(user => `
        <option value="${h(user.id)}">
          ${h(user.student_no || '—')} — ${h(user.name)}
        </option>
      `).join('');
});

/* Navigation */

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
        ...await api('/teacher-attendance?month=' + work.month),
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

$('retry').addEventListener('click', () => location.reload());

/* Authentication */

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
    formFeedback.clear();
    work = null;
    selectedClass = '';
    directoryFilter = { year: '', season: '' };
    classFilter = { year: '', season: '' };
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