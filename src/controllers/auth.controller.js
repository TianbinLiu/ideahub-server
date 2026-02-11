const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");

async function register(req, res, next) {
  try {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
      res.status(400);
      throw new Error("username, email, password are required");
    }
    if (password.length < 6) {
      res.status(400);
      throw new Error("password must be at least 6 characters");
    }

    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) {
      res.status(409);
      throw new Error("username or email already in use");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      email,
      passwordHash,
      role: role === "company" ? "company" : "user", // Phase 2 先允许 user/company
      bio: "",
    });

    const token = signToken(user);

    res.status(201).json({
      ok: true,
      token,
      user: { id: user._id, username: user.username, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      res.status(400);
      throw new Error("emailOrUsername and password are required");
    }

    const user = await User.findOne({
      $or: [{ email: emailOrUsername }, { username: emailOrUsername }],
    });

    if (!user) {
      res.status(401);
      throw new Error("Invalid credentials");
    }

    const ok = await bcrypt.compare(password, user.passwordHash || "");
    if (!ok) {
      res.status(401);
      throw new Error("Invalid credentials");
    }

    const token = signToken(user);

    res.json({
      ok: true,
      token,
      user: { id: user._id, username: user.username, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res) {
  res.json({ ok: true, user: req.user });
}


module.exports = { register, login, me};
