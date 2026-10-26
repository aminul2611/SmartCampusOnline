import { auth } from './firebase-config.js';

import {
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const root = document.getElementById('semester-history');
const content = document.getElementById('content');

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

let data = null;
let userId = '';
let generation = 0;
let loading = false;
let controller = null;
let feedback = '';
let pendingReportUid = '';

let filters = {
  year: '',
  season: '',
  search: ''
};

function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  return ['year', 'month', 'day']
    .map(name =>
      parts.find(part => part.type === name).value
    )
    .join('-');
}

function termInfo(value) {
  const match = /^(summer|spring)\s*[-/]?\s*(\d{4})$/i.exec(
    String(value || '').normalize('NFKC').trim()
  );

  if (
    !match ||
    Number(match[2]) < 1900 ||
    Number(match[2]) > 9999
  ) {
    return null;
  }

  const season = match[1].toLowerCase() === 'summer'
    ? 'Summer'
    : 'Spring';

  const year = Number(match[2]);

  return {
    season,
    year,
    label: season + ' ' + year,
    from: year + (season === 'Summer' ? '-01-01' : '-07-01'),
    to: year + (season === 'Summer' ? '-06-30' : '-12-31')
  };
}

function termKey(value) {
  const info = termInfo(value);

  const name = String(value || 'Semester not assigned')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  const numeric =
    /^(?:semester\s*)?([1-9]\d?)(?:st|nd|rd|th)?(?:\s*semester)?$/
      .exec(name);

  return info
    ? info.label.toLowerCase()
    : numeric
      ? 'semester ' + Number(numeric[1])
      : name;
}

function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function classWindow(course) {
  const term = termInfo(course.semester);

  const from = course.start_date || term?.from || '';
  const to = course.end_date || term?.to || '';

  return (
    validDate(from) &&
    validDate(to) &&
    from <= to
  )
    ? { from, to }
    : null;
}

function groupStage(classes, onDate) {
  const windows = classes.map(classWindow);

  if (
    !windows.length ||
    windows.some(value => !value)
  ) {
    return {
      label: 'Dates not set',
      tone: 'unknown',
      from: '',
      to: ''
    };
  }

  const from = windows
    .map(value => value.from)
    .sort()[0];

  const to = windows
    .map(value => value.to)
    .sort()
    .at(-1);

  return {
    from,
    to,

    ...(
      to < onDate
        ? {
            label: 'Finished',
            tone: 'finished'
          }
        : from > onDate
          ? {
              label: 'Upcoming',
              tone: 'upcoming'
            }
          : {
              label: 'Ongoing',
              tone: 'ongoing'
            }
    )
  };
}

function semesterGroups(classes, onDate = today()) {
  const unique = new Map(
    classes.map(course => [course.id, course])
  );

  const groups = new Map();

  for (const course of unique.values()) {
    const key = termKey(course.semester);

    if (!groups.has(key)) {
      groups.set(key, {
        key,

        label:
          termInfo(course.semester)?.label ||
          course.semester ||
          'Semester not assigned',

        classes: []
      });
    }

    groups.get(key).classes.push(course);
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      stage: groupStage(group.classes, onDate)
    }))
    .sort((a, b) => {
      const x = termInfo(a.label);
      const y = termInfo(b.label);

      return x && y
        ? y.year - x.year ||
          (
            x.season === y.season
              ? 0
              : x.season === 'Spring'
                ? -1
                : 1
          )
        : x
          ? -1
          : y
            ? 1
            : a.label.localeCompare(
                b.label,
                undefined,
                { numeric: true }
              );
    });
}

function tag(text, tone = '') {
  return `
    <span class="history-tag ${tone}">
      ${h(text)}
    </span>
  `;
}

