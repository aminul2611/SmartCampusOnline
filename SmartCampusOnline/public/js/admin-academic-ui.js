// Presentation helpers.
// All writes go through the authenticated Admin API.

export function semesterStatus(
  semesters,
  value,
  termKey
) {
  return (
    (semesters || []).find(
      item =>
        termKey(item.semester) ===
        termKey(value)
    ) || null
  );
}

export function subjectPicker(
  edit,
  subjects,
  h
) {
  if (edit) {
    return `
      <div class="subject-picker">
        <label>
          Subject

          <input
            value="${h(
              edit.code + ' — ' + edit.name
            )}"
            readonly
          >
        </label>

        <input
          type="hidden"
          name="code"
          value="${h(edit.code)}"
        >

        <input
          type="hidden"
          name="name"
          value="${h(edit.name)}"
        >

        <small>
          Saved class subject.
          Use Create class to choose another subject.
        </small>
      </div>
    `;
  }

  return `
    <div class="subject-picker">
      <label for="class-subject">
        Subject
      </label>

      <input
        id="class-subject"
        name="subject_query"
        type="search"
        list="subject-options"
        placeholder="Select a subject — search name or code"
        required
        maxlength="250"
        autocomplete="off"
      >

      <datalist id="subject-options">
        ${subjects.map(item => `
          <option
            value="${h(
              item.code + ' — ' + item.name
            )}"
          ></option>
        `).join('')}
      </datalist>

      <small>
        Choose a saved subject.
        Add a new name and code in Manage subjects below.
      </small>
    </div>
  `;
}

export function resolveSubject(
  query,
  subjects
) {
  const normal = value =>
    String(value || '')
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const value = normal(query);

  const matches = subjects.filter(
    item => [
      item.code,
      item.name,
      item.code + ' — ' + item.name
    ].some(
      candidate =>
        normal(candidate) === value
    )
  );

  if (matches.length !== 1) {
    throw Error(
      matches.length
        ? 'More than one subject has this name. Choose the subject code from the suggestions.'
        : 'Choose an existing subject by name or code. Add it in Manage subjects if it is new.'
    );
  }

  return matches[0];
}

export function subjectsPanel({
  subjects = [],
  edit,
  search = '',
  h,
  field,
  button,
  panel,
  table
}) {
  const query = search
    .normalize('NFKC')
    .trim()
    .toLowerCase();

  const visible = subjects.filter(
    item =>
      (
        item.code + ' ' + item.name
      )
        .toLowerCase()
        .includes(query)
  );

  return panel(
    'Manage subjects',

    `
      <p class="info-note">
        Save each subject name and code once,
        then select it when creating classes.

        The same subject can be used in different
        semesters, years and sections.
      </p>

      <details ${edit ? 'open' : ''}>
        <summary>
          ${
            edit
              ? 'Edit subject'
              : '＋ Add subject'
          }
        </summary>

        <form
          data-kind="subject"
          data-id="${h(edit?.id || '')}"
        >
          <div class="form-grid">
            ${field(
              'Subject code',
              'code',
              edit?.code,
              'text',

              `required maxlength="80" ${
                edit ? 'readonly' : ''
              }`
            )}

            ${field(
              'Subject name',
              'name',
              edit?.name,
              'text',
              'required maxlength="150"'
            )}
          </div>

          <div class="form-footer">
            <button type="submit">
              Save subject
            </button>

            ${
              edit
                ? button(
                    'Cancel',
                    'cancel-subject'
                  )
                : ''
            }
          </div>
        </form>
      </details>

      <form
        data-kind="subject-search"
        class="filter-form"
      >
        ${field(
          'Search subject name or code',
          'search',
          search,
          'search'
        )}

        <button type="submit">
          Search subjects
        </button>

        ${button(
          'Reset',
          'reset-subjects'
        )}
      </form>

      ${table(
        [
          'Code',
          'Subject',
          'Source',
          'Action'
        ],

        visible.map(item => `
          <tr>
            <td>${h(item.code)}</td>

            <td>
              ${h(item.name)}

              ${
                item.names?.length > 1
                  ? `
                    <small>
                      Older classes use multiple names
                      for this code. Review the name
                      before saving.
                    </small>
                  `
                  : ''
              }
            </td>

            <td>
              ${
                item.saved
                  ? 'Saved subject'
                  : 'From existing classes'
              }
            </td>

            <td>
              ${button(
                item.saved
                  ? 'Edit'
                  : 'Review & save',

                'edit-subject',
                item.id
              )}
            </td>
          </tr>
        `)
      )}

      <p class="muted">
        Editing a subject updates the selection list
        for new classes.

        Existing class names, attendance and results
        keep their saved records.
      </p>
    `
  );
}

