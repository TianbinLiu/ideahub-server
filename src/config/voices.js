/**
 * @file voices.js - 数字人可选的豆包音色目录（`GET /api/tts/voices` 的数据源）
 * @category Config
 *
 * 人格市场的「音频」板块、Live2D 模型市场的上传表单、App 客服页的声音面板，选的都是这一份。
 * 与 app 仓 `src/studio/voices.ts`（铸卡师的嗓子，离线可用所以自带一份）保持同一批 id。
 *
 * 目录分两代，用途不同：
 *  · VOICE_CATALOG（2.0，*_uranus_*）—— 单音色直接念，支持 context_texts 语调指令与表现力增强；**混不了**（55000000）。
 *  · MIXABLE_VOICES（1.0，*_moon_bigtts / *_mars_bigtts）—— 声音市场（/api/voice-templates）的原料：
 *    豆包混音（speaker=custom_mix_bigtts）只吃 1.0 音色，≤3 个、mix_factor 之和 = 1。
 *    2026-09-04 实测本账号 1.0 已开通：混音与 1.0 单音色都能出声。下面 23 个是逐个真调过 /api/tts
 *    能出声的，**其它 1.0 id 一律不要往里加**——目录里出现一个哑的，用户配好的配方就整条哑掉，且很难查。
 *
 * 三条硬约束（与 app 仓同文）：
 *  ① /api/tts 按 speaker 里有没有 uranus 决定 resource id（2.0 → seed-tts-2.0，其余 → seed-tts-1.0）；
 *  ② 绝不收「IP 仿音」（玲玲姐姐/春日部姐姐/女雷神…）——可识别性最高、授权性质官方从未说明；
 *  ③ 一律中文音色。
 * 单音色允许目录之外的 id（表单有「自定义音色 ID」），/api/tts 只做字符集收口，念不念得出由上游决定；
 * 混音的每一味**必须**在 MIXABLE_VOICES 里（utils/voiceSettings.js 的 zod 校验兜底）。
 */

/** 2.0 目录：每条加 generation / mixable 是给前端分组用的，别在别处再猜 id 前缀 */
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
].map((v) => ({ ...v, generation: "2.0", mixable: false }));

/**
 * 1.0 可混音目录（声音市场的原料）。★ 只收 2026-09-04 逐个真调过能出声的 23 个，别扩。
 * gender 给前端分「女 / 男」两栏用；1.0 没有 context_texts，所以这里也没有 why / expressive 那些 2.0 专属字段。
 */
const MIXABLE_VOICES = [
  // 女
  { id: "zh_female_gaolengyujie_moon_bigtts", name: "高冷御姐", gender: "female" },
  { id: "zh_female_meilinvyou_moon_bigtts", name: "魅力女友", gender: "female" },
  { id: "zh_female_zhixingnvsheng_mars_bigtts", name: "知性女声", gender: "female" },
  { id: "zh_female_gufengshaoyu_mars_bigtts", name: "古风少御", gender: "female" },
  { id: "zh_female_wenroushunv_mars_bigtts", name: "温柔淑女", gender: "female" },
  { id: "zh_female_sajiaonvyou_moon_bigtts", name: "柔美女友", gender: "female" },
  { id: "zh_female_qiaopinvsheng_mars_bigtts", name: "俏皮女声", gender: "female" },
  { id: "zh_female_wenrouxiaoya_moon_bigtts", name: "温柔小雅", gender: "female" },
  { id: "zh_female_shuangkuaisisi_moon_bigtts", name: "爽快思思", gender: "female" },
  { id: "zh_female_linjianvhai_moon_bigtts", name: "邻家女孩", gender: "female" },
  { id: "zh_female_kailangjiejie_moon_bigtts", name: "开朗姐姐", gender: "female" },
  { id: "zh_female_tianmeitaozi_mars_bigtts", name: "甜美桃子", gender: "female" },
  { id: "zh_female_cancan_mars_bigtts", name: "知性灿灿", gender: "female" },
  { id: "zh_female_wanwanxiaohe_moon_bigtts", name: "湾湾小何", gender: "female" },
  { id: "zh_female_tianmeixiaoyuan_moon_bigtts", name: "甜美小源", gender: "female" },
  { id: "zh_female_qingxinnvsheng_mars_bigtts", name: "清新女声", gender: "female" },
  // 男
  { id: "zh_male_shaonianzixin_moon_bigtts", name: "少年梓辛", gender: "male" },
  { id: "zh_male_wennuanahu_moon_bigtts", name: "温暖阿虎", gender: "male" },
  { id: "zh_male_yangguangqingnian_moon_bigtts", name: "阳光青年", gender: "male" },
  { id: "zh_male_jingqiangkanye_moon_bigtts", name: "京腔侃爷", gender: "male" },
  { id: "zh_male_beijingxiaoye_moon_bigtts", name: "北京小爷", gender: "male" },
  { id: "zh_male_yuanboxiaoshu_moon_bigtts", name: "渊博小叔", gender: "male" },
  { id: "zh_male_qingshuangnanda_mars_bigtts", name: "清爽男大", gender: "male" },
].map((v) => ({ ...v, generation: "1.0", mixable: true }));

const MIXABLE_IDS = new Set(MIXABLE_VOICES.map((v) => v.id));

/** 一次混音最多几味：豆包官方上限就是 3，前端选择器与 zod 校验都从这里取 */
const MAX_MIX_VOICES = 3;

/** 目录里有没有这个 id（目录外的 id 也合法，只是前端不显示名字） */
function findVoice(id) {
  return VOICE_CATALOG.find((v) => v.id === id) || null;
}

/** 这个 id 能不能进混音配方（= 在 23 个已验证的 1.0 音色里） */
function isMixableVoice(id) {
  return MIXABLE_IDS.has(String(id || ""));
}

module.exports = { VOICE_CATALOG, MIXABLE_VOICES, MAX_MIX_VOICES, findVoice, isMixableVoice };
