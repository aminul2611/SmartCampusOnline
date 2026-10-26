const express = require('express');

const {
  createAccountApp
} = require('./account-api');

const {
  createTeacherProfileApp
} = require('./teacher-profile-api');

const {
  createTeacherNoticesApp,
  loadNotices,
  addressedToAdmin
} = require('./teacher-notices-api');

const {
  ApiError,
  text,
  id,
  boolean,
  date,
  slots,
  key
} = require('./validation');

const A = require('./academic-core');

const Academic = require('./admin-academic-api');

function createAdminApp({ auth, db, timestamp }) {
  const app = express();

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');

    next();
  });

  app.use(express.json({ limit: '64kb' }));

  app.use(
    '/api/teacher/profile',
    createTeacherProfileApp({
      auth,
      db,
      timestamp
    })
  );

  const noticesApp = createTeacherNoticesApp({
    auth,
    db,
    timestamp
  });

  const accounts = {
    teacher: createAccountApp({
      auth,
      db,
      timestamp,
      role: 'teacher'
    }),

    student: createAccountApp({
      auth,
      db,
      timestamp,
      role: 'student'
    })
  };

  app.use((req, res, next) => {
    if (
      /^\/api\/teacher\/notices(?:\/|$)/.test(
        req.path
      )
    ) {
      return noticesApp(req, res, next);
    }

    for (const role of ['teacher', 'student']) {
      const path = new RegExp(
        '^/api/' + role + 's(?:/|$)'
      );

      if (path.test(req.path)) {
        if (
          req.body &&
          typeof req.body.semester === 'string'
        ) {
          req.body.semester = A.semester(
            req.body.semester
          );
        }

        return accounts[role](req, res, next);
      }
    }

    next();
  });

  const route = handler => async (
    req,
    res,
    next
  ) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  app.use('/api', async (req, res, next) => {
    try {
      const header =
        req.get('Authorization') || '';

      if (!header.startsWith('Bearer ')) {
        throw new ApiError(
          401,
          'Please sign in as administrator.'
        );
      }

      let decoded;

      try {
        decoded = await auth.verifyIdToken(
          header.slice(7),
          true
        );
      } catch (error) {
        if (
          String(error.code).startsWith('auth/')
        ) {
          throw new ApiError(
            401,
            'Session expired. Please sign in again.'
          );
        }

        throw error;
      }

      const user = await db
        .collection('users')
        .doc(decoded.uid)
        .get();

      if (
        !user.exists ||
        user.data().role !== 'admin' ||
        user.data().active !== true
      ) {
        throw new ApiError(
          403,
          'An active administrator account is required.'
        );
      }

      if (
        req.method === 'POST' &&
        (
          !req.body ||
          typeof req.body !== 'object' ||
          Array.isArray(req.body)
        )
      ) {
        throw new ApiError(
          400,
          'Send a valid JSON object.'
        );
      }

      req.adminUid = decoded.uid;
      req.adminProfile = user.data();

      next();
    } catch (error) {
      next(error);
    }
  });

  const ok = (res, data = {}) =>
    res.json({
      ok: true,
      ...data
    });

  Academic.registerAcademicRoutes({
    app,
    db,
    timestamp,
    route,
    ok
  });

  const list = async name =>
    A.rows(
      await db.collection(name).get()
    );

  const publicUser = user =>
    Object.fromEntries(
      [
        'id',
        'name',
        'email',
        'role',
        'active',
        'teacher_no',
        'student_no',
        'department',
        'program',
        'semester',
        'phone',
        'designation',
        'provisioning'
      ]
        .filter(
          field => user[field] !== undefined
        )
        .map(field => [
          field,

          field === 'semester'
            ? A.semester(user[field])
            : user[field]
        ])
    );

  async function existing(collection, uid) {
    const ref = db
      .collection(collection)
      .doc(id(uid));

    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new ApiError(
        404,
        'Record not found.'
      );
    }

    return {
      ref,
      data: snapshot.data()
    };
  }

  async function activeUser(uid, role) {
    const { data } = await existing(
      'users',
      uid
    );

    if (
      data.role !== role ||
      data.active !== true ||
      data.provisioning === 'pending'
    ) {
      throw new ApiError(
        400,
        'Select an active ' + role + '.'
      );
    }

    return data;
  }

  app.get(
    '/api/health',
    route(async (req, res) => {
      ok(res, {
        backend: 'Firebase Admin API'
      });
    })
  );

  app.get(
    '/api/directory',
    route(async (req, res) => {
      ok(res, {
        users: (
          await list('users')
        ).map(publicUser)
      });
    })
  );

  app.get(
    '/api/profile',
    route(async (req, res) => {
      ok(res, {
        profile: publicUser({
          ...req.adminProfile,
          id: req.adminUid
        })
      });
    })
  );

  app.post(
    '/api/profile',
    route(async (req, res) => {
      const fields = {
        name: text(
          req.body,
          'name',
          100
        ),

        phone: text(
          req.body,
          'phone',
          150,
          false
        ),

        department: text(
          req.body,
          'department',
          150,
          false
        )
      };

      const old = await auth.getUser(
        req.adminUid
      );

      await auth.updateUser(req.adminUid, {
        displayName: fields.name
      });

      try {
        await db
          .collection('users')
          .doc(req.adminUid)
          .update({
            ...fields,
            updated_at: timestamp()
          });
      } catch (error) {
        await auth.updateUser(
          req.adminUid,
          {
            displayName:
              old.displayName || ''
          }
        );

        throw new ApiError(
          503,
          'Profile could not save. Please retry.'
        );
      }

      ok(res, {
        message: 'Profile updated.',

        profile: publicUser({
          ...req.adminProfile,
          ...fields,
          id: req.adminUid
        })
      });
    })
  );

  app.get(
    '/api/classes',
    route(async (req, res) => {
      const [
        classes,
        enrolments
      ] = await Promise.all([
        list('classes'),
        list('enrolments')
      ]);

      ok(res, {
        classes: classes.map(
          classroom => ({
            ...classroom,

            semester: A.semester(
              classroom.semester
            )
          })
        ),

        enrolments: enrolments.map(
          enrolment => ({
            ...enrolment,

            periods: A.periods(enrolment)
          })
        )
      });
    })
  );

  function classFields(body) {
    const fields = {
      code: text(
        body,
        'code',
        80
      ),

      name: text(
        body,
        'name',
        150
      ),

      semester: A.semester(
        text(body, 'semester', 80)
      ),

      academic_session: text(
        body,
        'academic_session',
        80,
        false
      ),

      section: text(
        body,
        'section',
        80,
        false
      ),

      teacher_id: id(
        body.teacher_id
      ),

      weekly_slots: slots(
        body.weekly_slots
      ),

      start_date: body.start_date
        ? date(body.start_date)
        : '',

      end_date: body.end_date
        ? date(body.end_date)
        : ''
    };

    if (
      fields.start_date &&
      fields.end_date &&
      fields.start_date > fields.end_date
    ) {
      throw new ApiError(
        400,
        'Class end date must be on or after its start date.'
      );
    }

    for (
      const [name, maximum]
      of Object.entries({
        assessment: 20,
        mid: 30,
        final: 50
      })
    ) {
      const value =
        body[name + '_max'] ?? maximum;

      if (
        value === '' ||
        !Number.isFinite(Number(value)) ||
        Number(value) < 0 ||
        Number(value) > 10000
      ) {
        throw new ApiError(
          400,
          'Enter a valid ' +
            name +
            ' maximum.'
        );
      }

      fields[name + '_max'] =
        Number(value);
    }

    if (
      fields.assessment_max +
      fields.mid_max +
      fields.final_max <= 0
    ) {
      throw new ApiError(
        400,
        'Total maximum marks must be greater than zero.'
      );
    }

    return fields;
  }

  const identity = classroom => [
    classroom.code
      .trim()
      .toLowerCase(),

    A.semester(
      classroom.semester
    ).toLowerCase(),

    (
      classroom.academic_session || ''
    )
      .trim()
      .toLowerCase(),

    (
      classroom.section || ''
    )
      .trim()
      .toLowerCase()
  ];

  async function saveClass(
    req,
    res,
    creating
  ) {
    const fields = classFields(
      req.body
    );

    await activeUser(
      fields.teacher_id,
      'teacher'
    );

    const classId = creating
      ? key(
          'class',
          ...identity(fields)
        )
      : id(req.params.id);

    const ref = db
      .collection('classes')
      .doc(classId);

    await db.runTransaction(
      async transaction => {
        const before = await A.scheduleState(
          transaction,
          db
        );

        const old = before.classes.find(
          classroom =>
            classroom.id === classId
        );

        if (
          creating &&
          req.body.subject_id
        ) {
          const subject =
            await transaction.get(
              db
                .collection('subjects')
                .doc(
                  id(req.body.subject_id)
                )
            );

          const catalogue =
            Academic.subjectCatalogue(
              subject.exists
                ? [
                    {
                      ...subject.data(),
                      id: subject.id
                    }
                  ]
                : [],

              before.classes
            );

          const chosen = catalogue.find(
            item =>
              item.id ===
              req.body.subject_id
          );

          if (
            !chosen ||
            Academic.subjectCode(
              chosen.code
            ) !==
              Academic.subjectCode(
                fields.code
              )
          ) {
            throw new ApiError(
              400,
              'Select a saved subject by name or code.'
            );
          }

          fields.name = chosen.name;
        }

        const teacher =
          await transaction.get(
            db
              .collection('users')
              .doc(fields.teacher_id)
          );

        if (
          !teacher.exists ||
          teacher.data().role !== 'teacher' ||
          teacher.data().active !== true
        ) {
          throw new ApiError(
            400,
            'Choose an active teacher.'
          );
        }

        if (!creating && !old) {
          throw new ApiError(
            404,
            'Class not found.'
          );
        }

        if (
          creating &&
          before.classes.some(
            classroom =>
              Academic.subjectCode(
                classroom.code
              ) ===
                Academic.subjectCode(
                  fields.code
                ) &&

              Academic.semesterKey(
                classroom.semester
              ) ===
                Academic.semesterKey(
                  fields.semester
                ) &&

              Academic.semesterKey(
                classroom.academic_session
              ) ===
                Academic.semesterKey(
                  fields.academic_session
                ) &&

              String(
                classroom.section || ''
              )
                .trim()
                .toLowerCase() ===

              String(
                fields.section || ''
              )
                .trim()
                .toLowerCase()
          )
        ) {
          throw new ApiError(
            409,

            'This subject/session/semester/section already exists. ' +
              'Edit or restore it.'
          );
        }

        if (
          old &&
          JSON.stringify(
            identity(old)
          ) !==
            JSON.stringify(
              identity(fields)
            )
        ) {
          throw new ApiError(
            409,

            'Subject code, semester, academic session and section ' +
              'are fixed. Create a new class to preserve historical records.'
          );
        }

        const marks =
          await transaction.get(
            db
              .collection('teacher_marks')
              .where(
                'class_id',
                '==',
                classId
              )
          );

        const hasMarks =
          marks.docs.some(doc =>
            [
              'assessment',
              'mid',
              'final'
            ].some(
              name =>
                doc.data()[name] != null
            )
          );

        const defaults = {
          assessment: 20,
          mid: 30,
          final: 50
        };

        const maximumChanged = [
          'assessment',
          'mid',
          'final'
        ].some(
          name =>
            Number(
              old?.[name + '_max'] ??
              defaults[name]
            ) !==
            fields[name + '_max']
        );

        if (
          old &&
          hasMarks &&
          maximumChanged
        ) {
          throw new ApiError(
            409,
            'Maximum marks cannot change after marks have been entered.'
          );
        }

        const record = {
          ...(old || {}),
          ...fields,

          id: classId,

          active: old
            ? old.active !== false
            : true
        };

        const excludesSavedSession =
          before.lessons.some(
            session =>
              session.class_id === classId &&
              session.cancelled !== true &&

              (
                (
                  fields.start_date &&
                  session.lesson_date <
                    fields.start_date
                ) ||

                (
                  fields.end_date &&
                  session.lesson_date >
                    fields.end_date
                )
              )
          );

        if (excludesSavedSession) {
          throw new ApiError(
            409,
            'The class date range must include its saved sessions.'
          );
        }

        const after = {
          ...before,

          classes: [
            ...before.classes.filter(
              classroom =>
                classroom.id !== classId
            ),

            record
          ]
        };

        A.rejectNew(before, after);

        const {
          id: ignored,
          ...saved
        } = record;

        transaction.set(
          ref,

          {
            ...saved,

            updated_at: timestamp(),

            ...(
              creating
                ? {
                    created_at: timestamp(),
                    created_by: req.adminUid
                  }
                : {}
            )
          },

          {
            merge: true
          }
        );

        transaction.set(
          before.lock,

          {
            updated_at: timestamp()
          }
        );
      }
    );

    ok(res, {
      id: classId,

      message: creating
        ? 'Class created.'
        : 'Class updated.'
    });
  }

  app.post(
    '/api/classes',

    route((req, res) =>
      saveClass(req, res, true)
    )
  );

  app.post(
    '/api/classes/:id/save',

    route((req, res) =>
      saveClass(req, res, false)
    )
  );

  app.post(
    '/api/classes/:id/status',

    route(async (req, res) => {
      const classId = id(
        req.params.id
      );

      const active = boolean(
        req.body.active
      );

      await db.runTransaction(
        async transaction => {
          const before =
            await A.scheduleState(
              transaction,
              db
            );

          const classroom =
            before.classes.find(
              course =>
                course.id === classId
            );

          if (!classroom) {
            throw new ApiError(
              404,
              'Class not found.'
            );
          }

          if (active) {
            const teacher =
              await transaction.get(
                db
                  .collection('users')
                  .doc(
                    classroom.teacher_id
                  )
              );

            if (
              !teacher.exists ||
              teacher.data().active !== true
            ) {
              throw new ApiError(
                409,
                'Enable or replace the assigned teacher first.'
              );
            }
          }

          A.rejectNew(
            before,

            {
              ...before,

              classes: before.classes.map(
                course =>
                  course.id === classId
                    ? {
                        ...course,
                        active
                      }
                    : course
              )
            }
          );

          transaction.update(
            db
              .collection('classes')
              .doc(classId),

            {
              active,
              updated_at: timestamp()
            }
          );

          transaction.set(
            before.lock,

            {
              updated_at: timestamp()
            }
          );
        }
      );

      ok(res, {
        message: active
          ? 'Class restored.'
          : 'Class archived; saved records are retained.'
      });
    })
  );

  app.post(
    '/api/classes/:id/enrolments',

    route(async (req, res) => {
      const classId = id(
        req.params.id
      );

      const studentId = id(
        req.body.student_id
      );

      const from = date(
        req.body.joined_on || A.day()
      );

      if (from > A.day()) {
        throw new ApiError(
          400,
          'Joining date cannot be in the future.'
        );
      }

      await activeUser(
        studentId,
        'student'
      );

      await db.runTransaction(
        async transaction => {
          const before =
            await A.scheduleState(
              transaction,
              db
            );

          const classroom =
            before.classes.find(
              course =>
                course.id === classId
            );

          if (
            !classroom ||
            classroom.active === false
          ) {
            throw new ApiError(
              409,
              'Select an active class.'
            );
          }

          const ref = db
            .collection('enrolments')
            .doc(
              key(
                classId,
                studentId
              )
            );

          const old =
            before.enrolments.find(
              enrolment =>
                enrolment.id === ref.id
            );

          const student =
            await transaction.get(
              db
                .collection('users')
                .doc(studentId)
            );

          if (
            !student.exists ||
            student.data().role !== 'student' ||
            student.data().active !== true
          ) {
            throw new ApiError(
              400,
              'Choose an active student.'
            );
          }

          if (
            old &&
            old.active !== false
          ) {
            return;
          }

          const periods = old
            ? A.periods(old).map(
                period => ({
                  ...period
                })
              )
            : [];

          if (
            periods.length &&
            (
              !periods.at(-1).to ||
              from < periods.at(-1).to
            )
          ) {
            throw new ApiError(
              400,
              'Re-enrolment must start on or after the previous leaving date.'
            );
          }

          periods.push({
            from,
            to: null
          });

          const enrolment = {
            ...(old || {}),

            id: ref.id,
            class_id: classId,
            student_id: studentId,
            active: true,

            joined_on:
              periods[0].from,

            left_on: null,

            periods,

            semester: A.semester(
              classroom.semester
            ),

            academic_session:
              classroom.academic_session ||
              '',

            section:
              classroom.section || '',

            class_code:
              classroom.code,

            class_name:
              classroom.name
          };

          A.rejectNew(
            before,

            {
              ...before,

              enrolments: [
                ...before.enrolments.filter(
                  item =>
                    item.id !== ref.id
                ),

                enrolment
              ]
            }
          );

          const {
            id: ignored,
            ...saved
          } = enrolment;

          transaction.set(
            ref,

            {
              ...saved,

              updated_at: timestamp(),

              ...(
                !old
                  ? {
                      created_at: timestamp(),
                      created_by: req.adminUid
                    }
                  : {}
              )
            },

            {
              merge: true
            }
          );

          transaction.set(
            before.lock,

            {
              updated_at: timestamp()
            }
          );
        }
      );

      ok(res, {
        message:
          'Student enrolled; history preserved.'
      });
    })
  );

  app.post(
    '/api/classes/:id/enrolments/:uid/remove',

    route(async (req, res) => {
      const classId = id(
        req.params.id
      );

      const studentId = id(
        req.params.uid
      );

      const to = date(
        req.body.left_on || A.day()
      );

      if (to > A.day()) {
        throw new ApiError(
          400,
          'Leaving date cannot be in the future.'
        );
      }

      await db.runTransaction(
        async transaction => {
          const before =
            await A.scheduleState(
              transaction,
              db
            );

          const ref = db
            .collection('enrolments')
            .doc(
              key(
                classId,
                studentId
              )
            );

          const old =
            before.enrolments.find(
              enrolment =>
                enrolment.id === ref.id
            );

          if (!old) {
            throw new ApiError(
              404,
              'Enrolment not found.'
            );
          }

          if (old.active === false) {
            return;
          }

          const saved =
            await transaction.get(
              db
                .collection(
                  'student_attendance'
                )
                .where(
                  'class_id',
                  '==',
                  classId
                )
            );

          if (
            saved.docs.some(
              doc =>
                doc.data().student_id ===
                  studentId &&

                doc.data().session_date > to
            )
          ) {
            throw new ApiError(
              409,
              'Leaving date is before a saved attendance record.'
            );
          }

          const periods =
            A.periods(old).map(
              period => ({
                ...period
              })
            );

          if (
            to <
            periods.at(-1).from
          ) {
            throw new ApiError(
              400,
              'Leaving date is before the joining date.'
            );
          }

          periods[
            periods.length - 1
          ].to = to;

          transaction.update(
            ref,

            {
              active: false,

              joined_on:
                periods[0].from,

              left_on: to,

              periods,

              updated_at: timestamp()
            }
          );

          transaction.set(
            before.lock,

            {
              updated_at: timestamp()
            }
          );
        }
      );

      ok(res, {
        message:
          'Enrolment closed; previous records are preserved.'
      });
    })
  );

  app.get(
    '/api/schedule-conflicts',

    route(async (req, res) => {
      const [
        classes,
        enrolments,
        lessons,
        users
      ] = await Promise.all([
        list('classes'),
        list('enrolments'),
        list('teacher_lessons'),
        list('users')
      ]);

      const names = new Map(
        users.map(
          user => [
            user.id,
            user.name
          ]
        )
      );

      ok(res, {
        conflicts: A.conflicts(
          classes,
          enrolments,
          lessons
        ).map(conflict => ({
          ...conflict,

          person_name:
            names.get(
              conflict.person_id
            ) ||
            'Account unavailable'
        }))
      });
    })
  );

  app.get(
    '/api/student-reports/:uid',

    route(async (req, res) => {
      const studentId = id(
        req.params.uid
      );

      const { data } =
        await existing(
          'users',
          studentId
        );

      if (
        data.role !== 'student'
      ) {
        throw new ApiError(
          400,
          'Select a student.'
        );
      }

      res.json(
        await A.studentData(
          db,
          studentId,
          data
        )
      );
    })
  );

  app.get(
    '/api/teacher-attendance',

    route(async (req, res) => {
      const month = String(
        req.query.month ||
        A.day().slice(0, 7)
      );

      if (
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(
          month
        )
      ) {
        throw new ApiError(
          400,
          'Select a valid month.'
        );
      }

      const next = new Date(
        month + '-01T00:00:00Z'
      );

      next.setUTCMonth(
        next.getUTCMonth() + 1
      );

      const end = next
        .toISOString()
        .slice(0, 10);

      const snapshot = await db
        .collection(
          'teacher_work_attendance'
        )
        .where(
          'work_date',
          '>=',
          month + '-01'
        )
        .where(
          'work_date',
          '<',
          end
        )
        .get();

      ok(res, {
        month,

        records: A.rows(
          snapshot
        ).sort(
          (a, b) =>
            b.work_date.localeCompare(
              a.work_date
            )
        )
      });
    })
  );

  app.get(
    '/api/overview',

    route(async (req, res) => {
      const onDate = date(
        req.query.date ||
        A.day()
      );

      const [
        users,
        classes,
        notices,
        work,
        records,
        lessons
      ] = await Promise.all([
        list('users'),
        list('classes'),
        loadNotices(db),

        db
          .collection(
            'teacher_work_attendance'
          )
          .where(
            'work_date',
            '==',
            onDate
          )
          .get(),

        db
          .collection(
            'student_attendance'
          )
          .where(
            'session_date',
            '==',
            onDate
          )
          .get(),

        db
          .collection(
            'teacher_lessons'
          )
          .where(
            'lesson_date',
            '==',
            onDate
          )
          .get()
      ]);

      const status = {
        Present: 0,
        Late: 0,
        Absent: 0,
        Excused: 0
      };

      records.docs.forEach(doc => {
        if (
          Object.hasOwn(
            status,
            doc.data().status
          )
        ) {
          status[
            doc.data().status
          ]++;
        }
      });

      const published =
        notices.filter(
          notice =>
            notice.author_role !==
            'teacher'
        );

      ok(res, {
        date: onDate,

        totals: {
          teachers: users.filter(
            user =>
              user.role ===
                'teacher' &&

              user.provisioning !==
                'pending'
          ).length,

          students: users.filter(
            user =>
              user.role ===
                'student' &&

              user.provisioning !==
                'pending'
          ).length,

          classes: classes.filter(
            classroom =>
              classroom.active !==
              false
          ).length,

          notices:
            published.length
        },

        attendance: {
          teacher_checkins:
            new Set(
              work.docs
                .filter(
                  doc =>
                    doc.data().check_in !=
                    null
                )
                .map(
                  doc =>
                    doc.data().teacher_id
                )
            ).size,

          ...status,

          sessions:
            lessons.docs.filter(
              doc =>
                doc.data().cancelled !==
                true
            ).length
        },

        recent_notices:
          published.slice(0, 3)
      });
    })
  );

  async function noticeFields(body) {
    const audience = text(
      body,
      'audience',
      20
    );

    if (
      ![
        'all',
        'teachers',
        'students',
        'selected'
      ].includes(audience)
    ) {
      throw new ApiError(
        400,
        'Choose valid recipients.'
      );
    }

    let recipient_ids = [];

    if (audience === 'selected') {
      if (
        !Array.isArray(
          body.recipient_ids
        ) ||

        !body.recipient_ids.length ||

        body.recipient_ids.length > 200
      ) {
        throw new ApiError(
          400,
          'Select 1–200 recipients.'
        );
      }

      recipient_ids = [
        ...new Set(
          body.recipient_ids.map(id)
        )
      ].sort();

      for (
        const uid
        of recipient_ids
      ) {
        const { data } =
          await existing(
            'users',
            uid
          );

        if (
          data.active !== true ||
          data.provisioning === 'pending'
        ) {
          throw new ApiError(
            400,
            'Select active recipients.'
          );
        }
      }
    }

    return {
      title: text(
        body,
        'title',
        140
      ),

      body: text(
        body,
        'body',
        10000
      ),

      audience,
      recipient_ids
    };
  }

  app.get(
    '/api/notices',

    route(async (req, res) => {
      const notices =
        await loadNotices(db);

      ok(res, {
        notices: notices.filter(
          notice =>
            notice.author_role !==
            'teacher'
        ),

        received: notices.filter(
          notice =>
            addressedToAdmin(
              notice,
              req.adminUid
            )
        )
      });
    })
  );

  app.post(
    '/api/notices',

    route(async (req, res) => {
      const requestId = text(
        req.body,
        'request_id',
        32
      );

      if (
        !/^[a-f0-9]{32}$/.test(
          requestId
        )
      ) {
        throw new ApiError(
          400,
          'Refresh the notice form.'
        );
      }

      const fields = {
        ...await noticeFields(
          req.body
        ),

        author_role: 'admin',

        author_name:
          req.adminProfile.name ||
          'Administrator'
      };

      const ref = db
        .collection('notices')
        .doc(
          key(
            'notices',
            req.adminUid,
            requestId
          )
        );

      const hash = key(fields);

      await db.runTransaction(
        async transaction => {
          const old =
            await transaction.get(ref);

          if (old.exists) {
            if (
              old.data().creation_hash !==
                hash ||

              old.data().active === false
            ) {
              throw new ApiError(
                409,
                'This notice request was already used.'
              );
            }

            return;
          }

          transaction.set(
            ref,

            {
              ...fields,

              active: true,

              created_by:
                req.adminUid,

              created_at:
                timestamp(),

              updated_at:
                timestamp(),

              creation_hash:
                hash
            }
          );
        }
      );

      ok(res, {
        message:
          'Notice published.'
      });
    })
  );

  for (
    const action
    of ['save', 'remove']
  ) {
    app.post(
      '/api/notices/:id/' +
        action,

      route(async (req, res) => {
        const {
          ref,
          data
        } = await existing(
          'notices',
          req.params.id
        );

        const sender =
          data.created_by
            ? await db
                .collection('users')
                .doc(
                  data.created_by
                )
                .get()
            : null;

        if (
          data.author_role ===
            'teacher' ||

          sender?.data()?.role ===
            'teacher'
        ) {
          throw new ApiError(
            403,
            'Received teacher notices are read-only.'
          );
        }

        if (
          data.active === false
        ) {
          throw new ApiError(
            409,
            'This notice was removed.'
          );
        }

        await ref.update({
          ...(
            action === 'save'
              ? await noticeFields(
                  req.body
                )
              : {
                  active: false
                }
          ),

          updated_at:
            timestamp(),

          updated_by:
            req.adminUid
        });

        ok(res, {
          message:
            action === 'save'
              ? 'Notice updated.'
              : 'Notice removed.'
        });
      })
    );
  }

  app.use('/api', (req, res) => {
    res.status(404).json({
      ok: false,

      message:
        'API route not found.'
    });
  });

  app.use((
    error,
    req,
    res,
    next
  ) => {
    const status =
      error.status ||

      (
        error.type ===
          'entity.parse.failed'
          ? 400

          : error.type ===
              'entity.too.large'
            ? 413

            : 503
      );

    if (status >= 500) {
      console.error(
        'Admin API error:',
        error.code || 'internal'
      );
    }

    res.status(status).json({
      ok: false,

      message: error.status
        ? error.message

        : status === 400
          ? 'Send valid JSON.'

          : 'The server could not complete this request. Please retry.'
    });
  });

  return app;
}

module.exports = {
  createAdminApp
};