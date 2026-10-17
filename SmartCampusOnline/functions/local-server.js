const express = require("express");
const path = require("node:path");

const {
  initializeApp
} = require("firebase-admin/app");

const {
  getAuth
} = require("firebase-admin/auth");

const {
  getFirestore,
  FieldValue
} = require("firebase-admin/firestore");

const {
  createCampusApp
} = require("./campus-api");

initializeApp({
  projectId:
    process.env.GCLOUD_PROJECT ||
    "smart-campus-9aafa"
});

const app = express();

app.disable("x-powered-by");

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Smart Campus"
  });
});

app.use(
  createCampusApp({
    auth: getAuth(),
    db: getFirestore(),
    timestamp: () => FieldValue.serverTimestamp()
  })
);

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

app.use(
  express.static(
    path.join(__dirname, "../public")
  )
);

const port = Number(
  process.env.PORT || 5003
);

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Smart Campus server is running on port ${port}`
  );
});