export function renderAcademicReports(ctx) {
  const {
    state,
    report,
    filter,
    scope,
    h,
    field,
    select,
    panel,
    termFilterFields,
    matchesTerm,
    studentMatchesTerm,
    semesterKey,
    termInfo,
    displayTerm,
    marksTable,
    resultSummary,
    attendanceSummary,
    metrics,
    percentage,
    number,
    badge,
    table,
    today,
    button
  } = ctx;

  const students = state.users.filter(
    user =>
      user.role === 'student' &&

      studentMatchesTerm(
        user,
        scope
      ) &&

      [
        user.name,
        user.student_no,
        user.email
      ]
        .join(' ')
        .toLowerCase()
        .includes(
          scope.search.toLowerCase()
        )
  );

  const chooser = `
    <form
      data-kind="load-report"
      class="filter-form"
    >
      ${termFilterFields(scope)}

      ${field(
        'Find Student ID, name or email',
        'student_search',
        scope.search,
        'search',
        'id="student-search"'
      )}

      ${select(
        'Student',
        'student_id',

        students.map(user => [
          user.id,

          (user.student_no || '—') +
            ' — ' +
            user.name
        ]),

        report?.profile.id || '',
        true
      )}

      <button type="submit">
        View academic report
      </button>

      ${button(
        'Reset selection filters',
        'reset-report-scope'
      )}

      <p class="muted">
        Choose Year and Semester first,
        or leave them blank for all records.

        Students are matched using saved enrolment
        history as well as their profile.
      </p>
    </form>
  `;

  if (!report) {
    return panel(
      'Student academic reports',
      chooser
    );
  }

  const all = report.classes || [];

  const visible = all.filter(
    course =>
      matchesTerm(
        course.semester,
        filter
      ) &&

      (
        !filter.class_id ||
        course.id === filter.class_id
      )
  );

  const termClasses = (
    term,
    source = visible
  ) =>
    source.filter(
      course =>
        semesterKey(course.semester) ===
        semesterKey(term)
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

    if (x && y) {
      return (
        x.year - y.year ||

        (
          x.season === y.season
            ? 0
            : x.season === 'Summer'
              ? -1
              : 1
        )
      );
    }

    return a.localeCompare(
      b,
      undefined,
      {
        numeric: true
      }
    );
  });

  const statusOf = term =>
    semesterStatus(
      state.semesters,
      term,
      semesterKey
    )?.status || '';

  const statusLabels = {
    upcoming: 'Upcoming',
    ongoing: 'Ongoing',
    completed: 'Completed'
  };

  const eligible = terms.filter(
    term =>
      statusOf(term) === 'completed' &&

      resultSummary(
        termClasses(term, all)
      ).complete
  );

  const overall = resultSummary(
    visible.filter(
      course =>
        eligible.some(
          term =>
            semesterKey(term) ===
            semesterKey(course.semester)
        )
    )
  );

  const ongoing = [
    ...new Set(
      all
        .filter(
          course =>
            statusOf(
              course.semester
            ) === 'ongoing'
        )
        .map(
          course =>
            displayTerm(
              course.semester
            )
        )
    )
  ];

  const ids = new Set(
    visible.map(
      course => course.id
    )
  );

  const rows = (
    report.attendance || []
  ).filter(
    session =>
      ids.has(session.class_id) &&

      (
        !filter.from ||
        session.lesson_date >=
          filter.from
      ) &&

      (
        !filter.to ||
        session.lesson_date <=
          filter.to
      )
  );

  const attendance =
    attendanceSummary(rows);

  const scopeLabel = [
    filter.season || 'All semesters',
    filter.year || 'All years'
  ].join(' · ');

  const semesterCards = terms
    .map(term => {
      const courses =
        termClasses(term);

      const summary =
        resultSummary(courses);

      const fullSummary =
        resultSummary(
          termClasses(term, all)
        );

      const totalAttendance =
        attendanceSummary(
          rows.filter(
            row =>
              courses.some(
                course =>
                  course.id ===
                  row.class_id
              )
          )
        );

      return `
        <details
          class="semester-record academic-term"
          open
        >
          <summary>
            <strong>
              ${h(term)}
            </strong>

            <span
              class="academic-status ${h(
                statusOf(term) || 'unset'
              )}"
            >
              ${
                statusLabels[
                  statusOf(term)
                ] || 'Status not set'
              }
            </span>

            ${badge(
              fullSummary.complete
                ? 'Result complete'
                : 'Result incomplete',

              fullSummary.complete
                ? 'present'
                : ''
            )}
          </summary>

          ${metrics([
            [
              'Subjects shown',
              courses.length
            ],

            [
              'Graded subjects',

              summary.count +
                ' / ' +
                summary.total
            ],

            [
              'Earned / maximum',

              summary.complete
                ? number(summary.earned) +
                  ' / ' +
                  number(summary.max)
                : 'Incomplete'
            ],

            [
              filter.class_id
                ? 'Selected subject percentage'
                : 'Semester average',

              fullSummary.complete &&
              summary.complete
                ? percentage(
                    summary.average
                  )
                : 'Incomplete'
            ],

            [
              'Attendance',

              percentage(
                totalAttendance.percentage
              )
            ]
          ])}

          ${marksTable(courses)}

          <p class="muted">
            Semester status is set by Admin.
            Result completeness is checked separately.

            ${
              fullSummary.complete
                ? ''
                : `
                  The semester average is withheld until
                  every enrolled subject has complete marks.
                `
            }

            ${
              filter.class_id
                ? `
                  Subject filter is active;
                  displayed totals cover only
                  the selected class.
                `
                : ''
            }
          </p>
        </details>
      `;
    })
    .join('');

  return (
    panel(
      'Student academic reports',
      chooser
    ) +

    panel(
      report.profile.name,

      `
        <p class="muted">
          ${h(
            [
              report.profile.student_no,
              report.profile.email,
              report.profile.department
            ]
              .filter(Boolean)
              .join(' · ')
          )}
        </p>

        <p>
          <strong>
            Ongoing enrolled semesters:
          </strong>

          ${h(
            ongoing.join(', ') ||
            'None marked Ongoing by Admin'
          )}
        </p>

        <p class="muted">
          Profile semester:

          ${h(
            displayTerm(
              report.profile.semester
            ) || 'Not assigned'
          )}.

          Report status comes from Semester History,
          independently of the profile.
        </p>
      `
    ) +

    panel(
      'Report filters',

      `
        <form
          data-kind="report-filter"
          class="filter-form"
        >
          ${termFilterFields(filter)}

          ${select(
            'Subject / class (blank = all)',
            'class_id',

            all
              .filter(
                course =>
                  matchesTerm(
                    course.semester,
                    filter
                  )
              )
              .map(course => [
                course.id,

                course.code +
                  ' — ' +
                  course.name +
                  ' · ' +
                  displayTerm(
                    course.semester
                  ) +

                  (
                    course.section
                      ? ' · Section ' +
                        course.section
                      : ''
                  )
              ]),

            filter.class_id
          )}

          ${field(
            'Attendance from',
            'from',
            filter.from,
            'date'
          )}

          ${field(
            'Attendance to',
            'to',
            filter.to,
            'date',
            `max="${today()}"`
          )}

          <button type="submit">
            Apply filters
          </button>

          ${button(
            'Reset',
            'reset-report'
          )}

          <p class="muted">
            Year and Semester filter results
            and attendance together.

            Date filters apply only to attendance.

            Pass ≥ 40%;
            Fail &lt; 40% after all marks are entered.
          </p>
        </form>
      `
    ) +

    panel(
      'Overall result · ' +
        scopeLabel,

      metrics([
        [
          'Completed semesters with complete results',
          eligible.length
        ],

        [
          'Graded subjects included',
          overall.count
        ],

        [
          'Earned / maximum',

          overall.count
            ? number(overall.earned) +
              ' / ' +
              number(overall.max)
            : '—'
        ],

        [
          'Weighted average',
          percentage(
            overall.average
          )
        ]
      ]) +

      `
        <p class="info-note">
          Only semesters marked Completed by Admin
          with complete marks in every enrolled subject
          enter this average.

          Upcoming, Ongoing, unset and incomplete
          semesters are excluded.

          Average = total earned ÷ total maximum × 100.

          Selected Year, Semester and Subject filters apply.

          No GPA/CGPA is inferred.
        </p>
      `
    ) +

    panel(
      'Semester results · ' +
        scopeLabel,

      semesterCards ||

      `
        <p class="empty-state">
          No enrolled subjects match these filters.
        </p>
      `
    ) +

    panel(
      'Student attendance · ' +
        scopeLabel,

      metrics([
        [
          'Recorded classes',
          attendance.total
        ],

        [
          'Attended',
          attendance.attended
        ],

        [
          'Absent',
          attendance.Absent
        ],

        [
          'Excused',
          attendance.Excused
        ],

        [
          'Not marked',
          attendance['Not marked']
        ],

        [
          'Attendance',

          percentage(
            attendance.percentage
          )
        ]
      ]) +

      `
        <p class="info-note">
          Present + Late count as attended.

          Excused and Not marked remain
          in the recorded-class total.

          ${attendance.pending}
          past sessions awaiting attendance are excluded.
        </p>
      ` +

      table(
        [
          'Subject',
          'Semester',
          'Recorded',
          'Attended',
          'Absent',
          'Excused',
          'Not marked',
          '%'
        ],

        visible.map(course => {
          const summary =
            attendanceSummary(
              rows.filter(
                row =>
                  row.class_id ===
                  course.id
              )
            );

          return `
            <tr>
              <td>
                ${h(course.code)}
                —
                ${h(course.name)}

                ${
                  course.section
                    ? `
                      <small>
                        Section
                        ${h(course.section)}
                      </small>
                    `
                    : ''
                }
              </td>

              <td>
                ${h(
                  displayTerm(
                    course.semester
                  )
                )}
              </td>

              <td>
                ${summary.total}
              </td>

              <td>
                ${summary.attended}
              </td>

              <td>
                ${summary.Absent}
              </td>

              <td>
                ${summary.Excused}
              </td>

              <td>
                ${summary['Not marked']}
              </td>

              <td>
                ${percentage(
                  summary.percentage
                )}
              </td>
            </tr>
          `;
        })
      )
    ) +

    panel(
      'Dated class records',

      table(
        [
          'Date',
          'Subject',
          'Semester',
          'Time',
          'Status'
        ],

        rows.map(session => `
          <tr>
            <td>
              ${h(session.lesson_date)}
            </td>

            <td>
              ${h(session.code)}
              —
              ${h(session.name)}
            </td>

            <td>
              ${h(
                displayTerm(
                  session.semester
                )
              )}
            </td>

            <td>
              ${h(session.start_time)}–${h(
                session.end_time
              )}
            </td>

            <td>
              ${badge(
                session.counted
                  ? session.status
                  : 'Awaiting attendance',

                session.counted
                  ? (
                      {
                        Present: 'present',
                        Late: 'late',
                        Absent: 'absent',
                        Excused: 'excused',
                        'Not marked': 'unmarked'
                      }[session.status] || ''
                    )
                  : ''
              )}
            </td>
          </tr>
        `)
      )
    )
  );
}