function studentRows(course, accounts) {
  const enrolled = [
    ...new Map(
      data.enrolments
        .filter(item => item.class_id === course.id)
        .map(item => [item.student_id, item])
    ).values()
  ];

  return enrolled
    .sort((a, b) =>
      String(accounts.get(a.student_id)?.name || '')
        .localeCompare(
          String(accounts.get(b.student_id)?.name || '')
        )
    )
    .map(item => {
      const student = accounts.get(item.student_id);

      const periods = item.periods?.length
        ? item.periods
        : [{
            from: item.joined_on || '',
            to: item.active === false
              ? item.left_on || ''
              : null
          }];

      return `
        <tr>
          <td>
            <strong>
              ${h(student?.name || 'Account unavailable')}
            </strong>
            <small>${h(student?.student_no || '—')}</small>
          </td>

          <td>
            ${tag(
              item.active === false
                ? 'Closed enrolment'
                : 'Open enrolment',

              item.active === false
                ? 'closed'
                : 'ongoing'
            )}

            ${
              student && !student.active
                ? '<small>Account disabled</small>'
                : ''
            }
          </td>

          <td>
            ${periods.map(period =>
              `${h(period.from || 'Date not set')} → ${
                h(
                  period.to ||
                  (
                    item.active === false
                      ? 'Date not set'
                      : 'Open'
                  )
                )
              }`
            ).join('<br>')}
          </td>

          <td>
            ${
              student?.role === 'student' &&
              student.provisioning !== 'pending'
                ? `
                  <button
                    type="button"
                    class="secondary"
                    data-action="report"
                    data-id="${h(item.student_id)}"
                  >
                    Academic report ↓
                  </button>
                `
                : 'Account unavailable'
            }
          </td>
        </tr>
      `;
    })
    .join('') || `
      <tr>
        <td colspan="4" class="empty-state">
          No saved enrolments in this class.
        </td>
      </tr>
    `;
}

function classCard(course, accounts) {
  const teacher = accounts.get(course.teacher_id);
  const window = classWindow(course);

  const enrolled = data.enrolments.filter(
    item => item.class_id === course.id
  );

  const students = new Set(
    enrolled.map(item => item.student_id)
  );

  return `
    <details class="history-class">
      <summary>
        <span>
          <strong>
            ${h(course.code || '—')} ·
            ${h(course.name || 'Previous class')}
          </strong>

          <small>
            ${h([
              course.semester,

              course.section
                ? 'Section ' + course.section
                : 'Section not assigned',

              course.academic_session
                ? 'Session ' + course.academic_session
                : ''
            ].filter(Boolean).join(' · '))}
          </small>
        </span>

        <span class="history-tags">
          ${tag(students.size + ' students')}

          ${tag(
            course.active === false
              ? 'Archived class'
              : 'Active class',

            course.active === false
              ? 'closed'
              : 'ongoing'
          )}
        </span>
      </summary>

      <p class="history-copy">
        Assigned teacher:
        <strong>
          ${h(teacher?.name || 'Account unavailable')}
        </strong>

        · Class dates:
        ${
          window
            ? h(window.from + ' – ' + window.to)
            : 'Not fully recorded'
        }
      </p>

      <div
        class="table-wrap"
        tabindex="0"
        role="region"
        aria-label="Class enrolment history"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Student / ID</th>
              <th scope="col">Enrolment</th>
              <th scope="col">Joining / leaving dates</th>
              <th scope="col">Records</th>
            </tr>
          </thead>

          <tbody>
            ${studentRows(course, accounts)}
          </tbody>
        </table>
      </div>

      <p class="history-copy">
        Open a student's academic report to review subject marks,
        attendance and dated class records.
      </p>
    </details>
  `;
}

