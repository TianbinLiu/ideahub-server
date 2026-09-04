/**
 * @file voices.js - 数字人可选的豆包音色目录（`GET /api/tts/voices` 的数据源）
 * @category Config
 *
 * 人格市场的「音频」板块、Live2D 模型市场的上传表单、App 客服页的声音面板，选的都是这一份。
 * 与 app 仓 `src/studio/voices.ts`（铸卡师的嗓子，离线可用所以自带一份）保持同一批 id ——
 * 那边多出的 5 条「混音」配方这里不收：混音只吃 1.0 音色，本账号 1.0 未开通（45000030），
 * 挂到市场上只会让别人选到一把哑的嗓子。
 *
 * 三条硬约束（与 app 仓同文）：
 *  ① 只收 2.0 音色（*_uranus_*），/api/tts 按 speaker 里有没有 uranus 决定 resource id；
 *  ② 绝不收「IP 仿音」（玲玲姐姐/春日部姐姐/女雷神…）——可识别性最高、授权性质官方从未说明；
 *  ③ 一律中文音色。
 * 目录之外的 id 也允许（表单有「自定义音色 ID」），/api/tts 只做字符集收口，念不念得出由上游决定。
 */

const VOICE_CATALOG = [
  // 角色扮演档（ICL_uranus_*_tob）：支持表现力增强版 + <cot> 语音标签，二次元人设音色的正经产地
  { id: "ICL_uranus_zh_female_qinglenggaoya_tob", name: "清冷高雅 2.0", why: "清冷、有距离感", expressive: true, rate: -10 },
  { id: "ICL_uranus_zh_female_chengshujiejie_tob", name: "成熟姐姐 2.0", why: "年龄感更足，压得住场", expressive: true, rate: -10 },
  { id: "ICL_uranus_zh_female_chengshuwenrou_tob", name: "成熟温柔 2.0", why: "成熟但不冷，留一点温度", expressive: true, rate: -10 },
  { id: "ICL_uranus_zh_female_lixingyuanzi_tob", name: "理性圆子 2.0", why: "讲道理的口吻", expressive: true, rate: -10 },
  { id: "ICL_uranus_zh_female_xiemeinvwang_tob", name: "邪魅女王 2.0", why: "更强的气场，偏危险感", expressive: true, rate: -10 },
  { id: "ICL_uranus_zh_female_wenrounvshen_tob", name: "温柔女神 2.0", why: "端庄柔和", expressive: true, rate: -10 },
  { id: "ICL_uranus_zh_female_bingjiaojiejie_tob", name: "病娇姐姐 2.0", why: "低语感强", expressive: true, rate: -10 },
  // 通用场景（*_uranus_bigtts）
  { id: "zh_female_gaolengyujie_uranus_bigtts", name: "高冷御姐 2.0", why: "清冷疏离（/api/tts 的默认音色）" },
  { id: "zh_female_zhixingnv_uranus_bigtts", name: "知性女声 2.0", why: "沉稳讲道理，长台词稳得住" },
  { id: "zh_female_cancan_uranus_bigtts", name: "知性灿灿 2.0", why: "最有人味的知性音" },
  { id: "zh_female_sophie_uranus_bigtts", name: "魅力苏菲 2.0", why: "成熟偏低的音域" },
  { id: "zh_female_wenroushunv_uranus_bigtts", name: "温柔淑女 2.0", why: "冷静但不硬" },
  { id: "zh_female_qingxinnvsheng_uranus_bigtts", name: "清新女声 2.0", why: "干净中性，最不抢戏" },
  { id: "zh_female_xiaohe_uranus_bigtts", name: "小何 2.0", why: "自然口语感，像真人在说话" },
  { id: "zh_female_gufengshaoyu_uranus_bigtts", name: "古风少御 2.0", why: "少女与御姐之间，二次元感最强" },
  { id: "zh_female_vv_uranus_bigtts", name: "Vivi 2.0", why: "2.0 旗舰嗓，自然度最高" },
  { id: "zh_female_gujie_uranus_bigtts", name: "顾姐 2.0", why: "更硬的姐系" },
  { id: "zh_female_meilinvyou_uranus_bigtts", name: "魅力女友 2.0", why: "低音域，气声偏多" },
  { id: "zh_female_tvbnv_uranus_bigtts", name: "TVB女声 2.0", why: "港剧配音腔" },
];

/** 目录里有没有这个 id（目录外的 id 也合法，只是前端不显示名字） */
function findVoice(id) {
  return VOICE_CATALOG.find((v) => v.id === id) || null;
}

module.exports = { VOICE_CATALOG, findVoice };
