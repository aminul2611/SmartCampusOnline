const {
  ApiError,
  text,
  id,
  key
} = require('./validation');

function subjectCode(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function semesterLabel(value) {
  const name = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');

  const calendar =
    /^(summer|summar|spring)\s*[-/]?\s*(\d{4})$/i.exec(name);

  if (
    calendar &&
    Number(calendar[2]) >= 1900 &&
    Number(calendar[2]) <= 9999
  ) {
    const season =
      calendar[1].toLowerCase() === 'spring'
        ? 'Spring'
        : 'Summer';

    return season + ' ' + Number(calendar[2]);
  }

  const ordinal =
    /^(?:semester\s*)?([1-9]\d?)(?:st|nd|rd|th)?(?:\s*semester)?$/i.exec(
      name
    );

  return ordinal
    ? 'Semester ' + Number(ordinal[1])
    : name;
}

const semesterKey = value =>
  semesterLabel(value).toLowerCase();

const subjectId = code =>
  key('subject', subjectCode(code));

const semesterId = term =>
  key('semester', semesterKey(term));

const rows = snapshot =>
  snapshot.docs.map(doc => ({
    ...doc.data(),
    id: doc.id
  }));

const statuses = [
  'upcoming',
  'ongoing',
  'completed'
];

function subjectCatalogue(subjects, classes) {
  const result = new Map();

  for (const course of classes) {
    const code = subjectCode(course.code);

    if (!code || !course.name) {
      continue;
    }

    const uid = subjectId(code);

    if (!result.has(uid)) {
      result.set(uid, {
        id: uid,
        code,
        name: course.name,
        saved: false,
        names: []
      });
    }

    const item = result.get(uid);

    if (!item.names.includes(course.name)) {
      item.names.push(course.name);
    }
  }

  for (const subject of subjects) {
    const uid = subjectId(subject.code);

    result.set(uid, {
      id: uid,
      code: subjectCode(subject.code),
      name: subject.name,
      saved: true,
      names: result.get(uid)?.names || []
    });
  }

  return [...result.values()].sort((a, b) =>
    a.code.localeCompare(b.code)
  );
}

function registerAcademicRoutes({
  app,
  db,
  timestamp,
  route,
  ok
}) {
  app.get(
    '/api/academic-setup',
    route(async (req, res) => {
      const [
        subjects,
        classes,
        semesters
      ] = await Promise.all([
        db.collection('subjects').get(),
        db.collection('classes').get(),
        db.collection('academic_semesters').get()
      ]);

      ok(res, {
        subjects: subjectCatalogue(
          rows(subjects),
          rows(classes)
        ),

        semesters: rows(semesters).map(item => ({
          id: item.id,

          semester: semesterLabel(
            item.semester
          ),

          status: statuses.includes(item.status)
            ? item.status
            : '',

          revision: Number.isSafeInteger(
            item.revision
          )
            ? item.revision
            : 0
        }))
      });
    })
  );

  async function saveSubject(
    req,
    res,
    editing
  ) {
    const code = subjectCode(
      text(req.body, 'code', 80)
    );

    const name = text(
      req.body,
      'name',
      150
    );

    if (code.length > 80) {
      throw new ApiError(
        400,
        'Subject code is too long.'
      );
    }

    const uid = subjectId(code);

    if (
      editing &&
      id(req.params.id) !== uid
    ) {
      throw new ApiError(
        400,
        'Subject code is fixed. Add a new subject for another code.'
      );
    }

    const ref = db
      .collection('subjects')
      .doc(uid);

    await db.runTransaction(async tx => {
      const old = await tx.get(ref);

      if (old.exists && !editing) {
        throw new ApiError(
          409,
          'This subject code already exists. Select or edit the saved subject.'
        );
      }

      if (!old.exists && editing) {
        const classes = await tx.get(
          db.collection('classes')
        );

        const exists = rows(classes).some(
          course =>
            subjectCode(course.code) === code
        );

        if (!exists) {
          throw new ApiError(
            404,
            'Subject not found. Refresh the subject list.'
          );
        }
      }

      tx.set(
        ref,
        {
          code,
          name,

          updated_at: timestamp(),
          updated_by: req.adminUid,

          ...(
            !old.exists
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
    });

    ok(res, {
      id: uid,

      message:
        'Subject saved. Existing class names and records are unchanged.'
    });
  }

  app.post(
    '/api/subjects',
    route((req, res) =>
      saveSubject(req, res, false)
    )
  );

  app.post(
    '/api/subjects/:id/save',
    route((req, res) =>
      saveSubject(req, res, true)
    )
  );

  app.post(
    '/api/academic-semesters/status',

    route(async (req, res) => {
      const semester = semesterLabel(
        text(req.body, 'semester', 80)
      );

      const status = req.body.status;
      const revision = req.body.revision;

      if (!statuses.includes(status)) {
        throw new ApiError(
          400,
          'Choose Upcoming, Ongoing or Completed.'
        );
      }

      if (
        !Number.isSafeInteger(revision) ||
        revision < 0
      ) {
        throw new ApiError(
          400,
          'Refresh semester status before saving.'
        );
      }

      const uid = semesterId(semester);

      const ref = db
        .collection('academic_semesters')
        .doc(uid);

      await db.runTransaction(async tx => {
        const [
          old,
          classes
        ] = await Promise.all([
          tx.get(ref),
          tx.get(db.collection('classes'))
        ]);

        const hasClasses = rows(classes).some(
          course =>
            semesterKey(course.semester) ===
            semesterKey(semester)
        );

        if (!hasClasses) {
          throw new ApiError(
            404,
            'No saved classes belong to this semester.'
          );
        }

        const savedRevision = old.exists
          ? old.data().revision || 0
          : 0;

        if (savedRevision !== revision) {
          throw new ApiError(
            409,
            'Semester status changed in another session. Refresh history and try again.'
          );
        }

        tx.set(
          ref,
          {
            semester,
            status,

            revision: revision + 1,

            updated_at: timestamp(),
            updated_by: req.adminUid
          },
          {
            merge: true
          }
        );
      });

      ok(res, {
        id: uid,
        semester,
        status,

        revision: revision + 1,

        message:
          'Semester status saved. Attendance and results were preserved.'
      });
    })
  );
}

module.exports = {
  registerAcademicRoutes,
  subjectCode,
  subjectId,
  semesterLabel,
  semesterKey,
  semesterId,
  subjectCatalogue
};