function render() {
  const groups = data
    ? semesterGroups(data.classes)
    : [];

  const accounts = new Map(
    (data?.users || []).map(user => [user.id, user])
  );

  const query = filters.search
    .normalize('NFKC')
    .trim()
    .toLowerCase();

  const visible = groups
    .map(group => ({
      ...group,

      classes: group.classes.filter(course => {
        const term = termInfo(course.semester);

        return (
          !filters.year ||
          term?.year === Number(filters.year)
        ) &&
        (
          !filters.season ||
          term?.season === filters.season
        ) &&
        [
          course.code,
          course.name,
          course.section,
          course.semester,
          accounts.get(course.teacher_id)?.name
        ]
          .join(' ')
          .normalize('NFKC')
          .toLowerCase()
          .includes(query);
      })
    }))
    .filter(group => group.classes.length);

  const totals = [
    ['Saved semesters', groups.length],

    [
      'Finished semesters',
      groups.filter(group =>
        group.stage.tone === 'finished'
      ).length
    ],

    [
      'Ongoing semesters',
      groups.filter(group =>
        group.stage.tone === 'ongoing'
      ).length
    ],

    [
      'Upcoming semesters',
      groups.filter(group =>
        group.stage.tone === 'upcoming'
      ).length
    ]
  ];

  const unknown = groups.filter(group =>
    group.stage.tone === 'unknown'
  ).length;

  if (unknown) {
    totals.push(['Dates not set', unknown]);
  }

  root.innerHTML = `
    <section class="panel">
      <div class="section-heading">
        <div>
          <span class="eyebrow">CAMPUS RECORDS</span>
          <h2>Semester & class history</h2>

          <p>
            All saved campus classes, including previous
            and archived classes.
          </p>
        </div>

        <button
          type="button"
          class="secondary"
          data-history-refresh
          ${loading ? 'disabled' : ''}
        >
          ${loading ? 'Loading…' : 'Refresh history'}
        </button>
      </div>

      ${
        feedback
          ? `
            <p class="flash danger" role="alert">
              ${h(feedback)}
            </p>
          `
          : ''
      }

      ${
        loading
          ? `
            <p class="info-note" role="status">
              Loading semester history…
            </p>
          `
          : ''
      }

      ${
        data
          ? `
            <div class="metrics">
              ${totals.map(([label, value]) => `
                <article class="metric">
                  <span>${h(label)}</span>
                  <strong>${value}</strong>
                </article>
              `).join('')}
            </div>
          `
          : ''
      }

      <p class="info-note">
        Summer: January–June. Spring: July–December.
        Semester counts use saved class records.
        Finished/Ongoing/Upcoming use class dates;
        blank dates use the Summer/Spring calendar.
        Missing legacy dates remain unclassified.
        A finished term does not mean all marks have been entered.
      </p>

      <form data-history-filter>
        <fieldset
          class="history-filters"
          ${loading || !data ? 'disabled' : ''}
        >
          <label>
            Year (blank = all)

            <input
              type="number"
              name="year"
              min="1900"
              max="9999"
              step="1"
              value="${h(filters.year)}"
            >
          </label>

          <label>
            Semester (blank = all)

            <select name="season">
              <option value="">All semesters</option>

              ${['Summer', 'Spring'].map(season => `
                <option
                  value="${season}"
                  ${filters.season === season ? 'selected' : ''}
                >
                  ${season}
                </option>
              `).join('')}
            </select>
          </label>

          <label>
            Search subject, section or teacher

            <input
              type="search"
              name="search"
              value="${h(filters.search)}"
            >
          </label>

          <button type="submit">Apply</button>

          <button
            type="button"
            class="secondary"
            data-history-reset
          >
            Reset
          </button>
        </fieldset>

        <p
          class="history-filter-error flash danger"
          data-history-error
          role="alert"
          hidden
        ></p>
      </form>

      ${
        data
          ? `
            <p class="history-copy">
              Showing ${visible.length} of ${groups.length}
              saved semesters.
              The same subject in different semesters remains
              a separate class with separate records.
            </p>
          `
          : ''
      }

      ${visible.map(group => {
        const ids = new Set(
          group.classes.map(course => course.id)
        );

        const students = new Set(
          data.enrolments
            .filter(item => ids.has(item.class_id))
            .map(item => item.student_id)
        );

        return `
          <details
            class="history-term"
            ${
              filters.year ||
              filters.season ||
              query ||
              group.stage.tone === 'ongoing'
                ? 'open'
                : ''
            }
          >
            <summary>
              <span>
                <strong>${h(group.label)}</strong>

                <small>
                  ${
                    group.stage.from
                      ? h(
                          group.stage.from +
                          ' – ' +
                          group.stage.to
                        )
                      : 'Set class dates to classify this term'
                  }
                </small>
              </span>

              <span class="history-tags">
                ${tag(
                  group.stage.label,
                  group.stage.tone
                )}

                ${tag(group.classes.length + ' classes')}
                ${tag(students.size + ' students')}
              </span>
            </summary>

            ${group.classes
              .slice()
              .sort((a, b) =>
                String(a.code).localeCompare(String(b.code)) ||
                String(a.section).localeCompare(String(b.section))
              )
              .map(course => classCard(course, accounts))
              .join('')}
          </details>
        `;
      }).join('') || (
        data
          ? `
            <p class="empty-state">
              No semester records match these filters.
            </p>
          `
          : ''
      )}
    </section>
  `;

  root.setAttribute('aria-busy', String(loading));
}

