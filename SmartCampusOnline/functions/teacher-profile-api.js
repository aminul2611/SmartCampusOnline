const express = require("express");

const {
  ApiError,
  text
} = require("./validation");

const {
  createTeacherWorkspaceApp
} = require("./teacher-workspace-api");

function requireTeacher({ auth, db }) {
  return async (req, res, next) => {
    try {
      const header = req.get("Authorization") || "";

      if (!header.startsWith("Bearer ")) {
        throw new ApiError(
          401,
          "Please sign in as teacher."
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

      const profile = snapshot.exists
        ? snapshot.data()
        : {};

      if (
        profile.role !== "teacher" ||
        profile.active !== true ||
        profile.provisioning === "pending"
      ) {
        throw new ApiError(
          403,
          "An active teacher account is required."
        );
      }

      req.teacherUid = decoded.uid;
      req.teacherProfile = profile;

      next();
    } catch (error) {
      next(error);
    }
  };
}

function publicProfile(uid, data) {
  return {
    id: uid,
    name: data.name || "",
    email: data.email || "",
    teacher_no: data.teacher_no || "",
    phone: data.phone || "",
    department: data.department || "",
    designation: data.designation || "",
    role: "teacher",
    active: data.active === true
  };
}

function createTeacherProfileApp({ auth, db, timestamp }) {
  const app = express();

  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use(express.json({ limit: "32kb" }));

  app.use(requireTeacher({ auth, db }));

  app.use(
    "/workspace",
    createTeacherWorkspaceApp({ db, timestamp })
  );

  app.get("/", (req, res) => {
    res.json({
      ok: true,
      profile: publicProfile(
        req.teacherUid,
        req.teacherProfile
      )
    });
  });

  app.post("/", async (req, res, next) => {
    try {
      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      ) {
        throw new ApiError(
          400,
          "Send a valid JSON object."
        );
      }

      const fields = {
        name: text(req.body, "name", 100),
        phone: text(req.body, "phone", 150, false),
        department: text(req.body, "department", 150, false),
        designation: text(req.body, "designation", 150, false)
      };

      const ref = db
        .collection("users")
        .doc(req.teacherUid);

      const profile = await db.runTransaction(
        async transaction => {
          const snapshot = await transaction.get(ref);

          const current = snapshot.exists
            ? snapshot.data()
            : {};

          if (
            current.role !== "teacher" ||
            current.active !== true ||
            current.provisioning === "pending"
          ) {
            throw new ApiError(
              403,
              "An active teacher account is required."
            );
          }

          transaction.update(ref, {
            ...fields,
            updated_at: timestamp()
          });

          return publicProfile(req.teacherUid, {
            ...current,
            ...fields
          });
        }
      );

      res.json({
        ok: true,
        message: "Profile updated successfully.",
        profile
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      message: "Teacher profile route not found."
    });
  });

  return app;
}

module.exports = {
  createTeacherProfileApp,
  requireTeacher
};