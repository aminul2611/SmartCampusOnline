const express = require('express');

const { createAccountApp } = require('./account-api');

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

function createAdminApp({ auth, db, timestamp }) {
  const app = express();

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  // Teacher Profile: verify Teacher login inside this module.
  app.use(
    '/api/teacher/profile',
    createTeacherProfileApp({
      auth,
      db,
      timestamp
    })
  );

  const teacherNoticesApp = createTeacherNoticesApp({
    auth,
    db,
    timestamp
  });

  const teacherApp = createAccountApp({
    auth,
    db,
    timestamp,
    role: 'teacher'
  });

  const studentApp = createAccountApp({
    auth,
    db,
    timestamp,
    role: 'student'
  });

  app.use((req, res, next) => {
    if (/^\/api\/teacher\/notices(?:\/|$)/.test(req.path)) {
      return teacherNoticesApp(req, res, next);
    }

    if (/^\/api\/teachers(?:\/|$)/.test(req.path)) {
      return teacherApp(req, res, next);
    }

    if (/^\/api\/students(?:\/|$)/.test(req.path)) {
      return studentApp(req, res, next);
    }

    next();
  });

  const route = handler => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  app.use('/api', async (req, res, next) => {
    try {
      const header = req.get('Authorization') || '';

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
        if (String(error.code).startsWith('auth/')) {
          throw new ApiError(
            401,
            'Session expired. Please sign in again.'
          );
        }

        throw error;
      }

      const profile = await db
        .collection('users')
        .doc(decoded.uid)
        .get();

      if (
        !profile.exists ||
        profile.data().role !== 'admin' ||
        profile.data().active !== true
      ) {
        throw new ApiError(
          403,
          'An active administrator account is required.'
        );
      }

      if (
        req.method === 'POST' && (
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
      req.adminProfile = profile.data();

      next();
    } catch (error) {
      next(error);
    }
  });

  const ok = (res, data = {}) => {
    res.json({ ok: true, ...data });
  };

  async function createOnce(req, collection, fields) {
    const requestId = text(req.body, 'request_id', 32);

    if (!/^[a-f0-9]{32}$/.test(requestId)) {
      throw new ApiError(
        400,
        'Refresh the form before creating this record.'
      );
    }

    const ref = db.collection(collection).doc(
      key(collection, req.adminUid, requestId)
    );

    const hash = key(fields);

    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);

      if (snapshot.exists) {
        const saved = snapshot.data();

        if (
          saved.creation_hash !== hash ||
          saved.active === false
        ) {
          throw new ApiError(
            409,
            'This request was already used. Refresh the saved list before creating another record.'
          );
        }

        return;
      }

      tx.set(ref, {
        ...fields,
        active: true,
        created_by: req.adminUid,
        created_at: timestamp(),
        updated_at: timestamp(),
        creation_hash: hash
      });
    });

    return ref.id;
  }

  async function list(
    collection,
    transform = value => value
  ) {
    const result = await db.collection(collection).get();

    return result.docs.map(doc =>
      transform({ ...doc.data(), id: doc.id })
    );
  }

  async function existing(collection, uid) {
    const ref = db.collection(collection).doc(id(uid));
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new ApiError(404, 'Record not found.');
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
    ).catch(error => {
      if (error.status === 404) {
        throw new ApiError(
          400,
          `Select an existing ${role}.`
        );
      }

      throw error;
    });

    if (
      data.role !== role ||
      data.active !== true ||
      data.provisioning === 'pending'
    ) {
      throw new ApiError(
        400,
        `Select an active ${role}.`
      );
    }

    return data;
  }

  function publicUser(user) {
    const result = { id: user.id };

    for (const field of [
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
    ]) {
      if (user[field] !== undefined) {
        result[field] = user[field];
      }
    }

    return result;
  }

  app.get('/api/health', route(async (req, res) => {
    ok(res, {
      project: 'smart-campus-9aafa',
      backend: 'Firebase Admin API'
    });
  }));

  app.get('/api/directory', route(async (req, res) => {
    ok(res, {
      users: await list('users', publicUser)
    });
  }));

  app.get('/api/overview', route(async (req, res) => {
    const day = date(
      req.query.date ||
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date())
    );

    const [
      users,
      classes,
      notices,
      teacherRecords,
      studentRecords
    ] = await Promise.all([
      list('users', publicUser),
      list('classes'),
      loadNotices(db),

      db.collection('teacher_work_attendance')
        .where('work_date', '==', day)
        .get(),

      db.collection('student_attendance')
        .where('session_date', '==', day)
        .get()
    ]);

    const published = notices.filter(
      notice => notice.author_role !== 'teacher'
    );

    ok(res, {
      date: day,

      totals: {
        teachers: users.filter(user =>
          user.role === 'teacher' &&
          user.provisioning !== 'pending'
        ).length,

        students: users.filter(user =>
          user.role === 'student' &&
          user.provisioning !== 'pending'
        ).length,

        classes: classes.filter(
          item => item.active !== false
        ).length,

        notices: published.length
      },

      attendance: {
        teacher_checkins: new Set(
          teacherRecords.docs
            .filter(doc => doc.data().check_in != null)
            .map(doc => doc.data().teacher_id)
        ).size,

        student_present: studentRecords.docs.filter(
          doc => doc.data().status === 'Present'
        ).length,

        student_absent: studentRecords.docs.filter(
          doc => doc.data().status === 'Absent'
        ).length
      },

      recent_notices: published
        .sort(
          (a, b) =>
            timeOf(b.created_at) - timeOf(a.created_at)
        )
        .slice(0, 5)
    });
  }));

  async function classFields(data) {
    const fields = {
      code: text(data, 'code', 80),
      name: text(data, 'name', 150),
      semester: text(data, 'semester', 80),
      teacher_id: id(data.teacher_id),
      weekly_slots: slots(data.weekly_slots)
    };

    await activeUser(fields.teacher_id, 'teacher');

    return fields;
  }

  app.get('/api/classes', route(async (req, res) => {
    ok(res, {
      classes: await list('classes'),
      enrolments: await list('enrolments')
    });
  }));

  async function saveClass(req, res, creating) {
    const fields = await classFields(req.body);

    const ref = creating
      ? db.collection('classes').doc(
          key(fields.code.toLowerCase())
        )
      : db.collection('classes').doc(
          id(req.params.id)
        );

    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);

      if (creating && snapshot.exists) {
        throw new ApiError(
          409,
          'This class code already exists. Edit or restore that class.'
        );
      }

      if (!creating && !snapshot.exists) {
        throw new ApiError(404, 'Class not found.');
      }

      if (
        !creating &&
        fields.code !== snapshot.data().code
      ) {
        throw new ApiError(
          400,
          'Class code cannot change. Create a new class for a different code.'
        );
      }

      tx.set(ref, {
        ...fields,
        updated_at: timestamp(),

        ...(creating ? {
          active: true,
          created_by: req.adminUid,
          created_at: timestamp()
        } : {})
      }, { merge: true });
    });

    ok(res, {
      id: ref.id,
      message: creating
        ? 'Class created.'
        : 'Class updated.'
    });
  }

  app.post('/api/classes', route(
    (req, res) => saveClass(req, res, true)
  ));

  app.post('/api/classes/:id/save', route(
    (req, res) => saveClass(req, res, false)
  ));

  app.post(
    '/api/classes/:id/status',
    route(async (req, res) => {
      const { ref } = await existing(
        'classes',
        req.params.id
      );

      const active = boolean(req.body.active);

      await ref.update({
        active,
        updated_at: timestamp()
      });

      ok(res, {
        message: active
          ? 'Class restored.'
          : 'Class archived. Existing records are preserved.'
      });
    })
  );

  app.post(
    '/api/classes/:id/enrolments',
    route(async (req, res) => {
      const student_id = id(req.body.student_id);
      const class_id = id(req.params.id);

      await activeUser(student_id, 'student');

      const classRef = db
        .collection('classes')
        .doc(class_id);

      const ref = db.collection('enrolments').doc(
        key(class_id, student_id)
      );

      await db.runTransaction(async tx => {
        const [classSnap, enrolSnap] = await Promise.all([
          tx.get(classRef),
          tx.get(ref)
        ]);

        if (!classSnap.exists) {
          throw new ApiError(404, 'Class not found.');
        }

        if (classSnap.data().active === false) {
          throw new ApiError(
            409,
            'Restore the class before adding students.'
          );
        }

        tx.set(ref, {
          class_id,
          student_id,
          active: true,
          updated_at: timestamp(),

          ...(!enrolSnap.exists ? {
            created_at: timestamp(),
            created_by: req.adminUid
          } : {})
        }, { merge: true });
      });

      ok(res, {
        message: 'Student enrolled.'
      });
    })
  );

  app.post(
    '/api/classes/:id/enrolments/:uid/remove',
    route(async (req, res) => {
      const { ref } = await existing(
        'enrolments',
        key(
          id(req.params.id),
          id(req.params.uid)
        )
      );

      await ref.update({
        active: false,
        updated_at: timestamp()
      });

      ok(res, {
        message: 'Enrolment removed. Previous records are preserved.'
      });
    })
  );

  async function noticeFields(body) {
    const audience = text(body, 'audience', 20);

    if (![
      'all',
      'teachers',
      'students',
      'selected'
    ].includes(audience)) {
      throw new ApiError(
        400,
        'Choose a valid audience.'
      );
    }

    let recipient_ids = [];

    if (audience === 'selected') {
      if (
        !Array.isArray(body.recipient_ids) ||
        !body.recipient_ids.length ||
        body.recipient_ids.length > 200
      ) {
        throw new ApiError(
          400,
          'Choose 1–200 recipients.'
        );
      }

      recipient_ids = [
        ...new Set(body.recipient_ids.map(id))
      ];

      for (const uid of recipient_ids) {
        const { data } = await existing(
          'users',
          uid
        ).catch(error => {
          if (error.status === 404) {
            throw new ApiError(
              400,
              'A selected recipient no longer exists.'
            );
          }

          throw error;
        });

        if (
          data.active !== true ||
          data.provisioning === 'pending'
        ) {
          throw new ApiError(
            400,
            'Choose active recipients.'
          );
        }
      }
    }

    return {
      title: text(body, 'title', 140),
      body: text(body, 'body', 10000),
      audience,
      recipient_ids
    };
  }

  app.get('/api/notices', route(async (req, res) => {
    const notices = await loadNotices(db);

    ok(res, {
      notices: notices.filter(
        notice => notice.author_role !== 'teacher'
      ),

      received: notices.filter(
        notice => addressedToAdmin(
          notice,
          req.adminUid
        )
      )
    });
  }));

  app.post('/api/notices', route(async (req, res) => {
    const fields = {
      ...await noticeFields(req.body),
      author_role: 'admin',
      author_name:
        req.adminProfile.name || 'Administrator'
    };

    const recordId = await createOnce(
      req,
      'notices',
      fields
    );

    ok(res, {
      id: recordId,
      message: 'Notice published.'
    });
  }));

  app.post(
    '/api/notices/:id/save',
    route(async (req, res) => {
      const { ref, data } = await existing(
        'notices',
        req.params.id
      );

      const sender = await db.collection('users')
        .doc(data.created_by)
        .get();

      if (
        data.author_role === 'teacher' ||
        sender.data()?.role === 'teacher'
      ) {
        throw new ApiError(
          403,
          'Received teacher notices are read-only.'
        );
      }

      if (data.active === false) {
        throw new ApiError(
          409,
          'This notice was removed. Create a new notice.'
        );
      }

      await ref.update({
        ...await noticeFields(req.body),
        updated_at: timestamp(),
        updated_by: req.adminUid
      });

      ok(res, {
        message: 'Notice updated.'
      });
    })
  );

  app.post(
    '/api/notices/:id/remove',
    route(async (req, res) => {
      const { ref, data } = await existing(
        'notices',
        req.params.id
      );

      const sender = await db.collection('users')
        .doc(data.created_by)
        .get();

      if (
        data.author_role === 'teacher' ||
        sender.data()?.role === 'teacher'
      ) {
        throw new ApiError(
          403,
          'Received teacher notices are read-only.'
        );
      }

      await ref.update({
        active: false,
        updated_at: timestamp(),
        updated_by: req.adminUid
      });

      ok(res, {
        message: 'Notice removed.'
      });
    })
  );

  app.get('/api/profile', route(async (req, res) => {
    ok(res, {
      profile: publicUser({
        ...req.adminProfile,
        id: req.adminUid
      })
    });
  }));

  app.post('/api/profile', route(async (req, res) => {
    const fields = {
      name: text(req.body, 'name', 100),
      phone: text(req.body, 'phone', 150, false),
      department: text(
        req.body,
        'department',
        150,
        false
      )
    };

    const old = await auth.getUser(req.adminUid);

    await auth.updateUser(req.adminUid, {
      displayName: fields.name
    });

    try {
      await db.collection('users')
        .doc(req.adminUid)
        .update({
          ...fields,
          updated_at: timestamp()
        });
    } catch (error) {
      await auth.updateUser(req.adminUid, {
        displayName: old.displayName || ''
      });

      throw new ApiError(
        503,
        'Profile could not save. Retry with the same values.'
      );
    }

    ok(res, {
      message: 'Profile updated.'
    });
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({
      ok: false,
      message: 'API route not found.'
    });
  });

  app.use((error, req, res, next) => {
    const status = error.status || (
      error.type === 'entity.parse.failed' ? 400 :
      error.type === 'entity.too.large' ? 413 : 503
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
          : status === 413
            ? 'Request is too large.'
            : 'Firebase could not complete the request. Retry with the same values.'
    });
  });

  return app;
}

function timeOf(value) {
  const seconds = value?.seconds ?? value?._seconds;

  return seconds != null
    ? seconds * 1000
    : Date.parse(value) || 0;
}

module.exports = { createAdminApp };