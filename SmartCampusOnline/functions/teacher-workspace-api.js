const express = require("express");

const {
  ApiError,
  text,
  id,
  date,
  key
} = require("./validation");

const {
  loadNotices
} = require("./teacher-notices-api");

const ZONE = "Asia/Shanghai";

const LIMITS = {
  assessment: 20,
  mid: 30,
  final: 50
};

function day(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);

  return ["year", "month", "day"]
    .map(name => parts.find(part => part.type === name).value)
    .join("-");
}

function joined(data) {
  if (data.joined_on) return data.joined_on;

  const value = data.created_at;
  const seconds = value?.seconds ?? value?._seconds;

  const parsed = seconds != null
    ? new Date(seconds * 1000)
    : new Date(value);

  return Number.isFinite(parsed.getTime())
    ? day(parsed)
    : "0000-01-01";
}

const rows = snapshot => snapshot.docs.map(doc => ({
  ...doc.data(),
  id: doc.id
}));

function safeStudent(uid, data) {
  const result = { id: uid };

  for (const field of [
    "name",
    "email",
    "student_no",
    "semester",
    "department",
    "program",
    "phone",
    "active",
    "created_at"
  ]) {
    if (data[field] !== undefined) {
      result[field] = data[field];
    }
  }

  return result;
}

function limits(classroom) {
  return Object.fromEntries(
    Object.entries(LIMITS).map(([name, maximum]) => [
      name,
      classroom[name + "_max"] ?? maximum
    ])
  );
}

