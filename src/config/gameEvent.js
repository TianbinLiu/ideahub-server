// src/config/gameEvent.js
// 「工坊对局」的**回合间事件**（第 2/4/6 回合结算之后的那个三选一，2026-11-23，G5 联机第三块）。
//
// 设计正本在 app 仓：`docs/workshop-game-design.md` §2.3b / §5-7、`src/studio/game/rules.ts`
// 的 `GAME_EVENTS` / `EVENT_AFTER_ROUNDS` / `drawEventAfterRound`，文案在 `src/studio/game/labels.ts`
// 的 `eventName` / `eventOptionName`。
//
// ══ ★★ 为什么服务端也要有一份事件表 ══════════════════════════════════════════════════════
//   从现在起「这一回合出哪个事件」由服务端定（同一个房间、同一回合，四个人看到的是同一个事件）。
//   服务端不跑 App 的规则引擎，但它至少要能回答三件事：出哪个事件、有哪几个选项、哪个选项回血。
//   所以这张表是**跨仓的同一份数据**（与 App `rules.GAME_EVENTS` 同口径）：
//     · id / cost / effects 必须逐字一致（改一边就要改另一边，否则「App 上扣 3 金、服务端按 5 金回血」）；
//     · `label` 是 App `labels.eventOptionName` 的中文卡名，服务端直接下发，**不让 App 的 v1 契约
//       再多一个「按 id 查文案」的兼容层**（老 App 读不到这份数据就自己映射，id 不变就能对上）。
//   ★ 与 config/gameRound 同一条纪律：产品规则是**代码常量**，不进环境变量（改数要过代码评审）。
//
// ══ ★★ effects 为什么拆成 server / client 两半 ═══════════════════════════════════════════
//   联机版的事件不再只在本机改数：**只有「回血」必须落库**（血量是服务端判淘汰 / 胜者的唯一依据），
//   其余效果（金币、模型档位、道具上限、免费刷新、随机卡）改的都是 App 本机的状态，服务端根本没有
//   那些字段（房间文档里没有 gold / modelLevel / buffs）。硬把它们也搬上服务端等于把整份单机规则
//   复制一遍，而那份规则每改一次就要在服务端再跟一次 —— 所以契约是**分工**：
//     · `effects.server`：服务端**会**执行的键。今天只有一个 `hp`（delta；例如补给站「回 15 血」）。
//       App **不要**再应用一次，否则一次回血会变成两次（这正是本模块要防的那类「跨端不一致」）。
//     · `effects.client`：交给 App 本地落的效果，数组、与 App `rules.EventEffect` **同形**，
//       App 原样按 `applyEventEffects` 应用即可（顺序也照数组顺序）。
//   ★ `cost` 不在 effects 里：它是金币花费，**由 App 本地扣**（服务端没有金币账户）。
//   ★ 事件里今天只有**回血**（App 的 applyEventEffects 也只允许正 delta 而不走淘汰判定）；
//     真加扣血效果时必须同时想清楚「会不会把人打到 0」，那属于结算，不属于事件。
//
// ══ ★★ 确定性抽选：为什么按房号洗一次牌，而不是「按 (房号+回合) 各抽一次」 ══════════════
//   App 单机版的规则是「一局 3 次事件、从池子里**不重样**地抽」（`drawEventAfterRound`）。联机版把
//   抽选搬到服务端之后，判据必须还是「同一个房间、同一回合，所有人看到同一个事件」：
//     · 用 (房号, 回合) 现算一个种子、每次独立取一个 → **可能抽到同一个事件三次**（一局里重样，
//       与 App 单机口径不同）；也拿不到「已经抽过哪几个」的共享状态（服务端不存 drawnEventIds）。
//     · 所以：按**房号**把 3 个事件确定性洗一次牌（sha256 排序，不用随机数），第 n 个事件回合
//       取牌堆第 n 张。于是 ①同一房间同一回合天然一致（纯函数）；②一局三次事件**一定不重样**；
//       ③不需要任何落库状态（不用在房间上存一个「已经抽过什么」的数组 —— 那又会多一处真相）。
//   ★ 洗牌只看房号、不看回合：回合号只用来决定**取第几张**（EVENT_AFTER_ROUNDS 的下标）。
//     这仍然满足「由 (roomCode, round) 确定性抽选」，而且是更严的那种（一局内是排列）。
const { createHash } = require("crypto");

/**
 * 哪几个回合结算之后出事件（与 App `EVENT_AFTER_ROUNDS` 一致：2 / 4 / 6）。
 * ★ 只在这三个回合可读（见 services/gameRound.service 的 getRoundEvent / chooseRoundEvent）：
 *   第 1 / 3 / 5… 回合结算后没有事件，App 直接进下一回合。
 */
const EVENT_AFTER_ROUNDS = Object.freeze([2, 4, 6]);

/**
 * App 的「跳过」表态（`rules.EVENT_SKIP_PICK === "skip"`）。
 * ★ 为什么服务端也认它：三选一里那个免费项在某些局面下也落不了账（背包满 / 类型到上限 /
 *   钱不够），App 的规则给了一个「跳过」的合法出口，全员表态必须能凑齐。服务端只记录这个表态，
 *   **不执行任何效果**（与「选了免费项但什么都不改」等价）。不与任何真实选项 id 撞车。
 */
const SKIP_PICK = "skip";

