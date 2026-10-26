const express = require("express");
const { ApiError, text, id, key } = require("./validation");
const { loadNotices } = require("./teacher-notices-api");

const ZONE = "Asia/Shanghai";
const STATUSES = ["Present", "Late", "Absent", "Excused"];

const rows = snapshot =>
  snapshot.docs.map(doc => ({
    ...doc.data(),
    id: doc.id
  }));

function day(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);

  return ["year", "month", "day"]
    .map(k => parts.find(p => p.type === k).value)
    .join("-");
}

function joined(record) {
  if (record.joined_on) return record.joined_on;

  const value = record.created_at;
  const seconds = value?.seconds ?? value?._seconds;

  const parsed = new Date(
    seconds != null ? seconds * 1000 : value
  );

  return Number.isFinite(parsed.getTime())
    ? day(parsed)
    : "0000-01-01";
}

function profile(uid, user) {
  const result = {
    id: uid,
    role: "student"
  };

  for (const field of [
    "name",
    "email",
    "student_no",
    "phone",
    "department",
    "program",
    "semester"
  ]) {
    result[field] = user[field] || "";
  }

  return result;
}

function checkStudent(snapshot) {
  const user = snapshot.exists ? snapshot.data() : {};

  if (
    user.role !== "student" ||
    user.active !== true ||
    user.provisioning === "pending"
  ) {
    throw new ApiError(
      403,
      "An active student account is required."
    );
  }

  return user;
}

function summary(history) {
  const counted = history.filter(item => item.counted);

  const counts = {
    Present: 0,
    Late: 0,
    Absent: 0,
    Excused: 0,
    "Not marked": 0
  };

  for (const item of counted) {
    counts[item.status]++;
  }

  const attended = counts.Present + counts.Late;

  return {
    total: counted.length,
    attended,
    counts,

    pending: history.filter(item => !item.counted).length,

    percentage: counted.length
      ? Math.round(attended * 1000 / counted.length) / 10
      : null
  };
}