function createTeacherWorkspaceApp({ db, timestamp }) {
  const app = express();

  const route = handler => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  const ok = (res, data = {}) => {
    res.json({ ok: true, ...data });
  };

  async function actor(transaction, req) {
    const snapshot = await transaction.get(
      db.collection("users").doc(req.teacherUid)
    );

    const user = snapshot.exists ? snapshot.data() : {};

    if (
      user.role !== "teacher" ||
      user.active !== true ||
      user.provisioning === "pending"
    ) {
      throw new ApiError(
        403,
        "An active teacher account is required."
      );
    }

    return user;
  }

  async function classroom(transaction, req) {
    const classId = id(req.params.cid);

    const snapshot = await transaction.get(
      db.collection("classes").doc(classId)
    );

    if (
      !snapshot.exists ||
      snapshot.data().teacher_id !== req.teacherUid ||
      snapshot.data().active === false
    ) {
      throw new ApiError(
        403,
        "Select an active class assigned to you."
      );
    }

    return {
      ...snapshot.data(),
      id: classId
    };
  }

  async function student(
    transaction,
    classId,
    studentId,
    onDate
  ) {
    const [enrolment, account] = await Promise.all([
      transaction.get(
        db.collection("enrolments").doc(
          key(classId, studentId)
        )
      ),

      transaction.get(
        db.collection("users").doc(studentId)
      )
    ]);

    if (
      !enrolment.exists ||
      enrolment.data().active === false ||
      !account.exists ||
      account.data().role !== "student" ||
      account.data().active !== true ||
      account.data().provisioning === "pending"
    ) {
      throw new ApiError(
        403,
        "Select an active student enrolled in this class."
      );
    }

    if (onDate && joined(enrolment.data()) > onDate) {
      throw new ApiError(
        400,
        "This student was not enrolled on the session date."
      );
    }
  }

  app.use((req, res, next) => {
    if (
      req.method === "POST" && (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      )
    ) {
      return next(
        new ApiError(400, "Send a valid JSON object.")
      );
    }

    next();
  });

  app.get("/data", route(async (req, res) => {
    const classes = rows(
      await db.collection("classes")
        .where("teacher_id", "==", req.teacherUid)
        .get()
    )
      .filter(item => item.active !== false)
      .map(item => ({
        ...item,
        limits: limits(item)
      }));

    const groups = await Promise.all(
      classes.map(async item => {
        const [
          enrolments,
          marks,
          lessons,
          attendance
        ] = await Promise.all(
          [
            "enrolments",
            "teacher_marks",
            "teacher_lessons",
            "student_attendance"
          ].map(collection =>
            db.collection(collection)
              .where("class_id", "==", item.id)
              .get()
          )
        );

        const enrolled = rows(enrolments)
          .filter(record => record.active !== false)
          .map(record => ({
            ...record,
            joined_on: joined(record)
          }));

        const students = (
          await Promise.all(
            enrolled.map(async record => {
              const snapshot = await db
                .collection("users")
                .doc(record.student_id)
                .get();

              if (
                !snapshot.exists ||
                snapshot.data().role !== "student" ||
                snapshot.data().provisioning === "pending"
              ) {
                return null;
              }

              return safeStudent(
                snapshot.id,
                snapshot.data()
              );
            })
          )
        ).filter(Boolean);

        return {
          enrolments: enrolled,
          students,
          marks: rows(marks),
          lessons: rows(lessons),
          attendance: rows(attendance)
        };
      })
    );

    const [work, notices] = await Promise.all([
      db.collection("teacher_work_attendance")
        .where("teacher_id", "==", req.teacherUid)
        .get(),

      loadNotices(db)
    ]);

    const received = notices.filter(notice =>
      notice.author_role === "admin" && (
        notice.audience === "all" ||
        notice.audience === "teachers" ||
        (
          notice.audience === "selected" &&
          notice.recipient_ids?.includes(req.teacherUid)
        )
      )
    );

    const flatten = name =>
      groups.flatMap(group => group[name]);

    ok(res, {
      today: day(),
      classes,

      students: [
        ...new Map(
          flatten("students").map(item => [item.id, item])
        ).values()
      ],

      enrolments: flatten("enrolments"),
      marks: flatten("marks"),
      lessons: flatten("lessons"),
      attendance: flatten("attendance"),

      work: rows(work)
        .sort((a, b) =>
          b.work_date.localeCompare(a.work_date)
        )
        .slice(0, 60),

      received,

      sent: notices.filter(notice =>
        notice.created_by === req.teacherUid &&
        notice.author_role === "teacher"
      )
    });
  }));

  app.post(
    "/classes/:cid/marks",
    route(async (req, res) => {
      const studentId = id(req.body.student_id);

      await db.runTransaction(async transaction => {
        await actor(transaction, req);

        const currentClass = await classroom(
          transaction,
          req
        );

        await student(
          transaction,
          currentClass.id,
          studentId
        );

        const saved = {};

        for (const [name, maximum] of Object.entries(
          limits(currentClass)
        )) {
          const value = req.body[name];

          if (
            value == null ||
            (
              typeof value === "string" &&
              !value.trim()
            )
          ) {
            saved[name] = null;
            continue;
          }

          if (
            !["number", "string"].includes(typeof value) ||
            !Number.isFinite(Number(value)) ||
            Number(value) < 0 ||
            Number(value) > maximum
          ) {
            throw new ApiError(
              400,
              `${name} marks must be between 0 and ${maximum}.`
            );
          }

          saved[name] = Number(value);
        }

        transaction.set(
          db.collection("teacher_marks").doc(
            key(currentClass.id, studentId)
          ),
          {
            ...saved,
            class_id: currentClass.id,
            student_id: studentId,
            updated_by: req.teacherUid,
            updated_at: timestamp()
          }
        );
      });

      ok(res, {
        message: "Marks saved successfully."
      });
    })
  );

  app.post(
    "/classes/:cid/lessons",
    route(async (req, res) => {
      const fields = {
        class_id: id(req.params.cid),
        lesson_date: date(req.body.lesson_date),
        start_time: text(req.body, "start_time", 5),
        end_time: text(req.body, "end_time", 5),
        room: text(req.body, "room", 100, false),
        topic: text(req.body, "topic", 200, false)
      };

      const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;

      if (
        !validTime.test(fields.start_time) ||
        !validTime.test(fields.end_time) ||
        fields.end_time <= fields.start_time
      ) {
        throw new ApiError(
          400,
          "Choose valid times with end after start."
        );
      }

      const requestId = text(req.body, "request_id", 32);

      if (!/^[a-f0-9]{32}$/.test(requestId)) {
        throw new ApiError(
          400,
          "Refresh the session form."
        );
      }

      const ref = db.collection("teacher_lessons").doc(
        key("lesson", req.teacherUid, requestId)
      );

      const hash = key(fields);

      await db.runTransaction(async transaction => {
        await actor(transaction, req);
        await classroom(transaction, req);

        const old = await transaction.get(ref);

        if (old.exists) {
          if (old.data().creation_hash !== hash) {
            throw new ApiError(
              409,
              "This request was already used. Check saved sessions."
            );
          }

          return;
        }

        const lock = db.collection("_teacher_days").doc(
          key(req.teacherUid, fields.lesson_date)
        );

        await transaction.get(lock);

        const classes = rows(
          await transaction.get(
            db.collection("classes")
              .where("teacher_id", "==", req.teacherUid)
          )
        ).filter(item => item.active !== false);

        const existing = (
          await Promise.all(
            classes.map(item =>
              transaction.get(
                db.collection("teacher_lessons")
                  .where("class_id", "==", item.id)
              )
            )
          )
        ).flatMap(rows);

        const overlap = existing.some(item =>
          item.lesson_date === fields.lesson_date &&
          item.start_time < fields.end_time &&
          item.end_time > fields.start_time
        );

        if (overlap) {
          throw new ApiError(
            409,
            "This session overlaps another class in your schedule."
          );
        }

        transaction.set(ref, {
          ...fields,
          teacher_id: req.teacherUid,
          created_at: timestamp(),
          creation_hash: hash
        });

        transaction.set(lock, {
          updated_at: timestamp()
        });
      });

      ok(res, {
        id: ref.id,
        message: "Class session saved."
      });
    })
  );

  app.post(
    "/classes/:cid/attendance",
    route(async (req, res) => {
      const studentId = id(req.body.student_id);
      const lessonId = id(req.body.lesson_id);
      const status = text(req.body, "status", 10);

      if (![
        "Present",
        "Absent",
        "Late",
        "Excused"
      ].includes(status)) {
        throw new ApiError(
          400,
          "Select a valid attendance status."
        );
      }

      await db.runTransaction(async transaction => {
        await actor(transaction, req);

        const currentClass = await classroom(
          transaction,
          req
        );

        const lesson = await transaction.get(
          db.collection("teacher_lessons").doc(lessonId)
        );

        if (
          !lesson.exists ||
          lesson.data().class_id !== currentClass.id
        ) {
          throw new ApiError(
            403,
            "Select a session from your class."
          );
        }

        const sessionDate = lesson.data().lesson_date;

        if (sessionDate > day()) {
          throw new ApiError(
            400,
            "Future attendance cannot be recorded."
          );
        }

        await student(
          transaction,
          currentClass.id,
          studentId,
          sessionDate
        );

        transaction.set(
          db.collection("student_attendance").doc(
            key(lessonId, studentId)
          ),
          {
            class_id: currentClass.id,
            lesson_id: lessonId,
            student_id: studentId,
            teacher_id: req.teacherUid,
            session_date: sessionDate,
            status,
            updated_at: timestamp()
          }
        );
      });

      ok(res, {
        message: "Student attendance saved."
      });
    })
  );

  app.post(
    "/work-attendance",
    route(async (req, res) => {
      const action = text(req.body, "action", 3);

      if (!["in", "out"].includes(action)) {
        throw new ApiError(
          400,
          "Select check-in or check-out."
        );
      }

      const workDate = day();

      const ref = db
        .collection("teacher_work_attendance")
        .doc(key(req.teacherUid, workDate));

      await db.runTransaction(async transaction => {
        await actor(transaction, req);

        const snapshot = await transaction.get(ref);

        const record = snapshot.exists
          ? snapshot.data()
          : null;

        if (action === "in") {
          if (!record) {
            transaction.set(ref, {
              teacher_id: req.teacherUid,
              work_date: workDate,
              check_in: timestamp(),
              check_out: null
            });
          }
        } else {
          if (!record?.check_in) {
            throw new ApiError(409, "Check in first.");
          }

          if (record.check_out == null) {
            transaction.update(ref, {
              check_out: timestamp()
            });
          }
        }
      });

      ok(res, {
        message: action === "in"
          ? "Check-in recorded."
          : "Check-out recorded."
      });
    })
  );

  app.post("/notices", route(async (req, res) => {
    const title = text(req.body, "title", 140);
    const body = text(req.body, "body", 5000);
    const audience = text(req.body, "audience", 10);
    const requestId = text(req.body, "request_id", 32);

    if (
      !["admin", "class", "students"].includes(audience) ||
      !/^[a-f0-9]{32}$/.test(requestId)
    ) {
      throw new ApiError(
        400,
        "Check the notice recipients and request."
      );
    }

    const classId = audience === "class"
      ? id(req.body.class_id)
      : "";

    let selected = [];

    if (audience === "students") {
      if (
        !Array.isArray(req.body.student_ids) ||
        !req.body.student_ids.length ||
        req.body.student_ids.length > 200
      ) {
        throw new ApiError(
          400,
          "Select 1–200 students."
        );
      }

      selected = [
        ...new Set(req.body.student_ids.map(id))
      ].sort();
    }

    const alsoAdmin = req.body.also_admin === true;

    const ref = db.collection("notices").doc(
      key(
        "teacher-workspace-notice",
        req.teacherUid,
        requestId
      )
    );

    const hash = key(
      title,
      body,
      audience,
      classId,
      selected,
      alsoAdmin
    );

    await db.runTransaction(async transaction => {
      const teacher = await actor(transaction, req);
      const old = await transaction.get(ref);

      if (old.exists) {
        if (old.data().creation_hash !== hash) {
          throw new ApiError(
            409,
            "Check Sent notices. This request was already used."
          );
        }

        return;
      }

      const classes = rows(
        await transaction.get(
          db.collection("classes")
            .where("teacher_id", "==", req.teacherUid)
        )
      ).filter(item => item.active !== false);

      if (
        audience === "class" &&
        !classes.some(item => item.id === classId)
      ) {
        throw new ApiError(
          403,
          "Select your own assigned class."
        );
      }

      const enrolments = (
        await Promise.all(
          classes.map(item =>
            transaction.get(
              db.collection("enrolments")
                .where("class_id", "==", item.id)
            )
          )
        )
      )
        .flatMap(rows)
        .filter(item => item.active !== false);

      const allowed = new Set(
        enrolments.map(item => item.student_id)
      );

      if (selected.some(uid => !allowed.has(uid))) {
        throw new ApiError(
          403,
          "Choose students from your own classes."
        );
      }

      const candidates = audience === "class"
        ? enrolments
            .filter(item => item.class_id === classId)
            .map(item => item.student_id)
        : selected;

      const users = await Promise.all(
        [...new Set(candidates)].map(uid =>
          transaction.get(
            db.collection("users").doc(uid)
          )
        )
      );

      const recipients = new Set(
        users.filter(snapshot =>
          snapshot.exists &&
          snapshot.data().role === "student" &&
          snapshot.data().active === true &&
          snapshot.data().provisioning !== "pending"
        ).map(snapshot => snapshot.id)
      );

      if (
        audience === "students" &&
        recipients.size !== selected.length
      ) {
        throw new ApiError(
          400,
          "Choose active students."
        );
      }

      if (audience === "admin" || alsoAdmin) {
        const admins = await transaction.get(
          db.collection("users")
            .where("role", "==", "admin")
        );

        admins.docs
          .filter(snapshot => snapshot.data().active === true)
          .forEach(snapshot => recipients.add(snapshot.id));
      }

      if (!recipients.size) {
        throw new ApiError(
          400,
          "No eligible recipients found."
        );
      }

      transaction.set(ref, {
        title,
        body,
        audience: "selected",
        recipient_ids: [...recipients],
        author_role: "teacher",
        author_name: teacher.name || "Teacher",
        created_by: req.teacherUid,
        active: true,
        created_at: timestamp(),
        updated_at: timestamp(),
        creation_hash: hash
      });
    });

    ok(res, {
      message: "Notice sent successfully."
    });
  }));

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      message: "Teacher workspace route not found."
    });
  });

  return app;
}

module.exports = {
  createTeacherWorkspaceApp
};