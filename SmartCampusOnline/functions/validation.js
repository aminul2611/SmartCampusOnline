const { createHash } = require("node:crypto");

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function text(data, key, max, required = true) {
  const value = data[key] ?? "";

  if (
    typeof value !== "string" ||
    (required && !value.trim()) ||
    value.trim().length > max
  ) {
    throw new ApiError(
      400,
      `Check ${key.replaceAll("_", " ")} (maximum ${max} characters).`
    );
  }

  return value.trim();
}

function id(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    /[\/\x00-\x1f]/.test(value) ||
    [".", ".."].includes(value)
  ) {
    throw new ApiError(400, "Invalid record ID.");
  }

  return value;
}

function boolean(value) {
  if (typeof value !== "boolean") {
    throw new ApiError(400, "Choose a valid status.");
  }

  return value;
}

function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    throw new ApiError(400, "Enter a valid date (YYYY-MM-DD).");
  }

  return value;
}

function slots(value) {
  if (!Array.isArray(value) || !value.length || value.length > 21) {
    throw new ApiError(400, "Add 1–21 weekly time slots.");
  }

  const result = value.map(s => {
    if (
      !s ||
      typeof s.start !== "string" ||
      typeof s.end !== "string" ||
      !Number.isInteger(s.day) ||
      s.day < 0 ||
      s.day > 6 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end) ||
      s.start >= s.end
    ) {
      throw new ApiError(
        400,
        "Choose a valid day and an end time after the start time."
      );
    }

    return {
      day: s.day,
      start: s.start,
      end: s.end,
      room: text(s, "room", 80, false)
    };
  }).sort(
    (a, b) => a.day - b.day || a.start.localeCompare(b.start)
  );

  for (let i = 1; i < result.length; i++) {
    if (
      result[i].day === result[i - 1].day &&
      result[i].start < result[i - 1].end
    ) {
      throw new ApiError(400, "Weekly time slots must not overlap.");
    }
  }

  return result;
}

const key = (...values) =>
  createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex");

module.exports = {
  ApiError,
  text,
  id,
  boolean,
  date,
  slots,
  key
};