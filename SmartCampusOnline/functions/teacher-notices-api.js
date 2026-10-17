const express = require('express');
const { ApiError, text, key } = require('./validation');

function noticeTime(value) {
  if (value?.seconds != null) return value.seconds * 1000;
  if (value?._seconds != null) return value._seconds * 1000;
  return Date.parse(value) || 0;
}

async function loadNotices(db) {
  const [notices, users] = await Promise.all([
    db.collection('notices').get(),
    db.collection('users').get()
  ]);

  const people = new Map(
    users.docs.map(doc => [doc.id, doc.data()])
  );

  return notices.docs
    .map(doc => {
      const data = doc.data();
      const author = people.get(data.created_by);

      return {
        ...data,
        id: doc.id,
        author_role: data.author_role || author?.role || 'admin',
        author_name:
          data.author_name || author?.name || 'Campus account'
      };
    })
    .filter(notice => notice.active !== false)
    .sort(
      (a, b) =>
        noticeTime(b.created_at) - noticeTime(a.created_at)
    );
}

function addressedToAdmin(notice, uid) {
  return notice.author_role === 'teacher' && (
    notice.audience === 'admins' ||
    notice.audience === 'all' ||
    (
      notice.audience === 'selected' &&
      notice.recipient_ids?.includes(uid)
    )
  );
}

function createTeacherNoticesApp({ auth, db, timestamp }) {
  const app = express();

  app.use(express.json({ limit: '32kb' }));

  app.use(async (req, res, next) => {
    try {
      const header = req.get('Authorization') || '';

      if (!header.startsWith('Bearer ')) {
        throw new ApiError(401, 'Please sign in as teacher.');
      }

      let decoded;

      try {
        decoded = await auth.verifyIdToken(header.slice(7), true);
      } catch (error) {
        if (String(error.code).startsWith('auth/')) {
          throw new ApiError(
            401,
            'Session expired. Please sign in again.'
          );
        }

        throw error;
      }

      const snapshot = await db
        .collection('users')
        .doc(decoded.uid)
        .get();

      const profile = snapshot.exists ? snapshot.data() : {};

      if (
        profile.role !== 'teacher' ||
        profile.active !== true ||
        profile.provisioning === 'pending'
      ) {
        throw new ApiError(
          403,
          'An active teacher account is required.'
        );
      }

      req.teacherUid = decoded.uid;
      req.teacherProfile = profile;

      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/teacher/notices', async (req, res, next) => {
    try {
      const notices = await loadNotices(db);

      const received = notices.filter(notice =>
        notice.author_role === 'admin' && (
          notice.audience === 'all' ||
          notice.audience === 'teachers' ||
          (
            notice.audience === 'selected' &&
            notice.recipient_ids?.includes(req.teacherUid)
          )
        )
      );

      const sent = notices.filter(notice =>
        notice.created_by === req.teacherUid &&
        notice.author_role === 'teacher'
      );

      res.json({
        ok: true,
        received,
        sent,
        name: req.teacherProfile.name || 'Teacher'
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/teacher/notices', async (req, res, next) => {
    try {
      if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body)
      ) {
        throw new ApiError(400, 'Send a valid JSON object.');
      }

      const title = text(req.body, 'title', 140);
      const body = text(req.body, 'body', 10000);
      const requestId = text(req.body, 'request_id', 32);

      if (!/^[a-f0-9]{32}$/.test(requestId)) {
        throw new ApiError(
          400,
          'Refresh the form before sending this notice.'
        );
      }

      const ref = db.collection('notices').doc(
        key('teacher-notice', req.teacherUid, requestId)
      );

      const hash = key(title, body);

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
              'This request was already used. Check Sent notices before trying again.'
            );
          }

          return;
        }

        tx.set(ref, {
          title,
          body,
          audience: 'admins',
          recipient_ids: [],
          active: true,
          author_role: 'teacher',
          author_name: req.teacherProfile.name || 'Teacher',
          created_by: req.teacherUid,
          created_at: timestamp(),
          updated_at: timestamp(),
          creation_hash: hash
        });
      });

      res.json({
        ok: true,
        id: ref.id,
        message: 'Notice sent to Admin successfully.'
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      message: 'Teacher notice route not found.'
    });
  });

  return app;
}

module.exports = {
  createTeacherNoticesApp,
  loadNotices,
  addressedToAdmin
};