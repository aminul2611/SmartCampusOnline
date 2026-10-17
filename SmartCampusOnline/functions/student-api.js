const express = require("express");

const {
  ApiError,
  text,
  id,
  key
} = require("./validation");

const {
  loadNotices
} = require("./teacher-notices-api");

const ZONE = "Asia/Shanghai";

const STATUSES = [
  "Pending",
  "In Progress",
  "Completed"
];

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
    .map(name => parts.find(part => part.type === name).value)
    .join("-");
}

function joined(record) {
  if (record.joined_on) {
    return record.joined_on;
  }

  const value = record.created_at;
  const seconds = value?.seconds ?? value?._seconds;

  const parsed = seconds != null
    ? new Date(seconds * 1000)
    : new Date(value);

  return Number.isFinite(parsed.getTime())
    ? day(parsed)
    : "0000-01-01";
}

function profile(uid, user) {
  const result = {
    id: uid,
    role: "student"
  };

  const fields = [
    "name",
    "email",
    "student_no",
    "phone",
    "department",
    "program",
    "semester"
  ];

  for (const field of fields) {
    result[field] = user[field] || "";
  }

  return result;
}

function checkStudent(snapshot) {
  const user = snapshot.exists
    ? snapshot.data()
    : {};

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

function taskAllowed(task, uid, classes) {
  if (task.active === false) {
    return false;
  }

  return task.assigned_to
    ? task.assigned_to === uid
    : Boolean(task.class_id) && classes.has(task.class_id);
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

      const snapshot = await db
        .collection("users")
        .doc(decoded.uid)
        .get();

      req.student = checkStudent(snapshot);
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
      profile: profile(
        req.studentUid,
        req.student
      )
    });
  });

  app.get("/data", route(async (req, res) => {
    const uid = req.studentUid;
    const today = day();

    const enrolments = rows(
      await db
        .collection("enrolments")
        .where("student_id", "==", uid)
        .get()
    ).filter(item => item.active !== false);

    const unique = [
      ...new Map(
        enrolments.map(item => [
          item.class_id,
          item
        ])
      ).values()
    ];

    const groups = (
      await Promise.all(
        unique.map(async enrolment => {
          const classId = id(enrolment.class_id);

          const snapshot = await db
            .collection("classes")
            .doc(classId)
            .get();

          if (!snapshot.exists) {
            return null;
          }

          const classroom = snapshot.data();

          const [
            teacher,
            marks,
            lessons
          ] = await Promise.all([
            classroom.teacher_id
              ? db
                .collection("users")
                .doc(id(classroom.teacher_id))
                .get()
              : Promise.resolve(null),

            db
              .collection("teacher_marks")
              .doc(key(classId, uid))
              .get(),

            db
              .collection("teacher_lessons")
              .where("class_id", "==", classId)
              .get()
          ]);

          const result = {
            id: classId,
            code: classroom.code || "",
            name: classroom.name || "",

            semester:
              enrolment.semester ||
              classroom.semester ||
              req.student.semester ||
              "Semester not assigned",

            teacher_name:
              teacher?.exists &&
              teacher.data().role === "teacher"
                ? teacher.data().name
                : "Teacher not available",

            active: classroom.active !== false,

            weekly_slots: (
              classroom.weekly_slots || []
            ).map(slot => ({
              day: slot.day,
              start: slot.start,
              end: slot.end,
              room: slot.room || ""
            })),

            joined_on: joined(enrolment)
          };

          const savedMarks =
            marks.exists &&
            marks.data().student_id === uid
              ? marks.data()
              : {};

          const maximums = {
            assessment: 20,
            mid: 30,
            final: 50
          };

          for (
            const [name, maximum] of Object.entries(maximums)
          ) {
            result[name] = savedMarks[name] ?? null;

            result[name + "_max"] =
              classroom[name + "_max"] ?? maximum;
          }

          const sessions = rows(lessons)
            .filter(
              lesson =>
                lesson.lesson_date >= result.joined_on
            )
            .map(lesson => ({
              id: lesson.id,
              class_id: classId,
              code: result.code,
              name: result.name,
              lesson_date: lesson.lesson_date,
              start_time: lesson.start_time,
              end_time: lesson.end_time,
              room: lesson.room || "",
              topic: lesson.topic || ""
            }));

          return {
            classroom: result,
            sessions
          };
        })
      )
    ).filter(Boolean);

    const classes = groups
      .map(group => group.classroom)
      .sort(
        (a, b) =>
          a.semester.localeCompare(b.semester) ||
          a.code.localeCompare(b.code)
      );

    const classIds = new Set(
      classes.map(classroom => classroom.id)
    );

    const [
      attendance,
      notices,
      directTasks,
      progress,
      ...classTasks
    ] = await Promise.all([
      db
        .collection("student_attendance")
        .where("student_id", "==", uid)
        .get(),

      loadNotices(db),

      db
        .collection("tasks")
        .where("assigned_to", "==", uid)
        .get(),

      db
        .collection("student_task_progress")
        .where("student_id", "==", uid)
        .get(),

      ...classes.map(classroom =>
        db
          .collection("tasks")
          .where("class_id", "==", classroom.id)
          .get()
      )
    ]);

    const statuses = new Map(
      rows(attendance).map(item => [
        item.lesson_id,
        item.status
      ])
    );

    const sessions = groups.flatMap(
      group => group.sessions
    );

    const history = sessions
      .filter(lesson => lesson.lesson_date <= today)
      .map(lesson => ({
        ...lesson,
        status: statuses.get(lesson.id) || null
      }))
      .sort(
        (a, b) =>
          b.lesson_date.localeCompare(a.lesson_date) ||
          b.start_time.localeCompare(a.start_time)
      );

    const counts = {
      Present: 0,
      Absent: 0,
      Late: 0,
      Excused: 0,
      "Not marked": 0
    };

    for (const item of history) {
      const status = Object.hasOwn(counts, item.status)
        ? item.status
        : "Not marked";

      counts[status]++;
    }

    const percentage = history.length
      ? Math.round(
        (
          counts.Present +
          counts.Late
        ) * 1000 / history.length
      ) / 10
      : 0;

    const inbox = notices
      .filter(notice =>
        (
          notice.audience === "selected" &&
          notice.recipient_ids?.includes(uid)
        ) ||
        (
          notice.author_role === "admin" &&
          ["all", "students"].includes(notice.audience)
        )
      )
      .map(notice => ({
        id: notice.id,
        title: notice.title,
        body: notice.body,
        author_name: notice.author_name,
        author_role: notice.author_role,
        created_at: notice.created_at
      }));

    const ownProgress = new Map(
      rows(progress).map(item => [
        item.task_id,
        item.status
      ])
    );

    const allTasks = [
      ...new Map(
        [directTasks, ...classTasks]
          .flatMap(rows)
          .map(task => [task.id, task])
      ).values()
    ];

    const tasks = allTasks
      .filter(task => taskAllowed(task, uid, classIds))
      .map(task => ({
        id: task.id,
        title: task.title || "",
        description: task.description || "",
        due_date: task.due_date || "",
        priority: task.priority || "Medium",

        status:
          ownProgress.get(task.id) ||
          (
            task.assigned_to === uid &&
            STATUSES.includes(task.status)
              ? task.status
              : "Pending"
          )
      }))
      .sort(
        (a, b) =>
          Number(a.status === "Completed") -
          Number(b.status === "Completed") ||
          (a.due_date || "9999").localeCompare(
            b.due_date || "9999"
          )
      );

    res.json({
      ok: true,
      profile: profile(uid, req.student),
      today,
      classes,
      attendance: history,
      counts,
      percentage,

      daily: sessions
        .filter(lesson => lesson.lesson_date === today)
        .sort(
          (a, b) =>
            a.start_time.localeCompare(b.start_time)
        ),

      notices: inbox,
      tasks,

      completed: tasks.filter(
        task => task.status === "Completed"
      ).length
    });
  }));

  app.post("/profile", route(async (req, res) => {
    const fields = {
      name: text(req.body, "name", 100),
      phone: text(req.body, "phone", 150, false)
    };

    const ref = db
      .collection("users")
      .doc(req.studentUid);

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

  app.post(
    "/tasks/:tid/status",
    route(async (req, res) => {
      const tid = id(req.params.tid);
      const status = text(req.body, "status", 20);

      if (!STATUSES.includes(status)) {
        throw new ApiError(
          400,
          "Choose a valid task status."
        );
      }

      await db.runTransaction(async transaction => {
        checkStudent(
          await transaction.get(
            db
              .collection("users")
              .doc(req.studentUid)
          )
        );

        const task = await transaction.get(
          db.collection("tasks").doc(tid)
        );

        if (!task.exists) {
          throw new ApiError(
            404,
            "Task not found."
          );
        }

        const data = task.data();
        const classes = new Set();

        if (!data.assigned_to && data.class_id) {
          const classId = id(data.class_id);

          const [
            enrolment,
            classroom
          ] = await Promise.all([
            transaction.get(
              db
                .collection("enrolments")
                .doc(key(classId, req.studentUid))
            ),

            transaction.get(
              db.collection("classes").doc(classId)
            )
          ]);

          if (
            enrolment.exists &&
            enrolment.data().active !== false &&
            classroom.exists
          ) {
            classes.add(classId);
          }
        }

        if (
          !taskAllowed(
            data,
            req.studentUid,
            classes
          )
        ) {
          throw new ApiError(
            403,
            "This task is not assigned to you."
          );
        }

        transaction.set(
          db
            .collection("student_task_progress")
            .doc(key(tid, req.studentUid)),
          {
            task_id: tid,
            student_id: req.studentUid,
            status,
            updated_at: timestamp()
          }
        );
      });

      res.json({
        ok: true,
        message: "Task status updated successfully.",
        status
      });
    })
  );

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
            : "Firebase could not complete this request. Check your connection and retry."
    });
  });

  return app;
}

module.exports = {
  createStudentApp
};