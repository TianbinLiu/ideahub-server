const mongoose = require("mongoose");
const { CURRENT_DEFAULT_TEMPLATE_VERSION } = require("../config/workshopVersion");

const workshopLayoutItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    kind: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    x: { type: Number, min: 0, max: 100, required: true },
    y: { type: Number, min: 0, max: 100, required: true },
    w: { type: Number, min: 4, max: 100, required: true },
    h: { type: Number, min: 4, max: 100, required: true },
    z: { type: Number, min: 0, max: 99, default: 0 },
    visible: { type: Boolean, default: true },
    _id: false,
  },
  { _id: false }
);

const workshopLayoutSchema = new mongoose.Schema(
  {
    version: { type: Number, default: 1 },
    canvas: {
      width: { type: Number, default: 1200 },
      height: { type: Number, default: 760 },
      _id: false,
    },
    pages: {
      home: {
        items: { type: [workshopLayoutItemSchema], default: [] },
        _id: false,
      },
      _id: false,
    },
    _id: false,
  },
  { _id: false }
);

const workshopUpdateLogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    summary: { type: String, default: "", trim: true, maxlength: 300 },
    authorName: { type: String, default: "", trim: true, maxlength: 80 },
    source: { type: String, enum: ["manual", "ai", "system"], default: "manual" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const workshopThemeSchema = new mongoose.Schema(
  {
    backgroundType: {
      type: String,
      enum: ["none", "image", "video", "gradient"],
      default: "none",
    },
    backgroundUrl: { type: String, default: "" },
    accentColor: { type: String, default: "#22d3ee" },
    textColor: { type: String, default: "#f3f4f6" },
    cardRadius: { type: Number, min: 0, max: 48, default: 16 },
    cardOpacity: { type: Number, min: 0.25, max: 1, default: 0.92 },
    customCss: { type: String, default: "" },
    componentCss: {
      card: { type: String, default: "" },
      button: { type: String, default: "" },
      title: { type: String, default: "" },
      _id: false,
    },
    _id: false,
  },
  { _id: false }
);

const workshopTemplateSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    summary: { type: String, default: "", trim: true, maxlength: 300 },
    previewImageUrl: { type: String, default: "" },
    tags: { type: [String], default: [] },
    templateVersion: { type: String, required: true, default: CURRENT_DEFAULT_TEMPLATE_VERSION, index: true },
    shared: { type: Boolean, default: false, index: true },
    theme: { type: workshopThemeSchema, default: () => ({}) },
    layout: { type: workshopLayoutSchema, default: () => ({}) },
    siteDraft: { type: mongoose.Schema.Types.Mixed, default: () => ({ pages: {} }) },
    stats: {
      viewCount: { type: Number, default: 0 },
      likeCount: { type: Number, default: 0 },
      bookmarkCount: { type: Number, default: 0 },
      commentCount: { type: Number, default: 0 },
      _id: false,
    },
    appliedCount: { type: Number, default: 0 },
    updateLogs: { type: [workshopUpdateLogSchema], default: [] },
  },
  { timestamps: true }
);

workshopTemplateSchema.index({ shared: 1, createdAt: -1 });
workshopTemplateSchema.index({ shared: 1, "stats.likeCount": -1, "stats.viewCount": -1, createdAt: -1 });

module.exports = mongoose.model("WorkshopTemplate", workshopTemplateSchema);
