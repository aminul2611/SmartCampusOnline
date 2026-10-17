const express = require("express");
const { randomUUID } = require("node:crypto");

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function text(data, key, maximum, required = false) {
    const raw = data[key] ?? "";

    if (typeof raw !== "string") {
        throw new ApiError(400, `Enter a valid ${key}.`);
    }

    const value = raw.trim();

    if ((required && !value) || value.length > maximum) {
        throw new ApiError(
            400,
            `Check ${key}; maximum ${maximum} characters.`
        );
    }

    return value;
}

function details(data) {
    const email = text(data, "email", 254, true).toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ApiError(400, "Enter a valid email address.");
    }

    return {
        name: text(data, "name", 100, true),
        teacher_no: text(data, "teacher_no", 80, true),
        email,
        department: text(data, "department", 150),
        phone: text(data, "phone", 150),
        designation: text(data, "designation", 150)
    };
}

function password(data) {
    const value = data.new_password;

    if (
        typeof value !== "string" ||
        value.length < 8 ||
        value.length > 128
    ) {
        throw new ApiError(
            400,
            "Password must contain 8–128 characters."
        );
    }

    if (value !== data.confirm_password) {
        throw new ApiError(400, "Passwords do not match.");
    }

    return value;
}

function activeValue(data) {
    if (typeof data.active !== "boolean") {
        throw new ApiError(400, "Choose a valid account status.");
    }

    return data.active;
}

