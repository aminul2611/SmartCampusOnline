const { ApiError, id, key } = require('./validation');

const ZONE = 'Asia/Shanghai';
const STATUS = ['Present', 'Late', 'Absent', 'Excused'];

const rows = snapshot =>
  snapshot.docs.map(doc => ({
    ...doc.data(),
    id: doc.id
  }));

function day(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);

  return ['year', 'month', 'day']
    .map(name => parts.find(part => part.type === name).value)
    .join('-');
}

function timestampDate(value) {
  if (value == null) return '';

  const seconds = value?.seconds ?? value?._seconds;
  const parsed = new Date(
    seconds != null ? seconds * 1000 : value
  );

  return Number.isFinite(parsed.getTime())
    ? day(parsed)
    : '';
}

function semester(value) {
  const name = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');

  const match =
    /^(?:semester\s*)?([1-9]\d?)(?:st|nd|rd|th)?(?:\s*semester)?$/i
      .exec(name);

  return match
    ? 'Semester ' + Number(match[1])
    : name;
}

function periods(enrolment) {
  if (
    Array.isArray(enrolment.periods) &&
    enrolment.periods.length
  ) {
    return enrolment.periods;
  }

  const from =
    enrolment.joined_on ||
    timestampDate(enrolment.created_at) ||
    '0001-01-01';

  return [{
    from,
    to: enrolment.active === false
      ? enrolment.left_on ||
        timestampDate(enrolment.updated_at) ||
        from
      : null,
    inferred:
      !enrolment.joined_on ||
      (
        enrolment.active === false &&
        !enrolment.left_on
      )
  }];
}

function enrolledOn(enrolment, date) {
  return periods(enrolment).some(period =>
    period.from <= date &&
    (!period.to || date <= period.to)
  );
}

function counts(history) {
  const counted = history.filter(session => session.counted);

  const result = {
    Present: 0,
    Late: 0,
    Absent: 0,
    Excused: 0,
    'Not marked': 0
  };

  counted.forEach(session => {
    const status = STATUS.includes(session.status)
      ? session.status
      : 'Not marked';

    result[status]++;
  });

  const attended = result.Present + result.Late;

  return {
    total: counted.length,
    attended,
    counts: result,
    pending: history.length - counted.length,
    percentage: counted.length
      ? Math.round(attended * 1000 / counted.length) / 10
      : null
  };
}

async function studentData(
  db,
  uid,
  user,
  now = new Date()
) {
  const today = day(now);

  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(now);

  const enrolments = rows(
    await db.collection('enrolments')
      .where('student_id', '==', uid)
      .get()
  );

  const unique = [
    ...new Map(
      enrolments.map(enrolment => [
        enrolment.class_id,
        enrolment
      ])
    ).values()
  ];

  const groups = await Promise.all(
    unique.map(async enrolment => {
      const classId = id(enrolment.class_id);

      const [
        classDoc,
        markDoc,
        lessonDocs,
        attendanceDocs
      ] = await Promise.all([
        db.collection('classes').doc(classId).get(),

        db.collection('teacher_marks')
          .doc(key(classId, uid))
          .get(),

        db.collection('teacher_lessons')
          .where('class_id', '==', classId)
          .get(),

        db.collection('student_attendance')
          .where('class_id', '==', classId)
          .get()
      ]);

      const classroom = classDoc.exists
        ? classDoc.data()
        : {};

      const teacher = classroom.teacher_id
        ? await db.collection('users')
            .doc(id(classroom.teacher_id))
            .get()
        : null;

      const course = {
        id: classId,

        code:
          classroom.code ||
          enrolment.class_code ||
          'Archived',

        name:
          classroom.name ||
          enrolment.class_name ||
          'Previous class',

        semester:
          semester(enrolment.semester || classroom.semester) ||
          'Semester not assigned',

        academic_session:
          enrolment.academic_session ||
          classroom.academic_session ||
          '',

        section:
          enrolment.section ||
          classroom.section ||
          '',

        teacher_name:
          teacher?.exists &&
          teacher.data().role === 'teacher'
            ? teacher.data().name
            : 'Teacher not available',

        active:
          classDoc.exists &&
          classroom.active !== false,

        enrolment_active:
          enrolment.active !== false,

        joined_on:
          enrolment.joined_on ||
          periods(enrolment)[0].from,

        weekly_slots:
          classroom.weekly_slots || []
      };

      const marks =
        markDoc.exists &&
        markDoc.data().student_id === uid
          ? markDoc.data()
          : {};

      for (
        const [name, maximum]
        of Object.entries({
          assessment: 20,
          mid: 30,
          final: 50
        })
      ) {
        course[name] = marks[name] ?? null;
        course[name + '_max'] =
          classroom[name + '_max'] ?? maximum;
      }

      const held = new Set();
      const own = new Map();

      rows(attendanceDocs)
        .filter(record => STATUS.includes(record.status))
        .forEach(record => {
          held.add(record.lesson_id);

          if (record.student_id === uid) {
            own.set(record.lesson_id, record.status);
          }
        });

      const sessions = rows(lessonDocs)
        .filter(session =>
          session.cancelled !== true &&
          (
            enrolledOn(enrolment, session.lesson_date) ||
            own.has(session.id)
          )
        )
        .map(session => {
          const ended =
            session.lesson_date < today ||
            (
              session.lesson_date === today &&
              session.end_time <= clock
            );

          return {
            id: session.id,
            class_id: classId,
            code: course.code,
            name: course.name,
            semester: course.semester,
            lesson_date: session.lesson_date,
            start_time: session.start_time,
            end_time: session.end_time,
            room: session.room || '',
            topic: session.topic || '',
            status: own.get(session.id) || 'Not marked',
            ended,
            counted: ended && held.has(session.id),
            enrolled: enrolledOn(
              enrolment,
              session.lesson_date
            )
          };
        });

      return { course, sessions };
    })
  );

  const classes = groups
    .map(group => group.course)
    .sort((a, b) =>
      a.semester.localeCompare(
        b.semester,
        undefined,
        { numeric: true }
      ) ||
      a.code.localeCompare(b.code)
    );

  const sessions = groups.flatMap(group => group.sessions);

  const history = sessions
    .filter(session => session.ended)
    .sort((a, b) =>
      b.lesson_date.localeCompare(a.lesson_date) ||
      b.start_time.localeCompare(a.start_time)
    );

  const profile = {
    id: uid,
    role: 'student'
  };

  for (const field of [
    'name',
    'email',
    'student_no',
    'phone',
    'department',
    'program',
    'semester'
  ]) {
    profile[field] = user[field] || '';
  }

  profile.semester = semester(profile.semester);

  return {
    ok: true,
    profile,
    current_semester: profile.semester,
    today,
    classes,
    attendance: history,
    summary: counts(history),

    daily: sessions
      .filter(session =>
        session.lesson_date === today &&
        session.enrolled &&
        classes.some(course =>
          course.id === session.class_id &&
          course.active &&
          course.enrolment_active
        )
      )
      .sort((a, b) =>
        a.start_time.localeCompare(b.start_time)
      )
  };
}

function overlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function dateWindow(classroom) {
  return {
    from: classroom.start_date || '0001-01-01',
    to: classroom.end_date || '9999-12-31'
  };
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function occurrence(dayNumber, from, to) {
  if (from > to) return '';

  const date = new Date(from + 'T00:00:00Z');

  date.setUTCDate(
    date.getUTCDate() +
    (dayNumber - date.getUTCDay() + 7) % 7
  );

  const result = date.toISOString().slice(0, 10);
  return result <= to ? result : '';
}

function conflicts(
  classes,
  enrolments,
  lessons,
  since = day()
) {
  const active = classes.filter(
    classroom => classroom.active !== false
  );

  const people = new Map();

  enrolments.forEach(enrolment => {
    if (!people.has(enrolment.class_id)) {
      people.set(enrolment.class_id, new Map());
    }

    people.get(enrolment.class_id).set(
      enrolment.student_id,
      enrolment
    );
  });

  const events = active.flatMap(classroom => {
    const window = dateWindow(classroom);

    const routine = (classroom.weekly_slots || [])
      .map((slot, index) => ({
        cid: classroom.id,
        c: classroom,
        type: 'routine',
        event: 'routine-' + index,
        start: slot.start,
        end: slot.end,
        day: slot.day,
        from: window.from,
        to: window.to
      }));

    const actual = lessons
      .filter(session =>
        session.class_id === classroom.id &&
        session.cancelled !== true &&
        session.lesson_date >= since
      )
      .map(session => ({
        cid: classroom.id,
        c: classroom,
        type: 'session',
        event: session.id,
        start: session.start_time,
        end: session.end_time,
        day: weekday(session.lesson_date),
        from: session.lesson_date,
        to: session.lesson_date
      }));

    return [...routine, ...actual];
  });

  const result = [];
  const seen = new Set();

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];

      if (
        a.day !== b.day ||
        !overlap(a, b) ||
        (
          a.cid === b.cid &&
          (
            a.type === 'routine' ||
            b.type === 'routine'
          )
        )
      ) {
        continue;
      }

      const from = [a.from, b.from, since]
        .sort()
        .at(-1);

      const to = [a.to, b.to].sort()[0];

      const date = occurrence(a.day, from, to);
      if (!date) continue;

      const push = (kind, personId, onDate) => {
        const descriptions = [
          [
            a.cid,
            a.event,
            a.start,
            a.end,
            a.from,
            a.to
          ].join('|'),

          [
            b.cid,
            b.event,
            b.start,
            b.end,
            b.from,
            b.to
          ].join('|')
        ].sort();

        const signature = key(
          kind,
          personId,
          ...descriptions
        );

        if (seen.has(signature)) return;
        seen.add(signature);

        result.push({
          signature,
          kind,
          person_id: personId,
          date: onDate,
          class_a: a.cid,
          class_b: b.cid,
          name_a: a.c.code + ' — ' + a.c.name,
          name_b: b.c.code + ' — ' + b.c.name,
          time_a: a.start + '–' + a.end,
          time_b: b.start + '–' + b.end
        });
      };

      if (
        a.c.teacher_id &&
        a.c.teacher_id === b.c.teacher_id
      ) {
        push('Teacher', a.c.teacher_id, date);
      }

      const aStudents = people.get(a.cid) || new Map();
      const bStudents = people.get(b.cid) || new Map();

      for (const [studentId, aEnrolment] of aStudents) {
        const bEnrolment = bStudents.get(studentId);
        if (!bEnrolment) continue;

        let onDate = '';

        for (const aPeriod of periods(aEnrolment)) {
          for (const bPeriod of periods(bEnrolment)) {
            onDate = onDate || occurrence(
              a.day,

              [
                from,
                aPeriod.from,
                bPeriod.from
              ].sort().at(-1),

              [
                to,
                aPeriod.to || '9999-12-31',
                bPeriod.to || '9999-12-31'
              ].sort()[0]
            );
          }
        }

        if (onDate) {
          push('Student', studentId, onDate);
        }
      }
    }
  }

  return result;
}

