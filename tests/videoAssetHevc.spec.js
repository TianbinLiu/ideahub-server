/**
 * 成片转存时 H.265 → H.264（2026-10-07，电影级「样片」定稿出来的 1080p 是 HEVC Main 10，App 的 WebView 解不出画面）。
 * 只验服务端这一层的三件事：认不认得出 H.265、认出来时带不带入站变换、转码那一发失败时按原样再存一次（不能把转存弄丢）。
 * Cloudinary 的 upload_stream 换成假的：不出网。
 */
const { cloudinary } = require("../src/config/cloudinary");
const videoAsset = require("../src/services/videoAsset.service");

/** 造一段带 stsd 的最小字节：stsd 类型之后 版本+标志 4、条目数 4、条目大小 4，再 4 字节是样本描述的 fourcc */
function mp4With(fourcc) {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 40]),
    Buffer.from("stsd", "latin1"),
    Buffer.alloc(8),
    Buffer.from([0, 0, 0, 24]),
    Buffer.from(fourcc, "latin1"),
    Buffer.alloc(32),
  ]);
}

/** 假的 upload_stream：按调用次数给结果（Error = 这一发失败） */
function fakeUploads(results) {
  const calls = [];
  jest.spyOn(cloudinary.uploader, "upload_stream").mockImplementation((opts, cb) => {
    const n = calls.length;
    calls.push(opts);
    return {
      end: () => {
        const r = results[n];
        setImmediate(() => (r instanceof Error ? cb(r) : cb(undefined, r)));
      },
    };
  });
  return calls;
}

afterEach(() => jest.restoreAllMocks());

describe("isHevcMp4", () => {
  test("hvc1 / hev1 认得出；avc1 不算；没有 stsd 不算", () => {
    expect(videoAsset.isHevcMp4(mp4With("hvc1"))).toBe(true);
    expect(videoAsset.isHevcMp4(mp4With("hev1"))).toBe(true);
    expect(videoAsset.isHevcMp4(mp4With("avc1"))).toBe(false);
    expect(videoAsset.isHevcMp4(Buffer.from("fake-video hvc1 hvc1"))).toBe(false);
    expect(videoAsset.isHevcMp4("not a buffer")).toBe(false);
  });

  test("前面有一个对不上的 stsd（mdat 里的随机字节）也接着往后找", () => {
    const noise = Buffer.concat([Buffer.from("xxstsdzz", "latin1"), Buffer.alloc(20)]);
    expect(videoAsset.isHevcMp4(Buffer.concat([noise, mp4With("hvc1")]))).toBe(true);
  });

  test("stsd 在最末尾、后面不够 16 字节：不越界、判否", () => {
    expect(videoAsset.isHevcMp4(Buffer.concat([Buffer.alloc(10), Buffer.from("stsd", "latin1"), Buffer.alloc(4)]))).toBe(false);
  });
});

describe("uploadVideoBuffer", () => {
  test("H.264 原样存：只上传一次，不带入站变换", async () => {
    const calls = fakeUploads([{ secure_url: "https://res.cloudinary.com/x/video/upload/v1/a.mp4" }]);
    const url = await videoAsset.uploadVideoBuffer(mp4With("avc1"), "u-1-seg", { timeoutMs: 1000 });
    expect(url).toBe("https://res.cloudinary.com/x/video/upload/v1/a.mp4");
    expect(calls).toHaveLength(1);
    expect(calls[0].raw_transformation).toBeUndefined();
    expect(calls[0].timeout).toBe(1000);
    expect(calls[0].public_id).toBe("u-1-seg");
  });

  test("H.265：带 vc_h264 的入站变换上传一次，存下来的就是转好的那份", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const calls = fakeUploads([{ secure_url: "https://res.cloudinary.com/x/video/upload/v1/b.mp4", video: { codec: "h264", pix_format: "yuv420p" } }]);
    const url = await videoAsset.uploadVideoBuffer(mp4With("hvc1"), "u-2-seg");
    expect(url).toBe("https://res.cloudinary.com/x/video/upload/v1/b.mp4");
    expect(calls).toHaveLength(1);
    expect(calls[0].raw_transformation).toBe(videoAsset.H264_TRANSCODE);
    expect(videoAsset.H264_TRANSCODE).toMatch(/^vc_h264/);
  });

  test("★ 转码那一发失败 → 按原样再存一次（同一个 public_id、不带变换），转存不丢", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const calls = fakeUploads([new Error("Invalid transformation"), { secure_url: "https://res.cloudinary.com/x/video/upload/v1/c.mp4" }]);
    const url = await videoAsset.uploadVideoBuffer(mp4With("hev1"), "u-3-seg");
    expect(url).toBe("https://res.cloudinary.com/x/video/upload/v1/c.mp4");
    expect(calls).toHaveLength(2);
    expect(calls[0].raw_transformation).toBe(videoAsset.H264_TRANSCODE);
    expect(calls[1].raw_transformation).toBeUndefined();
    expect(calls[1].public_id).toBe("u-3-seg");
    expect(warn).toHaveBeenCalled();
  });

  test("转出来不是 8 bit H.264：只吼不拦（存下来的照样是永久地址）", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const calls = fakeUploads([{ secure_url: "https://res.cloudinary.com/x/video/upload/v1/d.mp4", video: { codec: "hevc", pix_format: "yuv420p10le" } }]);
    const url = await videoAsset.uploadVideoBuffer(mp4With("hvc1"), "u-4-seg");
    expect(url).toBe("https://res.cloudinary.com/x/video/upload/v1/d.mp4");
    expect(calls).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("不是 8 bit H.264"))).toBe(true);
  });

  test("原样存那一发也失败 → 照旧抛给调用方（转存登记会落 failed）", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    fakeUploads([new Error("boom-1"), new Error("boom-2")]);
    await expect(videoAsset.uploadVideoBuffer(mp4With("hvc1"), "u-5-seg")).rejects.toThrow("boom-2");
  });
});