function createTeacherApp({ auth, db, timestamp }) {
    const app = express();

    app.disable("x-powered-by");

    app.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        res.set("X-Content-Type-Options", "nosniff");
        next();
    });

    app.use(express.json({ limit: "32kb" }));

    async function withTeacherLock(uid, work) {
        if (
            !uid ||
            uid.length > 128 ||
            uid.includes("/") ||
            uid === "." ||
            uid === ".."
        ) {
            throw new ApiError(404, "Teacher not found.");
        }

        const ref = db.collection("_teacher_api_locks").doc(uid);
        const token = randomUUID();

        await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);

            if (
                snapshot.exists &&
                snapshot.data().expires_ms > Date.now()
            ) {
                throw new ApiError(
                    409,
                    "Another update is running for this teacher. Retry shortly."
                );
            }

            transaction.set(ref, {
                token,
                expires_ms: Date.now() + 120000
            });
        });

        try {
            return await work();
        } finally {
            try {
                await db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);

                    if (
                        snapshot.exists &&
                        snapshot.data().token === token
                    ) {
                        transaction.delete(ref);
                    }
                });
            } catch {
                console.error(
                    "Teacher operation lock could not release; it expires automatically."
                );
            }
        }
    }

    const route = handler => async (req, res, next) => {
        try {
            const header = req.get("Authorization") || "";

            if (!header.startsWith("Bearer ")) {
                throw new ApiError(
                    401,
                    "Please sign in as administrator."
                );
            }

            let decoded;

            try {
                decoded = await auth.verifyIdToken(
                    header.slice(7),
                    true
                );
            } catch (error) {
                const tokenErrors = [
                    "auth/argument-error",
                    "auth/invalid-id-token",
                    "auth/id-token-expired",
                    "auth/id-token-revoked",
                    "auth/user-disabled",
                    "auth/user-not-found"
                ];

                if (tokenErrors.includes(error.code)) {
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
                profile.role !== "admin" ||
                profile.active !== true
            ) {
                throw new ApiError(
                    403,
                    "An active administrator account is required."
                );
            }

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

            req.adminUid = decoded.uid;

            const requestId = req.body.request_id;

            const uid = req.params.uid || (
                typeof requestId === "string" &&
                /^[a-f0-9]{32}$/.test(requestId)
                    ? "teacher-" + requestId
                    : null
            );

            if (uid) {
                await withTeacherLock(
                    uid,
                    () => handler(req, res)
                );
            } else {
                await handler(req, res);
            }
        } catch (error) {
            next(error);
        }
    };

    async function teacher(uid) {
        if (
            !uid ||
            uid.length > 128 ||
            uid.includes("/") ||
            uid === "." ||
            uid === ".."
        ) {
            throw new ApiError(404, "Teacher not found.");
        }

        const ref = db.collection("users").doc(uid);
        const snapshot = await ref.get();

        if (
            !snapshot.exists ||
            snapshot.data().role !== "teacher"
        ) {
            throw new ApiError(404, "Teacher not found.");
        }

        return {
            ref,
            profile: snapshot.data()
        };
    }

    function checkCreation(profile, adminUid, requestId, email) {
        if (
            profile.role !== "teacher" ||
            profile.created_by !== adminUid ||
            profile.creation_request !== requestId ||
            profile.email !== email
        ) {
            throw new ApiError(
                409,
                "Creation request does not match. No account was changed."
            );
        }
    }

    app.post("/api/teachers", route(async (req, res) => {
        const fields = details(req.body);
        const initialPassword = password(req.body);
        const requestId = req.body.request_id;

        if (
            typeof requestId !== "string" ||
            !/^[a-f0-9]{32}$/.test(requestId)
        ) {
            throw new ApiError(
                400,
                "Refresh the form before creating an account."
            );
        }

        const uid = "teacher-" + requestId;
        const ref = db.collection("users").doc(uid);
        const snapshot = await ref.get();

        if (snapshot.exists) {
            const profile = snapshot.data();

            checkCreation(
                profile,
                req.adminUid,
                requestId,
                fields.email
            );

            if (profile.provisioning !== "pending") {
                const account = await auth.getUser(uid);

                if (account.disabled || profile.active !== true) {
                    throw new ApiError(
                        409,
                        "Account already exists and is disabled. Use Settings to enable it."
                    );
                }

                return res.json({
                    ok: true,
                    uid,
                    message: "Teacher account created successfully."
                });
            }
        } else {
            try {
                await auth.createUser({
                    uid,
                    email: fields.email,
                    password: initialPassword,
                    displayName: fields.name,
                    disabled: true
                });
            } catch (error) {
                if (error.code !== "auth/uid-already-exists") {
                    throw error;
                }

                const account = await auth.getUser(uid);
                const retry = await ref.get();

                if (retry.exists) {
                    checkCreation(
                        retry.data(),
                        req.adminUid,
                        requestId,
                        fields.email
                    );
                } else if (
                    !account.disabled ||
                    account.email?.toLowerCase() !== fields.email
                ) {
                    throw new ApiError(
                        409,
                        "A different account already exists for this request."
                    );
                }
            }

            try {
                await ref.create({
                    ...fields,
                    role: "teacher",
                    active: false,
                    created_by: req.adminUid,
                    creation_request: requestId,
                    created_at: timestamp(),
                    provisioning: "pending"
                });
            } catch (error) {
                if (
                    error.code !== 6 &&
                    error.code !== "already-exists"
                ) {
                    throw error;
                }

                const retry = await ref.get();

                checkCreation(
                    retry.data() || {},
                    req.adminUid,
                    requestId,
                    fields.email
                );

                if (retry.data().provisioning !== "pending") {
                    const account = await auth.getUser(uid);

                    if (
                        account.disabled ||
                        retry.data().active !== true
                    ) {
                        throw new ApiError(
                            409,
                            "Account is disabled. Use Settings to enable it."
                        );
                    }

                    return res.json({
                        ok: true,
                        uid,
                        message: "Teacher account created successfully."
                    });
                }
            }
        }

        const account = await auth.getUser(uid);

        if (account.email?.toLowerCase() !== fields.email) {
            throw new ApiError(
                409,
                "Login email does not match this creation request."
            );
        }

        await auth.updateUser(uid, { disabled: false });

        await ref.update({
            active: true,
            provisioning: "complete"
        });

        res.json({
            ok: true,
            uid,
            message: "Teacher account created successfully."
        });
    }));

    app.post(
        "/api/teachers/:uid/account",
        route(async (req, res) => {
            const { ref, profile } = await teacher(req.params.uid);

            if (profile.provisioning === "pending") {
                throw new ApiError(
                    409,
                    "Finish the original account creation before editing it."
                );
            }

            const fields = details(req.body);
            const active = activeValue(req.body);
            const account = await auth.getUser(req.params.uid);

            const emailChanged =
                account.email?.toLowerCase() !== fields.email;

            await auth.updateUser(req.params.uid, {
                email: fields.email,
                displayName: fields.name,
                disabled: !active,
                ...(emailChanged ? { emailVerified: false } : {})
            });

            try {
                await ref.update({
                    ...fields,
                    active,
                    updated_at: timestamp()
                });
            } catch {
                await auth.updateUser(req.params.uid, {
                    email: account.email,
                    displayName: account.displayName || "",
                    disabled: account.disabled,
                    emailVerified: account.emailVerified
                });

                throw new ApiError(
                    503,
                    "Profile could not save. Retry Save with the same values."
                );
            }

            if (!active || emailChanged) {
                await auth.revokeRefreshTokens(req.params.uid);
            }

            res.json({
                ok: true,
                message: "Teacher account updated successfully."
            });
        })
    );

    app.post(
        "/api/teachers/:uid/status",
        route(async (req, res) => {
            const { ref, profile } = await teacher(req.params.uid);

            if (profile.provisioning === "pending") {
                throw new ApiError(
                    409,
                    "Finish the original account creation first."
                );
            }

            const active = activeValue(req.body);
            const account = await auth.getUser(req.params.uid);

            await auth.updateUser(req.params.uid, {
                disabled: !active
            });

            try {
                await ref.update({
                    active,
                    updated_at: timestamp()
                });
            } catch {
                await auth.updateUser(req.params.uid, {
                    disabled: account.disabled
                });

                throw new ApiError(
                    503,
                    "Account status could not save. Retry the same status."
                );
            }

            if (!active) {
                await auth.revokeRefreshTokens(req.params.uid);
            }

            res.json({
                ok: true,
                message: active
                    ? "Teacher enabled successfully."
                    : "Teacher disabled successfully."
            });
        })
    );

    app.post(
        "/api/teachers/:uid/password",
        route(async (req, res) => {
            const { profile } = await teacher(req.params.uid);

            if (profile.provisioning === "pending") {
                throw new ApiError(
                    409,
                    "Finish the original account creation first."
                );
            }

            const newPassword = password(req.body);

            await auth.updateUser(req.params.uid, {
                password: newPassword
            });

            await auth.revokeRefreshTokens(req.params.uid);

            res.json({
                ok: true,
                message:
                    "Teacher password reset successfully. They must sign in with the new password."
            });
        })
    );

    app.use((req, res) => {
        res.status(404).json({
            ok: false,
            message: "API route not found."
        });
    });

    app.use((error, req, res, next) => {
        if (error instanceof ApiError) {
            return res.status(error.status).json({
                ok: false,
                message: error.message
            });
        }

        if (error.type === "entity.parse.failed") {
            return res.status(400).json({
                ok: false,
                message: "Send valid JSON."
            });
        }

        if (error.type === "entity.too.large") {
            return res.status(413).json({
                ok: false,
                message: "Request is too large."
            });
        }

        const known = {
            "auth/email-already-exists": [
                409,
                "This email is already in use."
            ],
            "auth/user-not-found": [
                404,
                "Firebase login account was not found."
            ],
            "auth/invalid-password": [
                400,
                "Enter a valid password."
            ],
            "auth/invalid-email": [
                400,
                "Enter a valid email address."
            ]
        };

        const [status, message] = known[error.code] || [
            503,
            "Firebase could not complete the request. Retry the same form values."
        ];

        console.error(
            "Teacher API request failed:",
            error.code || "internal"
        );

        res.status(status).json({
            ok: false,
            message
        });
    });

    return app;
}

module.exports = { createTeacherApp };