function createStudentApp({ auth, db, timestamp }) {
  const app = express();

  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  app.use(express.json({
    limit: "32kb"
  }));

  const route = handler => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  app.use(async (req, res, next) => {
    try {
      const header = req.get("Authorization") || "";

      if (!header.startsWith("Bearer ")) {
        throw new ApiError(
          401,
          "Please sign in as student."
        );
      }

      let decoded;

      try {
        decoded = await auth.verifyIdToken(
          header.slice(7),
          true
        );
      } catch (error) {
        if (String(error.code).startsWith("auth/")) {
          throw new ApiError(
            401,
            "Session expired. Please sign in again."
          );
        }

        throw error;
      }

      req.student = checkStudent(
        await db.collection("users").doc(decoded.uid).get()
      );

      req.studentUid = decoded.uid;

      if (
        req.method === "POST" &&
        (
          !req.body ||
          typeof req.body !== "object" ||
          Array.isArray(req.body)
        )
      ) {
        throw new ApiError(
          400,
          "Send a valid JSON object."
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  });

  app.get("/profile", (req, res) => {
    res.json({
      ok: true,
      profile: profile(req.studentUid, req.student)
    });
  });

  app.get("/data", route(async (req, res) => {
    const uid = req.studentUid;
    const now = new Date();
    const today = day(now);

    const clock = new Intl.DateTimeFormat("en-GB", {
      timeZone: ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(now);

    const enrolments = rows(
      await db
        .collection("enrolments")
        .where("student_id", "==", uid)
        .get()
    );

    const unique = [
      ...new Map(
        enrolments.map(e => [e.class_id, e])
      ).values()
    ];

    const groups = await Promise.all(
      unique.map(async enrolment => {
        const classId = id(enrolment.class_id);

        const [
          classSnap,
          markSnap,
          lessonSnap,
          attendanceSnap
        ] = await Promise.all([
          db.collection("classes").doc(classId).get(),

          db.collection("teacher_marks")
            .doc(key(classId, uid))
            .get(),

          db.collection("teacher_lessons")
            .where("class_id", "==", classId)
            .get(),

          db.collection("student_attendance")
            .where("class_id", "==", classId)
            .get()
        ]);

        const source = classSnap.exists
          ? classSnap.data()
          : {};

        const teacher = source.teacher_id
          ? await db.collection("users")
            .doc(id(source.teacher_id))
            .get()
          : null;

        const classroom = {
          id: classId,

          code:
            source.code ||
            enrolment.class_code ||
            "Archived",

          name:
            source.name ||
            enrolment.class_name ||
            "Previous class",

          semester:
            enrolment.semester ||
            source.semester ||
            "Semester not assigned",

          teacher_name:
            teacher?.exists &&
            teacher.data().role === "teacher"
              ? teacher.data().name || "Teacher"
              : "Teacher not available",

          active:
            classSnap.exists &&
            source.active !== false,

          enrolment_active:
            enrolment.active !== false,

          joined_on: joined(enrolment),

          weekly_slots: Array.isArray(source.weekly_slots)
            ? source.weekly_slots
            : []
        };

        const marks =
          markSnap.exists &&
          markSnap.data().student_id === uid
            ? markSnap.data()
            : {};

        for (const [field, maximum] of Object.entries({
          assessment: 20,
          mid: 30,
          final: 50
        })) {
          classroom[field] = marks[field] ?? null;

          classroom[field + "_max"] =
            source[field + "_max"] ?? maximum;
        }

        const recorded = new Set();
        const own = new Map();

        for (const record of rows(attendanceSnap)) {
          if (!STATUSES.includes(record.status)) {
            continue;
          }

          recorded.add(record.lesson_id);

          if (record.student_id === uid) {
            own.set(record.lesson_id, record.status);
          }
        }

        const sessions = rows(lessonSnap)
          .filter(lesson => {
            if (lesson.cancelled === true) return false;

            if (own.has(lesson.id)) return true;

            if (lesson.lesson_date < classroom.joined_on) {
              return false;
            }

            if (enrolment.active !== false) return true;

            return Boolean(
              enrolment.left_on &&
              lesson.lesson_date <= enrolment.left_on
            );
          })
          .map(lesson => {
            const ended =
              lesson.lesson_date < today ||
              (
                lesson.lesson_date === today &&
                lesson.end_time <= clock
              );

            return {
              id: lesson.id,
              class_id: classId,
              code: classroom.code,
              name: classroom.name,
              semester: classroom.semester,
              lesson_date: lesson.lesson_date,
              start_time: lesson.start_time,
              end_time: lesson.end_time,
              room: lesson.room || "",
              topic: lesson.topic || "",
              status: own.get(lesson.id) || "Not marked",
              ended,
              counted: ended && recorded.has(lesson.id)
            };
          });

        return {
          classroom,
          sessions
        };
      })
    );

    const classes = groups
      .map(g => g.classroom)
      .sort((a, b) =>
        a.semester.localeCompare(
          b.semester,
          undefined,
          { numeric: true }
        ) ||
        a.code.localeCompare(b.code)
      );

    const sessions = groups.flatMap(g => g.sessions);

    const history = sessions
      .filter(s => s.ended)
      .sort((a, b) =>
        b.lesson_date.localeCompare(a.lesson_date) ||
        b.start_time.localeCompare(a.start_time)
      );

    const allNotices = await loadNotices(db);

    const notices = allNotices
      .filter(n =>
        (
          n.audience === "selected" &&
          n.recipient_ids?.includes(uid)
        ) ||
        (
          n.author_role === "admin" &&
          ["all", "students"].includes(n.audience)
        )
      )
      .map(n => ({
        id: n.id,
        title: n.title,
        body: n.body,
        author_name: n.author_name,
        author_role: n.author_role,
        created_at: n.created_at
      }));

    res.json({
      ok: true,
      profile: profile(uid, req.student),
      today,
      current_semester: req.student.semester || "",
      classes,
      attendance: history,
      summary: summary(history),

      daily: sessions
        .filter(s =>
          s.lesson_date === today &&
          classes.some(c =>
            c.id === s.class_id &&
            c.active &&
            c.enrolment_active
          )
        )
        .sort((a, b) =>
          a.start_time.localeCompare(b.start_time)
        ),

      notices
    });
  }));

  app.post("/profile", route(async (req, res) => {
    const fields = {
      name: text(req.body, "name", 100),
      phone: text(req.body, "phone", 150, false)
    };

    const ref = db.collection("users").doc(req.studentUid);

    const saved = await db.runTransaction(
      async transaction => {
        const current = checkStudent(
          await transaction.get(ref)
        );

        transaction.update(ref, {
          ...fields,
          updated_at: timestamp()
        });

        return profile(req.studentUid, {
          ...current,
          ...fields
        });
      }
    );

    res.json({
      ok: true,
      message: "Profile updated successfully.",
      profile: saved
    });
  }));

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      message: "Student API route not found."
    });
  });

  app.use((error, req, res, next) => {
    const status =
      error.status ||
      (
        error.type === "entity.parse.failed"
          ? 400
          : error.type === "entity.too.large"
            ? 413
            : 503
      );

    if (status >= 500) {
      console.error(
        "Student API error:",
        error.code || "internal"
      );
    }

    res.status(status).json({
      ok: false,

      message: error.status
        ? error.message
        : status === 400
          ? "Send valid JSON."
          : status === 413
            ? "Request is too large."
            : "Could not load your information. Please retry."
    });
  });

  return app;
}

module.exports = {
  createStudentApp
};