async function scheduleState(transaction, db) {
  const lock = db
    .collection('_schedule_locks')
    .doc('campus');

  await transaction.get(lock);

  const [classDocs, enrolmentDocs, lessonDocs] =
    await Promise.all(
      ['classes', 'enrolments', 'teacher_lessons']
        .map(name =>
          transaction.get(db.collection(name))
        )
    );

  return {
    lock,
    classes: rows(classDocs),
    enrolments: rows(enrolmentDocs),
    lessons: rows(lessonDocs)
  };
}

function rejectNew(
  before,
  after,
  since = day()
) {
  const old = new Set(
    conflicts(
      before.classes,
      before.enrolments,
      before.lessons,
      since
    ).map(conflict => conflict.signature)
  );

  const issue = conflicts(
    after.classes,
    after.enrolments,
    after.lessons,
    since
  ).find(conflict => !old.has(conflict.signature));

  if (issue) {
    throw new ApiError(
      409,
      `${issue.kind} schedule conflict on ${issue.date}: ` +
      `${issue.name_a} (${issue.time_a}) overlaps ` +
      `${issue.name_b} (${issue.time_b}).`
    );
  }
}

async function createLesson({
  db,
  teacherUid,
  fields,
  requestId,
  timestamp
}) {
  const ref = db.collection('teacher_lessons').doc(
    key('lesson', teacherUid, requestId)
  );

  const hash = key(fields);

  await db.runTransaction(async transaction => {
    const user = await transaction.get(
      db.collection('users').doc(teacherUid)
    );

    if (
      !user.exists ||
      user.data().role !== 'teacher' ||
      user.data().active !== true ||
      user.data().provisioning === 'pending'
    ) {
      throw new ApiError(
        403,
        'An active teacher account is required.'
      );
    }

    const before = await scheduleState(transaction, db);
    const old = await transaction.get(ref);

    const classroom = before.classes.find(course =>
      course.id === fields.class_id &&
      course.teacher_id === teacherUid &&
      course.active !== false
    );

    if (!classroom) {
      throw new ApiError(
        403,
        'Select your own active class.'
      );
    }

    if (old.exists) {
      if (old.data().creation_hash !== hash) {
        throw new ApiError(
          409,
          'This session request was already used.'
        );
      }

      return;
    }

    const window = dateWindow(classroom);

    if (
      fields.lesson_date < window.from ||
      fields.lesson_date > window.to
    ) {
      throw new ApiError(
        400,
        'Session date is outside the class date range.'
      );
    }

    const record = {
      ...fields,
      id: ref.id,
      teacher_id: teacherUid,
      creation_hash: hash
    };

    rejectNew(
      before,
      {
        ...before,
        lessons: [...before.lessons, record]
      },
      fields.lesson_date
    );

    const { id: ignored, ...data } = record;

    transaction.set(ref, {
      ...data,
      created_at: timestamp()
    });

    transaction.set(before.lock, {
      updated_at: timestamp()
    });
  });

  return ref.id;
}

module.exports = {
  ZONE,
  STATUS,
  rows,
  day,
  semester,
  periods,
  enrolledOn,
  counts,
  studentData,
  conflicts,
  scheduleState,
  rejectNew,
  createLesson,
  dateWindow
};