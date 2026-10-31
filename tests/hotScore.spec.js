// 热度与「热门」轮换的纯函数（utils/hotScore）
const { hotScore, roundHeat, trendScore, TREND_HALF_LIFE_DAYS } = require("../src/utils/hotScore");

describe("utils/hotScore", () => {
  it("heat 公式一字不差：赞 6、评论 4、收藏 3、浏览 0.04 且封顶 5000", () => {
    expect(hotScore({ likeCount: 1 })).toBe(6);
    expect(hotScore({ likeCount: 1, bookmarkCount: 1, viewCount: 1 })).toBeCloseTo(9.04, 5);
    expect(hotScore({ viewCount: 99999 })).toBe(200);
    expect(roundHeat(6.640000000000001)).toBe(6.64);
  });

  it("trend：刚上架不衰减，一周一半，两周四分之一；没有时间 = 不衰减；未来时间当作刚上架", () => {
    const now = Date.parse("2026-10-31T00:00:00Z");
    const day = 86400e3;
    expect(TREND_HALF_LIFE_DAYS).toBe(7);
    expect(trendScore(100, now, now)).toBe(100);
    expect(trendScore(100, now - 7 * day, now)).toBeCloseTo(50, 9);
    expect(trendScore(100, now - 14 * day, now)).toBeCloseTo(25, 9);
    expect(trendScore(100, null, now)).toBe(100);
    expect(trendScore(100, "not a date", now)).toBe(100);
    expect(trendScore(100, now + 3 * day, now)).toBe(100);
    expect(trendScore(undefined, now - day, now)).toBe(0);
  });

  it("trend 只改排序：两条 heat 相同，新上架的那条 trend 更高", () => {
    const now = Date.parse("2026-10-31T00:00:00Z");
    const fresh = trendScore(60, now - 86400e3, now);
    const old = trendScore(60, now - 30 * 86400e3, now);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeLessThan(6);
  });
});
