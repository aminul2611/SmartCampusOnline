const express = require("express");

const {
  createAdminApp
} = require("./admin-api");

const {
  createStudentApp
} = require("./student-api");

function createCampusApp(services) {
  const app = express();

  app.disable("x-powered-by");

  app.use(
    "/api/student",
    createStudentApp(services)
  );

  app.use(
    createAdminApp(services)
  );

  return app;
}

module.exports = {
  createCampusApp
};