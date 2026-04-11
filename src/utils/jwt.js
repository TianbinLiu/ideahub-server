//jwt.js

const jwt = require("jsonwebtoken");

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, tokenVersion: Number(user.tokenVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function signOauthState(payload) {
  return jwt.sign(
    { ...payload, purpose: "oauth-state" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

function verifyOauthState(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload?.purpose !== "oauth-state") {
    throw new Error("Invalid OAuth state");
  }
  return payload;
}

module.exports = { signToken, signOauthState, verifyOauthState };
