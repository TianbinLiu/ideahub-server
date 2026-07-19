// src/controllers/standpoint.controller.js
// 立场展开控制器：取/建代理、配置、状态、绑定账号、事件流、模拟来消息、批准/重生成/忽略。
const mongoose = require("mongoose");
const StandpointAgent = require("../models/StandpointAgent");
const StandpointEvent = require("../models/StandpointEvent");
const { classifyAndReply } = require("../services/standpointAi.service");
const { notFound, invalidId } = require("../utils/http");

const EVENT_STATUSES = ["pending", "drafted", "sent", "dismissed"];

function genAccountId() {
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

// ── 序列化（严格对齐冻结契约的字段/形状）──────────────────────────
function serializeAccount(a) {
  return {
    id: a.id,
    platform: a.platform || "",
    handle: a.handle || "",
    connected: !!a.connected,
  };
}

function serializeConfig(c = {}) {
  return {
    stance: c.stance || "rational",
    personaText: c.personaText || "",
    personalInfo: c.personalInfo || "",
    autoSendEnabled: !!c.autoSendEnabled,
    replyToMalicious: c.replyToMalicious !== false,
    replyToQuestions: c.replyToQuestions !== false,
  };
}

function serializeStats(s = {}) {
  return {
    detected: Number(s.detected || 0),
    drafted: Number(s.drafted || 0),
    sent: Number(s.sent || 0),
  };
}

function serializeAgent(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    status: doc.status || "stopped",
    accounts: Array.isArray(doc.accounts) ? doc.accounts.map(serializeAccount) : [],
    config: serializeConfig(doc.config || {}),
    stats: serializeStats(doc.stats || {}),
    lastActiveAt: doc.lastActiveAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function serializeReply(r) {
  if (!r) return null;
  const out = { text: r.text || "", style: r.style || "" };
  if (r.model) out.model = r.model;
  if (typeof r.heuristic === "boolean") out.heuristic = r.heuristic;
  return out;
}

function serializeEvent(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    kind: doc.kind,
    platform: doc.platform || "",
    fromHandle: doc.fromHandle || "",
    incomingText: doc.incomingText || "",
    classification: doc.classification || "other",
    reply: serializeReply(doc.reply),
    status: doc.status || "drafted",
    autoSent: !!doc.autoSent,
    threadUrl: doc.threadUrl || "",
    createdAt: doc.createdAt,
  };
}

// ── 取或建当前用户的代理 ──────────────────────────────────────────
async function loadOrCreateAgent(userId) {
  let agent = await StandpointAgent.findOne({ user: userId });
  if (agent) return agent;
  try {
    agent = await StandpointAgent.create({ user: userId });
  } catch (err) {
    if (err && err.code === 11000) {
      agent = await StandpointAgent.findOne({ user: userId });
    } else {
      throw err;
    }
  }
  return agent;
}

// ── 加载属于当前用户的事件（找不到即 notFound）────────────────────
async function loadOwnedEvent(id, userId) {
  if (!isValidId(id)) invalidId("Invalid event id");
  const event = await StandpointEvent.findOne({ _id: id, user: userId });
  if (!event) notFound("Event not found");
  return event;
}

// ── 控制器 ────────────────────────────────────────────────────────

async function getAgent(req, res, next) {
  try {
    const agent = await loadOrCreateAgent(req.user._id);
    res.json({ ok: true, agent: serializeAgent(agent) });
  } catch (err) {
    next(err);
  }
}

async function updateConfig(req, res, next) {
  try {
    const agent = await loadOrCreateAgent(req.user._id);
    const b = req.body;
    const cfg = agent.config;

    if (b.stance !== undefined) cfg.stance = b.stance;
    if (b.personaText !== undefined) cfg.personaText = b.personaText;
    if (b.personalInfo !== undefined) cfg.personalInfo = b.personalInfo;
    if (b.autoSendEnabled !== undefined) cfg.autoSendEnabled = b.autoSendEnabled;
    if (b.replyToMalicious !== undefined) cfg.replyToMalicious = b.replyToMalicious;
    if (b.replyToQuestions !== undefined) cfg.replyToQuestions = b.replyToQuestions;

    await agent.save();
    res.json({ ok: true, agent: serializeAgent(agent) });
  } catch (err) {
    next(err);
  }
}

async function setStatus(req, res, next) {
  try {
    const agent = await loadOrCreateAgent(req.user._id);
    agent.status = req.body.status;
    if (req.body.status === "running") {
      agent.lastActiveAt = new Date();
    }
    await agent.save();
    res.json({ ok: true, agent: serializeAgent(agent) });
  } catch (err) {
    next(err);
  }
}

async function addAccount(req, res, next) {
  try {
    const agent = await loadOrCreateAgent(req.user._id);
    agent.accounts.push({
      id: genAccountId(),
      platform: req.body.platform,
      handle: req.body.handle,
      connected: true,
    });
    await agent.save();
    res.json({ ok: true, agent: serializeAgent(agent) });
  } catch (err) {
    next(err);
  }
}

async function removeAccount(req, res, next) {
  try {
    const { accountId } = req.params;
    const agent = await loadOrCreateAgent(req.user._id);
    const before = agent.accounts.length;
    agent.accounts = agent.accounts.filter((a) => a.id !== accountId);
    if (agent.accounts.length === before) notFound("Account not found");
    await agent.save();
    res.json({ ok: true, agent: serializeAgent(agent) });
  } catch (err) {
    next(err);
  }
}

async function listEvents(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10) || 20, 1), 50);
    const status = String(req.query.status || "").trim();

    const filter = { user: req.user._id };
    if (EVENT_STATUSES.includes(status)) filter.status = status;

    const total = await StandpointEvent.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const items = await StandpointEvent.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      ok: true,
      events: items.map(serializeEvent),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