/** 一条事件选项的效果拆分（★ 见文件头：server 只有 hp，client 原样交给 App） */
function effects(server, client) {
  return Object.freeze({ server: Object.freeze(server), client: Object.freeze(client) });
}

/**
 * 事件池。**与 App `src/studio/game/rules.ts` 的 `GAME_EVENTS` 同口径**：
 *   id / cost / effects 逐字一致；title / label 抄 App 的中文文案（labels.eventName / eventOptionName）。
 * ★ 顺序不重要（真实下发顺序由房号洗牌决定，见 eventFor），但**要有顺序**：洗牌需要一份确定的输入。
 * ★ 选项 id 在事件内唯一（App 的存档 / 回执认它）；服务端的回合 eventPicks 也只存这个 id。
 */
const EVENTS = Object.freeze([
  {
    id: "model-arms-race",
    title: "模型军备",
    options: Object.freeze([
      Object.freeze({ id: "upgrade-draft", cost: 8, label: "画质升级", effects: effects({}, [{ kind: "model-level", to: 2 }]) }),
      Object.freeze({ id: "upgrade-cinema", cost: 15, label: "画质升级 · 顶配", effects: effects({}, [{ kind: "model-level", to: 3 }]) }),
      Object.freeze({ id: "half-next", cost: 5, label: "批量采购", effects: effects({}, [{ kind: "next-round-cost-half" }]) }),
      Object.freeze({ id: "free-gold", cost: 0, label: "金币大使", effects: effects({}, [{ kind: "gold", delta: 4 }]) }),
    ]),
  },
  {
    id: "inspiration-burst",
    title: "灵感爆发",
    options: Object.freeze([
      Object.freeze({ id: "double-shoot", cost: 6, label: "双机位", effects: effects({}, [{ kind: "next-round-segments", value: 2 }]) }),
      Object.freeze({ id: "long-prompt", cost: 3, label: "灵感喷涌", effects: effects({}, [{ kind: "prompt-limit-pct", pct: 50 }]) }),
      Object.freeze({ id: "free-blue-card", cost: 0, label: "天降蓝卡", effects: effects({}, [{ kind: "random-card", quality: 3 }]) }),
    ]),
  },
  {
    id: "supply-drop",
    title: "补给站",
    options: Object.freeze([
      Object.freeze({ id: "bag-expand", cost: 5, label: "道具扩容", effects: effects({}, [{ kind: "item-limit", delta: 1 }]) }),
      // ★ 唯一一个由服务端执行的效果：血量是服务端判淘汰 / 胜者的唯一依据
      Object.freeze({ id: "heal", cost: 3, label: "医疗补给", effects: effects({ hp: 15 }, []) }),
      Object.freeze({ id: "free-refresh", cost: 0, label: "刷新补贴", effects: effects({}, [{ kind: "free-refresh", count: 2 }]) }),
    ]),
  },
]);

/**
 * 按房号把事件池洗成一副牌（确定性、纯函数）。
 * ★ 排序键 = `sha256("game-event:<CODE>:<eventId>")`：没有随机数、没有进程内状态，
 *   两个 cluster 实例对同一间房算出来的顺序**逐位相同**（用 Math.random 或进程时钟就会漂）。
 * ★ 房号统一大写：进房接口对大小写不敏感，抽事件必须同一口径（否则 AB3K7Q / ab3k7q 出两个事件）。
 */
function eventOrderFor(roomCode) {
  const code = String(roomCode ?? "").trim().toUpperCase();
  return EVENTS.map((event) => ({
    event,
    key: createHash("sha256").update(`game-event:${code}:${event.id}`).digest("hex"),
  }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((row) => row.event);
}

/**
 * 这一回合出哪个事件（**唯一判据**：服务端 GET /choice 与 App 的「同房间同回合同一个事件」都问它）。
 * @param {string} roomCode 6 位房号（大小写不敏感）
 * @param {number} round 回合号，1 起
 * @returns {object|null} `null` = 这一回合不是事件回合（第 1/3/5… 回合）
 */
function eventFor(roomCode, round) {
  const index = EVENT_AFTER_ROUNDS.indexOf(Number(round));
  if (index < 0) return null;
  const order = eventOrderFor(roomCode);
  if (!order.length) return null;
  return order[index % order.length];
}

/** 这个事件里的一个选项（认 id；`skip` 不是选项，由调用方单独处理） */
function optionOf(event, optionId) {
  const id = String(optionId ?? "").trim();
  if (!id) return null;
  return (event?.options || []).find((option) => option.id === id) || null;
}

/**
 * 总开关。缺省**开**；`GAME_EVENTS_API=off` 急停（不用发版）。
 * ★ 与 `GAME_ROUNDS` 分开：回合引擎还开着时，也能单独把「事件读取 / 选择」关掉
 *   （事件出问题不该顺手把整局关上）。`GAME_ROUNDS=off` 时回合端点的闸会先回 `GAME_ROUNDS_OFF`。
 * ★ 每次现读环境变量（不在模块加载时定死）：测试要在同一个进程里开关它。
 */
function enabled() {
  return String(process.env.GAME_EVENTS_API ?? "").trim().toLowerCase() !== "off";
}

module.exports = {
  EVENT_AFTER_ROUNDS,
  SKIP_PICK,
  EVENTS,
  enabled,
  eventFor,
  optionOf,
};