async function get(path, token, signal) {
  const response = await fetch('/api' + path, {
    headers: {
      Authorization: 'Bearer ' + token
    },

    signal,
    cache: 'no-store'
  });

  if (
    !(response.headers.get('content-type') || '')
      .includes('application/json')
  ) {
    throw Error(
      'Semester history is unavailable. Please retry.'
    );
  }

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw Error(
      result.message || 'History request failed.'
    );
  }

  return result;
}

async function load() {
  if (
    loading ||
    !auth.currentUser ||
    !userId
  ) {
    return;
  }

  const expectedUid = userId;
  const ticket = ++generation;

  controller?.abort();
  controller = new AbortController();

  const activeController = controller;

  const timer = setTimeout(
    () => activeController.abort(),
    70000
  );

  loading = true;
  feedback = '';

  render();

  const current = () =>
    ticket === generation &&
    expectedUid === userId &&
    auth.currentUser?.uid === expectedUid;

  try {
    const token = await Promise.race([
      auth.currentUser.getIdToken(),

      new Promise((resolve, reject) =>
        activeController.signal.addEventListener(
          'abort',

          () => reject(
            Error(
              'History request timed out. Please retry.'
            )
          ),

          { once: true }
        )
      )
    ]);

    if (!current()) return;

    const [classes, directory] = await Promise.all([
      get('/classes', token, activeController.signal),
      get('/directory', token, activeController.signal)
    ]);

    if (!current()) return;

    data = {
      classes: classes.classes,
      enrolments: classes.enrolments,
      users: directory.users
    };
  } catch (error) {
    if (current()) {
      feedback = error.name === 'AbortError'
        ? 'History request timed out. Please retry.'
        : error.message;
    }
  } finally {
    clearTimeout(timer);

    if (current()) {
      loading = false;
      render();
    }
  }
}

function visit() {
  const reports =
    location.hash.slice(1).split('?')[0] === 'reports';

  root.hidden = !reports || !userId;

  if (!reports) {
    pendingReportUid = '';
  }

  if (reports && userId) {
    if (data || loading) {
      render();
    } else {
      load();
    }
  }
}

/* History filters */

root.addEventListener('submit', event => {
  if (!event.target.matches('[data-history-filter]')) {
    return;
  }

  event.preventDefault();

  if (loading) return;

  const values = Object.fromEntries(
    new FormData(event.target)
  );

  const year = String(values.year || '').trim();

  if (
    year &&
    (
      !/^\d{4}$/.test(year) ||
      Number(year) < 1900 ||
      Number(year) > 9999
    )
  ) {
    const error = root.querySelector(
      '[data-history-error]'
    );

    error.textContent =
      'Enter a four-digit year between 1900 and 9999, or leave Year blank.';

    error.hidden = false;
    return;
  }

  filters = {
    year,

    season: ['Summer', 'Spring'].includes(values.season)
      ? values.season
      : '',

    search: String(values.search || '')
  };

  render();
});

/* Buttons */

root.addEventListener('click', event => {
  if (event.target.closest('[data-history-refresh]')) {
    load();
    return;
  }

  if (event.target.closest('[data-history-reset]')) {
    filters = {
      year: '',
      season: '',
      search: ''
    };

    render();
    return;
  }

  const report = event.target.closest(
    '[data-action="report"]'
  );

  if (report) {
    pendingReportUid = report.dataset.id;
  }
});

/* Move to the student report once it has loaded */

new MutationObserver(() => {
  const selectedStudent = content.querySelector(
    '[data-kind="load-report"] [name="student_id"]'
  );

  if (
    pendingReportUid &&
    selectedStudent?.value === pendingReportUid
  ) {
    pendingReportUid = '';

    content.tabIndex = -1;

    content.scrollIntoView?.({
      block: 'start',
      behavior: 'smooth'
    });

    content.focus?.({
      preventScroll: true
    });
  }
}).observe(content, {
  childList: true
});

/* Refresh, navigation and authentication */

document.getElementById('refresh')
  .addEventListener('click', () => {
    if (!root.hidden) load();
  });

window.addEventListener('hashchange', visit);

onAuthStateChanged(auth, user => {
  ++generation;

  controller?.abort();

  loading = false;
  data = null;
  feedback = '';

  filters = {
    year: '',
    season: '',
    search: ''
  };

  pendingReportUid = '';
  userId = user?.uid || '';

  root.innerHTML = '';

  visit();
});