async function simulateEvent(req, res, next) {
  try {
    const agent = await loadOrCreateAgent(req.user._id);
    const { kind, platform, fromHandle, incomingText } = req.body;

    const { classification, reply } = await classifyAndReply({
      incomingText,
      kind,
      config: agent.config,
    });

    // 登记事件：检测计数 +1
    agent.stats.detected += 1;

    const cfg = agent.config;
    const shouldAutoSend =
      agent.status === "running" &&
      cfg.autoSendEnabled &&
      ((classification === "malicious" && cfg.replyToMalicious) ||
        ((classification === "question" || classification === "request") && cfg.replyToQuestions));

    let status = "drafted";
    let autoSent = false;
    if (shouldAutoSend) {
      status = "sent";
      autoSent = true;
      agent.stats.sent += 1;
    } else {
      status = "drafted";
      agent.stats.drafted += 1;
    }

    const event = await StandpointEvent.create({
      agent: agent._id,
      user: req.user._id,
      kind,
      platform,
      fromHandle,
      incomingText,
      classification,
      reply,
      status,
      autoSent,
    });

    await agent.save();

    res.json({ ok: true, event: serializeEvent(event) });
  } catch (err) {
    next(err);
  }
}

// 真实到消息 → AI 即时草稿（人在环内，绝不自动发送）。
// 与 simulateEvent 的关键差别：无论 autoSendEnabled / status 如何，一律出草稿、
// autoSent=false、drafted++，绝不 sent，也绝不代替用户在平台上点发送。
async function ingestEvent(req, res, next) {
  try {
    const agent = await loadOrCreateAgent(req.user._id);
    const { kind, platform, fromHandle, incomingText, threadUrl } = req.body;

    const { classification, reply } = await classifyAndReply({
      incomingText,
      kind,
      config: agent.config,
    });

    // 检测计数 +1
    agent.stats.detected += 1;
    // 真实到消息永远只出草稿，绝不自动发送
    agent.stats.drafted += 1;

    const event = await StandpointEvent.create({
      agent: agent._id,
      user: req.user._id,
      kind,
      platform,
      fromHandle: fromHandle || "",
      incomingText,
      classification,
      reply,
      status: "drafted",
      autoSent: false,
      threadUrl: threadUrl || "",
    });

    await agent.save();

    res.json({ ok: true, event: serializeEvent(event) });
  } catch (err) {
    next(err);
  }
}

async function regenerateReply(req, res, next) {
  try {
    const event = await loadOwnedEvent(req.params.id, req.user._id);
    const agent = await loadOrCreateAgent(req.user._id);

    const { reply } = await classifyAndReply({
      incomingText: event.incomingText,
      kind: event.kind,
      config: agent.config,
    });

    event.reply = reply;
    await event.save();
    res.json({ ok: true, event: serializeEvent(event) });
  } catch (err) {
    next(err);
  }
}

async function sendReply(req, res, next) {
  try {
    const event = await loadOwnedEvent(req.params.id, req.user._id);

    // 仅本系统内标记为已回复（模拟），不真正向第三方平台发帖
    if (event.status !== "sent") {
      event.status = "sent";
      await event.save();

      const agent = await loadOrCreateAgent(req.user._id);
      agent.stats.sent += 1;
      await agent.save();
    }

    res.json({ ok: true, event: serializeEvent(event) });
  } catch (err) {
    next(err);
  }
}

async function dismissEvent(req, res, next) {
  try {
    const event = await loadOwnedEvent(req.params.id, req.user._id);
    event.status = "dismissed";
    await event.save();
    res.json({ ok: true, event: serializeEvent(event) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAgent,
  updateConfig,
  setStatus,
  addAccount,
  removeAccount,
  listEvents,
  simulateEvent,
  ingestEvent,
  regenerateReply,
  sendReply,
  dismissEvent,
};
