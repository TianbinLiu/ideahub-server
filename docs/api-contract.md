# 分支视频 · 服务端 API 契约（v1）

接入 `ideahub-server`（Express 5 + MongoDB + JWT）。所有响应遵循既有约定：
成功 `{ ok: true, ... }`，失败 `{ ok: false, message }`；鉴权用 `requireAuth` / `optionalAuth`。
挂载点：`app.use("/api/branch", require("./routes/branchVideo.routes"))`。

## 资源模型

### BranchVideo
```
{
  _id, title, category, description, cover,      // cover=图片 URL（Cloudinary）
  clientId,                                       // 客户端幂等键（可选），{author, clientId} 唯一（partial index）
  segments: [{ title, plot, firstFrame, lastFrame, durationSec, videoUrl?, videoTier?, aspect? }],
  // aspect: "portrait" | "landscape"，该段出片时的画幅。**缺省一律按 landscape 读**
  // （画幅可选之前的老数据全是写死的 16:9）。它只是播放端的排版提示——真正的判据是
  // 视频解码出来的宽高，所以服务端**丢掉这个字段不会让画面出错**，只会让首帧解码前
  // 那一瞬按横屏排版、解码后跳一下。videoTier 同理，只是创作侧的档位快照。
  branchTree?: { rootId, startChoices?, nodes },
  takedown?: { by: ObjectId(User), at: Date, reason: String },   // 见下「平台下架」
  author: ObjectId(User), plays, likes, commentCount,
  revision,        // 回炉次数。**恒发**（缺失归一成 0）。同时是回炉的乐观并发支点，见下「回炉重做」
  revisedAt?,      // 最近一次回炉的时间。**只在有值时发**（老作品不该凭空长出一个日期）
  assetUrls?,      // 这条作品占用的全部云端地址（in-use 反查用）。客户端不读它，读侧判否定
  createdAt, updatedAt
}
```
索引：`{ author: 1, createdAt: -1 }`、`{ category: 1, createdAt: -1 }`、`{ createdAt: -1 }`、`{ assetUrls: 1 }`

### BranchProject（工坊工程 / 画布快照）
```
{ owner, video, videoRevision, stale, title, bytes, canvas, lostCount, createdAt, updatedAt }
```
按 `video` 唯一的**独立集合**（不挂在 BranchVideo 上：那三条读路径都是无投影 `lean()`，
挂上去每页要多搬 12~50 份画布，而补 `.select()` 就是同一条规则写三处）。
**不加 TTL**（工程是用户资产，不是任务行）。`canvas` 形状由客户端定义，服务端只当 Mixed 存，
但强制两条不变量：**不许出现** `data:<mime>/` / `idb:` / `*.volces.com` / `*.volccdn.com`，
且单份 ≤ 2MB。端点见下「端点」表的 `/api/branch/projects*` 四行，语义见「回炉重做」。

#### 平台下架（`takedown`）

**有这个子文档 = 已被平台下架。** 没下架时服务端**根本不发这个键**（不是 `null`、不是 `false`）。

| 谁 | 读不读得到这条作品 | 回包里有没有 `takedown` |
|---|---|---|
| 陌生人 / 未登录 | ❌ 列表、搜索、他人主页、按 id 直取全部没有 | — |
| **作者本人** | ✅ 照常读得到 | ✅ 带 `{at, reason}`，**不带 `by`** |
| 管理员 | ✅ 按 id 直取读得到（列表里与常人一样） | ✅ 带 `{at, reason}` |

三条不许踩：

1. **不能拿 `visibility=private` 当下架。** 那是作者自己的开关，作者照样看得见，
   而且 `PATCH /videos/:id` 只校验"是不是作者" —— 他能一键改回 public。
   两个开关**互不顶替**：下架的作品把 visibility 改成 public 也还是下架。
2. **作者必须看得见它，并且看得见原因。** 直接从作者眼前抹掉比下架更糟：
   他只会以为系统吞了自己的作品，然后**原样再发一遍**。
3. **`by`（谁下的架）只留在库里，不出回包。** 把审核员透给被处理的用户
   等于把他摆到被骚扰的位置。

作者**改不掉**它：`PATCH /videos/:id` 的 zod（`updateBody`）没有声明 `takedown`，
z.object 默认 strip，塞进去会被丢掉。★ 这条靠的是 strip 语义，所以
**谁给那个 schema 加 `.loose()` 就会静默打开这个后门** —— 服务端有用例从外面钉住它。
⚠ 2026-09-07 起 `updateBody` 有 **10 个键**（多了回炉那四个），这条纪律**不随键数放松**：
**仍然绝不许 `.loose()`**，也不许把 `takedown` 声明进去、更不许在 controller 里
补一句 `delete patch.takedown`（同一条规则写两处，以后只会有人改一处）。
另外：**已下架的作品不许回炉**（400 `REVISE_TAKEN_DOWN`），下架期间作者改不动内容。

客户端判据一律是"这个键在不在"，不是 `takedown.xxx === 某值`：
`takedown: null` 这类坏数据的失败方向必须是"作品照常显示"，
而不是"作品被判成已下架"（老服务端没有这个键，缺省一律当没下架 —— 铁律七）。

### BranchCard（用户卡片）
```
{ _id, owner: ObjectId(User), cardId, type, name, summary, cover, hot?, tags?,
  modelUrl?, genPrompt?,                       // 3D 建模指针 / 生成蓝图
  realPerson?,                                 // 真人声明（布尔），见下
  views?: [{ url, kind, note? }],              // 形象参考图（0~3 张），见下
  portrait?: { assetId, scope, note, boundAt }, // 肖像授权绑定（只有卡主读得到），见下
  published?, publishedAt?, description?,      // 分享到创意工坊
  createdAt }
// imageTier?  —— 客户端 Card 上有，服务端**目前不存**，见下面单独一节
```
`cardId` 是客户端生成的稳定 id（市场卡为 `mkt_*`），`{ owner, cardId }` 唯一索引。

#### `realPerson` —— 真人声明（2026-08-23 加）

用户在圈选提取时**自己勾的**「画面里是真实人物」（机器判不准，只能让当事人表态；
勾它必须同时勾肖像同意协议，责任由用户承担——产品决定，开放任意真人照片）。
真人素材受供应商内容审核与深度合成法规约束，出片档位按它分流。

- **缺省 = 老卡/老客户端 = 非真人**，两边读侧一律判否定（`!== true` 当非真人）。
  拿它和 `false` 等值判"明确声明过不是"会把存量卡整批误判（同 `visibility` 那条规则）。
- **随分享/安装/卡组快照/作品卡组快照一路携带，不剥**：它是内容属性不是隐私字段，
  掉在任何一跳，真人卡经那条路洗一遍就变回"非真人"，档位分流静默失效。
  落库要过的几处与 `views` 完全同一批（见下面「五处一起加」，含第六、第七处的
  `BranchVideo.deckCardSchema` 与 `branchVideo.controller` 字段白名单）。
- `PATCH /cards/:cardId` 的 schema 声明了它但当前客户端**不发**（那条 PATCH 是 views
  专用；声明只为将来加"改声明"入口时不再经历一次"发了、被 strip、零报错"）。

#### `views` —— 卡片的形象参考图

`{ url: string, kind: "face" | "body" | "detail", note?: string }`，**最多 3 张**。
它是"多图参考"的载体：客户端推演三套方案时把这些图当 Seedream 的参考图，
人物形象因此被烤进首尾帧，出片仍旧只按首尾帧走（Seedance 请求形状一个字没变 ——
方舟规定「图生视频-首帧 / 首尾帧 / 全模态参考生视频是 3 种**互斥**场景，不可混用」）。

- **`url` 只收 http(s)，不收 dataURL。** 一张卡 3 张 dataURL 会把随作品发布的卡组快照
  （`deck.cards`）撑爆 —— `modelUrl` 当年正是为这件事改成 `idb:` 指针的。客户端在
  `data/cardViews.ts` 里先走 `/api/uploads/image` 转存拿永久 URL 再发上来。
- **上限 3 不是拍脑袋**：方舟提示词指南「不建议用满素材上限，过多素材会导致模型难以
  判断特征优先级」。人物卡的推荐组合是 `face`（大头照）+ `body`（全身照）两张。
  ⚠ 同一个人的**多角度视图是反效果**（指南原文：模型易将其识别为多个不同主体，
  加剧 ID 漂移），所以客户端 UI 不给"多角度"这种引导 —— 服务端也不要在文档/示例里写。
- **缺省与空数组是同一个意思**：老卡这一项是 `undefined`，新服务端对老卡回的是 `[]`，
  两者在客户端 `types.viewsOf()` 里都归一成 `[{ kind: "body", url: cover }]`（卡面即全身参考）。
  判据是**数组里有没有内容**，不是"这个键在不在"。
  ★ 系统里**没有**"这张卡明确地不要任何参考图"这个状态，这是有意的：删掉附加参考图
  ≠ 让这张卡失去自己的长相，卡面本来就是它的形象。想加这个状态就得先改 `viewsOf`，
  而那会让新服务端返回的**每一张老卡**（回的都是 `[]`）一夜之间失去卡面兜底 ——
  改之前先想清楚这一点。
- **归一只在客户端做一次**：服务端**不要**替老卡补 `cover`。补了就是第二处实现，
  两边一旦分叉，"详情页看到的参考图"和"喂给 Seedream 的参考图"会不是同一批，且看不出来。
- **五处一起加，漏一处就是"发得出、存不下、读回来是空的，零报错"**（`deck` 当年就这么丢的）：
  `schemas/branchAsset.schemas.js` 的 `cardItem`（`z.object` 默认 strip 未声明字段）、
  `models/BranchCard.js`、`models/BranchDeck.js` 的 `snapshotCardSchema`、
  controller 的 `toCardPayload`，以及 app 的 `api/branch.ts` `ApiCard`。
  ⚠ 还有**第六、第七处**：作品自带的卡组快照是另一套 schema —— `models/BranchVideo.js`
  的 `deckCardSchema` 与 `branchVideo.controller` 里那份字段白名单（见下面「随作品发布的
  卡组」）。第一版就是只改了 `BranchDeck` 那份，作品里的卡组照样把 `views` 丢了。

#### `views[].kind` —— 枚举没变，但**同一个值在不同卡种下读作不同的图位**

枚举**冻结**在 `face | body | detail` 三个值（`schemas/branchAsset.schemas.js` 的
`CARD_VIEW_KINDS` + `models/cardView.schema.js` 的 mongoose enum 各钉一道）。
2026-08 铸卡分档时**没有**扩这个枚举，改的只是"这三个值分别读作什么"。

| `card.type` | 第 1 格（= 卡面） | 第 2 格 | 第 3 格 |
|---|---|---|---|
| `character` 人物 | `body` 全身立绘 | `face` 面部特写 | `detail` 标志性细节 |
| `scene` 场景 | `body` 全景主视图 | `detail` 局部特征 | — |
| `background` 背景 | `body` 色光基调 | `detail` 质感特写 | — |
| `prop` 道具 | `body` 净底主视图 | `detail` 局部细节 | — |
| `style` 画风 | `body` 画风样张 | `detail` 笔触特写 | — |

- **不许往枚举里加值。** 老服务端的 `z.enum` 会把带新 kind 的请求整批 400，而全 app
  **没有任何地方监听 `emitApiError`** —— 表现就是"炼完的卡一张都没同步上去，且一句提示
  都没有"（铁律八）。要表达新图位，加的是**读法**（哪个 type 下第几格叫什么），不是新值。
- **顺序是重要性降序，`[0]` 必须是能当卡面的那张** —— 所以人物卡是 `body` 打头而不是
  `face`：一张大头照当卡面既看不出服装配色，也没法直接喂给出片管线当形象参考。
- **非人物卡只有 2 格是有意的，不是漏写。** 出片管线对场景/背景/道具/画风卡只读
  `viewsOf()[0]` 一张（`app/src/ai/real.ts` 的 `prepareMaterialRefs` 规则二），
  第 3 张画了也喂不进模型 —— 那是"收了钱、画面一个像素不变、零报错"。
  顶档（3 张）对这四类就是真的少画一张、也真的少收一次钱，报价与结算都读同一次
  `economy.slotsFor()` 的结果（全仓唯一实现）。
- **归一只在客户端做一次，服务端一律不归一。** 客户端的唯一出处是 `app/src/types.ts`：
  `CARD_SLOTS`（表）/ `primarySlotOf` / `normalizeSlot`（脏值 → 合法 kind）/ `slotLabel`
  （kind + type → 中文图位名）/ `viewsOf`（老卡用 `cover` 兜底成一张 `body`）。
  服务端**只存 kind 的原值**：不按 `type` 校验、不改写、不补默认。
  ★ 理由与 `views` 的 cover 兜底同一条：卡的 `type` 是可以改的（同一个 `body` 换个 type
  就该读成另一个图位名），服务端跟着改写就是同一条规则的第二处实现；两边一旦分叉，
  "详情页看到的图位"和"喂给 Seedream 的那张"会不是同一张，而这种偏差在结果里看不出来。
  于是这里出现"服务端存着 `face`、而这张卡是场景卡"这种组合是**合法**的（改过 type 的
  老卡），客户端按 `normalizeSlot` 读，不报错也不改库。

#### `card.imageTier` —— 铸卡用的出图档位（**目前是纯客户端字段**）

值是 `app/src/data/economy.ts` `IMAGE_TIERS` 的 id：`"sketch" | "studio" | "master"`
（速写 / 定妆 / 精绘，分别对应 Seedream 4.0 / 4.5 / 5.0-pro，见下面「出图档位与计价」）。
它记的是"这张卡当初是用哪一档炼的"。

⚠ **截至 2026-08-11，服务端不存这个字段。** `schemas/branchAsset.schemas.js` 的 `cardItem`
里没有声明它，而 `z.object` 是 **strip** 语义 —— 客户端发上来会被**悄悄丢掉**：请求 201、
日志干净、读回来是空的，全程零报错（`deck` / `modelUrl` / `views` 都是这么丢的）。
所以在补齐下面那七处之前：

- **客户端不要发 `imageTier`**（发了等于假装存住了，比不发更糟）；
- **不要指望它跨设备存活**：`loadRemoteAssets()` 每次登录都用服务端那份**整体覆盖**
  本地卡库，本地存了也会被覆盖掉；
- **读侧必须容忍缺失**：`economy.imageTierOf(undefined)` 退回 `DEFAULT_IMAGE_TIER`
  （`"sketch"`），这是刻意的**降级不崩**。代价是卡片上的档位徽标、以及"照这一档补齐
  图位"的默认值会退成低档 —— 这是已知的、可接受的偏差，不是 bug。

要让它真正入库，**七处一起改**（漏一处就是"发得出、存不下、零报错"）：
`schemas/branchAsset.schemas.js` 的 `cardItem`、`models/BranchCard.js`、
`models/BranchDeck.js` 的 `snapshotCardSchema`、`models/BranchVideo.js` 的 `deckCardSchema`、
`branchAsset.controller` 的 `toCardPayload`、`branchVideo.controller` 的卡组字段白名单、
以及 app 的 `api/branch.ts`（`ApiCard` **和** `addCards` 的 payload —— 那里是逐字段手写的，
只加 interface 不加 payload 等于没加）。

#### `PATCH /api/branch/cards/:cardId`

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| PATCH | `/api/branch/cards/:cardId` | required | 改自己的一张卡：body 至少一个字段 `{ views?, name?, summary?, tags?, realPerson?, portrait? }`（**定向 $set，不带的字段一律不动**；空对象 400；未声明的字段 strip）。`portrait: { assetId, note? }` = 绑上肖像授权、`portrait: null` = 解绑（`$unset`）；`assetId` 认不出 → 400。返回 `{ ok, card }`；卡不在（别人的 / 只存在于本地）→ 404 |

★ **为什么不能复用 `POST /cards`**：那条是**新增**语义，controller 用的是
`$setOnInsert`（"已存在的字段一个不动"）。拿它去改卡会 201 得漂漂亮亮、库里一个字节
都没变；而客户端 `loadRemoteAssets()` 每次登录都用服务端那份**整体覆盖**本地卡库 ——
于是用户加的参考图在下一次冷启动时**无声消失**。这是丢数据，不是"暂未同步"。
用例钉在 server 的 `branchAssetPublish.spec.js` A12c（先证明 POST 改不动，再证明 PATCH 改得动）。

★ `views` 必填而不是可选：可选的话，一个拼错字段名的调用会拿到 200 +「改好了」，
而库里什么都没发生。客户端必须 await 并把失败显示出来（`data/cardViews.ts` 不吞错）——
全 app 没有任何地方监听 `emitApiError`，fire-and-forget 在这里等于静默丢数据。

#### `portrait` —— 肖像授权绑定（2026-09-05 加）

真人卡做完方舟肖像授权后拿到的可信素材 id（`asset-20260905120000-ab12c`，出片时拼成
`asset://<id>` 当参考图发，绕开人脸审核）。**属于账号，不属于卡**：

- 只出现在**卡主自己**的 `GET /cards` 与 PATCH 回执里；`GET /cards/shared`、`GET /cards/:cardId`、
  `POST /cards/:cardId/install` 的回执与装到别人名下的那份**一律不带**——资产绑死在平台的火山账号下、
  背后是某个真人的授权，跟着卡走出去等于替被授权人做了一个他没同意的授权。
- 缺省 = 没绑过（读侧判否定）；解绑是 `$unset`，不会留下空对象。
- 为什么要存服务端（此前只在 app 本机 IndexedDB 侧库）：换机 / 重装 / 并排装 debug 包再登录，卡从服务端
  回来了、绑定却没有，用户看到的是「退出再登录，授权就失效了」。app 侧库现在是它的本机镜像：
  登录时以服务端为准装回（`account.syncCardAssets`），本机独有的补传上去。用例钉在 server 的
  `branchAssetPublish.spec.js` A16。

⚠ **`hot` 不是热度**。它是客户端发上来的种子值（`mock/ai.ts` 里手打的 18 个数字），
没有任何东西会去加它。真热度看下面的「卡片/卡组的互动与热度」。保留这个字段只为向下兼容。

⚠ **同一个 `cardId` 会有 N 份文档**（唯一索引是 `{owner, cardId}`，每个装过它的人各一份）。
所以任何「这张卡的计数」都必须按 **cardId 聚合**，不能挂在某一份文档上——挂上去的话
每个安装者看到的都是自己那份的 0，表现出来就是数据丢了。
同理，「哪一份是权威的」也只有一条规则：`{publishedAt: 1, _id: 1}` 最早发布的那份
（controller 里的 `AUTHORITATIVE_SORT`）。广场展示与 install 必须取同一份，否则
用户看到的卡和装到的卡不是一张。

### BranchDeck（卡组）
```
{ _id, owner: ObjectId(User), name, cardIds: [String], coverCardId?,
  published?, publishedAt?, description?,      // 分享到创意工坊
  cards?,                                      // 发布瞬间的卡片快照（自包含）
  installs?, sourceDeck?,                      // 被装走次数 / 装来的记住来源
  createdAt, updatedAt }
```

### BranchComment（评论，含楼中楼与 @提及）
```
{ _id, video, author, text, parent?, likes,
  mentions?: [{ user, token, offset, length }], createdAt }
```
`offset` = 正文里那个 `@` 的下标，`length` = 名字长度（不含 `@`），即
`text.slice(offset, offset + 1 + length) === '@' + 当时打出来的名字`。
★ `offset`/`length` 是**后加**的，存量行没有 —— 判「有没有」，不要给默认值：
0 是合法 offset，给了默认值就分不出「老数据」和「@ 在正文开头」。

`mentions` 是**服务端解析并解析成功的**那些 @（存下来，隔天再读也还能高亮）。
★ 客户端**不许**自己再解析一遍正文来高亮：那样会把服务端没认出来的 @ 也画成链接，
用户就看不出自己那个 @ 到底有没有生效了。没解析出来的 `@xxx` 保持纯文本，这是**故意的**。
`parent` = 被回复的评论（顶层评论没有这个字段）。**判据是「有没有 parent」**，
不是拿它和某个哨兵值比——历史评论这一项是 `undefined`。
回复只有两层：回复一条回复时服务端会把 `parent` 归到它的顶层父评论
（`parent.parent || parent._id`），通知仍然发给被回复的那个人。

### BranchCommentLike（评论点赞去重）
`{ user, comment }` 唯一索引。与 BranchLike 同构——计数由本表 `countDocuments` 回写，
不做裸 `$inc`，避免并发下漂移。

### BranchAssetStat / BranchAssetLike / BranchAssetView（卡片与卡组的互动）
```
BranchAssetStat  { kind: "card"|"deck", key, views, likes, bookmarks }   唯一 {kind, key}
BranchAssetLike  { user, kind, key, action: "like"|"bookmark" }          唯一 {user, kind, key, action}
BranchAssetView  { kind, key, viewer, expiresAt }                        唯一 {kind, key, viewer} + TTL
```
`key`：卡片是 **`cardId`**（理由见上），卡组是发布出去那条的 `_id`。
`viewer` 是 `u:<userId>:<UTC日>` 或 `a:<sha256(日+pepper+ip) 前32位>`——**不存原始 IP**，
每日换盐，所以昨天的匿名行关联不到今天。它是浏览量的**真正的门**：限流只减慢速度，
挡不住刷（60/分钟乘一小时也够把热度顶上去）。

### BranchLike（点赞去重）
`{ user, video }` 唯一索引。

### BranchDanmaku（弹幕）
`{ video, author, at, text, color }` + timestamps。索引 `{video, at}`（播放端按时间轴取）
与 `{video, createdAt}`（取最新 N 条）。字段口径见下「弹幕」。

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/branch/videos` | optional | 列表。query：`feed=recommend\|following`、`category`、`q`（对 **title / description / tags** 三者做不区分大小写的子串匹配）、`author`(用户 id)、`cursor`、`limit`(默认 12)。返回 `{ ok, items, nextCursor, author? }`；`items[].liked` 表示当前用户是否已赞。**只返回公开作品 + 自己的作品**（见下「可见性」）。★ `author` 生效时会**原样回显**在响应里 —— 老服务端会把这个 query strip 掉然后照常回推荐流，客户端只能靠"这个键在不在"分辨"按作者筛过、这人没作品"与"压根没筛"，判内容或判状态码都分不出来 |
| POST | `/api/branch/videos` | required | 发布。body=DraftVideo（title/category/description/**tags**/cover/segments/branchTree/**deck**/**visibility**/**linkOnly**/**clientId**）。**服务端负责把 body 里的外链资源转存**（见下）。带 `clientId` 时按 `{author, clientId}` 幂等：重发返回首次那条、状态码 200（首发是 201） |
| GET | `/api/branch/videos/:id` | optional | 详情（含 comments 前 50 条）。非作者访问 private 作品返回 **404**（不是 403） |
| PATCH | `/api/branch/videos/:id` | required | 作品编辑 **+ 回炉重做**，仅作者。body `{ title?, category?, description?, tags?, visibility?, linkOnly?, cover?, segments?, branchTree?, deck?, baseRevision? }`，**至少给一个字段**（空对象 400；只给 `baseRevision` 也 400）。限流 **6/分钟按账号**（`branch:revise` 桶）。★ **带了 `segments` / `branchTree` / `deck` 任意一个 = 回炉**（换内容），否则是改壳，行为一字未变。回炉详见下「回炉重做」 |
| DELETE | `/api/branch/videos/:id` | required | 仅作者可删 |
| POST | `/api/branch/videos/:id/play` | optional | 播放计数 +1，返回 `{ ok, plays }` |
| POST | `/api/branch/videos/:id/like` | required | 点赞，返回 `{ ok, likes, liked: true }` |
| DELETE | `/api/branch/videos/:id/like` | required | 取消，返回 `{ ok, likes, liked: false }` |
| GET | `/api/branch/videos/:id/comments` | optional | 评论列表。每条带 `parentId` / `likes` / `liked` |
| POST | `/api/branch/videos/:id/comments` | required | 发评论 `{ text, parentId?, mentions? }`。带 `parentId` = 回复。`mentions` 见下「@提及」。限流 **20/分钟按账号**（`branch:comment` 桶，与弹幕分开） |
| POST | `/api/branch/videos/:id/comments/:commentId/like` | required | 评论点赞 → `{ ok, likes, liked: true }` |
| DELETE | `/api/branch/videos/:id/comments/:commentId/like` | required | 取消 → `{ ok, likes, liked: false }` |
| DELETE | `/api/branch/videos/:id/comments/:commentId` | required | 删评论。**评论作者本人 或 作品作者**。连带删：回复、评论赞、指向它的通知；重算 `commentCount`。→ `{ ok, removed, commentCount }`。限流 30/分钟按账号 |
| DELETE | `/api/branch/videos/:id/danmaku/:danmakuId` | required | 删弹幕。**弹幕作者本人 或 作品作者**。→ `{ ok: true }`。限流 30/分钟按账号。★ 无权时回**裸 403**，回包与文案里**绝不能出现作者信息** —— 否则对每条弹幕试删一次，就等于给整面匿名弹幕墙开了一个逐条查作者的接口 |
| GET | `/api/branch/videos/:id/danmaku` | optional | 弹幕列表（见下「弹幕」）。query `limit`(默认 200，上限 500)。返回 `{ ok, items, truncated }` |
| POST | `/api/branch/videos/:id/danmaku` | required | 发弹幕 `{ at, text, color? }` → 201 `{ ok, danmaku }`。限流 **30/分钟**（按账号） |
| GET | `/api/branch/projects` | required | 我留存的工坊工程列表 → `{ ok, items: [{ video, title, bytes, videoRevision, stale, lostCount, updatedAt }] }`，最多 200 条。⛔ **绝不回 `canvas`**（那是"有没有"的问题；回正文等于每次进个人页下载几十 MB） |
| PUT | `/api/branch/videos/:id/recipe` | required | 公开配方（制作过程）：留存一份白名单形状的流水线描述，见下「公开配方」。body `{ recipe, videoRevision, public? }`，`videoRevision` 对不上作品当下的 `revision` 400 `RECIPE_REVISION_MISMATCH`。限流 12/分钟 |
| PATCH | `/api/branch/videos/:id/recipe` | required | 开 / 关公开 `{ public }`（仅作者） |
| GET | `/api/branch/videos/:id/recipe` | optional | 读配方：作者本人任何状态都读得到；别人只在公开且不过期时读得到，否则 404 `RECIPE_NOT_PUBLIC` |
| DELETE | `/api/branch/videos/:id/recipe` | required | 作者删掉留存的配方 → `{ ok: true }`，作品不受影响 |
| GET | `/api/branch/projects/by-video/:videoId` | required | 取回画布（**仅作者**）→ `{ ok, project: { video, title, canvas, videoRevision, stale, lostCount, updatedAt } }`。没有 → **404** `{ code: "PROJECT_NOT_FOUND", message: "这条作品没有留存工坊工程。" }`（客户端据此把「回炉重做」画成灰键 + 一句原因，不许摆没有原因的灰）。★★ 客户端**必须**拿 `videoRevision` 与作品当下的 `revision` 比，对不上就**不许铺进工坊**（那份画布描述的是上一版，就着它提交会把线上内容静默退回） |
| PUT | `/api/branch/projects/by-video/:videoId` | required | 留存/覆盖（**仅作者**，upsert）。body `{ title?, canvas, videoRevision, lostCount? }`。限流 **12/分钟按账号**（`branch:project`）。`bytes` 与 `owner` 由服务端自己算/自己填，客户端报的一律不信。**`videoRevision` 必须等于作品当下的 `revision`**，对不上 400 `PROJECT_REVISION_MISMATCH`（带 `details.currentRevision`）—— 这是「这一格只能靠真的 PUT 新画布往前走」那条纪律的唯一实现。五种 400：版次对不上、画布里残留 `data:<mime>/` / `idb:` / `*.volces.com` / `*.volccdn.com`（「画布里还有本机地址…」）、单份超 **2MB**（「这份工程太大了」）、配额超 **100 条 / 50MB**（`PROJECT_QUOTA`，⛔ **不自动淘汰**，整句告诉用户去删）；另有作品不是你的（403）/ 不存在（404） |
| DELETE | `/api/branch/projects/by-video/:videoId` | required | 放弃留存（**仅作者**）。作品本身不受影响 |
| GET | `/api/branch/cards` | required | 我的卡片 |
| POST | `/api/branch/cards` | required | 批量新增 `{ cards: Card[] }`（按 cardId 幂等） |
| DELETE | `/api/branch/cards/:cardId` | required | 删除一张 |
| GET | `/api/branch/cards/shared` | optional | 创意工坊的卡片广场。**必须注册在 `/cards/:cardId` 之前** |
| GET | `/api/branch/cards/:cardId` | optional | 按 id 读**一张已分享的卡**（卡片深链回源）。回包与广场列表同形（含 `installed`/`isOwner`）。⚠ **未分享 / 已撤下 / 不存在一律 404，不是 403** —— 403 等于承认"这个 id 存在但你不能看"，而 cardId 是 `前缀_时间戳_6位随机`，不是能力令牌。内容取**权威那份**（`findAuthoritativeCard`：最早发布的那条），与广场列表、安装同一把尺 |
| POST | `/api/branch/cards/:cardId/publish` | required | 分享到工坊 `{ description? }`（仅作者）。挂第三方版权模型的卡 **400** |
| DELETE | `/api/branch/cards/:cardId/publish` | required | 取消分享 |
| POST | `/api/branch/cards/:cardId/install` | required | 装走一张（按 `{owner, cardId}` 幂等：首次 201，之后 200 + `alreadyInstalled`） |
| GET | `/api/branch/decks` | required | 我的卡组 |
| POST | `/api/branch/decks` | required | 建组 `{ name, cardIds? }` |
| PATCH | `/api/branch/decks/:id` | required | 改名/改卡 `{ name?, cardIds?, coverCardId?, description? }` |
| DELETE | `/api/branch/decks/:id` | required | 删组 |
| GET | `/api/branch/decks/shared` | optional | 卡组广场。**必须注册在 `/decks/:id` 之前** |
| POST | `/api/branch/decks/:id/publish` | required | 分享整套 `{ description? }`。组里有第三方版权模型的卡 **400 并说明是哪张** |
| DELETE | `/api/branch/decks/:id/publish` | required | 取消分享 |
| POST | `/api/branch/decks/:id/install` | required | 整套装走，原组 `installs` +1 |
| POST | `/api/branch/assets/:kind/:key/view` | optional | 浏览 +1。限流 **60/分钟**，且同一访客同一天只计一次 |
| POST\|DELETE | `/api/branch/assets/:kind/:key/like` | required | 点赞/取消。限流按**账号**（换出口比换账号便宜） |
| POST\|DELETE | `/api/branch/assets/:kind/:key/bookmark` | required | 收藏/取消。与 like 共用一个限流桶 |
| GET | `/api/branch/assets/:kind/:key/stats` | optional | `{ views, likes, bookmarks, heat, liked, bookmarked }` |

`:kind` ∈ `card` \| `deck`。写端点会先校验这个 key 真的对应一张卡/一套组，对不上返回 **404** ——
不校验的话随便编个 key 就能凭空造出一行谁也够不着、也删不掉的计数。
读端点 `/stats` 故意不校验：它不写库，造不出任何行，而客户端手里合法地存在只在本机有的 `cardId`。

关注沿用既有 `/api/users/:id/follow` 与 `Follow` 模型，不新建。

### 公开配方（制作过程，`/videos/:id/recipe` 四条 + `remixOf`）

**一句话**（2026-10-02，模板体系 P1，方案 app 仓 docs/template-workflow-research.md §三 C）：作者可以把一条作品
**怎么一段段做出来的**公开给别人看（作品页「查看制作过程」），别人按它把同一条流水线铺到自己的草稿里接着做。
公开的**不是**回炉用的那份画布：客户端从画布投出一份**白名单形状**（app `data/recipe.projectRecipe`），服务端用
**同一形状的严格 schema** 再验一遍（`schemas/branchRecipe.schemas.js`，`z.object` 默认 strip，白名单之外的键进不来）。
加字段要三处一起动：app 的类型 + 投影、server 的 schema。

```
WorkflowRecipe {
  v: 1,
  mode: "workflow" | "simple",
  nodes: RecipeNode[1..24],            // 逐段：title / plot / shot? / durationSec / tier / model? / aspect / chain / kind / cards[] / slots[] / tpl? / flags[] / preview?
  deck:  RecipeCard[0..60],            // 随配方带走的卡（cardId / type / name / summary / cover / tags / idLine / textDesc / startFrames? / views），**没有** modelUrl / genPrompt
  cast:  RecipeSlot[0..30],            // 要使用者自己填的空位：{ type, why: "real" | "foreign" | "private", name }（real 恒空名）
}
```

- **红线**（客户端投影 + 服务端按作者卡库复核，两道）：声明过真实人物的卡 → `cast` 里一个 `real` 空位、**不带名字**；
  从别人那儿装来的卡（`BranchCard.sourceOwner` 有值）→ `foreign` 空位带名字；卡太多带不完 → `private`。
  服务端在 `deck` 里撞见真人卡 400 `RECIPE_REAL_PERSON`、装来的卡 400 `RECIPE_FOREIGN_CARD`。
- 段模板**只回指服务端 id**（`tpl: { id, title, part? }`，24 位十六进制），不带快照：出片只认已登记的模板视频，
  复制时客户端现取（`GET /templates/:id`），取不到那一段退成普通段并说明。
- 白模段的 `plot` 恒空（点名句里是原作挂的卡名）；`flags` 记原作这一段还用过但没带走的东西
  （`ref-video` / `mid-frames` / `stage` / `anns` / `revised`），故事板据此说一句。
- `preview.first / last` 只许 http(s) 且不是方舟临时链接（与工程那条不变量同一判据）；整份 ≤ 512KB，
  本机地址（`data:` / `idb:`）出现即 400。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| PUT | `/api/branch/videos/:id/recipe` | required，仅作者 | body `{ recipe, videoRevision, public? (默认 true) }`。★ `videoRevision` **必须等于作品当下的 `revision`**，对不上 400 `RECIPE_REVISION_MISMATCH`（带 `details.currentRevision`）。幂等 upsert（一条作品一份）。限流 12/分钟（scope `branch:recipe`）。→ `{ ok, recipe: meta }` |
| PATCH | `/api/branch/videos/:id/recipe` | required，仅作者 | body `{ public: boolean }` 只开 / 关。限流 30/分钟（scope `branch:recipe:toggle`）。没有配方 404 `RECIPE_NOT_FOUND` |
| GET | `/api/branch/videos/:id/recipe` | optional | 作品本身要对这个人可读（与作品同一套 `readableBy`）。**作者本人任何状态都读得到**；别人只在 `public && !stale` 时读得到，否则 404 `RECIPE_NOT_PUBLIC`「这条作品没有公开制作过程。」（作品不存在 / 不可读是 404 `NOT_FOUND`，与作品端点同句）。→ `{ ok, recipe, meta: { video, videoRevision, public, stale, listed, bytes, nodeCount, updatedAt, title, cover, author: { _id, username, displayName, avatarUrl }, isOwner } }` |
| DELETE | `/api/branch/videos/:id/recipe` | required，仅作者 | → `{ ok: true }`。作品不受影响 |

**`stale`**：配方描述的不是作品当下这一版 —— 回炉成功那一拍服务端只在 `BranchVideo.recipe` 上留 `{ public, revision }`
（revision 是配方描述的版次），`stale = revision !== video.revision`。回炉之后旧配方**自动对外隐藏**，客户端留存工程那一拍
随新画布重新 PUT 一份（`videoRevision` = 回炉回包的新版次）；作者关着公开的话不发。判否定：不发 `stale` = 不过期。

**作品上随之多出的四位**（`toVideoPayload`）：
- `recipePublic: true` —— **只在**公开且不过期时发（判有值）。列表与详情都发。
- `recipeState: { public, stale }` —— 只发给作者本人（编辑页那颗开关的初值）。
- `remixOf: { id, title, author }` —— 这条是按谁的流程做的。**只有详情端点算**；原作对**这个读者**不可读
  （私密 / 下架 / 删了）时不发。发布体 `POST /videos` 收可选的 `remixOf: string`（原作 id），服务端只认「发布者读得到的原作」，
  认不下来当没带、**不挡发布**。回炉体不收它（归属不变）。
- `remixCount: number` —— 有几条作品按它做了同款（不含作者自己的）。**只有详情端点算**。

**级联**：删作品连带删它的配方；永久删号连带删此人全部配方（`purgeUserCascade` 的清单里）。被引用的原作删掉后，
同款作品上的 `remixOf` 存着不动、只是不再发（读者读不到原作）。

#### 工作流模板（上架的公开配方，模板体系 P2，2026-10-02）

主人拍板「工作流模板必须挂在一条已发布作品上」（示例视频 = 那条作品），所以**工作流模板就是上了架的公开配方**，
不另开一张表：`BranchRecipe.listed`（+ `listedAt`）一位布尔。

- 上架的前提是**公开 + 不过期**：`PUT` 可带 `listed: true`（没勾公开时不上架、不报错 —— 从属开关）；不带 `listed` 的 PUT
  **不动**原来的上架位（回炉重投新一版不会悄悄下架）。`PATCH { listed: true }` 对没公开 / 过期的 400 `RECIPE_NOT_LISTABLE`
  （整句拒，不静默）；`PATCH { public: false }` 顺手下架。`PATCH` 至少要给 `public` / `listed` 一样。
- `GET /api/branch/templates/workflows`（optionalAuth）：货架。只列「上架 + 公开 + 不过期 + 作品对这个人可读」的，
  可读性按**凭链接可见也算**的口径（作者不想进首页流就把作品设成凭链接可见，仍能上货架）；私密、下架的不列。
  query `limit`（默认 30，上限 60）、`before`（上一页最后一条的 `listedAt`）。→ `{ ok, items: [{ video, title, cover,
  author, summary: { segs, totalSec, tiers, templated, cards, slots }, remixCount, listedAt, updatedAt }] }`，**不带正文**。
  ★ 这条路由挂在 branchTemplate.routes **之前**（app.js）：不然 `/templates/:id` 会把 `workflows` 当 id 吞掉。
- 模板页 = 作品的制作过程页（`GET /videos/:id/recipe`，meta 多一位 `listed`）；作者的作品回包 `recipeState` 多一位 `listed`。

**被公开配方引用着的段模板只能「退役」**（主人拍板：只能下架，素材保留到没人引用）：`BranchTemplate.status` 多一档 `retired`。
- 引用数现算：`BranchRecipe.refsOfTemplate(id)` = 公开配方里 `nodes[].tpl.id` 指向它的份数（关了公开的不算）。
- `DELETE /templates/:id` 在引用数 > 0 时**不删**：status 改成 `retired`（blocked 的不动），回 `{ ok, retired: true, refs }`，
  素材一个都不回收；引用数归零之后再删一次才真删。`PATCH /templates/:id/unpublish` 同理：有引用 → `retired`（回包带
  `retired: true, refs`），没引用 → `pending`。
- `retired` 对**所有人**可读（`GET /templates/:id`）、可用（ark 的 `resolveR2v` 放行）：按配方复制的人要靠它铺白模段、出片；
  不进 `/templates/shared` 货架。与 `pending`（只有作者）/ `blocked`（谁都不能用）是三件事。

⚠ 客户端判「这台服务器有没有这个端点」看**回包形状**（`meta.video` 是否存在），不看状态码：Capacitor 对未命中路径
回 200 + index.html。老服务端上这四条路都不存在 ⇒ App 把它说成「这台服务器还不支持公开制作过程」，不是「没有公开」。

### 同款奖励（`remix_reward`，模板体系 P3b，2026-10-02）

别人按你的流程做了同款、**公开发布满 24 小时还公开着** → **平台**印一笔 token 给原作者（主人 10-02 拍板四个数）。

★★ **这是平台印钱，不是同款作者付给原作者**：token 只能购买、只能站内消耗，不许在用户之间流转。账本上只有原作者
那一条 `remix_reward` 入账，同款作者的钱包不动。

| 数 | 值 | 在哪儿 |
|---|---|---|
| 每次 | 30,000 token（≈ 0.45 元） | `config/remixReward.js` 的 `TOKENS` |
| 每位原作者 24 小时内 | 最多 10 次，**不顺延** | `PER_AUTHOR_PER_DAY` |
| 每条原作一共 | 最多 50 次 | `PER_VIDEO` |
| 要挂多久 | 24 小时 | `HOLD_MS` |
| 开关 | 缺省开；`REMIX_REWARD_ENABLED=false` 关 | `enabled()` |
| 防刷一：每个**同款作者** 24 小时内 | 最多带来 3 次，不顺延 | `PER_REMIXER_PER_DAY` |
| 防刷二：**全站** 24 小时内（保险丝） | 最多 100 次（≈ 45 元 / 天），可用 `REMIX_REWARD_GLOBAL_PER_DAY` 调，不用发版 | `globalPerDay()` |

上面前四个数是**产品口径**（规则端点下发、App 上屏）；两道防刷（2026-10-03 加）是内部规则，**不进规则端点、不上屏**：
注册不要验证码，"小号互相做同款"刷得动 —— 防刷一把互刷的日产量从 10 次 / 号压到 3 次 / 号，防刷二给全站一天的总支出封顶。
保险丝断了之后到期的同款记成 `budget` 不发、也不补；这个窗口里第一次断的时候给管理员发一封信（收件人同 NCII 那条：
`TAKEDOWN_NOTIFY_EMAIL` / `SUPPORT_NOTIFY_EMAIL` / 管理员账号的邮箱），信里列着最近 24 小时收得最多 / 带来最多的各五个号。

**规则端点**：`GET /api/branch/remix-reward`（optionalAuth）
→ `{ ok, reward: { enabled, tokens, perDay, perVideo, holdHours }, mine?: { count, tokens, last24h } }`。
App 上那句「每次 N token、每天最多 M 次…」读的是这里，**不在 App 里另抄一份数**。`mine` 只在带登录态时有
（作为原作者累计发了几次 / 多少 token、最近 24 小时用掉了几次上限）。老服务端没有这条路 —— App 判回包形状（有没有 `reward` 对象）。

**一条同款的一生**（唯一实现 `services/remixReward.service.js`）：
1. 发布（`POST /videos` 认下了 `remixOf`）→ 作品上落 `remixOf.pending: true`。自己按自己的流程做的不落。
   上线之前发布的同款没有这一位 = 不欠，不回头补发。
2. 满 24 小时后，清扫器（`index.js`，只在 0 号实例，每 10 分钟一轮）判**一次**，写一行 `RemixReward`（每条同款恰好一行）：
   - 不发的原因（`reason`）：`disabled` 开关关着 / `remix_not_public` 同款那一刻是私密、凭链接可见或被下架 /
     `original_not_public` 原作没了、私密或被下架（**凭链接可见的原作算公开**：工作流模板可以挂在那种作品上）/
     `author_inactive`、`remixer_inactive` 账号注销或被封 / `repeat` 同一个人对同一条原作已经算过 /
     `remixer_cap` 这位同款作者 24 小时内带来的次数到了上限 / `video_cap`、`day_cap` 到了上限 /
     `budget` 全站保险丝断了（排在最后判：记成它的都是"别的都合格、只是全站额度用完了"）。
   - **判一次就定案**：到期那一刻不满足的，之后再变公开也不补；发了的，之后同款被删 / 设私密 / 下架也不追回。
3. 发：先占位（`status: claimed`，`remix` 唯一索引）→ `wallet.credit(原作者, 30000, "remix_reward", "同款奖励 remix:<id>")`
   （进 **addon**，不过期）→ `paid` → 一条 `BRANCH_REMIX_REWARD` 通知。崩在中间的由下一轮按**账本**续办
   （memo 逐字是证据：有那一条 = 发过了，只补状态）。

**账本**：`TokenLedger.reason` 多一档 `remix_reward`。它**不抵欠额**（不在 `REPAY_REASONS`：印的钱不是付的钱），
也**不冲当日用量**（不在 `SPEND_REASONS`）。

**删号 / 删作品**：`RemixReward` 里「他是原作者」的行随删号一起删；「他是同款作者」的行**留着**（那是别的原作者的上限计数，
跟着删的话刷子号做完同款就注销、上限被悄悄清零）。删作品不动这张表。

## 热度（`heat`）

**只有一个公式**，实现在 server 的 `src/utils/hotScore.js`：

```
likes×6 + comments×4 + bookmarks×3 + min(views, 5000)×0.04
```

权重是从 `ideas.controller.js` 的 `getIdeaHotScore` 原样搬过来的（那边现在也调用这个 util，
全仓就这一份）。卡片/卡组的 `comments` 恒为 0 —— 服务端没有卡片评论表，评论只存在客户端。

★ 客户端 `data/social.ts` 里有一份**镜像**（`heatFormula`），只在离线或对着老服务端时用。
两份必须**权重与入参都相等**：入参不等的话，联网那一刻数字会当着用户的面跳一截。
（同价目表的处境——两仓不在一个 CI 里，只能各留一份，改一边必须改另一边。）

## 通知（分支视频）

沿用既有的 `/api/notifications`（列表 / `unread-count` / `:id/read` / `read-all`），新增：

- `Notification.type` 增加 `BRANCH_LIKE`、`BRANCH_COMMENT`、`BRANCH_COMMENT_REPLY`、`BRANCH_COMMENT_LIKE`、`BRANCH_MENTION`
- `Notification.type` 另增 **`ADMIN_NOTICE`**（平台通知，管理员手动发给某个用户）。
  `payload = { text }`（自由文本，1~500 字），**没有 `actorId`**、没有 deeplink ——
  通知以平台口径发出，「是哪个管理员发的」刻意不透给用户（与 `takedown.by` 同一条理由）。
  App 渲染成「系统通知 + 原样文本」即可，头像用平台占位图（actorId 为 null 不是坏数据）。
  ★★ **未知类型必须降级显示，不许崩、不许吞**（铁律七）：消息页对认识的类型正常渲染，
  对不认识的类型显示成通用的「系统通知」行（标题给类型名或"通知"，正文尽力取
  `payload.text`）。老包收到新类型是常态 —— 白名单过滤器只该决定**归到哪个 tab**，
  不该决定**存不存在**；把未知类型直接 filter 掉的话，用户的红点数与列表条数永远对不上。
- `Notification.type` 另增 **`BRANCH_REMIX_REWARD`**（2026-10-02，模板体系 P3b）：**同款奖励到账**。收件人 = 原作者。
  `payload = { tokens, originalId, originalTitle, videoId?, videoTitle? }`；`actorId` = 同款作者、`videoId` = 那条同款
  （deeplink 到 `/video/:id`，看别人照着做出来的片子）。金额是 `payload.tokens`（数），**不拼成句子**——句子由 App 按界面语言说。
  ★ 两人之间有拉黑、或那条同款已经不公开时**不带** `actorId` / `videoId`（App 画成「有人做了你的同款」）：币已经进账，
  不能不说（App 没有流水页）；但也不能把被拉黑的人摆到眼前。
  ⚠ 老 App（≤ 2.60）**收不到**这一类（请求层白名单，同 `BRANCH_REVISED`）：币照到，只是没有那条通知。
- `Notification.type` 另增 **`GEN_TASK_REFUND`**（2026-10-07，失败退款）：**一发生成任务失败了，token 已经退回**。收件人 = 那一发的主人。
  `payload = { tokens, kind, taskId, provider }`（`kind` ∈ `video` / `draft` / `draftFinal` / `3d` / `blockout` / `minimax`，`provider` ∈ `ark` / `minimax`）；
  **不带** `actorId`、没有 deeplink（平台口径）。金额是 `payload.tokens`（数），句子由 App 按界面语言说。
  ★ 只在钱**不是**在本人那次轮询里退的时候发（清扫器、别人的轮询、白模化之外的另一发）：本人轮询的响应里已经带着 `refund`，再发是噪音；
  不发的话 App 没有流水页 —— 一笔说不出来历的余额变动比一条通知糟。写入只在 server `services/taskRefund.service.js` 一处，每笔最多一条。
  ⚠ 老 App **收不到**这一类（请求层白名单，同 `BRANCH_REVISED`）：钱照退，只是没有那条通知。
- `Notification.type` 另增 **`BRANCH_REVISED`**（2026-09-07）：**你收藏的作品被作者回炉重做了**。
  收件人 = 这条作品的收藏者（`BranchCollect`）；`actorId` = 作者；deeplink 目标是 **`videoId`**（`/video/:id`）。
  正文走 **`payload.commentText`**（`"这条作品重新剪辑过了"`）—— 刻意复用 `ADMIN_NOTICE` 已经走通的
  那条通道，而不是新开一个 `payload.text`：新开就要同时改 App 的 `data/notifications` 映射，
  而「服务端发了、App 静默丢掉」正是那张白名单存在要防的事故形态。
  扇出上限 **500** 个收藏者（超了只发前 500 并 `console.warn` 留痕），并发 8，`void` 调用 ——
  广播失败**不影响回炉成败**。
  ⚠⚠ **老 App（≤v2.45）收不到这一类**：它的 `BRANCH_NOTIFICATION_TYPES` 是**请求层白名单**
  （列表筛选 / 未读数 / 全部已读三处从它派生），老包压根不会把这个 type 放进查询。
  ⇒ 对未升级用户，**观众知情为零**。这不是"降级显示"，别写成降级显示。
- `Notification.type` 另增**老师人格四类**（2026-09-29，tutor 仓 docs/02 9.6 / 4.9 / 5.9；写入只在 `services/tutorNotify.service.js` 一处：
  拉黑双向判 + 同人同事 24 小时一条 + 失败只记日志）：
  `TUTOR_RATING`（有人给你的老师评了分，`payload { personaId, personaName, stars, text }`）、
  `TUTOR_COMMENT`（有人在你的老师下留言，`payload { personaId, personaName, commentId, preview, parentId }`）→ 收件人 = 作者；
  `TUTOR_REVIEW_DUE`（有阶段到了回访时间，`payload { courseId, personaName, count, stages[], stageId }`，**没有 actorId**，
  worker 每分钟扫 `TutorRun.nextReviewAt`，同一个到期时间只发一次）、
  `TUTOR_DOC_UPDATED`（作者发了新版可合并，`payload { personaId, personaName, version, courseId, note }`，扇出上限 500 / 并发 8）→ 收件人 = 学习者。
  deeplink **一律在 payload 里**（personaId → `/tutor/market/:id`，courseId → `/tutor/courses/:id` 或 `/tutor/run/:id`），刻意不加顶层字段
  （加字段就要同时改 App 的映射，见上一条）。
  ⚠⚠ **老 App（含 2.48）收不到这四类**：`BRANCH_NOTIFICATION_TYPES` 是请求层白名单，老包压根不会把它们放进查询 ——
  对 App 用户是「收不到」，不是降级显示；官网通知页认得（`NotificationsPage` 四个 case + 落点链接）。
- **删号级联多了老师人格这一线**（2026-09-29，`services/tutorPurge.service.js`，由 `purgeUserCascade` ⑩.7 懒 require）：十二张 `Tutor*` 表 +
  他发布的老师人格及其发布版 / 评分 / 安装 / 评论 / 举报（儿童安全举报按 `Report.URGENT_REASONS` 留下）；教材原件句柄进 `PendingAssetPurge`
  （`resourceType` 多一档 **raw**）。**别人从他的老师开出来的课不删**，只标 `sourceOrphanedAt`：那些学习者的课程 summary `source.gone / orphaned` 为真、
  「合并新版」409 `SOURCE_GONE`。删号不看 `TUTOR_ENABLED`：开关管功能挂不挂，不管数据在不在。
- `Notification.videoId`（ref `BranchVideo`）。★ **不要复用 `ideaId`** —— 它 ref 的是 `Idea`，
  塞一个 BranchVideo 的 id 进去不会报错，只会 populate 成 `null`，标题和跳转地址一起没了，全程零日志。
- 列表接口的 `actorId` 现在 populate `username displayName avatarUrl role`，并额外 populate
  `videoId` 的 `title cover visibility`
- `read-all` 接受可选的 `type` 过滤（与列表接口同样的逗号分隔写法）。**不传时行为一个字节都没变**。
  ★ App 的消息页只显示上面四种 BRANCH_*，所以它必须传这个过滤 —— 不传的话用户点一下「全部已读」，
  会把网站那边他**从没看过**的通知一起标成已读。

去重与限流（都在 server 一处实现，见 `notifyBranch` / `NOTIF_DEDUP_KEYS`）：
- `BRANCH_LIKE` 按 `{userId, actorId, videoId, type}` 24 小时内只发一条 —— 点赞是幂等 upsert，
  但「取消再点」会删行再插行，不去重的话一个循环就能把对方的通知箱刷爆。
- `BRANCH_COMMENT_LIKE` 的去重键额外带 `commentId`（否则赞了同一作品下的第二条评论就不通知了）。
- `BRANCH_REVISED` **要去重**，键与 `BRANCH_LIKE` 同形（`{userId, actorId, videoId, type}`，24 小时）：
  回炉是可重复的动作（改一版、看一眼、再改一版是正常创作节奏），不去重的话作者下午调五版，
  每个收藏者就收五条一模一样的。⚠ 漏了 `NOTIF_DEDUP_KEYS` 里那一行不会报错 ——
  `alreadyNotified` 对**不在那张表里的类型一律不去重**。
- 评论与回复**不去重**：每一条都是新内容，压掉就是真的丢消息。
- **弹幕不发通知**。弹幕的回包刻意不带作者（只有一个 `mine` 布尔），发通知等于把它去匿名化。
- **`BRANCH_MENTION` 不去重**：@ 永远搭在一条**新评论**上，按 24 小时去重的话，一段正常对话
  从第二轮起就再也不提醒了 —— 那是丢消息，不是防刷。刷的成本由另外三道闸门管：
  评论 20/分钟（按账号）、单条评论最多 10 个有效 @、以及下面那条「一条评论只通知你一次」。
- **一条评论只给同一个人发一条通知**。作品作者被 @ 时只收 `BRANCH_COMMENT`，
  被回复的人被 @ 时只收 `BRANCH_COMMENT_REPLY` —— 结构性的那条信息更全（它同时说明了
  "这是回给你的 / 这是你作品下的"），@ 让位。判重在 `addComment` 里一个 `notified` 集合上。
- **拉黑了就通不过**：所有 BRANCH_* 通知统一在 `notifyBranch` 里过一次 `hasAnyBlockBetween`。
  少了这一道，被拉黑的人就能靠 @ 把消息塞进对方的通知箱 —— 而拉黑对用户的承诺正是"这个人碰不到我"。
- **@ 也受可见性约束**：只有**看得见这条作品**的人才会收到 `BRANCH_MENTION`。
  否则在私密作品下 @ 一个人，就等于告诉他"存在这么一条你看不到的作品"，@ 成了探针。

## @提及（`@显示名`）

**@ 的是显示名**（`@我是王桑`），不是注册名。用户在界面上从头到尾看到的就是 `displayName`，
`username` 一处都不露脸 —— 只能 `@tianbinliu` 等于这个功能对普通用户不存在。

### 身份与显示是**两件事**，分开存

- **身份 = `userId`**。落库、发通知、跳主页，全都只认它。
- **显示 = 当下的 `displayName`**。渲染时按 `userId` 现查 —— 所以**作者改名之后，
  已经发出去的那些 @ 会跟着显示新名字**，不需要回填历史数据。
- 正文里那段名字只是"当时打出来的字面"，**不承担身份**。它会过时，这没关系。

这样就绕开了「拿可变字段当身份」那个老坑（`data/videos.ts` 的 `renameMyVideos` 收拾过一次）：
可变的只有显示，身份那一半仍然钉在 id 上。

### 中文没有词边界 —— 不靠正则猜，靠**客户端报范围、服务端核对**

`@我是王桑你看看` 用正则切不出「我是王桑」（贪婪会吃掉整句；试前缀等于一句话查 N 次库）。
所以选人由**补全面板**完成，客户端把「哪一段是谁」一起发上来：

```
POST /videos/:id/comments  { text, parentId?, mentions?: [{ userId, offset, length }] }   // ≤20 条
```

服务端**不盲信**这份名单（盲信 = 谁都能给任意人发通知），而是逐条核对，
**任何一条不过就丢掉那一条**（不是整条评论 400）：

1. `userId` 存在
2. `text[offset] === '@'`
3. `text.slice(offset+1, offset+1+length)` 等于该用户**当下**的 `displayName` 或 `username`
   （只折 ASCII 大小写；不能用 `toLowerCase()`，`'İ'` 折完会变成两个码位，长度一变校验先错且不报错）
4. 按 `userId` 去重 → 丢掉相互重叠的 span → 封顶 10 条

第 3 条是全部安全性所在：它保证「客户端声称 @ 了谁」与「正文里真的写着那个人的名字」一致，
所以伪造不出一个正文里根本没出现的提及。**上限必须作用在合并之后**，否则多报 span 就是
绕过收件箱封顶的口子。

### 仍然保留 ASCII `@username` 自动解析

手打 `@tianbinliu`（不经补全面板）、以及**老客户端**（不发 `mentions`）都靠它。
正则 `/(?<![\w@])@([A-Za-z0-9_-]{1,32})/g`，前置断言是为了让 `someone@example.com` 里的
`@example` **不**算提及（否则粘个邮箱就给陌生人发通知 —— ideas 那条线上表现为凭空发出一封邀请）。
两条路的结果合并去重。

### 回包与渲染

`toCommentPayload().mentions[] = { token, userId, username, displayName, offset, length }`，
`displayName` 是**现查**值。渲染端把 `[offset, offset+1+length)` 这一段**替换**成
`'@' + 当前 displayName` —— 这就是改名同步的落地方式。

- `offset`/`length` 是**后加**的键，老服务端不返回 → 客户端退回按 `token` 子串匹配。
- 服务端保证返回的 span **两两不重叠、按 offset 升序**。
- 存量评论行没有 span，服务端用 `token` 反查补一个 —— 反查**必须带与正则同样的前后边界判断**，
  否则 `bob@alice.com` 里那截 `@alice` 会被反查命中，客户端照 span 一替换，
  用户写的邮箱地址就被当面改写成别人的昵称、还变成一个链接。
- 客户端**不许**自己再解析一遍正文来补链接：那样会把服务端没认下来的 @ 也画成链接，
  用户就看不出自己那一 @ 到底有没有生效。没解析上的 `@xxx` 保持纯文本，**这是故意的**。

★ App 侧必须有 @ 自动补全（`components/MentionInput.tsx`），补全用的就是下面这条搜索接口。
没有补全，用户不知道该打什么，每一次 @ 都会静悄悄地谁也通知不到。

## 找人 `GET /api/users/search`

query `q`、`limit`(默认 8，上限 20)。返回 `{ ok, users: [{ _id, username, displayName, avatarUrl }] }`。

- **必须同时匹配 `displayName`**：App 里满屏显示的都是它，只按 `username` 匹配的结果是
  "用户搜自己每天看到的那个名字，一个人都搜不到"，而接口 200 + `users: []` —— 看着就像查无此人。
- 回包**只加不减**：`_id`/`username` 是官网客户端已经在读的，删任何一个都会当场打断它。
- `q` 一律走 `utils/regex` 的 `searchRegex`（转义 + 截断）。自己 `new RegExp(q)` 是本仓真出过事的 ReDoS 口子。
- 精确命中（`username` 等值）**单独发一条查询**，不与模糊那条合并后再 `limit` ——
  合并的话，一群把昵称改成你账号名的人可以把那一页占满，账号真叫这个名字的人一行都取不回来。
- 超时返回 **503**，不返回空列表：`users: []` 会让"服务器没查完"和"查无此人"在界面上长得一模一样。
- 限流按 **IP**（`users:search`，120/分钟）。这条是 `optionalAuth`，按账号限流等于没限
  —— 攻击者不带 token 就绕过去了。

## 话题标签（`tags`）

作品级的话题标签，2026-08-30 加。**与卡组快照里每张卡的 `tags` 同名不同物**：那是卡的
关键词（进出图提示词），这是作品的话题（给人搜）。审计里就把两者搞混过一次，据此得出
"服务端早就收 tags 了"的错误结论 —— 其实作品这条链路当时三处都没有。

- **判否定**：老作品库里根本没有这个字段。服务端一律归一成 `[]` 再发（`toVideoPayload`），
  客户端 `tags?: string[]` 缺省 = 没打过标签。任何地方都**不许**拿"有没有 tags"判新旧。
- **两组上限是有意不相等的**：
  - 服务端 `publishBody.tags` / `updateBody.tags` = `z.array(z.string().trim().max(40)).max(20)`
    —— **安全上界**，超了是**整发 400 而不是截断**；
  - 客户端 `types.VIDEO_TAG_MAX = 6` / `VIDEO_TAG_LEN = 10` —— **产品口径**，只要 ≤ 服务端
    那对，用户就撞不到那个 400，而且以后放宽不必发服务端。
  ⚠ 别"顺手对齐"这两组数：一旦客户端调到超过 20，用户会在发布一条几十分钟的付费成片时
  吃一个 400，而那一发的 token 已经花掉了。
- **`q` 搜索包含 tags**（`$or: [title, description, tags]`）。作品详情页的标签芯片是**可点的**，
  点了就跳这条查询 —— 不搜 tags 的话点自己刚打的标签会得到"没有结果"，比没有芯片更糟。
  ⚠ `q` 占用顶层 `$or`，可见性条件必须继续走 `$and`（server 那处有注释与用例，别改）。

## 可见性（`visibility`）

`BranchVideo.visibility` ∈ `"public" | "private"`，默认 `public`。`private` = 仅作者自己可见。

判定规则**只有一条**，服务端在下面每一处都用它（改一处必须改全部）：

- Mongo 查询：`{ $or: [{ visibility: { $ne: "private" } }, { author: 我 }] }`（未登录时只有前半）
- 内存判定：`doc.visibility !== "private" || 是作者`

★ **必须写成 `!== "private"` 而不是 `=== "public"`**：这个字段是后加的，存量作品这一项是
`undefined`，按等值判会把库里所有老作品从首页上抹掉——而且一点错都不报。
响应里的 `visibility` 已经归一过（`undefined` → `"public"`），客户端不用判缺省。

### 「凭链接可见」（`linkOnly`，2026-08-30）

界面上有**三档**：公开 / 凭链接可见 / 仅自己可见。但线上存的是**两个字段**：

| 界面档位 | `visibility` | `linkOnly` | 列表/搜索 | 按 id 直取 |
|---|---|---|---|---|
| 公开 | `public` | 不发 | 出现 | 放行 |
| 凭链接可见 | `private` | `true` | **不出现** | **放行** |
| 仅自己可见 | `private` | 不发 / `false` | 不出现 | 仅作者 |

★★ **为什么不给 `visibility` 加第三个枚举值 `unlisted`**（这是这条设计的全部要害）：
客户端**分不出新老**（请求里没有版本号），而老客户端的归一是
`v.visibility === "private" ? "private" : "public"` —— 收到 `"unlisted"` 会把它当成
**public**，之后用户在那台设备上随便改个标题保存，就把一条"只给链接看"的作品静默变成
全站公开。那是**隐私泄漏方向**的失败。
存成 `private + linkOnly` 之后：老客户端读到 `private`（**更严格**），而且它的 PATCH
**不带 `linkOnly`** ⇒ `$set` 碰不到那一位 ⇒ 作品照旧凭链接可见。失败方向从"泄漏"翻成
"过度保守"。（server 的用例 U4 专门钉这一条。）

★ 这一档的定义就是**两处刻意不一致**：`readableFilter`（列表）不认它、`readableBy`
（按 id）认它。⚠ 别"顺手统一"那两个函数 —— 统一哪一边都会毁掉一件事：要么这个功能没了，
要么私密作品漏进首页。

★ `visibility` 改回 `public` 时服务端会 **`$unset` 掉 `linkOnly`**（不是写成 `false`）：
这个字段判**有值**，写 false 会让每条老作品凭空长出一个字段，而 `public + linkOnly:true`
本身是个自相矛盾的状态。

★ 客户端：三档与两个字段的映射**只有 `types.visibilityOf` / `visibilityWire` 两个函数**。
⚠ 从「凭链接可见」改成「仅自己可见」时必须**显式发 `linkOnly: false`** —— 不发的话服务端
碰不到那一位，界面显示收紧了而链接照样打得开（`visibilityWire` 里那条 ★）。

挡的地方不止详情：`GET /videos`（含 `q` 搜索）、`GET /videos/:id`、`POST /:id/play`、
`POST|DELETE /:id/like`、`GET|POST /:id/comments`、`DELETE /:id/comments/:commentId`、
`POST|DELETE /:id/comments/:commentId/like`、`GET|POST /:id/danmaku`、
`DELETE /:id/danmaku/:danmakuId` **全部**按同一条规则挡，非作者一律 404。
只挡详情等于给私密作品留了个探测旁路 —— 新加任何一条子端点都要进这张表。
服务端这几处收敛在 `branchVideo.controller.js` 的 `assertVisible()` 一个函数里
（原来是各写各的，加一条子端点就多抄一遍）。

## 弹幕

B 站式弹幕：一句话 + 它该在**视频第几秒**飘过去。与评论是两件事，各自一张表
（`BranchDanmaku`）—— 评论按发布时间倒序读完就行，弹幕脱开 `at` 就什么都不是。

**字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `at` | number | 出现在**全片累计秒**（多段作品要把前面几段时长加上，与播放器进度条同口径）。`0 ≤ at ≤ 86400` |
| `text` | string | 正文，trim 后 **1–40 字**。40 是契约值，客户端的 `DANMAKU_MAX_LEN` 必须与它相等 |
| `color` | string? | `#rrggbb`，**只收这一种格式**。缺省/空串 = 客户端默认色（白） |
| `mine` | boolean | 响应字段。这条是不是当前请求者发的 |

★ `color` 会原样进客户端的 `style.color`。收任意字符串等于把一段用户可控的文本
喂进 CSS，所以服务端用 `/^#[0-9a-f]{6}$/i` 钉死，不合格直接 400。

★ **响应里没有作者**，只有 `mine`。弹幕在这套心智里是匿名的：挂上 username，
一条作品的弹幕墙就成了"谁在什么时间看了这个视频"的公开记录。客户端要作者信息的
唯一用途是给自己发的那条描个边，一个布尔就够。

**采样口径**：`GET` 先按 `createdAt` 倒序取最新的 `limit` 条，再**按 `at` 升序**返回。
不是"按 at 取前 N 条"——那样一条爆火作品的前 10 秒会被老弹幕占满、后发的永远看不见。
返回值里的 `truncated` 明说这是不是全部；没有这个标记，客户端分不出
"这条作品就这么多弹幕"和"被我们截断了"。

★ 返回**必须是 `at` 升序**：播放端是按游标扫时间轴放的，乱序会整段漏放。

## 举报

> **2026-09-28（老师人格 M2，治理 P5）**：`targetType` 加 `persona`（人格线此前没有任何下架端点）；理由加 `instructorClaim`（教授认领 / 要求下架，**人工核实**再处置；App 的 `REPORT_REASONS` 还没有它 —— 服务端先上，老版本只是少一项可选）。处置走 `services/takedown.service.js` 的 **registry**（按 targetType 注册，不再往 if-chain 加分支）；`instructorClaim` 另有**人工核实队列**（`GET/POST /api/tutor/admin/claims…`，见「老师人格」一节末尾），与这条通用队列同一张表、同一份处置正文（`services/reportResolve.service.js`，2026-09-29 从 `resolveReport` 抽出）：`persona` 只有 `takedown`（写 `Persona.takenDown:true, shared:false, takenDownAt / takenDownReason / takenDownBy`；作者看得见原因、看不见处置人；下架后作者不能再 `PUT { shared:true }`，`/api/tutor/market` 与详情对非作者 404，也不能再发布），`delete` 一律 400（人格是作者的资产，要删由作者自己 `DELETE /api/personas/:id`）。管理端列表的 `target` 多一种形状 `{ exists, personaId, name, kind, shared, takenDown, takenDownReason, author, createdAt }`。

能举报**三种对象**：作品（`video`）、评论（`comment`）、弹幕（`danmaku`）。
三者共用一张 `Report` 表与同一条处理流程（待处理 → 下架 / 删除 / 驳回）——
管理端要的是"一个按时间排的待处理队列"，拆三张表那个队列就得三查一合再排序。

### 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/branch/reports` | required | 提交举报 `{ targetType, targetId, reason, detail? }` → 201 `{ ok, report }`。重复举报 **409**。限流见下 |
| GET | `/api/admin/branch/reports` | **admin** | 举报队列。query `status`(默认 `pending`，`all` 看全部)、`targetType?`、`page`(默认 1)、`limit`(默认 20，上限 50) → `{ ok, items, total, page, limit, status, targetType? }` |
| PATCH | `/api/admin/branch/reports/:id` | **admin** | 处理一条 `{ action, note? }` → `{ ok, report, applied, alsoResolved }` |
| POST | `/api/admin/branch/videos/:id/takedown` | **admin** | 下架一条作品 `{ reason }`（**必填**）→ `{ ok, video }`。可撤销 |
| DELETE | `/api/admin/branch/videos/:id/takedown` | **admin** | 撤销下架 → `{ ok, video }`。**幂等**（对没下架的作品调也 200，后台重复点不该报错） |
| GET | `/api/admin/branch/takedowns` | **admin** | 已下架列表。没有它，"撤销"就是个找不到入口的功能 |
| GET | `/api/admin/branch/stats` | **admin** | `{ users, banned, videos, takenDown, comments, danmaku, pendingReports }`，全部 `countDocuments`。`banned` 是后加的键（被封禁用户数），老服务端不给 —— 客户端读不到画 `—`，别当 0 |

★ `reason` 必填不是形式：作品消失了还不告诉作者为什么，比不下架更糟（见 BranchVideo 的「平台下架」）。

★ `stats.pendingReports` 有**两种空**，客户端必须分开显示：
`null` = 这台服务端没有举报功能（老服务端），后台画 `—`；
`0` = 有举报功能、当前没有待处理的。把 null 当 0 显示就是在说"没有活要干"，而实情是"问不到"。

★ **硬删除没有另开管理路径**：`DELETE /api/branch/videos/:id` 已经放行管理员
（权限判据只有一处：`assertCanDelete`）。再开一条 `/api/admin/...` 的删除端点
就是同一条规则的第二处实现。

服务端实现：`models/Report.js` + `controllers/report.controller.js` +
`routes/report.routes.js`（**导出两个 router**，在 `app.js` 里挂两个前缀）。
★ 管理端那两条挂在既有的 `/api/admin` 门后面（与管 Idea/Leaderboard 那 8 条同一道门），
但**实现仍在 report.routes.js 一处** —— 举报的读写共用同一套序列化与同一份状态机，
拆进 `admin.routes.js` 就变成"加一个动作要改两个文件"（铁律六）。
★ 「谁是管理员」的判据只有一处：`utils/roles.js` 的 `ADMIN_ROLE` / `isAdmin`。

非管理员打后两条是 **403**，不是 404。★ 与作品可见性那边"一律 404"是两回事：
那边要藏的是"这条作品在不在"，这里路径本身就写在契约上、藏不住，而队列内容根本没返回，
403 一个字节的新信息都没多给。

⚠ 路径改动必须**两仓同时改**（app 侧只有 `src/api/admin.ts` 的 `PATHS` 一张表）。
真机上改错了**不会 404**：Capacitor 对未命中路径回 **200 + index.html**，
于是"服务端根本没这个端点"会伪装成"一条举报都没有" —— 所以客户端一律**判回包形状**，
不判状态码（`readPage` / `submitReport` 已经这么做了）。

### 一条举报（响应形状）

```
{
  _id, targetType, targetId,
  reason, detail,                      // detail 可空串
  status,                              // 见下「状态机」
  reporter: { _id, username, displayName, avatarUrl },
  handler: {…} | null, handledAt: ISO | null, handleNote: "",
  createdAt,
  // ↓ 只有管理端列表才有
  target: { exists, … },               // 见下「target 是现查的」
  reportCount, pendingCount            // 这个**对象**一共被举报几次 / 还剩几条没处理
}
```

`reportCount` 是管理员最需要的信号：**30 个人举报同一条 ≠ 1 个人举报 30 条**。
（后者不可能发生 —— 见下「去重」。）

★ 处理信息用 `handler` / `handledAt` / `handleNote`，**没有** `resolution` 字段：
"做了什么"已经写在 `status` 里了（`taken_down` / `deleted` / `dismissed`），
再开一列就是同一件事存两遍，早晚对不上。

### 理由枚举（`reason`）

| key | 中文文案（客户端渲染） | 队列 |
|---|---|---|
| `csae` | 涉及未成年人 | **插队**（`priority: 1`） |
| `porn` | 色情低俗 | |
| `violence` | 血腥暴力 | |
| `abuse` | 人身攻击 / 辱骂 | |
| `spam` | 垃圾营销 / 刷屏 | |
| `infringe` | 侵权 / 冒用他人作品 | |
| `other` | 其他（配合 `detail` 用） | |

★ 落库的是**英文 key**，中文只在客户端。存中文的话改一版文案就得写数据迁移——
与 @提及那边「身份存 userId、名字现查」同一条道理：key 是身份，文案是显示。
★ 这七个 id 在 server `models/Report.js` 的 `REASONS` 与 app `src/api/admin.ts` 的
`REPORT_REASONS` 里**逐字相等**。两仓不在一个 CI 里，对不上的表现是用户选了「人身攻击」
而服务端 400，或者管理员看到一个认不出来的 key —— 而那恰恰是他判断要不要下架的主要依据。
★ 客户端遇到**不认识的 key 原样显示**，不要退成"其他"：那会把一条真实的举报理由
悄悄改写成另一个意思（铁律七/八）。
★ `other` 不是凑数：分类枚举永远盖不全，没有兜底项时用户只会随便挑一个不对的，
管理员看到的分类反而更脏。`detail` trim 后 **≤ 500 字**，客户端输入框上限必须与它相等。
（2026-09-03：app 侧一度是 100 且没写理由 —— 举报人打到第 100 字被无声截断，而最需要
写清楚的正是 `csae` 那一类「哪一段、第几秒、为什么判断是未成年人」。已改回 500。）

### `csae` 与队列顺序（2026-09-03 加）

**`csae` 不是 `porn` 的子类。** porn 的处置是「这条要下架」，csae 是「下架 + 封号 + 留证 +
依法报告主管机关」——合成一个 key，它就躺在几十条刷屏举报中间，而这是唯一一类
「晚一天处理后果完全不同」的举报。这一项同时是 **Google Play 上架的硬要求**
（UGC 儿童安全标准：应用内要有报告 CSAE 的入口），对外承诺写在
<https://ideahubs.org/child-safety>：「这一类举报优先于其他所有举报进入人工复核」。

兑现那句话的是**服务端的排序**，三条一起才成立，缺一条整条链路白做且零报错：

1. `Report.priority`：**只由 `reason` 推导**（`pre("validate")`，`URGENT_REASONS` 里的记 1，
   其余 0），**不接受调用方传值** —— 能传的话举报者就能把自己那条顶到队首。
2. `GET /api/admin/branch/reports` 的 sort 是 `{ priority: -1, createdAt: -1, _id: -1 }`，
   索引 `{ status: 1, priority: -1, createdAt: -1 }` 与它逐字对齐（不对齐会退化成内存排序）。
3. **客户端不许再排一遍。** app 的管理页原来按 `createdAt` 重排，把 ① ② 整个丢掉 ——
   而那是唯一的人工复核界面。⇒ 顺序只有服务端一处（铁律六）。

★ 存量数据没有 `priority`：降序下缺字段排在所有数字之后，而队列本来就是 createdAt 降序、
存量记录本来就在底部 ⇒ 不写迁移也不会让任何一条待处理举报往下掉，唯一的变化是 csae 顶上来。
**这条推理依赖"降序 + 新的在前"，换成升序或"老的在前"就立刻不成立。**

★ 加新理由**服务端必须先上**：客户端那份是子集时只是少一项可选；反过来是用户选了一个
服务端不认的 key → 400，而他正要报的可能恰恰是最紧急的那一类。

**上线顺序是三步，不是两步**（官网那一环容易漏，2026-09-03 复核指出）：

1. **server** —— 先上。不先上，App 里选「涉及未成年人」就是 400。
   （App 侧已经典了一层兑子：`reportErrorText` 对 400 + reason 会说人话并给出路，
   但那是兑子，不是顺序可以反的理由。）
2. **App 发版** —— 带着 `csae` 那一项。
3. **官网 /child-safety** —— **最后**，且不得早于 ②。
   那一页写着「举报理由里有专门的『涉及未成年人』一项」与「这一类优先进入人工复核」——
   官网先发的话，这两句在那段时间里**就是不实陈述**，
   而它恰恰是 Google Play 儿童安全那一项要逐条核的网页。
   ⚠ 反过来也不能拖太久：向 Play 提交时这个网址必须已经活着。
   ∴ 实际做法是「服务端先上 → 官网与提交 Play 同一天」。

### 状态机

```
                 ┌─ action=takedown ─▶ taken_down   内容还在，但谁都看不到
pending ─────────┼─ action=delete   ─▶ deleted      连内容一起删，不可撤销
                 └─ action=dismiss  ─▶ dismissed    举报不成立，内容照旧
```

动作 → 状态的映射**只有一处实现**：server `models/Report.js` 的 `ACTION_STATUS`。

- 只能**从 `pending` 出发**。已处理的再 PATCH 一次回 **409**（两个管理员同时点，
  不判这一下就会走两遍下架、写两遍处理人，后写的把先写的悄悄盖掉）。
- 离开 `pending` 时 `handler` / `handledAt` / `handleNote` 三样**一起**写入。
- 请求体只收 `action`，**不收目标状态**（比如 `status: "taken_down"`）——
  收了的话客户端就能把一条举报标成"已下架"而没有任何内容被下架。
- `takedown` 与 `delete` 是**两件事**，状态必须分得开：事后追责时"下架了"和"删没了"
  完全不同。两者调**同一个**服务，差别只有一个 `hard` 标志（见下）。

★★ **`status` 是跨仓字符串，新增取值必须两仓同步**（铁律九：server 的
`models/Report.js` 的 `ACTION_STATUS` + app 的渲染分支 + 本节）。
**老客户端读到不认识的取值时，判据一律是 `status !== "pending"` 即已处理**——
判否定，不判等值（与 `visibility !== "private"` 同源）。写成
`status === "dismissed" || status === "taken_down"` 的话，将来加一个 `duplicate`
之类的取值，老包会把它显示成"还没人管"，用户于是反复重新举报（而重新举报会被 409
挡住，他只会觉得 App 坏了）—— 这一个字的错不会有任何报错。

### 去重：同一个人对同一个对象只能举报一次

`{ reporter, targetType, targetId }` **唯一索引**。第二次（哪怕换个理由）回
**409 `DUPLICATE`**，`details` 里带 `{ reportId, status }`，客户端据此显示
"你已经举报过这一条了，当前状态：…"。**不许把 409 吞成成功**：用户以为自己第一次
没点上，就会反复点，每一次都撞同一个 409。

★ 没有这条索引，一个人写个循环就能把待处理队列刷成一万条同一个视频，真正需要人看的
被埋在下面 —— 不需要任何漏洞，只要一个合法账号。服务端那次预检 `findOne` 只是为了给一句
人话；**并发下真正兜住的是索引**（两个请求同时到达时预检会双双扑空），两处缺一不可。

### 限流：两个窗口，都按【账号】

| 桶 | 窗口 | 上限 |
|---|---|---|
| `report:create` | 60s | 10 |
| `report:daily` | 24h | 50 |

超限回 **429**（客户端文案："举报太频繁了，过一会儿再试"）。

★ 按账号（`userRateLimit`）不按 IP：这条在 `requireAuth` 后面，按 IP 计等于"换个出口就重开
一桶"，同时又会让同一个 NAT 后面的真人互相抢额度（理由与发评论那条逐字相同）。
★ 两个窗口缺一不可：只有短窗的话，一天 1440 分钟 × 10 = 一万四千条照样能把队列埋掉；
长窗才是硬顶。唯一索引只保证"同一个人对同一个对象一次"，**挡不住**"一个人举报一千个不同对象"
—— 那正是这两个桶存在的理由。

### ★★ 提交端点**不校验对象存在 / 可见**

举报一个根本不存在的 id 也会 **201**。这是刻意的：任何"存在就 201、不存在就 404"的写法，
都会把这条端点变成一个**探测私密作品的旁路**——拿一串 id 挨个试，凭状态码就能把库里
有哪些作品、哪条评论属于哪条作品数出来（与 `assertVisible` 挡的是同一类，那边为此
把 403 全改成了 404）。而举报天然是"我刚才看到了这个东西"：看不见就没有举报入口，
校验换不来什么，却要在举报这边抄第三份可见性规则（铁律六）。

垃圾举报由三样兜住：① 唯一索引；② 上面两个限流桶；③ 管理端**现查**对象，
查不到就如实标 `target.exists = false`，一眼能筛掉。

★ 同理，请求体里**不收 `videoId`**（发了会被 zod strip 掉）。那是外部输入，伪造一个
别的作品 id 就能让管理员点去看错误的现场；评论/弹幕属于哪条作品由服务端按 `targetId`
**现查**，那份才是权威的（结果在 `target.videoId` 里回给管理端）。

### `target` 是**现查**的，不是快照

管理端列表里每条举报会把被举报对象**当场查出来**（按 `targetType` 分三批查，不是逐条）：

| targetType | `target` 字段 |
|---|---|
| `video` | `{ exists, videoId, title, cover, visibility, takedown, author, createdAt }` |
| `comment` | `{ exists, videoId, text, author, createdAt }` |
| `danmaku` | `{ exists, videoId, text, at, author, createdAt }` |

- 查不到一律给 `{ exists: false }`。★ 用**必给的布尔** `exists`，不用"缺省即正常"的
  `missing?`：后者一旦服务端漏给这一项，客户端读到 `undefined` → falsy → 显示成
  "内容还在"，管理员会对着一条早就没了的内容按下"下架"。缺省必须是**未知**，
  而未知在这里不该存在 —— 所以这一项永远显式给（铁律八）。
- `takedown` **原样带出**那一列（没下架就是 `null`），管理端据 `takedown.at` 存不存在
  显示"已处于下架状态"。★ 这里刻意不算一个 `takenDown` 布尔：怎么判一条作品下没下架
  由 server `branchVideo.controller` 的 `isTakenDown` 一处说了算，在举报这边再写一遍
  就是第三份判断（铁律六）。⚠ 队列里出现"已下架但还有待处理举报"是正常的 ——
  管理员也可以走 `POST /api/admin/branch/videos/:id/takedown` 直接下架，那条路不碰举报队列。
- **不存快照**。快照只能来自举报者的请求体（外部输入，伪造一段脏话栽赃谁都做得到），
  而管理员要看的本来就是**现在**的内容。
- `Report.targetId` 上**没有 `ref`**：一列同时装三张表的 `_id`，写死任意一个都会让
  populate 在另外两种类型上**静默返回 null**（不报错，对象凭空消失）。解引用按类型分派。

★★ **弹幕这一项会带出 `author`** —— 弹幕的作者是**存了的**（`BranchDanmaku.author`），
只是对普通用户从不透出（见上「弹幕」：对外只有一个 `mine` 布尔）。
这里是全系统**唯一**一处把它露出来的地方，成立的前提是**整个列表端点挂在
`requireRole(ADMIN_ROLE)` 后面**。哪天把它放开给普通用户（比如做「我的举报」），
**必须先把这个字段摘掉**，否则举报一次就能查出某条弹幕是谁发的，整面弹幕墙都被去匿名化了。

### 「下架 / 删除」调另一条线的服务，举报侧**不写一行清理逻辑**

下架要连带清理的东西一长串（评论树、点赞行、弹幕、指向它的通知、计数回写……），
抄一份必然漏掉一两样，而漏了不报错，只是库里留下一堆谁也查不到也删不掉的行（铁律六）。
所以举报处理只**调用**：

```js
// server/src/services/takedown.service.js —— 它自己也不写清理逻辑，
// 全部转调 branchVideo.controller 的 applyTakedown / purgeVideo / purgeComments
exports.takedownTarget = async ({ targetType, targetId, operatorId, reason, hard }) => { … }
//   hard=false → 下架（可撤销，内容还在但谁都看不到）    hard=true → 硬删除（不可撤销）
//   失败 throw；返回值原样放进响应的 `takedown` 字段
```

对应关系：`action=takedown` → `hard=false`，`action=delete` → `hard=true`。
成功时响应里 `applied: true`，并且**同一个对象上其余待处理的举报被一并收尾**
（内容都没了，剩下那些谁也处理不了），条数在 `alsoResolved` 里。
`dismiss` 既不调服务也**不**级联：不同人举报的理由可能不同，驳回"垃圾营销"
不代表"色情"也不成立。

⚠ **评论与弹幕没有可撤销的下架**（那两张表没有隐藏位），对它们用 `action=takedown`
会得到 **400**「请改用 action=delete」。★ 这是**故意不降级**的：悄悄替管理员把"下架"
办成"删除"，会让举报记录上写着 `taken_down`（可撤销、内容还在）而内容其实已经没了 ——
事后申诉时谁也说不清发生过什么，且一个错都不报。

★★ **任何一种失败（服务抛错、400、以及服务整个不存在时的 501）都不写状态**：
举报原地留在 `pending`，管理员可以重来。把状态标成 `taken_down` 而内容还挂在首页上，
是这一整块里最坏的一种失败 —— 管理员以为处理完了、举报者以为被受理了，
而那条内容一直在线且全程零报错（铁律八）。客户端必须把这几种失败都当成"没处理成"
来显示，不能吞掉、更不能把那一行从列表里摘掉。

服务文件缺失时（部署漏了文件之类）回：

```
501  { ok:false, code:"TAKEDOWN_UNAVAILABLE", details:{ reportId, status:"pending", action, applied:false } }
```

回归测试 `server/tests/report.spec.js`（R1–R12，13 条）。★ R11 / R11b 一律**看内容**
（作品是不是真的 404 了、评论是不是真的从列表里没了），不看状态字段 ——
"状态对、内容没动"正是这块最需要防的失败。

## 管理员：用户与内容管理

全部挂在既有的 `/api/admin/branch` 前缀下（与举报队列 / 下架同一道
`requireAuth + requireRole(admin)` 门）。服务端实现：`controllers/branchAdmin.controller.js`
（复用件全部来自 `branchVideo.controller` / `branchAsset.controller`，清理与序列化只有一份）。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/branch/users` | 用户列表。query `page`(默认 1)、`limit`(默认 20，上限 50)、`q`（username/displayName 子串，大小写不敏感）、`role`（`user`\|`company`\|`admin`）、`banned`（`"1"` 只看被封 / `"0"` 只看没封）→ `{ ok, items, total, page, limit }`。筛选值拼错回 **400**，不静默当成"不筛" |
| POST | `/api/admin/branch/users/:id/ban` | 封禁 `{ reason }`（**必填**，≤500 字）→ `{ ok, user }`。**拒绝封禁管理员（403）**。重复封禁不报错（覆盖成最新原因） |
| DELETE | `/api/admin/branch/users/:id/ban` | 解封 → `{ ok, user }`。**幂等**（对没封的人调也 200） |
| DELETE | `/api/admin/branch/users/:id` | **硬删账号 + 级联，不可逆** → `{ ok, removed }`。**拒绝删除管理员（403）** |
| POST | `/api/admin/branch/users/:id/notify` | 发平台通知 `{ text }`（必填，1~500 字）→ 201 `{ ok, notificationId }`。落一条 `ADMIN_NOTICE` |
| GET | `/api/admin/branch/videos` | 作品钻取。query `page`/`limit`/`q`（标题子串，或作者 username/displayName 子串）/`takenDown`(`"1"`\|`"0"`) → `{ ok, items, total, page, limit }`。**私密与已下架都列得出来**（后台要看得全），序列化带 `takedown.by` |
| GET | `/api/admin/branch/comments` | 评论钻取。query `page`/`limit`/`q`（正文子串）/`videoId` → items：`{ _id, text, author, video:{_id,title}\|null, parentId, likes, createdAt }` |
| GET | `/api/admin/branch/danmaku` | 弹幕钻取。query 同上 → items：`{ _id, text, at, color, author, video, createdAt }` |

删除内容**不在这里另开端点**：删作品/评论/弹幕走各自既有的 `DELETE /api/branch/...`
（`assertCanDelete` 已放行管理员）；下架/撤销走上面「举报」一节列的两条。

### 用户列表的一条（DTO）

```
{
  _id, username, displayName, avatarUrl, role, createdAt,
  email,                 // ★ 打码版（"s***@example.com"），永远不回全文
  phone?,                // 打码版（"138****5678"）；没绑手机就没有这个键
  videoCount, commentCount,
  banned?: { at, reason } // 有这个键 = 被封；没有 = 正常（与 takedown 同一种给法）
}
```

★ **email/phone 只回打码版**：管理员列表的用途是「认出这个人、看状态」，全文 PII
在这里没有用途，却会把泄露面从「数据库被攻破」扩大到「任何一个管理员账号被钓走」。
★ `banned` **不带 `by`**（是哪个管理员封的只进库与操作日志），与 `takedown.by`
不透给作者同一条理由。

### 封禁的语义（★ 与内容处置**两权分开**）

- 封禁挡的是**登录与一切带 token 的请求**：
  - 登录（密码/OTP/OAuth 全部路径，收口在 `signToken`）→ **403 `code:"BANNED"`**，
    `message` 里带原因（形如 `账号已被封禁：<reason>`），可直接展示给用户；
  - 已发出去的 token（`requireAuth`）→ 同样 **403 BANNED + 原因**，封禁**立即生效**
    （requireAuth 每次请求从库里重读用户，不用等 token 过期）。
  - `optionalAuth` 的公开端点：被封的人**当匿名**处理（看得见公开内容，做不了带身份的事）。
- ★ 客户端必须区分 401 与 403 BANNED：401 的处置是「登出重登」，封禁重登也没用 ——
  收到 `code:"BANNED"` 时把 `message` 展示出来，不要把人踢回登录页转圈。
- **封人不隐藏其内容**。内容要下架/删除，走每条内容自己的端点。合成一个开关的话，
  解封一个改好了的人会连带把他真正违规的内容一起放出来；封人时全量藏内容又会把他
  没问题的作品也一起消失。两把开关，各管各的。
- 解封 = `$unset` 整个 `banned` 子文档（判据是 `banned.at` 的有无，与 `takedown` 同构）。

### 删除账号的级联（服务端一处实现：`purgeUserCascade`）

删：作品（逐条走 `purgeVideo`，连带该作品下所有人的评论/点赞/弹幕/通知）、
他发在别人作品下的评论（逐条走 `purgeComments`，连带楼中楼回复与点赞）、弹幕、
他点过的赞（并重算受影响作品/评论/卡片卡组的计数快照）、卡片与卡组（含卡组的
计数行与别人对它的赞）、举报（他提的 + 指向他内容的）、token 流水与订单、
关注关系（双向）、通知（他收的 + 他触发的）、搜索记录、用户本体。

**刻意不删**（不是遗漏）：`PointsLedger`（复式记账，删一侧对手方永远配不平）；
卡片的全局计数（`kind:"card"` 按 cardId 跨用户聚合，删了会清掉别人手里同一张卡的热度）；
ideas 产品线的内容（那边有自己的软删除体系，混着做一半更糟 —— 已知未尽事项）。

回包 `removed` 逐项带条数（`{ videos, comments, danmaku, likesGiven, …, user }`），
UI 把它显示出来 —— 「删了个寂寞」必须有症状。

★ UI 要求**输入用户名**做二次确认并把后果说全（不可逆、连带内容清单）；
服务端不收确认字段 —— 确认是交互，权限与后果才是服务端的事。

### `ADMIN_NOTICE` 通知

类型契约见上「通知（分支视频）」一节：`payload = { text }`、无 `actorId`、无 deeplink；
**未知通知类型客户端必须降级显示**（通用「系统通知」行），不许崩、不许 filter 成不存在。

回归测试：`server/tests/branchAdminUsers.spec.js`（U1–U6）。

## 随作品发布的卡组（`deck`）

`{ name, cards: [{ cardId, type, name, summary, cover, tags, views? }] }`，**内嵌快照**，
不是对 `BranchCard` 的引用——作者事后删掉自己库里的卡，已发布作品里的卡组不能跟着少张。

- 客户端 `Card.id` 落库统一叫 `cardId`（与 `BranchCard` 对齐），两个名字服务端都收
- `cards[].cover` 与帧字段走同一套转存（dataURL → Cloudinary）
- `cards[].views` 已经是永久 URL（客户端在加图那一刻就转存过了），**不需要**再转存一遍。
  ⚠ 这份快照是**作品**的，不是 `BranchDeck` 的那份 —— 两套 schema 各存各的，
  要声明的是 `models/BranchVideo.js` 的 `deckCardSchema` **加上** controller
  `transferDraftAssets` 里那份**字段白名单**（`deckCardBody` 是 `.loose()`，zod 放行，
  真正丢字段的是这两处）。漏掉的表现：观众把这套卡组装走之后卡还在、形象参考没了，
  炼出来的人物不是同一个人，而且一点错都不报。用例：`branchVideoVisibility.spec.js` V3b
- 无卡组时响应里**没有** `deck` 键，不会给一个空对象

★ 这个字段在 2026-08-10 之前是**发得出、存不下**的：`publishBody` 的 zod schema 没声明它，
`z.object` 默认 strip 未声明字段，于是客户端发了、服务端 201 了、读回来是空的。
往 DraftVideo 里加字段时记得同步这份 schema。

## 资源转存（关键）

客户端传来的 `cover` / `segments[].firstFrame` / `lastFrame` 可能是 **dataURL**（Seedream 出图落地的 base64），
`videoUrl` 是**火山方舟 TOS 的临时链接（约 24h 过期）**。发布时服务端必须转存：

1. dataURL → 解码 Buffer → `uploadToCloudinary(buffer, "branch-frames", userId)` → 得到永久 URL
2. 方舟 videoUrl → 服务端 `fetch` 下载 → Cloudinary `upload_stream({ resource_type: "video" })` → 永久 URL
3. 已经是 http(s) 且非方舟域的 URL → 原样保留

转存失败的单个资源降级并记录 warn，不阻断整条发布。降级规则视频与卡片**共用一套**
（环境变量 `BRANCH_INLINE_FALLBACK_MAX`，默认 512KB）：小于阈值的 dataURL 原样内联落库，
超过就丢弃置空——否则没配 Cloudinary 时每条记录都带着 MB 级 base64，
`GET /cards` 一次性返回全部卡面会撑出几十 MB 的响应体。

## 回炉重做（已发布作品换内容）

一句话：作者把发布时那份**工坊画布**留在服务端（`BranchProject`），之后能取回工坊改一改，
再走 `PATCH /api/branch/videos/:id` **替换原作品的内容** —— 同一个链接、同一批互动数据。

### 判据与并发

- **带了 `segments` / `branchTree` / `deck` 任意一个 = 回炉**；一个都没带 = 改壳（行为一字未变）。
- 回炉必须报 `baseRevision`（客户端手上那份内容基于作品的哪一版）。
- ★★ **`branchTree: null` = 「这一版没有分支树」**，与「不带 `branchTree` 这个键」（= 保留库里那棵旧的）
  是两件完全不同的事，服务端把 null 翻成 `$unset`。剪辑页的「合并导出」正是把互动作品改成
  `{segments:[merged], branchTree: undefined}` —— 少了这一档，作者把互动作品剪成线性再点
  「替换原作品」，segments 换了、revision 涨了、弹幕清了、通知发了，而**观众看到的还是旧互动内容**
  （播放端是 `part.branchTree ? 分支 : 线性`），全程零报错。
  ⇒ 客户端在回炉体里**恒发**这一格（没有分支树时发 `null`）。
- ★ 同一形状的第二处：**`deck: { name: "", cards: [] }` = 「这一版不带卡组」**（发布页那颗
  「随片带上这套卡」关掉时发的就是它），服务端翻成 `$unset deck`。不发这一格 = 保留旧卡组。
- **并发支点只有一个：`BranchVideo.revision`**。条件更新 `{ _id, author, revision: baseRevision }`
  匹配不上就是 409，**一个字都没写进去**（弹幕不清、通知不发、资产不回收）。
  ★ 条件更新**之前**还有一道同判据的**预检**（读一次 `revision` 就比）：资产转存排在条件更新
  前面，而 409 是这套设计明确期待会发生的 —— 不预检的话每撞一次就把整批刚转存上去的成片
  漏成孤儿（既不在任何 `assetUrls` 里，也没落 `PendingAssetPurge` 句柄，清扫器永远收不到）。
  预检**不能**代替条件更新（两句之间照样能被抢跑）；真在窗口里被抢跑的那一发，409 分支会把
  本次新转存的地址交给清扫器再抛。
- ⛔ **并发 ≠ 陈旧**，这两件事各有一道闸：`revision` 挡并发（两台设备同时提交），
  `BranchProject.videoRevision` 挡陈旧（画布是第 1 版、线上已经是第 2 版）。只有前者时，
  一份陈旧画布配上现读的 `baseRevision` 会被正常接受，把线上内容**静默退回上一版**。
  ★ 老作品库里没有这个字段：`baseRevision = 0` 时同时认 `{revision: 0}` 与 `{revision: {$exists:false}}`。
- 成功后 `revision` 自增、`revisedAt` 置为当下，两者都在回包的 `video` 里。

### 错误码（`message` 都是给用户看的整句中文，客户端**原样显示**）

| 状态 | code | message | 说明 |
|---|---|---|---|
| 400 | `REVISE_PAID` | 这条作品设为按分集收费，不能换内容。 | 付费作品 |
| 400 | `REVISE_TAKEN_DOWN` | 这条作品已被平台下架，下架期间不能改内容。 | |
| 400 | `REVISE_LOCKED` | 这条作品暂时不能改内容，请稍后再试。 | 有待处理的举报。★ 措辞里**刻意不出现「举报」「复核」**：告诉作者"你正在被复核"，他的最优解不是回炉（已被挡）而是**直接删掉作品**，管理员打开只剩 `target.exists=false` —— 比回炉规避更糟 |
| 400 | `REVISE_NO_BASE` | 请求缺少版本号，请更新 App 后再试。 | 带了内容字段却没报 `baseRevision` |
| 409 | `REVISE_CONFLICT` | 这条作品在别的设备上也改过（服务器上已经是第 N 版）。你这一版没有提交。 | 回包带 `details.currentRevision` |

### 服务端顺带做的四件事

1. **资产差量回收**：`gone = 旧地址 - 新地址`，逐条过归属判定与 **in-use 反查**，才落 `PendingAssetPurge` + destroy。
   ⛔ 不是「全删再重来」：5 段只改 1 段时另外 4 条 URL 逐字相同，全删会当场删掉还在用的段。
   ⛔ 卡组资产**一条都不回收**（卡面是按 URL 复制进别人库里的）。
2. **清空该作品的弹幕**（带了 `segments` 或 `branchTree` 时；只带 `deck` 不清）。
   `BranchDanmaku.at` 是**全片累计秒**、没有段落锚点，换内容后每一条都会盖在对不上的画面上且零报错。
   ★ 客户端必须在确认卡上**提前**告诉用户会删掉多少条，不是事后。
3. **`BRANCH_REVISED` 通知收藏者**（见上「通知」）。
4. 把这份工程标成 **`stale: true`**。
   ⛔⛔ **绝不**把 `BranchProject.videoRevision` 顶成新版次：画布正文此刻还是**上一版**的，
   要等客户端随后 PUT 才换，而那一发 PUT 是即发即忘的（断网/配额/待办缺失任一档都会让它不发生）。
   盖章之后库里留下「canvas=第 1 版正文、videoRevision=2」这种自相矛盾的行，
   之后**谁也看不出它陈旧了** —— 客户端拿它和作品 revision 一比正好对上，就着旧画布提交，
   线上内容被静默退回上一版，全程 200 零报错。
   ⇒ `videoRevision` 留在旧值（它此刻说的正是实话），只能靠 `PUT /projects/by-video/:id` 往前走。

### in-use 反查与 `assetUrls`（**上线顺序的硬要求**）

`BranchVideo.assetUrls` = 这条作品占用的全部云端地址（封面 + 各段首尾帧与成片 + 分支树里的每一段），
在**每一条会写 `cover` / `segments` / `branchTree` 的路径**上整份重写，带索引 —— 一共三处：
`createVideo`、`reviseVideoContent`、以及**改壳分支里改封面的那一支**（`updateVideo`，2026-09-07 补）。
漏了第三处会同时错两个方向：旧封面永远留在 `assetUrls` 里挡着回收（零报错的存储泄漏），
新封面进不了 `assetUrls`（别的作品被删/回炉时查不到本条在用它 → 被 destroy → 观众端黑屏）。
它存在的唯一理由是反查「这条地址还被别的作品引用着吗」——
`branchTree.nodes` 在模型里是 **Map**，按 `"branchTree.nodes.x.segment.videoUrl"` 这种点号路径查
**永远拿到空且零报错**，而互动作品的分支段恰恰只挂在那儿。

⚠⚠ **上线顺序**：① 服务端上线（新端点对老 App 是死代码）→ ② **立刻**跑
`npm run backfill:asset-urls` 并确认 `countDocuments({ assetUrls: { $exists: false } }) === 0`
→ ③ App 发版 → ④ 官网发版。
漏了 ② 的后果：删掉/回炉一条新作品会 destroy 掉一条老互动作品分支段还在用的资产，
**老作品当场黑屏、观众端零提示、不可逆**。

### 新旧版本兼容

| 组合 | 行为 |
|---|---|
| 老 App（≤v2.45）× 新服务端 | 老 App 的 PATCH 只有七个壳字段，`$set` 碰不到 `segments` —— **不会误改内容**（安全）。它读到 `revision` / `revisedAt` / `assetUrls` 只是多几个不认识的键。⚠ 但它**收不到** `BRANCH_REVISED`（见上），对未升级用户观众知情为零 |
| 新 App × 老服务端 | 老服务端的 `z.object` 把 `segments/branchTree/deck/baseRevision` 全 strip，返回 **200 且内容一字未改**。⇒ 客户端**必须**用回包的 `revision` 是否等于 `baseRevision + 1` 来判整发失败，不能只看状态码 |
| 新 App × 新服务端 × 老作品（无 `revision`） | `baseRevision = 0`，走 `$or` 那条分支。判否定：没有 `revision` = 从没回炉过 |

### 本版明确不做

不做版本历史（只留一份最新工程 + 一个计数）、不做三方合并、不做举报内容快照
（只把 `revision` / `revisedAt` 露给管理员：知道"改过 N 次"，看不到改了什么）、
不做「把我这一版另发成新作品」的逃生门（那会让两条作品逐字共享同一批资产）。

## 白模模板（blockout r2v）

白模模板 = 一段"白模视频"（人物是无五官的白色人偶、场景/运镜是原样的）+ 配方。套用者
出片走方舟 r2v（`omni_reference_task_type:"edit"`）整段复刻场景与运镜、只换主体。
方舟 r2v 的 `video_url` **只收 URL / asset://，没有 base64 选项** —— 参考视频必须先有
公网地址，所以上传是建模板的硬前置，不是可选项。

**两条进货渠道，别合并**（2026-08-15 起）：

| | V1：自带白模片 | V2：白模化（blockoutize） |
|---|---|---|
| 作者手上有什么 | 已经做好的白模预演视频 | **任意实拍/成片** |
| 怎么建 | 上传 → `POST /templates` 登记 | 上传 → 编辑页框选一段并裁掉水印 → `POST /templates/blockoutize` |
| 花不花 AI 的钱 | 不花 | **花两次真钱**（看帧认人的 chat + 一次真实付费出片） |
| 角色位 | 无（整段只有一个主体） | 有（`roles[]`，套用者逐个人偶挂卡；标记有编号/序数两种方案，见下） |

生命周期（服务端 `status` 是权威）：

```
上传素材（回执复核，① 号窗口）
  → V1: 登记 /templates          ┐
  → V2: 白模化 /templates/blockoutize ┘ → status=pending
  → 【V2 多一道】作者核对角色位（PATCH /templates/:id/roles，labelConfirmed=true）
  → 作者自己付费用它出一次片（服务端置 provenAt —— 试炼闸）
  → 发布 PATCH /publish（**两道独立的门**：provenAt 非空 + 角色位已核对）→ status=published 上市场
  → 平台下架 = blocked（作者 publish/unpublish 都动不了）
```

### 角色位标记有两种方案（2026-08-17 起并存，**判据是 `markSlots` 的存在性**）

| | 编号方案（存量，2026-08-17 之前建的） | 序数方案（新建的） |
|---|---|---|
| 人偶长什么样 | 白色，头上印阿拉伯数字 | **全都一模一样的纯白色**，身上什么都不印 |
| `roles[].label` | `"1"`/`"2"`/`"4"`（稳定但不连续） | 序数措辞（`"最左边"`/`"从左数第3个"`/`"最右边"`） |
| `markSlots` | **没有这个键** | 有（这段视频里的位置清单，逐字、按画面从左到右升序） |
| 套用提示词 | `把带编号的白色人偶替换为对应角色：编号1=张三。`＋**必须**有一句「把编号全部去掉」 | `按画面里从左到右的位置替换白色人偶：最左边=凛、从左数第3个=张三。`，**没有**擦除句 |
| 挂卡指令的书写顺序 | 不参与语义（模型按号找人） | **★★★ 承重**：必须按位置从左到右升序，见下 |
| 没挂卡的人偶在成片里 | 白色（看起来像风格化） | 白色（人偶本来就是纯白的，同样像风格化） |

三代的实测复盘：

1. **编号**：5 个角色位从来没有一发 5/5 全对（最好 4/5，还带重号，实出过 2/2/1/1/5）；
   "头部四面各印同一个数字"**从没被执行过**（每发只印一面，哪一面还不可控）；编号会被逐帧
   原样复刻进成片（实拍：换上去的角色后脑顶着「1」）。根因是这个模型把数字当"贴在当前
   这一帧上的二维贴纸"、**不维持跨帧对象恒等性**，而"任意角度读到同一个号"恰恰要求它。
2. **一位一色**（2026-08-16 上线、2026-08-17 整档删除）：消掉了上面两个老毛病，但白模化那一步
   要模型**同时维持 5 组"人↔颜色"绑定**，命中率只有 ~57%（7 发 4 发全对），失败形状高度一致
   （画面正中央那个"最像主角"的没被抹掉、相邻两色互换）。⚠ 它**从没产出过任何线上模板**
   （`markColors` 非空的文档数 = 0、在途凭据 = 0），所以直接删掉、不留运行期分支、零 DB 迁移。
3. **全白 + 序数**（现行）：把"做出区分"换成"**不要有任何区分**"—— 不需要维持任何绑定。
   白模化提示词 406 字（彩色版 590），实测是所有版本里**抹得最干净的一版**（无头发/五官/
   衣服/记号）。套用侧用序数指认：2 组 2/2、复跑 2/2、5 组满负载 5/5、3 组跳着挂 + 留 2 个空位
   5/5 —— **升序累计 12 组绑定零错误**。

⚠ **★★★ 最要害的一条跨仓规则：挂卡指令必须按位置从左到右升序书写。** 同样 3 张卡、同样
3 个目标位置、同样 2 个空位，只把书写顺序从 (第2→最右→第3) 改成 (第2→第3→最右)，结果从
**2/5 变成 5/5**（乱序那一发还多出一个重复角色）。机理：这个模型是在**对齐两个序列**
（指令序列 ↔ 画面从左到右的序列），不是在解析符号。⇒ **`markSlots` 的下标顺序就是这条规则的
依据**，服务端必须按画面横向位置升序发，App 拼提示词前必须 `markSlots.indexOf(label)` 排一次
（唯一实现 `src/studio/blockoutPrompt.orderSlots`）。App 侧还有一道运行期闸 `orderKept`：豆包
改写后若把先后顺序打乱，整句拒 + 给骨架。

⚠ **序数独有的一条失效模式**（编号/颜色都没有）：**删掉一个角色位之后，它右边那些位子的
序数会变** —— 序数是相对说法，不是印在人身上的记号。核对面板必须明说这一条（App 侧已做）。
同理，白模化漏掉的路人也会被换成白人偶，他与角色位长得一模一样，还会把右边所有位子挤歪一位。

⚠ **但这不是"修好了"**：白模化那一步仍然会漏人（最常见的还是画面正中央那个"最像主角"的）。
作者核对 / 删位 / 改位那一整套机制是**兜底**，必须保留。

⚠ **发布顺序：先切服务端，App 紧跟**（与颜色那一代相反，理由是这次两边的字段名不同）。
服务端上线即开始回 `markSlots`；窗口期内**用老 App 建的序数模板**会被判成编号方案，写出
`编号最左边=凛` —— 那句话**一眼就是坏的**（这正是"`label` 直接装措辞 token"而不是
"label 留序位数字 + 另加一个方案枚举"换来的好处：后者会写出一句看起来完全正常的
`编号3=凛`，用户不会起疑，钱花完才拿到一段换错人的片子），而且出现在**花钱之前**的可编辑
输入框里，更新 App 即恢复。窗口期内建模板的只有我们自己，可接受；但窗口期内**不要对外
宣传白模模板**。

### 两套验收窗口（V2 起分家，混用哪一个都不报错、只会静默出事）

- **① 原始素材**（用户传上来的那一份）—— 唯一实现 server `middleware/upload.js` 的
  `templateSourceIssue`；调用方只有上传口。
- **② 参考视频**（真正喂给方舟的那一段）—— 唯一实现同文件的 `templateRefIssue`；
  调用方三处：V1 登记复核、V2 裁剪后复核、V2 **白模化产物**转存后复核。

| 项 | ① 原始素材 | ② 参考视频 | 出处 |
|---|---|---|---|
| 格式 | mp4 / mov | （同左，格式在上传口就定了） | 方舟 r2v 官方只认这两种（webm/ogg 会拖到付费出片才 400） |
| 大小 | **≤ 100MB** | — | V2 传的是任意实拍，一分钟 1080p 就 60MB 级。⚠ nginx `client_max_body_size` 必须 **≥110m**，否则请求根本到不了 Node（用户看到 nginx 的 413 静态页，服务端日志一条都没有） |
| 时长 | **(0, 600]s** | **[4, 30]s** | 上限 600 只封上传/存储成本；[4,30] 是方舟 `edit` 子任务硬窗口（F1 实测原文 "the video selected must satisfy the duration requirement of 4 to 30 seconds"） |
| 边长 | ≥ 300px（**无上限**） | [300, 6000]px | 裁剪框不可能比原片大 ⇒ 下限是必要条件，早拒省一次 100MB 白传；上限只对裁后那块有意义（4K/8K 原片没问题） |
| 宽高比 | **不校** | [0.4, 2.5] | 比例正是裁剪框能修的那一项（16:9 原片裁出竖版完全合理） |
| 宽×高 | ≥ 407,696px | ≥ 407,696px | 2026-08-14 A2 探针实测的**像素数硬门**（官方文档没写，方舟直接拒单）；裁剪面积 ≤ 原片面积 ⇒ 对原片也是必要条件 |

⚠ **V1 时代那套 `[4,15]s / ≤20MB / 上传口校宽高比` 已作废**（2026-08-15）。旧值继续写在
上传口的话，一段 3 分钟的素材连传都传不上来，而它裁出来的 8 秒完全合格 —— 用户根本没法开始。
App 侧 `src/api/uploads.ts` 的预检是省用户一次白传的**镜像**，改窗口两边一起改。

### 发布成片直传（`POST /api/uploads/media/sign` + `/confirm`，2026-09-06）

发布作品时的成片（剪辑页导出的 webm/mp4）不再整份经服务器：客户端先 `POST /api/uploads/media/sign`
拿票（`{ uploadUrl, publicId, params, chunkBytes, maxSizeBytes }`，形状与 `/template-video/sign` 完全一致），
按 `chunkBytes` 分块直传 `api.cloudinary.com`，再 `POST /api/uploads/media/confirm { publicId }` 验收，
回 `{ ok, mediaUrl, publicId, bytes, duration, width, height }`，作品里 `segments[].videoUrl` 填 `mediaUrl`。

- 为什么：老路 `POST /uploads/media` 是整份 multipart 经 Cloudflare（125 秒读超时）→ nginx 收完整个
  body → Node 同步等 Cloudinary（100 秒），慢网上 10MB 级成片经常一个字节都到不了 Node，而客户端只能
  在 180 秒上限上放弃（2026-09-06 真机）。分块直传后每块各自超时、断了只重传那一块。
- 安全面与模板直传同一套：`public_id` 服务端生成并签进签名（目录 `ideahub/workshop-media`，形状
  `<userId>-<ts>`，归属判据 `ownWorkshopMediaPublicId`）、`overwrite:false`、`allowed_formats=mp4,webm,mov`、
  元数据以服务端 `api.resource` 取回为准；验收不过（格式 / 超过 100MB）当场 destroy 并 400。
- 限流：`/sign` 走 uploads 通用桶（20/分），`/confirm` 5/分（每发打一次 Admin API）。
- 老路 `POST /uploads/media` 保留（旧版 App 只认它，上限仍 20MB）；新版 App 在 `/sign` 回 404 时退回老路。

### 素材上传与回收

#### 默认路：客户端签名直传 Cloudinary + 分块（2026-08-22 起）

**为什么不走我们自己的服务器**：`Cloudflare 的 Proxy Read Timeout = 125 秒`，而 nginx 默认
`proxy_request_buffering on` —— 要把整个 body 收完才回包。于是整段上传期间 CF 看到的是
「源站零响应」，125 秒一到就掐断（nginx 记 **499**，客户端只拿到一个**没有状态码**的 fetch 失败）。
三发连续复现 `rt=125.006 / 125.005 / 125.006`。⇒ 老路的真实上限**不是那个 100MB，是「125 秒内
能推上去多少」**（实测手机 5G 上行 0.126MB/s ⇒ 约 15MB）。这个 125 秒**只有 Enterprise 套餐能调**。

**两步：**

`POST /api/uploads/template-video/sign`（requireAuth；限流与老路**共用同两个桶**：3 次/分 + 10 次/天）
响应：`{ ok, uploadUrl, publicId, params, chunkBytes, maxSizeBytes }`
- `params` 是要**原样逐字段转发**给 Cloudinary 的表单字段（`allowed_formats / overwrite /
  public_id / timestamp / api_key / signature`）。客户端**不许自己拼、不许增删**：多签一个没发、
  或发了一个没签，Cloudinary 都只回一句 `Invalid Signature`，那是最难查的一类错。
- 客户端把 `file` 与 `Content-Range: bytes <start>-<end>/<total>`（end 是**闭区间**）、
  `X-Unique-Upload-Id`（同一次上传的每一块用**同一个**值）加进去，POST 到 `uploadUrl`。
  除末块外**每块必须 > 5MB**（`chunkBytes` 由服务端下发）；中间块回 `{done:false}`，
  **只有末块**回完整资产。一块就装得下时走普通上传，不带那两个头。
- 同一张签名可用于该次上传的**所有块**（实测），有效期 1 小时；**同一块可以原地重传**
  （实测幂等，字节数不会重复累加）—— 断线时只重传那一块。

`POST /api/uploads/template-video/confirm`（requireAuth；限流 **5 次/分**，独立于 uploads 桶）
body：`{ publicId }`。响应与老路**逐字相同**（有测试比对字段集合）。
- 服务端拿 `publicId` 走 `cloudinary.api.resource(..., { media_metadata: true })` **自取**元数据，
  **客户端报的数一个都不信**（它现在能直接和 Cloudinary 对话，回执完全可以伪造，而时长正是
  r2v 的计价输入）。验收 = 格式/体积（`templateVideoFormatIssue`）+ ① 号窗口（`templateSourceIssue`）。
- 不过就 `destroy` 再 400；但 **destroy 前必须先问 `templateVideoInUse()`** —— 否则这个端点
  就成了客户端可点名的删除原语（拿一个已登记已发布的参考视频去 confirm，落在窗口外就被删掉）。

**三条防线（都在服务端，缺一条就有绕行路）：**
1. `public_id` 由服务端生成并**签死**，形状必须正好是 `ideahub/template-videos/<userId>-<digits>`。
   客户端能自选 = 能覆盖任何人的资产。请求体里塞 publicId/folder/overwrite 一律无效。
2. `overwrite: false` **进签名**：签名 1 小时可复用，不锁的话用户能在模板过审发布后用同一张票
   把内容**原地换掉**（DB 一个字段都不动、零报错）。实测过攻击成立，也实测过这一项挡得住。
3. `allowed_formats` **进签名**：Cloudinary 算签名时**排除 `resource_type`**（它只在 URL 路径里），
   所以一张 `/video/upload` 的票改成 `/raw/upload` 照样有效 —— 实测把 HTML 传进了我们的可信域，
   而那类资产我们三处 destroy 全写死 `resource_type:"video"` 且不带扩展名，**永远回收不到**。

#### 退路：老的一次性上传（**保留不删**）

已经装在用户手机上的旧版 App 只认它；新版在 `/sign` 回 404 时退回这条（**判回包形状不判状态码**）。

`POST /api/uploads/template-video`（requireAuth；FormData 字段名 `video`；
限流按账号 **3 次/分 且 10 次/天** 两桶串联）。

响应：`{ ok, url, publicId, duration, width, height, bytes, maxSizeBytes }`。
`duration/width/height/bytes` 是服务端从 Cloudinary 上传回执读出的值（整数秒），
**只是给客户端显示与预检报价用的镜像**；结算锚点是建模板/白模化时服务端再向 Cloudinary
现查的那一次（`media_metadata: true` 必须带，见下）。服务端**不收客户端报的任何元数据**。

回执复核走 **① 号窗口**；不过：服务端**先 `uploader.destroy` 回收再 400 整句拒**
（不留半成品，也不永久占配额）。

`DELETE /api/uploads/template-video`（requireAuth；body/query 传 `publicId`）——
回收**未登记成模板**的托管视频（孤儿治理）。归属钉在 `public_id` 前缀
（`ideahub/template-videos/<userId>-<ts>`，唯一实现 `utils/templateVideoAsset.js`），
只能删本账号传的；**两种引用都整句拒**：`refVideo.cloudinaryPublicId`（参考视频本体）
与 `source.publicId`（V2 的原始素材，删了模板还能用但再也重做不了）；幂等
（资源已不存在也回 `ok:true`）。App 侧在「放弃提取」与「删除未登记模板」两处调。

客户端判「这台服务器有没有白模模板能力」：探 `GET /api/branch/templates/shared`，
判**回包形状**（`ok:true` + `templates` 数组），绝不判状态码 —— Capacitor SPA 回退
恒 200 + HTML，老服务端对该路径回 JSON 404。唯一实现：App `src/data/templates.ts`
的 `remoteTemplatesCapable()`。探不过 → 上传入口不渲染（不摆永远点不动的开关）。

### 模板实体（`BranchTemplate`）

```
{ _id, id(字符串化的 _id，两个都回), ownerId(身份判定唯一依据), authorName(显示快照，会过时),
  title, intro, coverUrl(https 或空串，zod 拒 dataURL),
  recipe: { styleHint, beats[], durationSec, videoTier, aspect?, framePrompt },   // 经典降级路的镜像
  refVideo: { url, durationSec, width, height, bytes },   // ★ 服务端从 Cloudinary 写入的登记值
  roles?: [{ label, desc, labelConfirmed }],  // ★ 白模 V2 的角色位；**只在真有的时候才出这个键**
  markSlots?: ["最左边","从左数第2个","最右边"], // ★ 标记方案位：**存在 = 序数方案，缺失 = 编号方案**；顺序 = 画面从左到右（升序排序的依据）
  markBoxes?: [{ cx, cy, w, h }],             // ★ 与 markSlots **按下标对齐**的画面框（归一化 0~1000）；长度必须相等，否则客户端整份丢弃
  markBoxAtSec?: 2.4,                          // ★ 那些框量自第几秒（没有它，框就是一组没法核对的数）
  // ── markBoxes 这一对是怎么来的（2026-08-17 起，服务端 finish 的 ⑧b）──────────────
  //  · 量在**白模化产物**上，不是原视频：两段视频时间轴对不齐（edit 的产出比输入短，
  //    实测 5.0→4.736s），画面也是重新生成的。在原片上量出来的框叠到产物上会"看起来很准、
  //    实际偏一点"，而用户会照着它拖 —— 挂错人零报错。
  //  · 一次视觉调用，取产物**正中间**那一帧；框按 cx 升序与 markSlots 对齐（同一条左到右规则）。
  //  · **尽力而为 + 全有全无**：数目对不上、有一行数值越界、抽帧失败 —— 任何一条都整份不写。
  //    这两个键于是要么都在、要么都不在，客户端判存在性即可（不必自己再猜是哪一帧）。
  //  · **不计费**：这一发约 400 token，我们自己吃掉。理由是要守住白模化那条更要紧的承诺 ——
  //    「钱全在阶段一花掉，取回结果（finish）一分不加」（finish 是一条可以重来的路，
  //    一旦它会花钱，"重试取件"就成了用户不敢做的事）。⇒ 报价里没有它、账单上也没有它。
  status: "pending" | "published" | "blocked",
  provenAt: Date | null,          // 试炼闸：作者本人用它真实出过一次片才非空
  provenModels: string[],         // 作者在哪些出片模型上真实跑通过（模型 id，2026-10-02 加）。没证明过 = []；
                                  // 存量（有 provenAt、没记过）按当时唯一开着 r2v 的模型出，见下面「试炼闸」一段
  isOwner: boolean,               // 服务端按 ownerId 对当前 JWT 算；客户端绝不拿 authorName 比身份
  createdAt, updatedAt }
```

- `refVideo.url` 存的是 Cloudinary 的 `secure_url` 规范形态且**唯一索引** —— 一段视频只许
  挂一个模板（重复登记 409），r2v 结算就按这个字符串等值反查（见下「r2v 服务端规则」）。
  V2 里它存的是**白模化产物转存后**的地址（不是原始素材）：方舟产物 URL 是 TOS 签名地址、
  **24 小时过期**（F12），不转存的话今天建的模板明天就是一条死链，而且零症状 ——
  列表照常显示，直到有人套用它出片时方舟拉不到参考视频才 400。
- `refVideo` 的数值**只由服务端从 Cloudinary 取**（`cloudinary.api.resource(..., { media_metadata: true })`
  —— ⚠ 这个参数是**必须的**：Admin API 对视频默认只回 width/height/bytes、**不回 duration**，
  2026-08-14 生产实测踩过）；客户端塞元数据会被 zod strip（这里 strip 是帮手）。
- **`roles`（白模 V2）**：`label` = 白模人偶身上那个**可寻址的标记**，`desc` = 这个标记在
  原视频里替换掉的是谁（"穿黑袍的白发少年"，套用者挂卡时**只看这句话**）。四条铁则：
  0. **最多 9 条**（`BLOCKOUT_MAX_ROLES`，2026-08-15 起）：白模化时最多分配到 9 个，核对端点
     也只收 9 条。9 不是技术上限是**看得清的上限** —— 实测 12 个角色位时标记照样画得出来，
     但画面上人眼能稳定认出的只有 4~5 个，多出来的位子用户在画面里找不到、只会以为坏了。
     画面里超出这个数的人**照样白模化但不给标记**（序数方案下他们与角色位长得一模一样 ——
     全都是纯白人偶 —— 只是清单里没有他们的位置，见下面「清单之外的人」那条兜底）。
     App 侧镜像：`src/data/templates.ts` 的 `BLOCKOUT_MAX_ROLES` / `splitCastRoles`（一处实现，
     挂卡面板与出片前的落盘都问它）；存量模板带回多于 9 条时 App **照样列出来**但不给挂卡
     （画面上真有那个标记，列表里悄悄少几项用户只会以为坏了）。
     ⚠ 9 仍是**没验过的一档**：白模化提示词按人数增长，而实测 594 字通过、605 字就开始顶穿
     预算（抹外观那几句先垮）。全白版基线 406 字（比彩色版的 590 省了近 200 字，因为不用
     逐个点名颜色），余量比以前大，但 6 人以上依然没有实测。产品侧用文案劝到 5 人以内。
     改这个数是一次跨仓决策。
  1. **判存在性**（`roles?.length`），不判等值 —— V1 老模板整个键缺失，回空数组会让客户端
     分不清"老模板"和"新模板但一个人都没认出来"（后者根本建不出来，见下面 blockoutize 的
     「roles 为空整句拒」）。
  2. **`label` 是字符串，原样用**。两种形态并存，靠 `markSlots` 分辨（见下一条）：
     序数方案是序数措辞（`"从左数第3个"`），编号方案（存量）是阿拉伯数字且**稳定但不连续**
     （2026-08-15 F5 实测：一发四人实出 1/2/4/5）。别按下标推、别拿 `roles.length` 当最大编号、
     点名时**原样用 label**（不重编、不换近义说法 —— "从左数第3个"写成"第三个"就是换错人）。
     ⚠ 也**别按 `markSlots` 的下标推**：作者在核对面板改过 label 之后，`roles` 的顺序与
     `markSlots` 的顺序就不再一致了。
  3. **`labelConfirmed` = 作者对着成片核对过了**。为假时那份 label 只是服务端按视觉那一步
     量的横向位置**排出来的猜测** —— 与画面对不上时，套用者给「从左数第3个」（老模板是
     "3 号位"）挂上张三，模型会老老实实换掉画面上真正的第 3 个人（另一个人），**钱照扣、
     零报错**。所以未核对的模板**不许发布**（见下 `PATCH /publish` 的第二道门）。客户端读不到
     这一位时按**未核对**处理（往多提醒一次那侧退）。
- **`markSlots`（标记方案位，2026-08-17 起）**：这段视频里**一共有哪几个可寻址的位置**，
  逐字、**按画面从左到右升序**（如 `["最左边","从左数第2个","从左数第3个","从左数第4个","最右边"]`）。
  纯字符串数组，无派生字段。
  1. **存在即序数方案，缺失即编号方案。** 判据只写存在性 —— 线上那 6 个老模板（人偶身上印
     数字）天然缺这一位，于是套用时走编号版提示词，一个字不受影响。反过来写成 `!== "number"`
     会把存量整批翻面：画面上人偶头上明明印着号、提示词却说「最左边=凛」——**当场作废且
     零报错**。这是这次改动的头号红线。
  2. **顺序是承重的**，不是"读起来顺"：它就是 ★★★ 那条升序规则的依据（`indexOf`）。服务端
     必须按画面横向位置升序发；任何一方 sort / dedupe / 补齐都等于改写那条规则。
  3. **不可变**：`PATCH /roles` 只写 `doc.roles`，永远不碰它（客户端塞进来也被 zod strip）。
     让作者改得动方案位 = 让他把一个序数模板标成编号模板，套用侧当场整份错。
  4. **必须与 `roles` 同一批写入**（阶段一 `BlockoutJob`、阶段二 `BranchTemplate`）：白模化
     提示词在阶段一就发出去了、凭据 TTL 24 小时，发版正好夹在两阶段之间时，只有"凭据里记着
     当初发的是哪一套"才能保证 finish 出来的模板与那段视频真正的样子一致。在途的老凭据没有
     这一位 → finish 出编号方案模板 → **正确**。
  5. **真有才出这个键**，绝不 `|| []` 兜底（同 `realDurationSec`）：空数组与"老模板"在下游会被
     压成同一个值，而两者的处置相反。
  6. **措辞表只有服务端一处**（`blockoutize.service.ordinalSlots`）。App 仓**不许**出现任何
     序数措辞常量、也不许有"第 k 个怎么说"的函数：文字来自 `roles[].label` / `markSlots[i]`，
     顺序来自 `markSlots.indexOf(label)`。于是"两边相等"从靠约定变成结构上不可能不等。
  7. **措辞的三条约束**（服务端生成时保证，App 的正则依赖它们）：① 任意两个措辞**互不为子串**
     （M ≤ 9 保证不会出现「从左数第1个」vs「从左数第10个」）；② **不含「人偶」二字**（否则
     `${label}的人偶` 会自我匹配）；③ ≤ 8 字（`从左数第9个` = 6 字，三处 `maxlength: 8` 因此
     不用改）。
- **`markBoxes` / `markBoxAtSec`（画面位置框，可选）**：每个位置在**某一帧**上的框，
  归一化 0~1000 整数，**与 `markSlots` 按下标对齐、长度必须相等**。用途只有一个：让 App 的
  挂卡面板支持"把角色卡直接拖到画面上那个人偶身上"。
  1. **框挂在"位置"上，不挂在角色位上**：角色位 → 框的唯一路径是
     `markBoxes[markSlots.indexOf(role.label)]`。塞进 `roles[]` 就是给一个角色位第二个身份，
     作者改过 label 之后两者能互相矛盾且无人仲裁。
  2. **只用于落点判定，绝不参与"这是第几个"的判定**。框与 label 冲突时 **label 赢**
     （作者核对过它，框只是 AI 量的）。
  3. **缺一个框就整层关掉**（App 侧 `markBoxesOf` 长度不等即整份丢弃，退回下面那行格子）：
     局部可拖会让用户以为"这个人拖不了 = 坏了"，而挂错人是零报错的。
     ★ 退化的是**画面上那一层**，不是整个挂卡：格子行（一个格子 = 一个人偶）永远在，
     所以"框没量出来"最坏也只是少一条更直观的路，不会让人挂不了卡。
  4. `markBoxAtSec` **必须一起给**：框是一帧上量的、人是会走动的。App 一进挂卡面板就把
     播放头 seek 到这一秒，用户拖到别处时把落点层隐去并给一颗回跳键。
  5. **第四个开层条件（只在 App 侧，服务端管不到）**：`roles` 与 `markSlots` 必须**逐条对应**
     （`roles.length === markSlots.length` 且每个 `roles[].label` 都在 `markSlots` 里）。
     它防的是**作者核对之后的那一步**：删掉一个画面上不存在的位子时 `markSlots` 不动
     （历史事实），于是 roles 少了一条而框还是原来那 M 个 —— 此时按下标画框就会把
     落点画到别人身上。判据在 `RoleCastBoard` 的 `dragOn` 一处，服务端**不做也做不到**
     （它不知道作者删了哪一条之后画面上到底还剩几个人）。
- **`roles[].desc`（人偶描述，2026-08-17 起是"多维、且验过的"）**：`颜色、动作、与具体景物的
  位置关系`，服务端合成，≤60 字（`ROSTER_DESC_MAX`）。
  1. **为什么不是一句「外观特征」**：白模素材上那一句必然退化成 N 行一模一样的
     「全白关节人偶」。实测（两段素材 12 个人偶）：颜色在全白素材上只能区分 **1/5**
     （混色的群舞 3/7），而**动作 7/7 与 4/5**、**与景物的位置关系 6/7 与 5/5**。
     ⇒ 扛事的是后两项；颜色仍然**必须问**，因为用户可以传"人偶不同色"的白模视频。
  2. **`verified` 那一位管的是"这条描述能不能用来指认"**：服务端把每条描述拿回**同一帧**
     去定位，落不回本人的那条**只留颜色**（动作与位置关系整份丢掉）。理由是歧义描述有
     1/3 会塌缩成一个自信的错答，而"描述指错人"= 套用时把卡换到别人身上，画面照出、
     钱照收、零报错。⇒ 客户端可以认为 `desc` 里**有分句（顿号）就是验过的**，
     只剩一个词的就是没验过 —— 那不是第二处判据，是产物本身只有这两种形状。
  3. **套用侧怎么用**（App `blockoutPrompt`）：序数方案下拼进绑定的**等号左边**
     `从左数第2个（白色，半蹲前倾）=阿岚`，绑定形状与书写顺序一个字不变（升序是承重的）。
     编号方案（存量老模板）**一个括号都不拼**：它们的 `desc` 说的是"原视频里是谁"。
     字数塞不下时**整批**不带，不挑几个留。
  4. ⚠ 模型会自发拿**另一个人**当地标（「在红人偶左后方」）。混色素材上这是很强的锚点，
     **全白素材上则退化成变相的序数**（"第二个人偶旁边"并不比"第二个"多给任何信息）——
     所以别把 `verified` 高当成"指认一定准"。
- `recipe` 刻意独立成立：老客户端把白模模板当经典配方跑，也能出一段"降级但诚实"的片。
- `cloudinaryPublicId` 是内部回收记账字段，**不出现在响应里**。
- **`source` 服务端存、但不出任何响应**：`{ publicId, startSec, durSec, crop:{x,y,w,h} }`，
  是 V2 白模化的来源（溯源、重做、删模板时级联回收原始素材）。不出响应是因为它指向
  作者自己上传的原始素材（可能是有版权的片子），把 public_id 发给每个逛市场的人没有任何
  正当用途（同 `cloudinaryPublicId`）。客户端提交 `roles`/`source`/`markSlots`/`markBoxes`
  一律被 zod strip —— 收 `roles` = 让提交方自己写"1 号位是谁"，收 `source` = 让用户自己标价
  （`durSec` 就是 r2v 的计价输入时长），收 `markSlots` = 让提交方自己宣称这个模板是哪种方案
  **并自己定升序排序的依据**（套用侧当场整份错且零报错）。**唯一的例外**是作者的角色位确认
  （`PATCH /:id/roles`，见下），而它也**只收 `roles`**。

### 端点（挂在同一个 `/api/branch` base）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/branch/templates` | required（5/分） | **V1 登记**。body `{ title, intro, coverUrl, recipe, videoUrl, splits? }`；`videoUrl` 过三重白名单（host=res.cloudinary.com + 模板视频专用目录 + public_id 归属 `^<userId>-\d+$`），别处的链接 400；元数据服务端向 Cloudinary 现查，复核走 **② 号窗口**（整段原片直接当参考视频用）。建成 `status=pending`。重复视频 409（`refVideo.cloudinaryPublicId` **与 `group.sourcePublicId` 都算**——切过段的源不能再登记）。`splits` 非空 = **分段登记**（见下「长视频分段登记」），成功回 `{ ok, template, parts[], needsDetect: true }` |
| POST | `/api/branch/templates/blockoutize` | required（**3 次/10 分钟**） | **V2 白模化 · 阶段一**。body `{ publicId, startSec, durSec, crop:{x,y,w,h}, frameTimes?, title, intro, coverUrl, videoTier?, aspect?, note? }` —— 提交的是**四组数不是 URL**（变换地址由服务端自己拼）。`frameTimes` 见下「看哪几帧」，**自动模式不带这个字段**。成功 `201 { ok, jobId, taskId, durSec, frames, roles[], markSlots?, expiresAt }`（`markSlots` 见上：存在即序数方案，**阶段一就要给** —— 模板还没建出来时核对入口就要知道该按位置说话还是按编号说话）（**钱在这一刻花掉**；`frames` = 服务端**真正看了几帧**，App 报价与它不等时以它为准并如实说一句）。失败一律带 `billed`（见下） |
| POST | `/api/branch/templates/blockoutize/finish` | required（仅凭据所有者） | **V2 白模化 · 阶段二**。body `{ jobId }`，**只收 jobId**：任务成没成由服务端自己向方舟核实，客户端说什么都不作数。成功 `{ ok, template, blockout:{ taskId, durSec } }`。**幂等**（重复调回同一条模板，不许建出第二个）。本阶段**不扣钱** |
| GET | `/api/branch/templates/blockoutize/pending` | required | **掉线恢复**：本账号还没取回结果的凭据 `{ ok, jobs: [{ jobId, taskId, durSec, title, roles[], markSlots?, expiresAt, createdAt }] }`。App 进模板市场时拉一次，摆出取回入口 |
| GET | `/api/branch/templates/shared` | optional | 市场列表，只回 `status === "published"`，`{ ok, templates[] }`。**路由必须排在 `/:id` 前**（branchAsset 同款排序坑） |
| GET | `/api/branch/templates/:id` | optional | 详情。非 published 只有作者可见，对别人一律 **404 而不是 403**（不泄露私有模板的存在性） |
| PATCH | `/api/branch/templates/:id/roles` | required（仅作者，**仅 pending**） | **作者核对角色位**（白模 V2）。body `{ roles: [{ label, desc }] }`，1~9 条（`BLOCKOUT_MAX_ROLES`），**整份替换**（"少给一条 = 删掉那个角色位"，见下），落库时 `labelConfirmed=true`。这是**唯一收客户端 roles 的端点**；`markSlots` / `markBoxes` **不收也不动**（改得动方案位 = 套用侧当场整份错，还会连升序排序的依据一起改掉）。见下 |
| POST | `/api/branch/templates/:id/detect-roles` | required（仅作者，6 次/分） | **认人 + 量框 + 写描述**（V1「自己传参考视频」那条路专用；白模化 V2 在阶段一里已经认过了）。body **可选** `{ atSecs?: number[] }` —— 用户自己在编辑页标的分析帧，**片内相对秒**、0.5s 网格，不给就服务端自动铺。成功 `{ ok, template, detected, boxed, verified, note? }`：`detected` = 认出几个角色位、`boxed` = 量出几个框、`verified` = **有几条描述通过了唯一性自证**（见下「人偶描述」）。`note` 三档：一个都没认出来 / 认出来了但 `verified < detected` / 全成（不出 note）。**认不出不写库、不留痕**。作者核对过（`labelConfirmed`）之后 400 拒绝重认；同一模板并发再来一发 **409**（`detectingAt` 原子锁，11 分钟过期）。**这一发按 chat 计费** |
| PATCH | `/api/branch/templates/:id/publish` | required（仅作者） | **两道独立的门**：① 试炼闸 `provenAt` 非空；② 有 `roles` 时必须已核对。任一不过回 400 整句（各说各的原因）。blocked 不能发布 |
| PATCH | `/api/branch/templates/:id/unpublish` | required（仅作者） | 回到 pending。blocked 是平台处置，作者洗不掉（400） |
| DELETE | `/api/branch/templates/:id` | required（仅作者） | **连带 `uploader.destroy` 回收参考视频**（先云端后库：云端回收失败回 502 且不删库，重试即可；封面与 **V2 的 `source.publicId` 原始素材** best-effort 回收，失败不阻断）。回 `{ ok: true }` |

### 长视频分段登记（splits，2026-08-20）

超过参考视频窗口（30s）的素材走这条：`POST /templates` 的 body 多带
`splits: number[]`（秒，**严格递增**，落在 `(0, 源时长)` 开区间），服务端把源视频
**物理切成 N 段独立 Cloudinary 资产**、各建一条普通模板，`group` 归组。

- **每段必须落在 [4,30] 窗口**，越界**整单 400**、一个资产都不切。服务端**只验不修**
  （替用户挪分段点 = 替他改每段的价钱）。「用户标的帧 → 合法分段」在客户端一处实现：
  `app/src/data/templates.planSplits(真实时长, marks)` —— 丢掉切出 <4s 的刀（`dropped`
  返回给界面整句点名）、>30s 的段中点补刀到进窗。
- **段数上限 12**（zod `splits ≤ 11` ↔ app `SPLIT_MAX_PARTS`，跨仓契约）。
- **切段变换**：`so_<a>,du_<d>[/c_scale,w_<N>]/<sourcePublicId>.mp4`。`c_scale` 只在
  源画面低于 407,696 像素硬门时出现，放大到刚过线（×1.02 余量、宽取偶，公式与
  `/uploads/template-video/derive` 逐字同源），**接在 so_/du_ 之后**（链式按书写顺序）。
  边长（<300）与宽高比越窗放大救不了，照旧整单拒。
- **无裁剪、无时段选择**（v1）：吃的是**整条原始上传**。App 侧的对应限制：ownRef 路
  选段 >30s 时必须「整条 + 整幅」，否则判词整句拒（`arkVideoRules.ownRefSplitVerdict`）。
  整条的理由不只是省事：`group.sourceUrl` 就是合并成片时回填**完整音轨**的原片，
  登记中段音轨就从 0 秒起错位。
- 每段回包/详情带 `group: { key, index, count, sourceUrl, sourceDurationSec }`
  （`sourcePublicId` 不出，隐私口径同 `source`）。`sourceUrl` 给客户端解原片音轨。
- 半途失败：已切资产回收、库里零残留、502 可重试（回滚后判重不误伤）。
- 登记后每段照常走 `POST /:id/detect-roles` 认人（**每段一发、各自计费**，报价镜像
  `economy.ownRefTemplateCost` × 段数，App 提交前整句报总价）。
- 分段登记过的源视频不可再登记（409）、不可当孤儿回收（`group.sourcePublicId` 命中
  即拒删——它是整组的音轨来源）。

**试炼闸（provenAt）的写入**完全在服务端：r2v 任务被受理时代理落一条
`{ taskId, templateId, userId }` 追踪（TTL 48h）；轮询响应 `status=succeeded` 且发起人
就是模板作者时置 `provenAt`。客户端一句"我跑通了"不作数。为什么要有这道门：方舟任务
**受理后**失败（真人人脸、内容审核）—— 2026-10-07 起出片那一笔会自动退回，但每个套用者都要白等一趟、
白花前面推演 / 画帧的钱；没这道门，一个坏模板让每个套用者各赔一次；有这道门，坏在作者自己那一次。

**`provenModels`（2026-10-02 加）与 `provenAt` 是同一条证据链**：受理时追踪里多记一格 `model`（请求体里的出片模型，
此时已过在册白名单与 r2v 价目表两道闸），轮询到 `succeeded` 且发起人就是作者时 `$addToSet` 进模板。
`provenAt` 只置一次；`provenModels` 每次作者跑通都会记（幂等）—— 作者之后在另一个模型上再跑通，那个模型也算数。
- **为什么要记**：模板对出片模型是硬要求（App 侧「模板 × 出片模型」统一口径，app 仓 docs/template-workflow-research.md）。
  今天只有一个模型做得了白模复刻，这一格看似废话；但开第二个模型的那一天，"存量模板只在旧模型上证明过"如果没有底账就只能靠猜。
- **存量**：上线之前置上 `provenAt` 的模板没有这一格。出口（`BranchTemplate.provenModelsOf`，唯一实现）对它们回
  `["doubao-seedance-2-5-260628"]` —— 那段时间 r2v 价目表只有这一行，别的模型发 r2v 是 400、根本受理不了，所以这条推论推得死。
  这个 id 是**写死的历史事实**，不跟着 `SEEDANCE_2_5` 常量走。兜底只在读这一侧做，不回写库。
- **客户端写不进来**：建模板 / 改角色位的 schema 都不收它（zod strip），与 `provenAt` 同待遇。
- **App 今天不读它**（2.57 之后的版本只按"协议上哪一档做得了白模复刻"判）；老客户端收到多出来的这个键会忽略。
★ 注意分支二（未登记素材，见下）**没有** templateId，那一路不落试炼追踪 —— 白模化那一发
本来也不该被算作"用这个模板出过片"（那时模板还不存在）。

### 白模化（V2）—— **两阶段**，不是一条长请求

客户端在编辑页框出「哪一段 + 画面哪一块」，提交**四组数**（`startSec`/`durSec`/`crop`）。
服务端走完九步，全程**客户端拿不到任何变换 URL**。⚠ 这九步**分两次请求**跑完
（2026-08-15 改造；此前是一条同步等到底的长请求）：

```
阶段一 POST /templates/blockoutize          ①~⑥（到「r2v 被方舟受理」为止）→ 落一条凭据 BlockoutJob
       ↓ 钱在这一刻花掉（看帧 + r2v 受理；方舟之后明说失败时 r2v 那一笔自动退回，看帧不退，F11）
客户端 GET /api/ark/contents/generations/tasks/:id   轮询出片（**既有端点**：不计费、
       ↓                                            90/分独立限流桶。不新造轮询端点）
阶段二 POST /templates/blockoutize/finish    ⑦~⑨（核实 → 转存产物 → 建模板 pending）
恢复   GET  /templates/blockoutize/pending   还没取回结果的凭据（掉线/被杀进程后从这里领回）
```

**为什么必须拆**：一条请求要在服务端等完预热、看帧、出片、转存，**五分钟量级**。
手机切后台、弱网断线、App 进程被系统回收、nginx 超时掐断 —— 任何一条都会让用户
**丢掉这一发的结果，而钱已经花了**。两阶段让"结果"变成一件可以再来取的东西。

拆开之后必须同时成立的六条（少一条这次拆分就是负收益）：

1. **finish 自己向方舟核实**任务状态，绝不信客户端一句"成功了"（与试炼闸 `provenAt`
   同一条理由：一句"我跑通了"能白拿一个模板）。
2. **幂等**：重复 finish 不许建出两个模板 —— 凭据带状态；真撞上 `refVideo.url` 唯一索引
   时回**既有那条模板**而不是 500。App 侧同样去重（`adoptBlockoutTemplate` 按 `remoteId`
   查本机库，已有就返回它，不再 `saveTemplate` 一条 remoteId 相同的幽灵记录）。
3. **掉线可恢复**：`pending` 列表 + App 里一个**真入口**（模板市场页顶部的「还没取回结果」，
   两个 tab 都看得见）。没有这个入口，两阶段就白拆了。
4. **时限是 24 小时，不是 48**：方舟产物是 TOS 签名地址、**24h 过期**（F12）。凭据 TTL 与
   `expiresAt` 都按 24h；pending 列表显示**剩余时间**（每分钟重算），过期的那条
   **不给按钮**并整句说明「产物已过期」——不是超时重来。钱分两种情况说：AI 那边其实失败了的，
   出片那一笔会被自动退回（退的时候凭据会被改成 `failed` 并换上退款那句话）；出成了却没取回的，费用无法挽回。
5. **`billed` 的语义分阶段**：阶段一一旦 r2v 被受理就是 `billed:true`（钱这一刻扣了；方舟明说失败时 r2v 那一笔自动退回）；
   阶段二本身不扣钱，它的失败是**"取结果失败"**不是"又花了一笔"，两句话不许互换
   （App 侧的判据是 `BlockoutizeError.phase`）。
6. **归属**：finish 与 pending 都只认凭据的 `ownerId` —— 别人拿到 jobId 也取不走。

九步本身不变：

1. 归属校验（`public_id` 形状 `ideahub/template-videos/<userId>-<ts>`，唯一实现
   `utils/templateVideoAsset.js`）+ 「这段素材做过了吗」（`refVideo.cloudinaryPublicId`
   或 `source.publicId` 命中就整句拒 —— 不在开炼前问的话，会在最后一步撞唯一索引，而那时钱已经花了）；
2. 钱的门禁前置（价目在册 → 套餐门禁），**排在任何一次付费调用之前**；
3. 现查原片元数据（`media_metadata: true`）→ 校四组数：裁剪框在画面内、选段在片长内、
   裁后那一段过 **② 号窗口**。⚠ `c_crop` 超出画面时 Cloudinary 会**自己裁到边界而不是报错**，
   所以这一步非查不可，否则方舟收到的尺寸与我们预检的不是一回事；
4. **服务端自己拼** Cloudinary 变换 URL（`so_<秒>,du_<秒>,c_crop,x_,y_,w_,h_`，
   F8 实测同时做时间截取与画面裁剪、零转码成本）；
5. **预热**（F9：Cloudinary 变换是懒生成的，首次请求可能拿到不完整的资产）——
   连发到「两次读到的字节数相同且非零」才算好，否则 502 整句拒（不把半截视频喂给方舟）；
6. 抽几帧 → **一次 chat vision**：列出画面里有哪些人 + 外观特征（F4 的"先看"）。
   一个人都没认出 → 整句拒、**不建空壳模板**（角色位是套用者挂卡的唯一入口）。
   **看哪几帧见下一节**；回包里的 `frames` 就是这一步真正用掉的帧数；
7. **一次 r2v edit**（F4 的"点名"：提示词把每个人的外观特征逐个写进去 ——
   泛指"所有人物"只换配角、主角不动，两发对照实测）。人偶是**全都一模一样的纯白色**
   （2026-08-17 起；此前印过数字、也上过颜色，换掉的理由见上面「两种方案」那一节）：
   套用者"这个人偶挂这张卡"的连接键不再是人偶身上的记号，而是**它在画面上的站位**。
   **最多 9 个**（见上面 `roles` 的铁则 0），清单之外的人照样白模化 —— 他与角色位长得一模一样，
   只是清单里没有他的位置；提示词里那句「人偶身上不要出现任何数字或文字」**更要紧了**
   （现在它是唯一一条"不要自作主张加记号"的约束）。
   ⚠ 「动作、姿态、**站位、层次**、运镜、背景、道具、光影保持原样」那一句从"锦上添花"
   升级成**承重**：序数就是站位。
   **⑥ 与 ⑦ 之间就是阶段一的终点**：
   任务被受理即落凭据并 201 返回（`jobId`/`taskId`/`durSec`/`roles`/`markSlots`/`expiresAt`）；
   ⚠ `markSlots` 必须**在这一步落进凭据**（与 `roles` 同一批）：提示词是在这里发出去的，
   而凭据 TTL 24 小时 —— 发版夹在两阶段之间时，只有凭据里那一份能保证 finish 出来的模板
   与那段视频真正的样子一致。
   ⚠ **序数怎么算**：视觉那一步除了外观描述还要给每个人的**横向位置**；先按重要度截断到
   `BLOCKOUT_MAX_ROLES`（既有不变量，一个字不动），再算每个幸存者在**全部 M 个人**里的
   x 升序名次 k，`label = markSlots[k-1]`。⚠ **名次必须在全部 M 个人里算，不是在活下来的
   9 个人里算**：截掉的是戏份最轻的人，他们照样被人偶化、照样站在画面里、照样占一个位置 ——
   在幸存者里算名次会让所有人的序数集体左移，而那是零报错的整份错位。
   ⚠ 名次 k **只在这一刻用一次，不落库**：落库的只有 `label`（措辞本身）。作者能在核对面板
   改 label，若同时存一个 `pos`，两者立刻能互相矛盾且无人仲裁。
8. 【阶段二】向方舟核实 → 产物**转存 Cloudinary**（F12）→ 用 **② 号窗口**复核产物本身
   （它要当下一发的输入）；
9. 建模板 `status=pending`、`roles`（全部 `labelConfirmed:false`）、`markSlots`（从凭据原样搬，
   不重算）、`source` = 那四组数，并把凭据置为已取回（幂等的锚点）。
   在途的老凭据没有 `markSlots` → 建出编号方案模板 → **正确**（它的视频上印的确实是数字）。

**失败一律整句中文 + `billed` 一位**（全 app 没有任何地方监听错误码，只回 code 等于让用户
对着转圈干等）：

```
{ ok: false, message: "<能直接显示给用户的整句中文>", billed: true|false, code?: "PLAN_REQUIRED" }
```

| `billed` | 含义 | 典型场景 |
|---|---|---|
| `false` | **这一次调用**一分钱没动，或已经原路退回 | 【阶段一】归属/四组数没过、预热失败、套餐不够格（403 `PLAN_REQUIRED`）、余额不足（402）、方舟**受理前** 400（敏感词/输入不合格，W2 已退）；【阶段二】**全部**（它本来就不扣钱） |
| `true` | 已经产生费用（看帧那一笔退不回来；r2v 那一笔受理后方舟明说失败会自动退回，见下） | 【阶段一】看帧那一步花完之后的任何失败：`roles` 为空、r2v 受理后才发现的问题 |

★ 客户端缺省按 `false`（非 JSON 回包 = 请求根本没落到这个端点上）。**别把两类混成一句话** ——
要么把没扣的说成扣了（吓人），要么把扣了的说成没扣（在钱上撒谎）。
★★ **两阶段之后 `billed:false` 有两种含义，按阶段分**（App 侧判据 `BlockoutizeError.phase`）：
阶段一的 `false` = 这一发一分钱没动，重来即可；阶段二的 `false` = **这一步**没花钱，
但钱在阶段一已经花了 —— 该说的是"结果还能再取一次（24 小时内）"，**不是**"没扣钱，重开一发吧"
（那句话会让他再花一次）。同理，方舟**受理后 failed / cancelled / expired**（F11 真人脸）由**阶段二**报出来：
2026-10-07 起 **r2v 那一笔按扣的两桶自动退回**（server `services/taskRefund`，恰好一次 —— 清扫器或别的轮询先退了也一样），
看帧那一笔不退。回包：`{ ok:false, state:"failed", billed:false, lost:<退了或正在退 ? false : true>, refund?: { state, tokens }, message }`，
`refund` 的取值见下「失败退款」；退了的那一拍带余额头。**message 把两笔钱分开说**（措辞只有 `BlockoutJob.failedMessage` 一处）。
老凭据（自动退款上线之前受理的，没有账）`refund` 缺省、`lost:true`，message 说「没有自动退回，需要的话联系客服」。
⚠ 方舟**出成了**、但产物我们用不了（太短、元数据缺失）的那几种**不退**（方舟收了钱），仍是 `lost:true`。
★ **不做真人脸门禁**（浏览器 FaceDetector 覆盖率极低，漏报比不检查更坏）：改为在编辑页
开炼前就整句告知"视频里有真人面孔时 AI 可能中途拒绝"（出片那一笔会退回、看帧那一笔不退），用户自负。

### 看哪几帧（`frameTimes` / `frames`，2026-08-15）

**为什么要有这一节**：看帧数量原来写死 3 帧。实测一段 4 秒的素材（前段 2 人、后段围坐
群戏人更多）只认出 2 个人 —— 登记的角色位是 1、2，而方舟出片时看到更多人，**自己往下
编到了 3**。画面上站着一个 3 号、角色位列表里却没有第 3 项：套用者挂不上它，只会以为坏了，
而全程零报错。

| 模式 | 客户端 | 服务端 |
|---|---|---|
| **自动**（默认） | body 里**不带** `frameTimes` | 帧数按选段时长算：**每 1.5 秒一帧，下限 3、上限 8**。这条式子的**唯一实现在服务端**；App 侧 `data/templates.autoVisionFrames` 是**报价用的跨仓镜像**，两边必须逐字相等 |
| **自己挑** | `frameTimes: number[]` —— **相对选段起点的整数秒**（`[0, durSec-1]`），升序去重，1~8 个 | 按它取帧；条数仍夹上限 8 |

- 「自己挑」是给**画面里人数会变**（有人入场/离场）的素材用的：只有看得见画面的人知道
  该在哪几秒取帧。App 侧在编辑页 trim 那一屏逐帧标记（缩略图本机 `<canvas>` 抓，不占服务端）。
- **另一条路上的同一件事叫 `atSecs`**（`POST /templates/:id/detect-roles`，2026-08-17）：
  「自己传白模视频」那条路没有 blockoutize 阶段，认人是单独一发，所以参数另起了名字。
  两者语义同类但**三处不同**，别互相套用：① 网格是 **0.5 秒**不是整数秒（这条路的素材是
  用户自己剪好的短片，切镜可能落在半秒上）；② 上限是服务端的 `BOX_FRAME_TRIES`（认人量框
  那一路的候选数），不是 8；③ 服务端**一个字都不校验**——量化、掐在片内、去重、保序、截断
  全在 `blockoutize.pickedFrameCandidates` 一处，收到乱值就退成 `null` 让自动铺法接手。
  刻意不校验的理由与上面「帧数就是钱」同源：判两遍 = 两处规则，而这条路上多试一帧就是
  多花一笔，两边对上限的理解一漂移就直接变成报价与实收不等。
  ⚠ App 侧提交前必须过 `BoxFramePicker.boxMarksInSelection`（唯一的"标记 → 提交值"实现）：
  用户标完之后还能拖动选段，落到段外的标记要当场从计数里掉出来并**红着说出来**，
  否则会静默退成自动铺法 —— 而"自己挑"正是他为了避开自动铺法才付的这笔钱。
- **帧数就是钱**（视觉那一半 = 帧数 × 单帧）。所以阶段一回包必须带 `frames`（真正看了几帧），
  App 与本机报价不等时**以服务端为准并在进度里如实说一句**——默默按本机那个数显示，
  就是"页面写着看 3 帧、账单按 8 帧扣"，两个方向都不报错。
- 为什么这一个可以收客户端报的数，而 `durSec` 那一组不能：多标几帧最多多花视觉那几百
  token，且服务端照它自己收到的条数收；而 `du_` 决定 r2v 的计费时长，那才是能被用来自己标价的。
- **兜底（提示词，两种模式都要）**：画面里出现了清单之外的人，**也一律白模化，但不给标记**
  （老编号方案下是"不给编号"）。宁可让它挂不了卡，也不要出现一个清单里没有的标记 ——
  作者核对时会看见一个清单上不存在的记号，而**没有任何人能仲裁**那到底是谁；套用者
  看着它却挂不上，只会以为坏了。
  ⚠ **全白方案下这条兜底认下了一笔新债**：路人与角色位在画面上**长得一模一样**（都是纯白
  人偶），"清单之外一律纯白"这个区分手段消失了，而且**他还会把右边所有位子的序数挤歪
  一位**。这是本次有意接受的代价 —— 兜底从"提示词里区分"挪到了**作者核对那一屏**
  （他从左往右数一遍就看得出来），App 的核对面板与看帧那一屏都已经把这件事说明白。

### 角色位的核对 `PATCH /api/branch/templates/:id/roles`（V2）

body `{ roles: [{ label, desc }] }`（**1~9 条**，见上面 `roles` 的铁则 0），成功回完整模板（`roles[].labelConfirmed`
全为 `true`）。

**为什么这条端点非有不可**：白模化落库那一刻的 `label` 是服务端按视觉那一步的结果**猜的**
（序数是按 AI 量的横向位置排的名次，编号是按顺序编的），而画面上真正长什么样要看成片，
两者常常错位 —— 编号方案下"稳定但不连续"（F5 实测一发四人实出 1/2/4/5）；序数方案下最常见
的失败是**画面正中央那个最像主角的人根本没被换成人偶**（于是清单里多出一个画面上不存在的
位子，而且它右边所有位子都错位一格），其次是相邻两行排反。错位时套用者给「从左数第3个」
（老模板是"3 号位"）挂上张三 —— 模型老老实实换掉画面上真正的第 3 个人（另一个人），
**钱照扣、零报错**。所以标记只能由**看得见画面的人**确认；这条端点收的不是数据，
是**作者的确认**。

规则（服务端）：

- **仅作者**（身份只认 `ownerId`）、**仅 `status === "pending"`**。已发布的要先下架再改：
  编号一变，别人工程里存的「几号位挂谁」就全对不上了，而他们那边**不会有任何提示**；
  `blocked` 一律拒（状态归平台管）。
- **只对有角色位的模板成立**：V1 老模板 400（不凭空造出角色位 —— 那等于给一个没有编号的
  视频编出"1 号位"，套用者点了只会换错东西）。
- `label` 收**任意非空字符串**（≤8 字符）：**不校"是数字"、不校连续、不锁个数**，
  也不校"是不是 `markSlots` 里的措辞"。1/2/4/5 是编号方案实测的正常输出，校连续等于把正确的
  确认判成非法；序数措辞最长 6 字（`从左数第9个`），8 字符的上限两种形态都放得下
  （所以这次换方案 `maxlength` 一处都不用改 —— ⚠ 依据从"色名 2 汉字"改成了"序数措辞最长
  6 字"，别把它当成一个可以随便动的数）。作者还可以补上视觉漏认的人、删掉它多认的一条
  （服务端**整份替换**，不逐条 merge）。
  ⚠ **`markSlots` 不在 body 里、也不许被这条端点改写**：它是"这个模板是哪种方案"的判据
  **以及升序排序的依据**，由白模化那一刻的服务端说了算。作者一按「核对无误」就把方案位
  擦掉 = 套用侧当场整份错且零报错 —— 这是这次改动里最容易漏的一处（zod 的 strip 是第二道，
  handler 里逐字段重建 `{label, desc}` 时**只写 `doc.roles`** 是第一道）。
- **`label` 不许重复** → 400 整句（重了的话套用侧的 `label → 卡` 映射会**静默互相覆盖**，
  用户看到的是"我给两个人各挂了一张卡，结果只换了一个"）。这也正是**措辞 token 直接装进
  `label`**（而不是"label 留序位数字 + 另加一个方案枚举"）换来的：重号闸自动就是重位闸，
  一行代码都不用加；连接键全仓也仍然只有一个。整句提示按方案分（"编号「1」出现了两次" /
  "位置「从左数第3个」出现了两次…如果你是想把两行对调，请把另一行也改掉"）。
- 这条端点**碰不到钱与身份**：`refVideo`/`source`/`status`/`ownerId`/`provenAt` 塞进来
  一律被 zod strip（`durSec`/`refVideo.durationSec` 是 r2v 的计价锚点，从这里改得动就等于
  让用户自己标价）。
- 发布闸与试炼闸是**两道独立的门**，别合并：试炼那一发作者可以一张卡都不挂，跑通了也
  说明不了标记对；反过来标记对了也不代表这个模板出得了片。两道各说各的原因
  （落回另一句的话，作者会去再花一次钱出片，回来发现还是发不了）。

#### 删掉一个角色位 —— 这条端点的**一等操作**（2026-08-15）

**为什么它是必需的**：方舟画上去的标记并不可靠，**两种方案都是**。
- 编号方案：实测同一段 5 人素材出过 `2/2/1/1/5`（两组重号，3 和 4 整个没出现）与 `3/1/1/4/5`。
  而**库里永远不会有两个「1」**——落库那份是服务端自己编的连续 `1..N`，PATCH 又拒重号，
  所以**重号只发生在画面上**。作者的真实局面是「可寻址的号只有 2、1、5 三个」⇒
  改三个位子的号 + **删掉另外两个**。
- 序数方案：白模化那一步**仍然会漏人**（最常见的还是画面正中央那个最像主角的没被换成人偶），
  而 AI 报的横向名次本身也只是猜测。前者只能删位，后者对调相邻两行。
  ⚠ **序数独有**：删掉一个位子之后，如果删它的原因是"画面上根本没有这个人偶"，那么它右边
  所有位子的序数都要**往左挪一位** —— 这一条编号/颜色时代都不存在，必须在界面上明说，
  而且**不许自动改**（画面上那个人偶到底还在不在，只有看着画面的人分得清；自动改一次
  就是替他做了一个可能错的决定，且零报错）。
没有"删"这条路，作者打开模板发现对不上时唯一的出路是**再花一次钱重炼整段**。
⚠ 所以这套机制在序数方案下**必须原样保留**并跟着改文案：它是兜底，
不是"已经修好了所以可以砍掉"。

- **删的表达形式只有一种**：提交的数组里少了那一条（整份替换）。**不新开 DELETE**——
  改号与删位是同一次动作的两半，拆成两条端点两个方向都走不通：先改（把 1 号位改成「2」）
  必撞重号闸；先删后改会在中间态落库，第二次失败就留下一个「删了但没改完、
  `labelConfirmed` 已被置 true」的模板 —— 作者从入口看它是"已核对"，实际编号是错的。
- **剩下的 `label` 逐字不动、顺序不动**：服务端不排序、不补号、不重编。删掉 3 号之后
  5 号仍然叫 5 号。`label` 是"把卡挂到这个人偶身上"的唯一连接键（点名段 / `cast[label]` /
  `applyCast` 全靠它），重排 = 把卡挂到别人身上，**两边都不报错**。顺序也是
  `materials` 的落盘顺序（预算不够时谁先被挤掉）与编辑页的显示顺序。
- **下限是 1，不是 0**（`.min(1)`）。删到 0 会触发一条**四段全静默**的降级链：
  ① `toTemplatePayload` 只在 `roles.length > 0` 时带这个键 → 回包退化成 V1 形状；
  ② App 的 `rolesOf` 回空 → 本机记录不带 `roles`；③ 出片时 `segmentGen` 的
  `blockout && roles?.length` 为假 → **静默退成 V1 泛指出片**（套用者付了 r2v 的钱，
  换来一段"AI 自己挑人换"的片）；④ `rolesNeedConfirm` 同时变 false → **发布闸失效**。
  删到 0 的正确表达是 `DELETE /api/branch/templates/:id`（这个模板对套用者已经没意义了）。
- **删位不影响钱与试炼**：这条端点碰不到 `provenAt` / `refVideo.durationSec` /
  `status` / `ownerId`。角色位少一个不代表"这个模板出不了片"，顺手清掉 `provenAt`
  就等于让作者再付一次 r2v 的钱。
- **`labelConfirmed`：删完即已确认**，不单独再确认一次 —— 作者删掉一个位子，正是因为他
  对着画面看清了"这个号不存在 / 这个号重了"，那就是确认动作本身。⚠ 由此产生的后果：
  提交成功后 `rolesNeedConfirm` 变 false，作者界面上那条琥珀提示会消失 ——
  **所以入口必须常驻**（见下 App 侧）。
- **两个人偶印着同一个号时，删掉一条并不能让另一个恢复正常**：模型只认数字，
  挂在这个号上的卡很可能把两个人一起换成同一张卡。App 侧对作者如实说了这一点，
  并给出第二条选项（把这个号的位子也删掉，两个人偶都保持白模原样）。

**App 侧（本仓）**：面板与入口在 `src/components/blockout/RoleConfirmSheet.tsx`
（只收 props，市场页「我的模板」与详情页 `OwnerBar` 共用一份）。

- **入口两档常驻**：待核对 = 琥珀拦路条；已核对 = 低调的「重新核对编号」。第二档不是
  锦上添花 —— 作者多半是确认完之后才发现画面上有两个一样的号。
- **打开面板前 `refreshRemoteTemplate`**（读路径，失败降级用本机那份）：作者可能在
  另一台设备上改过编号，拿这台设备上那份过时的猜测去整份替换会把改对的又覆盖回错的。
  ⚠ 两台设备同时编辑仍是后到者覆盖前者（**已知、可接受**：不加乐观锁，缓解是面板里
  摆着完整的那一份，作者自己看得见）。
- **删除是两段式**（点一下进"待删"，提交时才少发那一条）+ 底部汇总
  「这次提交会删掉编号 X、Y，其余编号一个都不动」：整份替换下，服务端**分不清**
  "作者有意删一条"和"客户端状态丢了一条"，把它在点最终按钮之前变成可见的，是这个
  风险在 App 侧唯一的对冲。删掉的 `desc` 找不回来（原文是 AI 写的），所以不做无 undo 的即删。
- 下限那句整句的唯一实现是 `data/templates.roleFloorIssue(remaining)`（面板"最后一条
  不给删"的解释、提交前预检、`confirmTemplateRoles` 三处共用）；上限用
  `BLOCKOUT_MAX_ROLES` 在**加行那一步**就换成说明（不摆点不动的按钮）。
- **发版前手测**：5 个位删中间一个 → 提交 → 剩下的号肉眼逐个对（不许变连号）；
  再打开一次面板，号还是那些。

**App 侧流转**（`src/data/templates.ts`）：提取器落本机后**立刻异步登记**（服务端 r2v 只认
已登记 URL，不登记作者连试炼片都出不了）；登记失败原因落 `registerIssueOf`，详情页显示
并给「重新登记」。发布/删除收口在 `setTemplatePublished` / `deleteTemplateEverywhere`
一处（白模走服务端，经典配方首发照旧只翻本机布尔）。市场合并在 `browseTemplates`：
`videos.remoteOn()` 为真时懒加载远端 shared、到货 emit，按 `remoteId` 与本机去重。
⚠ V1 没有远端元数据编辑端点：市场里展示的 title/intro/cover 是**登记那一刻的快照**，
本机改名不回传（详情页向作者明示了这一点）。

**V2 在 App 侧多两处收口**（都在 `src/data/templates.ts`，一处实现）：

- `blockoutizeTemplate()` —— 白模化流程（花钱前的三道门：能力探测 / 套餐与价目 / 余额；
  成败都刷余额镜像，因为这条路最典型的失败恰恰是**扣了钱的**）。两阶段之后它内部是
  **start → 轮询 → finish** 三段：轮询走 `ai/arkClient.fetchArkTask`（`GET /api/ark/contents/
  generations/tasks/:id` 的唯一封装，**没有新端点**），每一拍的进度话里都带着
  「可以退出，24 小时内都能回「我的模板」取回结果」——那句话是这次改造唯一的用户可见承诺，
  少了它用户仍然会以为自己必须一直盯着。拿到凭据那一刻调 `onBilled`，宿主据此
  **不再回收**那段原始素材（钱已经花在它身上了）。「看哪几帧」由编辑页交上来
  （`BlockoutSelection.frameTimes`，`undefined` = 自动），这一层只做规范化（整数秒、去重、
  升序、落在选段内）并据此**现算报价的帧数**（`visionFrameCount`）；
  服务端回的 `frames` 与它不等时，之后每一句进度话都带上那句更正（以服务端为准）；
- `pendingBlockoutJobs()` / `refreshPendingBlockoutJobs()` / `resumeBlockoutize()` ——
  **掉线恢复**（名单只有服务端说得准，本机不存第二份：进程被系统回收时本机 state 一起没了，
  服务端那份是唯一还在的）。「等出片 → 取回结果」这后半段在 `takeBlockoutResult` **一处实现**，
  刚开炼的那一发与从恢复入口领回的那一发走同一段代码；
- `confirmTemplateRoles()` —— 角色位核对，**成功后把本机 `roles` 一起改写**：出片时点名用的
  是本机那份，只改远端的话作者在这台设备上出的片仍按旧标记点名（改了却没生效，零症状）。
  ⚠ 它**只发 `roles`**，`markSlots` 一个字都不带（那是方案位，见上）。
- `isOrdinalMark()` / `markSpecOf()` / `boxOfLabel()`（`src/data/templates.ts`）——
  「这个模板是哪种标记方案 + 它那份顺序表 / 某个位置的框在哪」的
  **全 app 唯一实现**。提示词（`studio/blockoutPrompt`）、核对面板、挂卡面板、
  `flowStore.applyCast` 的错误句全部问它们。
  界面上怎么称呼它（位置 / 编号）**没有名词函数**：原来的 `markNoun()` 在 2026-09-11 做多语言时删了
  （名词当片段拼进句子，英文拼不成整句），`confirmTemplateRoles`、`flowStore.applyCast`、FlowPage 的挂卡框
  按 `spec.scheme` 各写一句整话 —— 方案判据仍然只问 `markSpecOf`。
  ★ `markSpecOf` 返回的是**判别联合** `{scheme:"number"} | {scheme:"ordinal", slots}`，
  而不是一个光秃秃的枚举：序数方案下"怎么排序"与"能选哪几个位置"都要那份 slots，
  收成一个值之后，"序数方案但没有顺序表"这种在运行期必然排错序的状态在类型上不可表达。
  **App 仓不许出现任何序数措辞常量、也不许有"第 k 个怎么说"的函数** —— 文字来自
  `roles[].label` / `markSlots[i]`，顺序来自 `markSlots.indexOf(label)`，措辞表只有服务端一处。
- **★★★ 升序排序的唯一实现是 `studio/blockoutPrompt.orderSlots`**，不上移到数据层：
  `cast` 是 `Record<label, cardId>`，它本来就没有顺序 —— 顺序不是被"保持"的，是在拼提示词
  那一处被**制造**出来的。数据层排序等于给一个无序结构强加一个下游随时能悄悄打破的约定。
  App 还有一道运行期闸 `orderKept`（只在序数方案跑）：豆包改写后把先后顺序打乱就整句拒 +
  给骨架。⚠ 编号方案**跳过**这道闸（编号是印在人偶身上的，写作顺序不参与语义，加一道没有
  实测依据的顺序闸只会凭空多一种拒绝，线上那两个模板首当其冲）。
- 方案位要穿过 `rolesOf`/`markSlotsOf` → `apiToTemplate` → `flowStore.applyTemplate` 快照 →
  `FlowPage.castEditorState` → `VideoEditorPage.parseState` 五跳，其中后三跳都是**逐字段重建**
  （已知会静默丢字段）。所以每一跳都显式带这一位；漏一跳的后果是序数模板被当成编号模板
  **并且升序排序一起丢** —— 好在那时写出来的是 `编号最左边=凛`，**一眼就是坏的**且在花钱
  之前（这正是选 label 装 token 的理由）。⚠ `parseState` 里这一位**必须可选**：缺它绝不
  `return null`，否则一个从模板页正常点进来的用户会撞上"这一页需要从上传或模板页进来"。
- **`markSlots` 改名 + 改形状（`{label,swatch}[]` → `string[]`）是有意的**：App 侧那四跳
  （`apiToTemplate` / `NewTemplate` 类型 / `adoptBlockoutTemplate` / `refreshRemoteTemplate` 的
  mine 与 shared 两份）全部变成**编译错误**，而留一个同名同形的字段拿不到这个效果 ——
  那正是 `roles` / `realDurationSec` / `markColors` 三次漏搬都零报错的原因。
  ⚠ 编译器只能保证"你不能写错"，**不能保证"你不忘了写"**。
- `RemoteTemplateState.rolesNeedConfirm` 是「这个模板还等着核对吗」的镜像（与 status /
  provenAt 同族的生命周期状态，**不塞进 `VideoTemplate.roles`** —— 那份是出片点名要用的数据）。
  老服务端不回 `labelConfirmed` 时按**待核对**处理。

**降级矩阵**（老/新两边各差一个版本时会怎样）：

| 场景 | 行为 |
|---|---|
| 老服务端 × 新 App | `remoteTemplatesCapable()` 探不到 → 白模化入口不渲染，V1 上传路照旧；核对端点回不出模板形状 → 整句说"可能需要升级服务端"，不假装成功 |
| **同步版服务端（有 blockoutize、没有两阶段）× 新 App** | 阶段一那次 POST 会一口气跑完九步并把 `template` 带回来。App 按**回包形状**分叉（`jobId` → 两阶段；只有 `template` → `legacy`）：直接落本机，降级但**完整**。★ 绝不能把它当"形状不对"拒掉 —— 那就是"钱花了、模板其实建好了、本机什么都没留下"。也因此阶段一的超时给到 **8 分钟**（新服务端秒级返回，这个上限只兜同步版） |
| 新服务端 × 老 App（没有两阶段） | 老 App 拿到 `{ ok, jobId, … }` 里没有 `template`，会整句报"服务器没返回模板信息、这次很可能已经计费"并让用户去「我的模板」确认 —— 说的是实话（钱确实花了、模板确实还没建）。**但它取不回结果**：凭据会挂到 24 小时过期。所以两仓这一轮要一起发 |
| 新服务端 × 老 App | 老 App 不认 `roles`，套用时走 V1 的泛指语义句（降级但诚实）；它也发不出核对请求 —— 于是那些 V2 模板停在 pending，**不会**带着没核对的标记上市场 |
| 存量 V2 模板（`labelConfirmed` 字段还不存在） | 服务端 `rolesNeedConfirm` 用 `!== true` 判 → 算**未核对**（它们的标记确实没人核对过），作者核对一次即可发布 |
| **存量 V2 模板（没有 `markSlots`）** | `isOrdinalMark` 判否 → **编号方案** → 套用走老提示词（含那句「把编号全部去掉」）、排序仍是 `parseInt` 数值升序、**不跑 `orderKept`** → **一个字都不受影响**。线上 6 个模板全在这一档，其中两个好模板（`都市主角群舞转场`、`宗主垫脚舞`）还在被人用。这是本次改动的头号约束 |
| 在途 `BlockoutJob`（24h 凭据，发版夹在两阶段之间） | 凭据里没有 `markSlots` → finish 出编号方案模板 → **正确**（它的视频上印的确实是数字） |
| 序数方案服务端 × 老 App（不认 `markSlots`） | 走编号分支 → 输入框里出现 `编号最左边=凛`，**一眼就是坏的**，且在花钱之前的可编辑输入框里；更新 App 即恢复。发布顺序是**先服务端后 App**，窗口期内建模板的只有我们自己（见上「两种方案」那一节） |
| 本机模板库 `templates.v1` 里建模板时写下的老记录 | 缺 `markSlots` → 判编号 → 靠 `refreshRemoteTemplate` 回写自愈（**mine 与 shared 两条路都要回写**，否则作者自己那台设备上会一直把自己的序数模板当编号模板）。⚠ 残留的 `markColors` 键**不写清理逻辑**：删掉类型之后它只是个不参与任何判断的多余 JSON 键，写清理才有风险 |
| 服务端没给 `markBoxes` / 长度与 `markSlots` 对不上 / 没给 `markBoxAtSec` | 挂卡面板**画面上那一层整层不出现**，只剩视频下面那行格子（一个格子 = 一个人偶，点格子选卡 / 把卡拖到格子上），并照旧显示那句「画面本身点不了」。缺一个框就整层关掉，**不许局部可拖**（局部可拖会让用户以为「这个人拖不了 = 坏了」）。★ 格子行是**常在**的那条路，所以这次降级不会让人挂不了卡 |
| 老草稿里的 `flow.template` | 套过模板的流水线恒为 `mode:"simple"`，`saveWorkDraft` 不写 `flow` ⇒ 草稿里从来没有 template。极老草稿万一存过，缺这一位 → 判编号 → 兜得住（这正是"判否定"的又一个理由，别写成必填） |

## 账号端点（沿用既有 `/api/auth` 与 `/api/me`，实测口径）

| 方法 | 路径 | body / 说明 |
|---|---|---|
| POST | `/api/auth/register` | `{ username, email, password }`，password ≥ 6；冲突 409。**不接受 displayName**（controller 只解构 username/email/password/role），昵称要注册后补一次 profile |
| POST | `/api/auth/login` | `{ emailOrUsername, password }` —— 字段名不是 `account`；用户名和邮箱都能填 |
| GET | `/api/auth/me` | 只返回登录态字段（`_id/username/email/role/avatarUrl`），**不含 displayName/bio** |
| GET | `/api/me/profile` | 本次新增，对称于既有的 PUT，返回 `username/displayName/bio/avatarUrl/role/createdAt`。缺了它换设备登录后昵称会退回 username |
| PUT | `/api/me/profile` | `{ displayName?, bio?, avatarUrl? }`，返回更新后的 user |
| POST | `/api/me/deactivate` | `{ confirmUsername }` —— 注销账号（**软删除**：打 `deactivatedAt` 标记 + `tokenVersion++` 让全部旧 token 立即 401，内容数据不删、管理员可恢复）。confirmUsername 与本人 username **严格全等**（不 trim、区分大小写），客户端不得预先加工。App 入口：设置 → 注销账号（2026-08-28，仅远端模式显示）。注销后**登录也被拦**：拒签收口在 server 的 `utils/jwt.signToken`（所有签发路径唯一收口），401 整句「账号已注销……support@ 可恢复」；错误密码仍报通用凭据错误，不泄露注销状态。（此处曾误记为「登录仍发 token」——那是把被拒后的空 token 当 `NOTOKEN` 发出去的测法错误，2026-08-28 复查更正并在 server 补了整链测试） |

### 登录方式按出口 IP 分流

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/capabilities` | 无需鉴权。服务端用 `detectRegion(req)` 认**请求的出口 IP**，返回 `{ region, country, emailPasswordEnabled, oauthEnabled, phoneEnabled, providers[] }`。大陆 IP 关掉 `oauthEnabled`（Google 在墙内点了只会转圈）；短信通道没真配则 `phoneEnabled=false`（不摆发不出码的死按钮）。可用 `AUTH_FORCE_OAUTH` / `AUTH_FORCE_OAUTH_IN_CN` 强制覆盖 |

★ **客户端不得自行判断地区**：判据（国家库 + 上面两个强制开关）全在服务端，两边各判一次
必然分叉，而且客户端那份还能被随便改。探测失败就退到最小集（邮箱 + 密码）。

### 验证码（authOtp.routes）

| 方法 | 路径 | body → 返回 |
|---|---|---|
| POST | `/api/auth/email/register/start` | `{ email, username, password }` → `{ ok }`。**只发码，不建号** |
| POST | `/api/auth/email/register/verify` | `+{ code }` → `201 { ok, token, user }`，验码通过才真正建号并登录 |
| POST | `/api/auth/email/reset/start` | `{ email }` → `{ ok }` |
| POST | `/api/auth/email/reset/verify` | `{ email, code, newPassword }` → `{ ok, token, user }` |
| POST | `/api/auth/phone/login/start` | `{ phone }` → `{ ok }`。真发短信、真扣费，限流 5/分钟 |
| POST | `/api/auth/phone/login/verify` | `{ phone, code }` → `{ ok, token, user }`，该号没注册过则**自动建号**（登录即注册） |

⚠️ **这几条返回的 `user` 用的是 `id`，不是 `_id`** —— authOtp.controller 里是手写的对象字面量，
与 auth.controller 的 `serializeAuthUser` 不是同一套。客户端在 `api/auth.ts` 里归一，
不要让上层去认两种形状。

### 第三方登录回跳（含 App 深链）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/oauth/:provider?next=<目标>` | `provider` ∈ 服务端 `providers`（google / github）。授权完成后 302 带 token 回 `next` |

`next` 只接受两类值，其余一律被 `safeNextPath()` 打回 `/`：

1. **站内路径**（`/` 开头，且排除 `//`、`/\` 与控制字符）→ 回跳
   `CLIENT_BASE_URL/oauth/callback?token=…&next=<路径>`
2. **App 深链**：**完全等于** `${APP_OAUTH_SCHEME}://oauth` → 直接 302 到该深链，
   形如 `ideahub://oauth?token=…`（回 App 时不再带 `next`）

★ 深链是**严格等值**匹配，不是前缀匹配 —— `ideahub://oauth@evil.com/` 这类写法必须落回第 1 类，
否则等于把开放重定向从另一个门放回来。`APP_OAUTH_SCHEME` 留空则该特性整体关闭。

★ 为什么 App 不能直接在 WebView 里登：Google 对嵌入式 WebView 的授权请求一律返回
`disallowed_useragent`（反钓鱼策略，措辞绕不过）。所以 App 侧必须
**系统浏览器跑授权页 → 服务端深链回 App**。三处 scheme 要一致：
server 的 `APP_OAUTH_SCHEME`、app 的 `src/utils/oauth.ts` `APP_SCHEME`、
`android/app/src/main/AndroidManifest.xml` 的 intent-filter。

★ Google Cloud Console 里登记的授权回调**只有服务端那一个**
（`<SERVER_BASE_URL>/api/auth/oauth/google/callback`）。自定义 scheme 不需要、也不能
登记到 Google —— 它是服务端拿到 token **之后**自己发起的第二跳。

### QQ 登录（原生 SDK，**不走上面那条回跳**）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/oauth/qq/native` | 无 | `{ code }` → `201/200 { ok, token, created, user }`。`code` 是 App 原生 SDK `loginServerSide` 拿到的一次性授权码。限流 20/分钟·IP（`QQ_LOGIN_RATE_MAX`）。未配 `QQ_APP_ID`/`QQ_APP_KEY` 时 **503** |

★★ **QQ 不在 `capabilities.providers` 里**，这是有意的。那份列表的语义是"能跳转的 provider"，
而 QQ 互联注册的是**移动应用** —— 后台**没有回调地址那一栏**，网页版 OAuth2.0 授权走不通
（要走得先另注册「网站应用」，需要登记域名并 ICP 备案）。App 侧的判断因此是
"跑没跑在原生壳里"（`utils/qqLogin.ts` 的 `qqLoginSupported`），与 `providers` 无关。

★★ 请求体**只有 `code`**。客户端多送的 `openid` / `access_token` 一律忽略 ——
openid 由服务端拿 AppKey 向 `graph.qq.com` 换取，客户端没有机会伪造。
收客户端报上来的 openid 等于"报谁的 openid 就登谁的号"，是无凭证的账号接管。

★ QQ 用户**没有邮箱**（`get_simple_userinfo` 里就没这一项），建号时走合成邮箱
`qq_<openid>@no-email.ideahub.local`，与手机号注册同一套；昵称进 `displayName`，
用户名随机生成（`user_<8位hex>`）。openid 是**按 AppID 隔离**的，换 AppID 等于所有 QQ 用户失联。

### 用户协议同意留痕（2026-08-28）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/me/accept-terms` | requireAuth | `{ version }`（1~32 字符）→ `200 { ok, termsAcceptedVersion }`。写 `User.termsAcceptedVersion` + `termsAcceptedAt`（服务端时间）。**幂等**：同版本重复提交只刷新时间戳 |

读走 `GET /api/auth/me`：`serializeAuthUser` 现在带 `termsAcceptedVersion`（空串 = 没同意过）。

★ **服务端只存不判**。协议正文与当前版本号都在 app 仓（`src/data/agreements.tsx` 的
`TERMS_UPDATED`，形如 `"2026-08-28"`），"要不要弹补签门"由客户端拿服务端的值对自己的版本。
服务端这份是合规留痕（谁、哪版、何时），不是门禁。

★ **App 侧的对账在 `data/account.adoptUser` 一处**（四条登录路 + 冷启动都汇到它）：
服务端已有当前版本 → 落到本机 localStorage（换设备登录不重复弹）；本机有而服务端没有/旧 →
补传一次。补传覆盖两种天然漏发：登录页勾选发生在拿到 token **之前**（POST 发不出去）、
上次 POST 恰好断网。端点幂等，多发无害。

★ 老服务端没有这个端点（404）：App 一律按尽力而为处理，本机记录才是 UI 判据 —— 判否定
（`termsAcceptedVersion` 缺省/空串 = 没同意过），别判相等（「后加字段判否定」那条铁则）。

## 老师人格（tutor：用自己的教材铸一位 AI 老师）

**与 `/api/personas` 的关系（2026-09-28，tutor 仓 docs/04 S3 / S4）**：`Persona` 多了 `kind`（只认 `"tutor"`，缺省 = 老数据 = 客服人格，判否定）与 `course / currentDoc / remixOf`（M2 发布时由服务端写，客户端 body 里这几格一律被 strip）；`GET /api/personas` **缺省不列老师人格**，`?kind=tutor` 只列老师人格 —— 老 App 会把列表里任何一条 `PUT /api/companion/settings` 装成客服人格。判断只在 `services/personaKind.js` 一处。**2026-09-29 M3**：例外只有一种 —— 作者发布时勾了「同时发布为启梦人格 / 可装进看板娘」的老师（`Persona.companion.enabled === true`，判否定：没这一格 = 没勾）会进缺省列表、也能被选用；`personaAccess.checkPersonaAccess` 对没勾的老师人格回 `reason:"not_companion"`（`PUT /api/companion/settings` / Live2D 绑人格 → 403），作者自己也一样。过滤器写成单个 `$nor` 键（controller 那边 `Object.assign` 进 filter，不与 scope=installed 的 `$or`、搜索的 `$and` 打架）。

只在 `TUTOR_ENABLED=true` 时挂载（`src/app.js`），全部端点 **requireAuth**，不是本人的课一律 404。请求体上限 8mb（`TUTOR_TEXT_JSON_LIMIT`）。
产品与格式的正本在 tutor 仓（`docs/03` 人格文件格式 `ideahub-tutor/1.1`、`docs/05` §5.6 会话契约、`docs/06` §3.2 端点表）；本仓 `src/tutor/core/` 是那边同步过来的纯函数核心。
成功 `{ ok: true, … }`，失败 `{ ok: false, message, code? }`。**M1 只有作者自己学**：Run 的 id 对外就是课程 id。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/tutor/health` | 无 | `{ ok, tutor:true, demo, demoAllowed }`；`demo` = 没配 `AI_API_KEY`（演示模式：确定性老师，生产不许） |
| GET | `/api/tutor/config` | 必须 | `{ prices:{ tutor_turn, tutor_distill, tutor_extract }, demo, adultDeclared }`（价目只在 `config/tokens.js` 的 `TUTOR_PRICES`） |
| POST | `/api/tutor/declare-adult` | 必须 | 成人声明（v1 只做成人），幂等；`User.tutorAdultDeclaredAt` |
| GET / POST | `/api/tutor/courses` | 必须 | 本人的课 / 建课 `{ title, subject, code?, term?, policy:{ ai, homework_mode, allowed_uses?, text? }, key_dates? }`；缺必填 400 带 `field` |
| GET / PATCH | `/api/tutor/courses/:id` | 必须 | `{ course, materials, nameHint }` / 改元数据 |
| GET / HEAD | `/api/tutor/courses/:id/materials?sha256=` | 必须 | 去重探测 `{ exists, material }`（HEAD 200/404） |
| GET | `/api/tutor/courses/:id/rules` · `/quote` | 必须 | 从政策派生的 🔒 硬规则 / 生成报价 `{ materials, sections, stages, quote:{ lines, total }, demo }` |
| POST | `/api/tutor/materials/sign` | 必须 | `{ courseId, format, bytes, name }` → Cloudinary **raw** 直传票 `{ ticket(=publicId), putUrl, params, chunkBytes, maxBytes }`；格式白名单 pdf/pptx/docx/md/txt、`overwrite:false`、public_id 服务端签死（形状 `ideahub/tutor-materials/<userId>-<ts>-<6hex>.<ext>`） |
| POST | `/api/tutor/materials/confirm` | 必须 | `{ ticket, courseId, sha256, name, bytes, license:{source}, pages:[{ idx, title?, blocks:[{ hash(12hex), text, bbox? }] }], warnings }` → 201 `{ material }`；同 sha 200 `{ duplicate:true }`（副本回收）；Admin API 核对字节真的在（404 → 409 NOT_UPLOADED） |
| PATCH | `/api/tutor/materials/:sha` | 必须 | `{ courseId?, license:{ source } }` 事后改授权来源；文档头 `license.source` 按全体教材取最差重算，回 `{ docLicense, course }` |
| GET | `/api/tutor/materials/:sha/file` · `/text` | 必须 | 原件：**流式转发**签名下载的字节（不 302：raw 只有 api.cloudinary.com 的 download 端点能取、公开投递 401，而它给不给 CORS 头没量过 —— 理由在 `tutorFile.service.js` 头部）；`Range` 原样转上游、206 原样转回，`Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges`（pdf.js 分段取页）；客户端要带 Bearer（pdf.js 经 `httpHeaders`）；没原件 404 `MATERIAL_MISSING`；上游非 2xx → 502 `UPSTREAM`（带 `upstreamStatus`，不透传 401） / 块级文本 `{ sha, pages }` |
| GET | `/api/tutor/usage-ledger?since=` | 必须 | 本人的模型用量账本 `{ count, summary, records }`（数字与 kind，不含正文；tutor 仓 docs/10 的量具） |
| POST | `/api/tutor/personas/generate` | 必须 | `{ courseId, questionnaire:{ name, style?, catchphrase?, strictness?, address?, examples_from?, extra_rules? } }` → 202 `{ jobId, quote, nameHint }`；**受理那一拍按报价扣 tutor_extract × N**，之后失败不退；同课在跑 409 BUSY |
| GET | `/api/tutor/jobs/:id` | 必须 | `{ job:{ status, progress:{ step, done, total, message, mode }, result, failures, error } }`（worker 在 0 号实例串行跑，检查点续跑） |
| POST | `/api/tutor/personas/:id/preview` | 必须 | 试教（SSE，不落 Turn、不翻状态、**同价**）`{ kind?: teach|ask, stage?, text? }` |
| POST | `/api/tutor/personas/:id/scan` · `/patches/:pid/accept` | 必须 | 新教材 → 阶段提议 `{ patchId, proposals }`（扣 tutor_extract × 新教材数）→ 点头 `{ indices? }` 追加成新版 |
| GET | `/api/tutor/personas/:id/export?format=md\|json\|zip&audience=market\|self&keepStuckPoints&keepStudentQa` | 必须 | 导出件；头 `X-Tutor-Checksum / -Produce-Id / -Clean-Check / -Export-Id`；发布件对 `license.source=unsure` 400、教材泄漏核查不过 409 `CLEAN_CHECK`；每次留痕 |
| GET | `/api/tutor/personas/:id/exports` | 必须 | 留痕列表 `{ exports, retainDays:180 }` |
| POST | `/api/tutor/personas/import` | 必须 | `{ courseId?, text?\|json?, filename? }`：同一位老师回读成 `kind:import` 修订（`same:true`），别人的老师新开一门课（`created:true`）；删标识 / 改正文 400 |
| POST | `/api/tutor/personas/:id/publish` | 必须（作者） | **发布到市场**（tutor 仓 docs/02 §6）`{ name?, description?, tags?(≤6), coverEmoji?, aigcDeclared, note? }`：五道门在服务端一处（`tutorPublish.service.checkGates`），任一不过 **422 `GATE`** + `gate ∈ license\|cleanCheck\|adult\|aigc\|name\|tags` 指明哪一道 + 整句人话；全过 → 201 `{ persona:{ personaId, version, sha256, checksum, produceId, marketPath, shared, … }, warnings }`：铸一条 `TutorRelease`（market 口径的快照：② 只种子、学生问答不带、③ 状态列清空，与导出发布件同一份实现，**不可变**）+ `Persona{ kind:"tutor", shared:true, course, currentDoc, releaseVersion, subject, aigcDeclaredAt, license, policy }`；再发一次 = v(n+1)，旧版留着。被平台下架的 403 `TAKEN_DOWN` **复刻件（另存为我的人格，2026-09-29）**：从市场「开始学」开出来的课发同一个端点、同一套五道门 —— 没有自己的教材时 ① 沿用当初复制那一版（`sourceRelease`）的授权、② 不跑（那一版发布时查过；学习者多出来的只有自己的问答与条目），自己传了教材的按普通规则；发布件 `id` 从课 id 确定性派生（`fork-<12hex>`）、版次从 1 起、`fork_of {id, version}` 记血缘、`Persona.remixOf` 指回来源；回包与市场卡片 / 详情多 `remixOf { id, name }` **同时发布为启梦人格 / 可装进看板娘（M3，2026-09-29；tutor 仓 docs/06 §5.1 反向勾选）**：body 多 `alsoCompanion?: boolean`（默认 false、只认显式 true，`core/publish/companion.companionOptIn`）：勾了才由 ① 教学面生成 `Persona.style`（`companionStyleOf`：who + teaching_style → summary、catchphrases、tone、address_student → addressUser、greeting、example_turns → examples、hard_rules → boundaries，**只带说话风格**）并写 `Persona.companion { enabled:true, at }`，这位老师才进 `GET /api/personas` 缺省列表、才能 `PUT /api/companion/settings { personaId }` 装进看板娘；不勾 = `companion.enabled:false` 且 style 清空，**每次发布重新表态**。回包 `persona.companion { enabled, at }`（课程 summary 的 `published` 同形） |
| DELETE | `/api/tutor/personas/:id/publish` | 必须（作者） | 取消分享：只翻 `shared:false`，快照 / 版号 / 评论都留；没发布过 404 |
| GET | `/api/tutor/market?q&tag&subject&sort=new\|hot\|rating&scope=all\|installed\|mine&author&page&limit≤40` | 可选 | 市场列表（游客可逛；**不借 `/api/personas?kind=`**，监管若停陪聊线不连坐）：只回 `kind:"tutor" && shared && !takenDown`（`mine` 含自己没公开的；未登录 scope 退 all）；`hot` = 下载 → 点赞 → 时间，`rating` 均分、票数 < 3 沉底；登录用户看不到拉黑 / 被拉黑的作者；`{ items:[卡片], page, totalPages, total, sort, scope }`，卡片 `{ id, name, description, coverEmoji, coverImageUrl, tags, subject, author:{_id,username}, price, version, stats:{ downloadCount, likeCount, ratingAvg, ratingCount }, installed, isOwner, publishedAt }` |
| GET | `/api/tutor/market/:id` | 可选 | 详情：`{ persona(卡片), release:{ version, sha256, checksum, produceId, publishedAt, note, stages }, preview:{ card(① 教学面：who / teaching_style / catchphrases / hard_rules[{text,locked}]), stages[{ stage_id, title, summary, steps, memo, checks }], guide, policy, license }, others(作者的其它老师，≤6), relation:{ isOwner, installed, learning:{ courseId, version }\|null, ownCourse } }`；② ④ 正文不给（下载后才有）；未发布 / 已下架的只有作者看得到（多 `takedown:{ at, reason }`），其他人 **404**（不泄露存在性）；拉黑互不可见 |
| POST | `/api/tutor/runs` | 必须 | 「开始跟这位老师学」`{ persona }`（docs/02 5.7）：从发布版复制出自己的一门课（与「导入一位老师」同一条路：`createFromDoc` + `writePersona`；教材不复制、进度全 pending、🔒 硬规则随行；课上记 `sourcePersona / sourceVersion`）→ 201 `{ courseId, version, downloadCount }`，并 `PersonaInstall` +1（幂等）；同一人再点 → 200 同一门课 `created:false`；作者自己点 → 200 `own:true` 回自己那门课；付费老师没结算 403 `unpaid`（v1 全免费，只是闸的形状）；拉黑 403 `BLOCKED`；没发布版 409 `NO_RELEASE` |
| GET | `/api/tutor/market/:id/ratings?page` | 可选 | **评分**（tutor 仓 docs/02 9.6；全站第一张 1~5 星表 `TutorRating`，2026-09-29）：`{ summary:{ avg, count, dist:{1..5} }, items:[{ id, user:{_id,username}, stars, text, atVersion, createdAt, updatedAt }], page, totalPages, total, mine, canRate:{ ok } \| { ok:false, reason: login\|owner\|blocked\|notStarted\|noneDone, message } }`；未发布 / 已下架对非作者 404（与详情同口径） |
| PUT | `/api/tutor/market/:id/rating` | 必须 | `{ stars:1~5, text?(≤500) }` 一人一票可改（201 建 / 200 改）→ `{ created, mine, summary }`。**前置**（规则只在 `core/publish/rating.canRate` 一处）：从这位老师开出的课至少一个阶段 passed 或整门 done，否则 **403 `NOT_ELIGIBLE` + `reason`**；作者评自己 / 拉黑同样 403；`Persona.stats.ratingAvg / ratingCount` 从评分表 aggregate **重算**回写（不 `$inc`，`BranchAssetLike.js` 头上的理由）；第一次评作者收 `TUTOR_RATING`，改票不重发 |
| DELETE | `/api/tutor/market/:id/rating` | 必须 | 删自己那一票并重算；没评过 404 |
| POST | `/api/tutor/courses/:id/merge-release` | 必须（课主） | **合并新版**（tutor 仓 docs/03 §6.3，2026-09-29）：把从市场开出来的课合到那位老师的最新发布版 —— 三方合并（我手里的 / 当初复制的那版 `sourceRelease` / 最新版，规则只在 `core/publish/merge`）只换 ③ 结构与 ④ 内容：② 与进度按 `stage_id` 保留、`renamed_from` 搬进度、消失的阶段进 `run.archived` 不删；学习者自己加的必背 / 自检 / 易错点与全部学生问答留着（没有 `sourceRelease` 的老数据只保问答，`baseKnown:false`）。→ `{ version(自用件新版号), note, report:{ added, removed, renamed, changed, kept, learnerKept, studentQaKept, truncated, baseKnown }, source }`。409：`NOT_FORKED`（不是从市场开的）/ `SOURCE_GONE`（老师下架或取消分享）/ `UP_TO_DATE`。课程 summary 的 `source` 多 `personaName / latest / updateAvailable / gone / mergedAt` |
| GET | `/api/tutor/admin/claims?stage=new\|awaiting\|upheld\|rejected\|all&page` | 管理员 | **教授认领的人工核实队列**（2026-09-29；tutor 仓 docs/06 §4.2）：与 `GET /api/admin/branch/reports` **同一张 Report 表**，只是按 `targetType:persona × reason:instructorClaim` 切出一条车道。阶段**不新增 status 取值**，由 `status + review.contactedAt` 派生（new = 没联系过、awaiting = 联系过等补证、upheld = taken_down、rejected = dismissed）；待核实按**先来先处理**（createdAt 升序）。`{ items:[{ id, stage, status, detail, createdAt, reporter:{_id,username,displayName}（不回 email）, handler, handledAt, handleNote, review:{ contactedAt, contactCount, log[{at,by,action,note}] }, persona:{ exists, id, name, subject, author, shared, takenDown, takenDownReason, version, downloadCount, ratingCount, marketPath } }], total, page, limit, stage, counts:{new,awaiting,upheld,rejected} }` |
| POST | `/api/tutor/admin/claims/:id/contact` | 管理员 | `{ message ≤500 }` 联系举报人要证据：给举报人一条 **ADMIN_NOTICE**（平台口径、无 actorId，`payload { text, claimId, personaId }`），写 `review.contactedAt / contactCount / log`，状态不动 → 进「等待补证」。已处理 409 `HANDLED` |
| POST | `/api/tutor/admin/claims/:id/verdict` | 管理员 | `{ verdict: upheld\|rejected, note? }` 裁定。**处置正文与通用队列同一份**（`services/reportResolve.service`）：upheld = registry 下架（作者看到的原因「教授认领经人工核实成立：备注」）→ `taken_down` → 同一位老师上其余待处理举报一起收尾 → 举报人与作者各一条 ADMIN_NOTICE；rejected = `dismissed`，只通知举报人。老师已不存在 409 `TARGET_GONE`；已处理 409 |
| POST | `/api/tutor/referral` | 可选 | **引流位度量**（M3，2026-09-29；tutor 仓 docs/06 §5.1「度量（每条都能防刷）」）`{ from, path? }`：各入口带 `?from=`（白名单在 `core/publish/referral.REFERRAL_FROM`：nav / download / settings / tour / persona / gallery / preview / app-settings / app-create），落到 `/tutor` 时客户端发一发再把参数从地址栏抹掉。**只记不奖励**：未知来源不记（200 `recorded:false, reason:"unknown_from"`）、同一主体（登录 = 用户 id；游客 = IP 指纹 sha256 前 32 位，**不存明文 IP**）同一来源每天一条（201 `recorded:true` / 200 `reason:"duplicate"`）、90 天 TTL；按 IP 限流 30 次/分。表 `TutorReferral`，写入只在 `tutorMetrics.service.recordReferral` |
| GET | `/api/tutor/admin/metrics` | 管理员 | **三条度量**（M3）：`{ days:30, since, referrals:[{ from, count, users }], activation:{ tutorUsers, crossUsers, ratio }, companion:{ personas, accounts }, fork7d:{ days:7, forks, activated, ratio } }` —— 激活 = 同一 `user._id` 既有 `TutorRun` 又是 `BranchVideo` 作者或有 `CompanionSetting`（distinct + `$in`，按人去重）；反哺 = 勾了「同时发布为启梦人格」的老师数 / `CompanionSetting.persona` 指向它们的账号数；fork 7 天 = 从市场开始学的课里 7 天内通过 ≥1 阶段的比例（`core/publish/referral.forkActivated`，没记 passedAt 的不算）。只读 |
| GET | `/api/tutor/runs/:id` | 必须 | 学习页 bundle `{ run:{ status, progress, currentStage, usage, lastTurnSeq, demo, distill, dueReviews, pendingReview }, doc, materials, turns(最近 60), companion }`。`companion`（M4，2026-09-29；App 上课页「老师能不能开口」）= `{ personaId, name, enabled, reason? } \| null`：run 对应的老师人格（从市场开的课 = `sourcePersona`，作者自己的课 = 这门课发布出的那条），`enabled` 与「能不能装进看板娘」**同一条判定**（`personaAccess.checkPersonaAccess`：可见 + 勾了「同时发布为启梦人格」+ 付费；实现 `tutorPublish.companionOf` 只转述它），denied 时 `reason` 原样带回（`not_companion` / `private` / `unpaid`，只给排障看）；没发布过 / 人格已删 = `null`。客户端**判否定**：`null` 与 `enabled:false` 都画成纯文字，老 App 没有这一格照常上课 |
| GET | `/api/tutor/runs/:id/turns?after=` · `/review-card` · `/review-due` · `/review-quiz?stage=` · `/revisions` · `/usage-export?format=md\|csv\|json&from&to` | 必须 | 增量轮次 / 复习卡 / 到期回访 / 回访题 / 修订记录（新的在上 + 等点头数）/ 使用记录（复旦承诺书四项，csv 带 BOM） |
| PATCH | `/api/tutor/runs/:id/progress` | 必须 | `{ stage, stepIdx }` 漫游进度；走到最后一步 pending → taught |
| POST | `/api/tutor/runs/:id/turns` | 必须 | 一轮（**SSE**）`{ kind: ask|teach|quiz-from-selection|select|memorize, stage?, text?, selection?, direct?, selfExplain? }`；`select` / `memorize` 不过模型按 JSON 回 |
| POST | `/api/tutor/runs/:id/quiz` | 必须 | `{ stage?, answers[], review? }` → `{ results, correct, asked, passed, progress, nextStage, nextReviewAt, dueReviews, distillQueued }`；通过线 2/3 只在 `core/session/progress.js`；模型判卷形状不对退回确定性判法（今天不计费） |
| POST | `/api/tutor/runs/:id/skip` · `/feedback` | 必须 | 作者跳过自检 / 给某一轮 👍👎 `{ seq, value: 1|-1|null }` |
| POST | `/api/tutor/runs/:id/distill` | 必须 | 手动「整理一下」→ `{ status: done|empty|nothing|failed, revision, learned, pendingReview, version }`；扣 tutor_distill（模型回了正文即受理，形状不对重试一次不再扣） |
| POST | `/api/tutor/runs/:id/revisions/:rid/review` · `/revert` | 必须 | 逐条点头 / 否掉 `{ accept[], reject[] }`（点头了至少一条 = 版次 +1）/ 逐条撤销 `{ opIds[] }`（追加 `kind:revert`，历史不删） |

SSE（turns / preview）事件与 companion 同形：`token {t}` · `sentence {index,text}` · `done {seq,kind,text,flags,demo,preview,stage,progress,status,changed,distillQueued}` · `error {message}`；每 15 秒一行 `: ping` 注释帧。

```jsonc
// POST /api/tutor/runs/:id/turns —— 圈着教材原文问
{ "kind": "ask", "stage": "stage-02", "text": "这一句怎么理解？",
  "selection": { "anchor": { "material": "ed7455bfc594", "page": 12, "quote": "传播时延 = d / s" } } }
```

状态码约定：

- `402 INSUFFICIENT_TOKENS` / `403 PLAN_REQUIRED|WALLET_FROZEN` / `429 DAILY_LIMIT`：开流之前就拒，一分不扣（billing 的形状原样回）
- `409 BUSY`：老师还在回上一句 / 这门课正在生成；`409 NO_PERSONA`：还没生成老师；`409 NOT_PASSED`：没通过的阶段谈不上回访
- `501 AI_NOT_CONFIGURED`：没配模型且不许演示（生产）

★ **钱的序列**（tutor 仓 docs/05 §6.2）：教学轮在开流**之前** `billing.preAuthorize` 原子扣 `tutor_turn`，第一个 token 之前上游抛 ⇒ `refundUnaccepted`（`refundTag:"tutor_refund"`，进 `TOKEN_REASONS` 与 `SPEND_REASONS`），之后断流不退（W2 同口径）；管理员免单照 `noteFreeCall` 记账。生成受理即扣整份报价（`core/generate/pricing.generateQuote`，与端点报价同一个函数）。
★ **三个单价是建议值**（tutor 仓 docs/08 #4、docs/10）：`tutor_turn` 钉在 `CHAT_TURN_TOKENS`，另两个按 dogfood 量出的 p95 相对教学轮的比例定；改数只改 `TUTOR_PRICES` 一处，tutor 仓 `src/generate/pricing.js` 镜像（`tests/tutorCore.spec.js` 钉着两处相等）。
★ **私有**：教材原件在 Cloudinary raw（公开投递 401，只能签名下载）；块级文本、对话、修订记录永不进任何导出件；导出件本身永不含教材（`materials_included` 恒 false，导出前 `cleanCheck` 逐段核查）。

## 语音合成（工坊 NPC 的嗓子）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/tts/health` | 无 | `{ ok, tts: boolean }` —— 这台服务器配没配 `TTS_API_KEY`。不回密钥本身 |
| POST | `/api/tts` | **必须** | 合成一句台词，回 `audio/mpeg`。按用户限流 30 次/分钟 |
| GET | `/api/tts/voices` | 无 | 音色目录 `{ ok, voices, mixable, defaultVoiceId, maxMixVoices: 3 }`：`voices` = 2.0 单音色（每条 `generation:"2.0"`、`mixable:false`），`mixable` = 23 个验证过的 1.0 音色（`{ id, name, gender, generation:"1.0", mixable:true }`），混音配方**只能**从 `mixable` 里选。声音市场 `/api/voice-templates` 的契约见 server 仓 `PROJECT_STRUCTURE.md` 路由章节 |

请求体（除 `text` 外都可省）：

```jsonc
{
  "text": "≤300 字，超出截断",
  "voice": "zh_female_gaolengyujie_uranus_bigtts",  // 只允许 [A-Za-z0-9_.-]{1,64}，非法值回落默认音色
  "mix":   [{ "id": "…", "w": 0.6 }],               // 混音配方（≤3 味；也收 [{ "voiceId", "weight" }] 即 VoiceSettings.mix），权重服务端归一到和 = 1；只吃 1.0 音色（GET /voices 的 mixable）
  "emotion": "happy", "instruct": "用更冷静的语气",
  "rate": 0,        // [-50,100]，0 = 1.0 倍
  "pitch": -1,      // [-12,12]
  "expressive": true // 2.0 ICL 音色专属；<cot> 标签生效的前提
}
```

状态码约定（客户端据此决策，见 `app/src/studio/speech.ts`）：

- `501` 服务端没配密钥、`404` 没挂路由、`401/403` 掉登录 → **本会话永久关掉云端合成**，退回浏览器内置合成器
- `502/504` 上游偶发失败 → 只是这一句没出声，不关云端（下一句照常重试）
- `400` 空文本

★ **这个端点必须在服务端，不能只留在 app 仓 `vite.config.ts` 的 dev 中间件里**：
打成 APK 后 vite 不存在，`/api/tts` 无人应答，工坊 NPC 全程哑巴（安卓 WebView 的
`speechSynthesis.getVoices()` 常年返回空数组，退回本地也没声）。密钥更不能进前端包。

★ 与 `ARK_API_KEY` 是**两套凭据**：不同域名（openspeech vs ark）、不同鉴权、不同控制台。
方舟没有 TTS。控制台要开通的是 **2.0**（`seed-tts-2.0`），1.0 是另一件商品。

## 火山方舟代理（App 整条 AI 出片管线）

挂载点：`app.use("/api/ark", require("./routes/ark.routes"))`。凭据是服务端 `.env` 的 `ARK_API_KEY`。

| 方法 | 路径 | 鉴权 | 限流 | 说明 |
|---|---|---|---|---|
| GET | `/api/ark/health` | 无 | — | `{ ok, ark, imageGroups, res480, draftMode, failRefund, freeVideo: [{label, model, resolution}] }`：配没配 key + 能力位（老服务端没有的位 = 没有这个能力，App 据此藏起对应的东西；判能力只看能力位，不看状态码） |
| POST | `/api/ark/images/generations` | required | 30/min | Seedream 出图（卡面 / 首尾帧） |
| POST | `/api/ark/contents/generations/tasks` | required | 30/min | Seedance 出视频 / Seed3D 建模（同一个异步任务端点） |
| GET | `/api/ark/contents/generations/tasks/:id` | required | 90/min | 轮询任务状态（每 5s 一次，一段视频最多 120 次，所以单独一个桶） |
| POST | `/api/ark/chat/completions` | required | 30/min | 豆包对话 / 看图说话 |
| GET | `/api/ark/asset?url=…` | required | 90/min | 取方舟产物（图片 / 视频 / 3D zip），域名限 `*.volces.com`、`*.volccdn.com` |
| POST | `/api/ark/transfer-video` | required | 30/min | body=`{url}`（限方舟视频域名）→ 服务端拉取并传 Cloudinary → `{url}` 永久地址。**出片一成客户端就调它**（2026-08-20 起）：TOS 直链跨境下载速度低于成片码率，预览黑屏、合并超时；转存失败客户端退回方舟直链（24h 内有效，发布时的转存老路会再兜一次）。不计费（不产生算力消耗）。实现与发布时的转存共用 `services/videoAsset.service` 一份 |

请求体与响应**原样透传**方舟 v3（含错误码：`400` 敏感词、`429` 限流——客户端对这两者的
处置完全不同，聚合成 502 会把区分抹掉）。`POST /api/ark` 的 body 上限放宽到 50MB
（Seedance 任务带 base64 首尾帧），闸门同 `/api/branch`：先验 JWT 签名再决定给多大缓冲区。

**这是白名单转发，不是通用反向代理**：只有上表这几条上游路径可达，且 `model` 必须在
`ALLOWED_MODELS` 里（对应 `app/src/ai/arkClient.ts` 的 `MODELS` 与
`app/src/data/economy.ts` 的 `VIDEO_TIERS` / `IMAGE_TIERS`）。**App 新增视频档位 =
服务端要补一行** —— 每加一个模型都是一笔新单价，应该有人明确点头。
★ **出图那几行是从价目表自动带出的**（`ALLOWED_MODELS` 里摊开 `tokens.IMAGE_MODELS`）：
出图的「在册」与「有价」必须是同一件事。分成两张手写的表有两种漏法，而且都不报错 ——
在册了没定价 = 落到兜底按最贵档收（用户被多扣）；定价了没在册 = 这一档永远 400
（用户只会觉得"这档坏了"）。回归测试见 `server/tests/arkProxy.spec.js`。

### 视频档位与模型能力（写死在两边的表里，不靠运行时探测）

| 档位 id | label | 模型 | 分辨率 | 系数 mult | 首尾帧 | 参考图 | 时长窗口 | 谁能用 | 停用 |
|---|---|---|---|---|---|---|---|---|---|
| `fast` | 极速 | `doubao-seedance-1-0-pro-fast-251015` | 720p | 4.2/15 | ✗ | ✗ | 3~10s | **免费版可用** | 2026-11-24 13:00（北京时间） |
| `draft` | 草稿 | `doubao-seedance-2-0-mini-260615` | **480p** | 23/15 | ✓ | ✓ | 4~15s | **免费版可用** | — |
| `std` | 标准 | `doubao-seedance-1-0-pro-250528` | 720p | 1 | ✓ | ✗ | 3~10s | 付过钱 | 2026-11-24 13:00（北京时间） |
| `hd` | 高清 | `doubao-seedance-2-0-mini-260615` | 720p | 23/15 | ✓ | ✓ | 4~15s | 付过钱 | — |
| `ultra` | 电影级 | `doubao-seedance-2-5-260628` | 720p（样片 480p → 1080p） | 4.7（样片第二步 77/15） | ✓ | ✓ | 4~30s | 付过钱 | — |

★ **「草稿」与「高清」是同一个模型**，只差分辨率 —— 服务端的免费档清单、分辨率清单、跨仓测试都按 **(模型, 分辨率)** 认，
只按模型认就会把高清一起放给免费版（或者把草稿一起挡掉）。

- **参考图（全模态参考生视频）只有 2.5 与 2.0 系列有**；1.0/1.5 完全不支持。没人验证过
  1.0 收到 `reference_image` 是 400 还是**静默忽略** —— 若是忽略，用户就"加了图、多付了钱、
  画面一点没变、零报错"。所以 App 侧按 `VideoTier.refImg` 做硬白名单，不满足**降级回
  首尾帧模式并把原因说出来**，不指望方舟报错。
- **首帧 / 首尾帧 / 参考生视频是三种互斥场景**（方舟文档原文），不可混用：给了
  `reference_image` 就一张首尾帧都不能带。
- **2.5 在首帧/首尾帧任务上只接受 `ratio: "adaptive"`**（2.0 系列没有这条限制）；参考生
  视频任务上才能给具体宽高比。规则收在 `app/src/ai/arkClient.ts` 的 `ratioFor()` 一处。
- **2.5 的参考任务必须显式传 `omni_reference_task_type: "reference"`**：不传就是 `auto`，
  而 auto 判错是**异步失败** —— 任务已受理、钱已经扣了，几十秒后才 failed（2026-10-07 起会自动退回，
  但人白等了一趟，见下「失败退款」）。显式传则在提交时同步 400，一分钱不花。
- **2.5 的时长区间是 [4,30]**，给 3 秒同步 400。App 的时长下限写在 `VideoTier.minSec`，
  报价（`segTokens`）与出片（`composeSegments`）用同一个 `clampDuration`。
- **免费版（没付过钱）只能用「极速」「草稿」出普通片**（2026-10-07 主人拍板）：标准 / 高清 / 电影级（含样片两步）/
  真人档（MiniMax、Runway）/ 一切带参考视频的出片（白模、返修、延长、素材参考）都要**付过钱** ——
  有付费套餐（月费 > 0）**或者**付过任何一笔钱（充值包、套餐、Play 购买；钱包上的 `paidEver`）。
  判据只有服务端 `config/tokens.videoPlanDenial` 一处（「付过钱」是 `isPaidUser`）；它只管出视频，出图 / 对话 / 语音 / Seed3D 照常开放。
  拒绝回 **403** `{ code: "PLAN_REQUIRED", message, planId, allowed: ["极速","草稿"] }`：`message` 是能直接显示的整句中文
  （不含模型 id、不含 ASCII 双引号），`allowed` 是此刻免费版能用的档名（英文界面不显示服务端的中文句子，靠它自己说）。
  停用时刻一过，`allowed` 只剩「草稿」。App 侧免费版**看得见但点不动，并写出原因**（`tierBlockReason`）；
  ⚠ 客户端禁用只是提示，**不是安全边界**。运维总开关 `FREE_VIDEO_GATE=off`（缺省开）关掉之后退回改版前的口径：只挡电影级。
- **白模（r2v）能不能卖看 `VideoTier.refVid`**（App 档位表，四档全显式写值）：
  2026-08-14 起 **ultra=true 已开闸**（前置 A2 保真度 / A3 计费公式 / A4 门槛探底
  三发实测全过），其余三档 `false`（hd 的开闸前置见 r2vMult 注释：A6 + 画质实拍 +
  14元/M 账单核对）。未开档位界面按 `r2vPriceIssue` 整句「看得见但点不动 + 说原因」，
  **绝不静默退回首尾帧**（那是偷换商品）。服务端侧对应的白名单是
  `VIDEO_MULT_R2V`（模型不在表里 → r2v 任务 400 拒单）。

### 纯任务的参数钉子、样片两步、停用（2026-10-07）

**纯任务**（没有参考视频：文生 / 图生 / 参考图生视频 / 样片第一步）过 `pinPlainVideoTask`（server `ark.routes.js`），
不符 → 400 `VIDEO_PARAMS_NOT_ALLOWED`（整句中文，「没有扣费」）：

- **缺省补齐，不再放行**：不传 `duration` 补成 **5**、不传 `resolution` 补成 **720p**。方舟的缺省是 2.5 `-1`（最长 30 秒）、
  1.0 `1080p` —— 原来「缺省放行」就是两个少收的口子。补齐之后计价与门禁读的都是补好的那一份。
- `duration` 是这个模型窗口内的整数（不收 -1、字符串、小数）；不收 `frames`。
- **分辨率按模型放**（`tokens.VIDEO_RESOLUTIONS`）：1.0 两档只有 720p；2.0 mini 480p / 720p；2.5 只有 720p。
- **`draft: true`（电影级样片第一步）**：只给 2.5，且必须**显式** `resolution: "480p"` 与整数 `duration`；`draft` 只认布尔，
  `false` 与缺省同义（转发前剥掉）。带参考视频的出片不收 `draft`（`R2V_NOT_ALLOWED`）。
- `content[]` 只认 `text` / `image_url` / `audio_url`（`video_url` 由 r2v 那道闸接走，`draft_task` 由样片第二步那道闸接走）。
- **停用**：`doubao-seedance-1-0-pro-250528` 与 `doubao-seedance-1-0-pro-fast-251015` 自 **2026-11-24 13:00（北京时间）**起
  新任务一律 400 `{ code: "MODEL_RETIRED" }`（方舟 14:00 停服，我们提前一小时；`tokens.RETIRED_MODELS_AT`）。

**每一发 Seedance 任务**（纯任务、r2v、样片两步、白模化）转发前由服务端钉死：`execution_expires_after: 86400`
（客户端的值覆盖 —— 排队 / 运行超过 24 小时方舟标 `expired`，失败退款按它退）；剥掉 `callback_url`（拿我们的 key
往任意地址 POST）与 `service_tier`（flex 半价但排队以天计，我们按在线价收）。这两个字段在 Seed3D 任务上也剥
（同一个端点、同一个口子）；Seed3D 不套 `execution_expires_after`（没核实它收不收）。唯一实现 `arkGateway.withServerTaskFields`。

**电影级样片第二步**（480p 样片 → 1080p 成片）：`POST /api/ark/contents/generations/tasks`，请求体只许

```json
{ "model": "doubao-seedance-2-5-260628", "content": [{ "type": "draft_task", "draft_task": { "id": "<样片任务 id>" } }] }
```

另外只容忍 `resolution`（只能是 `"1080p"`）、`watermark`、`draft`（只能 false）、`execution_expires_after` / `callback_url` / `service_tier`
（这几样都会被重写或剥掉）。时长、画幅、提示词、图、视频、音频、种子、音频开关、任务类型**一个都不许带**（方舟规定沿用样片、重传即报错）
→ 400 `DRAFT_FINAL_NOT_ALLOWED`。服务端（`resolveDraftFinal`）：
- 只认**本人、经我们这里出的样片**（`ArkVideoTask` 里 `draft: true` 的那一条）—— 所有人的任务挂在同一把方舟 key 下；
- 有效期 **7 天差 1 小时**（方舟 7 天），按我们的登记与方舟 `created_at` 里更早的那个算；
- 向方舟 GET 一次（不计费）确认 `succeeded`（`running` 等 → 400；404 → 400；查不通 → 502，都不扣费；没配 key → 501）；
- 请求体重写成 `{ model, content:[draft_task], resolution:"1080p", watermark:false }` 再转发；
- **计价** = `round(样片时长 × 2.5 的 1080p 每秒 × 77/15)`：时长取**样片登记的** `durationSec`（不信请求体、也不信方舟回的数，
  登记没有才退方舟的整数秒），画幅取方舟回的实际画幅（认不出按 1080p 最大一格）。免费版一律 403（与其它出片同一道门）。
- 成片那一发在 `ArkVideoTask` 里记 `draftOf: <样片 id>`；`GET /api/ark/video-tasks` 的每一条多带 `draft` / `draftOf` / `costTokens`。

### r2v（带参考视频的出片）的服务端规则 —— `reference_video` 只有四条合法来源

任务体 `content[]` 里带 **`video_url` 形状条目**（`type:"video_url"` 或带 `video_url`
键——按**形状**判不按 `role` 判：`role` 是客户端可控字符串，只认 `role` 会被"去掉
role 的 video_url"绕过、按纯任务价放行）的请求，代理在计费前先过 `resolveR2v`
（server `ark.routes.js`）。

先过三条共同的门：

1. 条目必须带规范的 `role:"reference_video"`（有 `video_url` 却没有 → 400），且只许一条。
2. `model` 必须在 `VIDEO_MULT_R2V` 价目表里（首发只有 Seedance 2.5 = 2.8），不在 →
   400。**绝不静默按纯任务系数（4.7）结算** —— 那是不含视频输入的价，
   等于输入时长一分不收、账目全瞎。
3. **生成参数钉死在计价假设上**（按子任务各钉各的，2026-10-05 起三套）：
   - **edit**（白模复刻 / 白模化 / 返修）：`omni_reference_task_type` 必须是 `"edit"`、`duration` 只能缺省或 `-1`、
     `resolution` 只能缺省或 `"720p"`、`ratio` 只能缺省或 `"adaptive"`；计价 `r2vTokens` = (输入时长 × 2)×720p×24fps×系数；
   - **reference**（素材参考，分支三）：不许带 `omni_reference_task_type`（或显式 `"reference"`）、`duration` 是这个模型窗口内的整数（不收 -1）；
     计价 `materialRefTokens` = (输入 + 输出)×…；
   - **extend**（延长，分支四）：`omni_reference_task_type` 必须是 `"extend"`、`duration` 是窗口内的整数（不收 -1）、
     `ratio` 只能缺省或 `"adaptive"`（方舟对延长的要求）、`resolution` 只能缺省或 `"720p"`；计价同 reference（输入 + 输出）。
   越出任一条 → 400。以 edit 为例：计费是 (输入时长×2)×720p×24fps，而代理原样转发
   请求体——不钉的话改一行客户端就能按 4s 模板的价买 30s/1080p 的产出（reference
   子任务 duration 自由、-1 上探 30s，A7 实测），差额全进我们的方舟账单且零症状。
   `generate_audio` 钉的是「**与该模型的支持情况一致**」（`config/tokens.VIDEO_AUDIO`
   与 App `VideoTier.audio` 逐条相等）：支持的档允许 `true`，不支持的档只许 `false`/缺省
   —— 1.x 收下参数却静默忽略，传了会让两边都以为"这一发有声"。⚠ 开音频**零额外成本**
   （2026-08-15 费用中心逐行核对：同素材有声/无声两发用量与单价逐位相同），
   所以它**不进任何计价公式**。

**分支一：已登记的白模模板**（套用出片 / 作者试炼）

按 `video_url.url` **等值反查** `BranchTemplate.refVideo.url`（唯一索引，存的是
Cloudinary `secure_url` 规范形态——塞一段 transformation 也绕不开）。
`blocked` 的模板不能用；**未发布**的模板只有作者本人能用（那正是发布前的试炼一步，
别人拿到 URL 也蹭不了）。计价输入时长**只从服务端登记的 `refVideo.durationSec` 读**，
请求体里客户端说什么都不作数；流水 memo 追加 ` r2v tpl:<id>`；任务受理后落试炼追踪。

**分支二：本账号刚传、尚未登记的托管素材**（**白模化那一发的输入**，V2 新增）

白模化的输入是"用户刚传的素材裁出来的那一段"，此时世上还没有任何模板，分支一必然落空。
⚠ **绝不能**为了过闸门先把用户原视频登记成一个"模板"：那会污染模板库、撞 `refVideo.url`
唯一索引，还让试炼闸对着中间物计数。所以开第二条分支：

- URL 必须是**服务端自己拼的那种裁剪变换地址**（`utils/templateVideoAsset.parseOwnClipUrl`
  解得出 `publicId` + `so_`/`du_` + `c_crop` 四组数，且 `publicId` 归属本账号）。
  **没有 `du_` 的地址一律不认** —— 那等于把整条原片（最长 600s）喂进去却只按纯任务价收。
- 已经被登记过的素材不许走这条（否则"加一段裁剪变换"就绕开了 blocked / 未发布两道门禁）。
- 裁后那一段要过 **② 号窗口**；再现查一次 Cloudinary 资源详情，确认 `public_id` 真的存在、
  裁剪框没超出原片（`c_crop` 超界时 Cloudinary 自己裁到边界而不是报错）。
- **计价输入时长 = URL 里的 `du_` 那个数**，理由是它**自洽**：Cloudinary 照这条变换投递，
  方舟拿到的就是这么长的一段 —— 同一个字符串同时决定了"上游收到多长"和"我们收多少钱"，
  客户端拼不出"少付多得"。公式仍只有 `config/tokens.r2vTokens` 一处（**不加新公式**）。
- 这一路 `templateId` 为 `null`：**不落试炼追踪**（模板还不存在）。流水 memo 追加
  ` r2v src:<publicId>`（对账时分得出白模化那一发）。
- 额外限流：`6 次/分`（`ark-r2v-source` 桶，**串在** genLimit 后面）—— 每一发都要打一次
  Cloudinary Admin API，而免费档 Admin API 是**全局** 500 次/小时，不限的话一个账号能把
  全 App 的建模板能力一起刷停摆。

**分支三：已登记的用户素材参考视频**（工作流「自定义 = 多图 + 参考视频」，2026-08-28）

按 URL 等值反查 `MaterialRefVideo`（登记时服务端从 Cloudinary 写入时长）；素材**私有**，只有登记者本人能用。
走 reference 子任务（输出时长由用户选），计价 `materialRefTokens`（输入 + 输出）。

**分支四：本人自己出的成片**（App「修这一段」：返修 / 片段重拍 / 延长，2026-10-05）

- URL 是出片即转存的成片地址（`ideahub/branch-videos/<userId>-<毫秒>-<后缀>`，不带变换），归属用服务端合并认段落的
  同一个判据（`utils/videoCompose.parseOwnBranchVideoUrl`：目录 + 文件名以本人 id 开头）。别人的成片不认（落到下面「都不中」）。
- **计价输入时长由服务端向 Cloudinary 查**（Admin API，`media_metadata`），查过记进 `SegmentRefVideo`（TTL 一天：成片会被回收，
  缓存活得比文件久的话方舟拿不到视频是受理之后的失败）；客户端报的数一个不信。成片要过方舟参考视频窗口（`templateRefIssue`：4~30 秒等）。
  查不到（404）→ 400「找不到这一段成片」；别的读取失败 → 502；都不扣费。缓存没命中时同样走 `ark-r2v-source` 那道 6 次/分的桶。
- 只收两种子任务：`edit`（返修 / 片段重拍，计价 `r2vTokens` 输入 × 2）与 `extend`（延长，计价 `materialRefTokens` 输入 + 输出）；
  别的（含不带任务类型）→ 400。流水 memo 追加 ` r2v edit own:<publicId>` / ` r2v extend own:<publicId>`。
- ⚠ 2026-10-05 之前没有这一条：App 的「返修」发的就是本段成片，**在正式包里一直被这道闸 400**（不扣钱），只在 dev 直连方舟时跑得通。
- 高清档（2.0 mini）2026-10-05 起在 `VIDEO_MULT_R2V` 里（含视频输入的刊例 14 元/M ⇒ 14/15，主人「合」）：四条分支对它一样放行、按同一个式子结算。
  付费探测（app 仓 `design/video-input-probe.mjs`）：mini 认 `omni_reference_task_type`，参考 / 编辑 / 延长都一次受理；**延长的第一帧接不上原片**，
  所以 App 不给高清开延长（`VideoTier.extendOk`）—— 服务端只管价钱，真有高清延长的请求照价结算、不会少收。

四条都不中 → **400 `R2V_NOT_ALLOWED` 整句拒**，方舟不会被调用、不扣费。

为什么要收窄到这几条：r2v 的输入视频时长计进 token，「输入多长」只能有可信来源
（服务端登记值 / 服务端自己拼的 `du_` / 服务端向 Cloudinary 查到的时长）。代价是封死了"拿任意视频二创"这类 r2v ——
有意的范围取舍，放开前必须先解决输入时长的可信来源。

### 白模链路的两笔钱（报价 = 实收，两仓逐条相等）

V2 这条链路**花两次真钱**，报价页必须**两笔都写明**，不许只报后面那次：

| 步骤 | 计价 | 备注 |
|---|---|---|
| 看帧列人物（blockoutize 第 6 步） | 一次 chat（按**帧数**计） | App 侧 `blockoutizeCost(frameCount, …)` 的第一项，`frameCount` 由 `visionFrameCount(durSec, frameTimes)` 现算（自动 = 按时长，自己挑 = 标了几帧）。回包的 `frames` 是实收口径 |
| **白模化出片**（第 7 步） | `r2vTokens(durSec)` | `durSec` = 编辑页框选的那一段（走上面的分支二） |
| 套用出片 | `r2vTokens(template.refVideo.durationSec)` | 走分支一，与 V1 一致 |

### 出图档位与计价（**按 `model` 查表，不是一口价**）

| 档位 id | label | 模型 | 单价 | token/张 | 图位数 K |
|---|---|---|---|---|---|
| `sketch` | 速写 | `doubao-seedream-4-0-250828` | 0.20 元/张 | **13,333** | 1 |
| `studio` | 定妆 | `doubao-seedream-4-5-251128` | 0.25 元/张 | **16,667** | 2 |
| `master` | 精绘 | `doubao-seedream-5-0-pro-260628` | 0.60 元/张 | **40,000** | 3 |

折算口径与视频同一把尺子：**元/张 ÷ 15 元/百万 token**（15 = Seedance 1.0-pro 标准档）。
实际张数 = `min(K, 该卡种的图位数)`，见上面「`views[].kind`」——非人物卡只有 2 格，
顶档对它们真的少画一张、也真的少收一次钱（`economy.slotsFor()` 一处实现，报价与结算共用）。

★ **2026-08-11 之前这里是个致命缺口**：服务端 `priceOf` 拿到了请求体却**不读 `model`**，
一律按 13,300 收 —— 也就是**顶档按最低档收费**，每张顶档图白送 0.4 元。这种错没有任何
症状（用户无感、界面无错、测试全绿），只有火山账单知道。现在 `config/tokens.js` 按模型
查表，`arkProxy.spec.js` 与 `tokenWallet.spec.js` 各钉了一份。

★ **认不出的出图模型按已知最贵的一档收，并打 `console.error`**，既不按最便宜的收
（等于白送且永远没人发现），也不 throw（`billedForward` 会把它变成 500，**出图整条全挂**；
出图端点是用户可控 `model` 的转发口，老客户端随时可能发一个没登记的 id）。
方向是刻意选的：**少收是隐形的，多收当天就会被投诉**。这条兜底在路由上其实够不着
（在册 = 有价），是第二道保险。

⚠ **老客户端那个出图模型不能从在册名单里删。** 新版 app 已经把
`arkClient.MODELS.image` 改成跟着默认档走（`imageTierOf(DEFAULT_IMAGE_TIER).model` = 4.0），
新包不再发 `doubao-seedream-5-0-260128`；但**已装机的 APK 改不了** —— 它们补设定帧、
推三套方案的首尾帧、出 AI 封面全都还在发这个 id。删掉的表现不是"降级"，是那批用户
**出图整条 400**（而客户端把 400 当敏感词处理，连重试都不做）。
它的单价在方舟公开价目里**查不到**，所以服务端不去猜，直接沿用**老包自己报的那个价
13,300**（老版 `economy.IMAGE_TOKENS` 的常量）—— 老用户的「报价 = 实收」逐分不变，
这次改价对他们是**零影响**。若 5.0 实际更贵，差价我们自己吃：多收才是骗人，少收只是
我们亏钱，而且这批调用会随老版本淘汰而归零。
★ 这条兼容项的寿命 = 老版本的寿命；确认线上没有旧包在发它之后，连同白名单一起删。

各模型的像素区间是 2026-08-11 拿真 key 探出来的（发必然 400 的尺寸、读报错文案，零成本）：

| 模型 | 最小像素 | 最大像素 |
|---|---|---|
| `doubao-seedream-4-0-250828` | 921,600 | 16,777,216 |
| `doubao-seedream-4-5-251128` | 3,686,400 | 16,777,216 |
| `doubao-seedream-5-0-260128` ⚠仅老客户端 | 3,686,400 | —（未探） |
| `doubao-seedream-5-0-pro-260628` | 921,600 | 4,624,220 |

★ 那条 3,686,400 是 **4.5 / 5.0 专属**，不是 Seedream 通则 —— 别照抄成全家桶下限。
★ 卡面画布 `CARD_SIZE = 1728×2304 = 3,981,312` 像素：过得了 4.5 的下限，在 pro 上落在
**0.60 元那一档**（pro 按输出像素分档：≤261 万 0.30、>261 万 0.60）。这是有意的 ——
压到 261 万以下单价减半，但顶档出的图会**比中档还小**，一个"更贵却更糊"的顶档迟早被
当成 bug。哪天真要换成半价版，`ImageTier.size` 与两仓的价目表要**一起**改。
★ pro 实测出一张 1296×1728 要 **73.6 秒**（5.0 是 21-25s），所以客户端出图超时必须
大于服务端 `T_CREATE`。

⚠ 以上单价取自方舟公开价目（2026-08-11 核对），**尚未与控制台账单对过**。
**真实结算一律以控制台账单为准**；发现偏差改两仓的价目表（下面那条测试会红）。

状态码约定（客户端据此决策，见 `app/src/ai/arkClient.ts`）：

- `501` 服务端没配 `ARK_API_KEY` → 提示"这台服务器没有配置方舟密钥"
- `401` 掉登录 → 提示重新登录
- **响应不是 JSON**（`Content-Type` 不含 json）→ 提示"这台服务器没有 `/api/ark` 代理"

★ **最后这一条不是防御性编程，是修一个真故障。** 真机上 Capacitor 的本地静态服务器
对未命中路径做 **SPA 回退**：`POST https://localhost/api/ark/...` 拿回的是 **200 + index.html**
而不是 404。于是 `res.ok` 为真、`res.json()` 一头撞进 `<!doctype html>`，用户看到的是
「第 1 段生成失败：Unexpected token '<', "<!doctype"... is not valid JSON」，
工坊 NPC 对话同时哑火（走同一条路）。**判断"这台服务器有没有这个能力"要看
`Content-Type` 或专门的健康端点，永远不要信状态码**（`/api/tts` 当年栽的是同一条）。

★ 与 `TTS_API_KEY` 是**两套凭据**：不同域名、不同鉴权、不同控制台。互换一定 401。

### 扣费

**先扣钱、再转发；上游没受理就原路退回。** 顺序不能反：先转发再扣钱的话，余额不足的
请求已经把钱花掉了；而"先查余额、转发、再扣"更糟——查和扣之间的窗口正是并发双花的入口。
所以服务端的口径是「条件原子扣减成功 = 拿到了这次调用的许可」。

| 端点 | 计费 |
|---|---|
| `POST /images/generations` | **按 `body.model` 查表**：13,333 / 16,667 / 40,000（见上「出图档位与计价」）。认不出的按最贵档。**只出一张**：组图 / 图层拆分 / 流式 / `n≠1` / `tools` 一律 400（见下「组图」） |
| `POST /image-groups`（组图） | 受理时预扣 `单价 × max_images`，结束按**拿到手的张数**结算、多退（见下「组图」） |
| `GET /image-groups[/:id]` | **0** |
| `POST /chat/completions` | 400（一次豆包往返） |
| `POST /contents/generations/tasks`（Seedance） | `round(时长 × 每秒 raw token × 档位系数)`：每秒 raw token = 宽×高×24/1024 —— **720p 一刀切 21,600**（所有模型、所有画幅，改版前的口径）；480p / 1080p 按官方像素表逐格查（画幅缺省 / `adaptive` / 认不出按那一行最大一格）。系数：极速 4.2/15 / 标准 1 / 高清与草稿 23/15 / 电影级（含样片第一步）4.7。例：草稿 4 秒 9:16 = 61,603、5 秒 = 77,004；样片第一步 4 秒 9:16 = 180,621 |
| `POST /contents/generations/tasks`（**样片第二步**，`draft_task`） | `round(样片时长 × 2.5 的 1080p 每秒 × 77/15)`（刊例 77 元/M：输出 1080p、第一步无输入视频）。例：4 秒 9:16 = 997,920、5 秒 = 1,247,400。时长 / 画幅只取服务端登记与方舟查询（见上「样片两步」） |
| `POST /contents/generations/tasks`（**r2v 白模出片**，带 `reference_video`） | `输入时长 × 2 × 21,600 × r2v 系数`（2.5 = **2.8** = 42 元/M ÷ 15）。输入时长有且只有两个可信来源：**模板登记的 `refVideo.durationSec`**（分支一）或**服务端拼的变换 URL 里那个 `du_`**（分支二，白模化）。见上「r2v 的服务端规则」 |
| `POST /contents/generations/tasks`（Seed3D） | 160,000 |
| `GET /contents/generations/tasks/:id` | **0**（轮询高频，按次收会把一段片的价格翻几倍） |
| `GET /asset` | **0** |

- 余额不足 → **402** `{ code: "INSUFFICIENT_TOKENS", need, balance }`，**方舟根本不会被调用**
- 扣费先 plan 后 addon；服务端记下**这一笔从两桶各扣了多少**（`tokenWallet.debitSplit`）。
- 上游非 2xx（400 敏感词 / 429 限流 / 5xx / 501 没配 key）→ 扣掉的**按原桶退回**（plan 的回 plan、addon 的回 addon，
  `ark_refund`）。★ 2026-10-07 之前一律退进 addon —— 那是一条把会过期的当月额度洗成永久余额的路（敏感词提示词反复 400 即可）。
- **任务被受理之后才失败也退**（2026-10-07 主人拍板「做生成失败返回 token」）：方舟明说 `failed` / `cancelled` / `expired`、
  MiniMax 明说 `Fail` → 这一发的钱**按原桶退回、恰好一次**（流水 `provider_failed`，memo `provider_failed <ark|minimax> task:<任务号>`）。
  覆盖 Seedance 普通出片、r2v、电影级样片两步（各退各的）、Seed3D、白模化那一发 r2v、真人档 MiniMax。规则全文见下「失败退款」。
  ⚠ **老 App 还会说「受理之后的失败不退款」**（话是写死在包里的）—— 钱照退，只是那句话过时了。
- 退款**不抵欠额**（不在 `REPAY_REASONS`），**抵当日用量**（在 `SPEND_REASONS`）。
- 每个响应都带 `X-Wallet-Plan` / `X-Wallet-Addon`（CORS `exposedHeaders` 已放行），
  App 的钱包镜像据此同步，省掉一次 `GET /api/me/wallet`

★ **定价表两边都有，必须一起改**：服务端 `src/config/tokens.js` 是**结算**口径，
App `src/data/economy.ts` 是**报价**口径。不一致的后果是"报价 216k、余额掉了 243k"，
用户会觉得被偷了钱。已知的两处不一致写在 `tokens.js` 的 `priceOf` 注释里。
两张表的 **key 集合与数值必须逐条相等**，服务端有测试钉着（加档位漏一边就会红）：

| 内容 | app（报价） | server（结算） | 钉住它的测试 |
|---|---|---|---|
| 视频档位系数 | `VIDEO_TIERS[].mult` | `VIDEO_MULT` | `arkProxy.spec.js`「跨仓档位表一致性」（按 **(模型, 分辨率)** 认，草稿与高清不许塌成一行） |
| 每档分辨率 | `VIDEO_TIERS[].resolution` | `VIDEO_RESOLUTIONS` | 同上 |
| 免费档 | `VIDEO_TIERS[].freeOk` | `FREE_VIDEO_ALLOW` | 同上 |
| 停用时刻 | `VIDEO_TIERS[].retireAt` | `RETIRED_MODELS_AT` | 同上 |
| 像素表（480p / 1080p） | 像素表 | `VIDEO_PIXELS` | `arkProxy.spec.js`「跨仓像素表与 480p / 1080p 价目」（含草稿 / 样片两步的价目钉子） |
| **r2v 档位系数** | `VIDEO_TIERS[].r2vMult`（非 null 的那些档） | `VIDEO_MULT_R2V` | `arkProxy.spec.js`（r2vMult ↔ VIDEO_MULT_R2V 双向相等） |
| 出图单价 | `IMAGE_TOKENS_BY_MODEL` | `IMAGE_TOKENS_BY_MODEL` | `arkProxy.spec.js`「跨仓出图价目一致性」 |
| 套餐 / 直充包 | `PLANS` / `RECHARGE_PACKS` | `PLANS` / `order.service.RECHARGE_PACKS` | `payOrder.spec.js`「跨仓价目一致性」 |

出图那组除了逐条比数，还额外钉了三件事：**三个价互不相同**（证明"真的读了 `model`"，
而不是碰巧等于某一档的常量）、**档位越高越贵**（顺序倒挂 = 用户为更好的图付更少）、
**兜底不静默**（认不出的模型必须打日志）。

⚠ `电影级` 的 4.7 = **70 元/百万 token ÷ 15**（标准档 1.0-pro 15 元/M = 1）。这个 70
**不是从方舟官方价目表页读到的**（那页抓不到内容），是两个独立来源互相印证：另一来源
报「720P 每秒约 1.51 元」，而 1 秒 720p24 = 21,600 token ⇒ 1.51/0.0216 ≈ 69.9 元/M。
上线前必须照**控制台实际账单**校一次。

**r2v（白模出片）的公式与系数**（✅ 与 4.7 那种"来源互证"不同，这条**对过真账单**：
2026-08 A3 实测两发，同素材各打一发 t2v 与 r2v，两行账单与公式逐 token 相等，分毫不差）：

- 方舟原始公式：`raw = (输入视频时长 + 输出时长) × 输出宽 × 输出高 × fps ÷ 1024`。
  **输入视频的时长也计费**；输出恒为 720p 档（16:9 实测 1280×720=921,600px，adaptive
  实测 1266×728=921,648px，同为 92 万 px 级）、fps=24 ⇒ 每秒 **21,600** raw token。
- 报价与结算都按 **输出时长 = 输入时长** 取上界（edit 任务输出≈输入是协议行为；实测
  方舟还会略微裁短输出：14.04s 输入 → 13.67s 计费，即报价 ≥ 实收，误差 ~1%，方向安全）
  ⇒ 两仓同一条式子：`Math.round(输入时长 × 2 × 21,600 × 系数)`。
- 系数 = 含视频输入档单价 ÷ 15：2.5 视频输入档 **42 元/M** ⇒ **2.8**。它与纯任务的 4.7
  是**两个档位、不许互相推导**（方舟按请求里有没有 `reference_video` 分档计价）。
- **不过 `clampDuration` 的 10s 上限**：那是纯 t2v 档位的产品约束；r2v 时长跟随参考视频
  （**② 号窗口 [4,30]s**，服务端 `r2vTokens` 对输入时长夹到同一区间并在异常时吼）。
  ⚠ 这个夹取区间与 ② 号窗口**必须同时改**：夹到 15 而窗口放到 30 的话，一段 20s 的模板
  会按 15s 计价 = **报价 < 实收**，本仓头号事故形状。
- 2.0-mini 含视频输入档刊例 14 元/M ⇒ 系数 14/15，2026-10-05 **入表**：A6（mini 对 `omni_reference_task_type` 的行为）
  付费探测答了（认，三种子任务都一次受理，用量与 2.5 同式、输入按整秒往下取）；账单还待逐行核对（那三个任务每个原价 ¥3.04 = 14 元/M）。
  促销价（4 折）一律不写，价目只记刊例。

### 视频任务登记与找回（`GET /api/ark/video-tasks`，2026-09-06）

`POST /api/ark/contents/generations/tasks` 被受理的 **Seedance** 任务，服务端记一条 `{ userId, taskId, model, durationSec, ratio,
resolution, prompt(前 300 字), r2v, templateId }`（`ArkVideoTask`，48h TTL）。`GET /api/ark/video-tasks` 回
`{ ok, tasks: [{ taskId, createdAt, model, durationSec, ratio, resolution, prompt, r2v }] }`（最近 24 小时、新的在前、最多 50 条，
走轮询限流桶、不计费）。

- 为什么：客户端的取回凭据只在 localStorage；App 被系统回收 / 重装 / 出包重启两次，就可能把一发**已经付过钱**的成片弄丢
  （2026-09-06 真机：钱已扣、方舟侧好好存着、App 里一颗按钮都没有）。App 冷启动 / 进创作入口时拉这张表，把本机不认识、
  也没取回过的任务补成「待取回」凭据，再走同一条「取回」（`GET tasks/:id`，不计费）。
- 服务端不知道客户端取没取回：去重由客户端做（取回 / 正常收到结果 / 「知道了」都记进本机的已处理名单）。
- **已经因为失败退了钱的任务不列**（2026-10-07）：它们没有成片可取了；列出来就是一张永远取不回、还说着「钱已经花了」的卡
  （老 App 也靠这一条不去捞它们）。登记本身还在（样片第二步要用）。
- 与 `BranchTemplateTrial` 不是一回事：那条是试炼闸，任务一出结果就删。

### 失败退款（受理之后才失败的任务，2026-10-07）

主人 2026-10-07 拍板：上游**受理之后**明说这一发失败了，就把这一发的钱退回去。唯一实现 server `services/taskRefund.service.js`，
底账 `models/GenTaskCharge.js`（一个上游任务号一行：扣了多少、从哪两桶扣的、是不是管理员免单、结局）。

- **什么算失败**：方舟 `failed` / `cancelled` / `expired`；MiniMax `Fail`。**只认上游明说的状态** —— 我们自己的超时、方舟 404 / 504、
  回包读不懂、`queued` / `running`、认不出的新状态，一律**不是**失败（那时钱可能正在方舟那边变成一段好好的视频）。
- **每一发 Seedance 任务都钉了 `execution_expires_after: 86400`**（server 覆盖客户端的值）：排队 / 运行超过 24 小时方舟标 `expired`，
  于是每一发都会在我们的观察窗口里走到明确的终态。
- **退多少、退给谁**：这一发的实扣，**按扣的那两桶原样退回**；退给**账的主人**（不是来问的人：轮询端点不查归属）。
  管理员免单（没扣钱）与自动退款上线之前受理的任务（没有账）**不退**。样片两步是两笔独立的钱：第二步失败只退第二步。
- **恰好一次**：账的状态 `open → claimed → refunded`（条件原子抢占，两个 pm2 实例 + 清扫器 + 白模化取回同时看见也只退一次）；
  崩在半截的由清扫器按账本 memo 续办。8 天还问不出结局的记成 `lost` 并告警（人工核对）。
- **谁来发现失败**：① App 自己的轮询（`GET /api/ark/contents/generations/tasks/:id`、`GET /api/minimax/video/:taskId`）；
  ② 白模化取回（`POST /templates/blockoutize/finish`）；③ 0 号实例的清扫器（每 5 分钟，替没人再来问的那些问一次上游，退避 10 → 60 分钟）。
- **轮询回包多一个 `refund` 字段**（只在失败终态、只给账的主人）：`{ state, tokens }`，同时带余额头 `X-Wallet-*`：
  | `state` | 含义 |
  |---|---|
  | `refunded` | 已经退回 `tokens` |
  | `refunding` | 退款正在办（另一方刚抢到 / 搁浅了等清扫器续办）—— 会退，稍后到账 |
  | `pending` | 我们还没结账（如 MiniMax 退款开关关着）|
  | `skipped` | 没有要退的（管理员免单、账号已不在）|
  | `settled` / `lost` | 出成了钱照收 / 一直问不出结局交人工（失败回包里一般见不到）|
  没有这个字段 = 老服务端，或者这一发没有账（上线之前的任务）—— App 按「钱已经花了」说。
- **`GET /api/ark/task-charges/:taskId`**（requireAuth、轮询限流桶、不计费）：我的某一发任务的钱怎么样了 →
  `{ ok, taskId, provider, kind, state, tokens }`（`state` 同上表；`open` 的账说成 `pending`）；不是你的 / 没有账 → **404**。
  方舟与 MiniMax 的任务号都认（两家同号时方舟优先）。App 在对一发过期没取回的任务说「已经花掉的钱无法挽回」之前**先问它**
  （那一发可能早被清扫器退了钱）。⚠ 老服务端没有这条路（SPA 回退是 200 + HTML）—— 判能力看 `/api/ark/health` 的 `failRefund`。
- **通知**：钱不是在本人那次轮询里退的 → 一条 `GEN_TASK_REFUND`（见「通知」）。
- **白模化**：方舟明说失败时 r2v 那一笔退回、看帧那一笔不退；退款那一拍顺手把取件单钉成 `failed`（带退款那句话）——
  清扫器退的也一样，pending 列表不会对一发已经退了钱的任务说「无法挽回」。
- **MiniMax**：账上记着任务建在哪个站（`cn` / `intl`），清扫器只回同一个站去问（区域切走了就不问 —— 拿另一把 key 去问只会查无此任务）。
  开关 `MINIMAX_FAIL_REFUND=off` 关掉 MiniMax 的失败退款（MiniMax 对按量付费的失败任务计不计费没有书面说法）；关着期间账留 `open`，打开后还能接着退。
- ⚠ **钱不能"退"进别人的余额镜像**：`refund` 字段与余额头只给账的主人；别人轮询我的任务只看得见方舟的原话。

### 组图（`POST /api/ark/image-groups`，2026-10-05）

一次请求让 Seedream 出一组内容关联的图（方舟 `sequential_image_generation: "auto"`）。App 的「跟着做 C · 九宫格分镜」用它一次画出 4~9 个镜头的开头画面。

- **为什么不走单张出图那条路**：① 方舟按**实际画出的张数**计费（官方：「仅对成功生成图片按张数进行计费」），那条路按调用收一张；
  ② 一组 6 张实测 249 秒、9 张约 6 分钟，同步等必撞 Cloudflare 的 125 秒读超时；③ 非流式要等全部画完才回响应头，Node 自带 fetch 300 秒等不到就断。
  所以：受理 → 服务端后台对方舟走流式（SSE）→ 客户端短轮询，画好一张就多一张。
- **受理** `POST /api/ark/image-groups`（requireAuth + 生成限流桶）请求体 `{ model, prompt, image?, size?, max_images }`：
  `model` 只收 `doubao-seedream-4-0-250828` / `doubao-seedream-4-5-251128`（5.0 pro 不支持组图；老客户端那一档按老价亏 10%，不放进来乘十几张）；
  `image` 是 https 地址或图片 dataURL（单个或数组，≤14 张）；`max_images` 是 1~15 的整数（真数字，`"6"` 也拒），**参考图 + 张数 ≤ 15**（官方上限）；
  `size` 是 `WxH` 或 `1K/2K/4K`，缺省 `2K`。发给方舟的请求体由服务端按白名单重拼（`watermark:false`、`response_format:"url"`、`stream:true`），
  客户端多带的键一个都不出去。参数不对 → 400 `IMAGE_GROUP_PARAMS`；同一个人已经有一组在画 → 409 `IMAGE_GROUP_BUSY`（带那一组的 `id`）；
  余额 / 套餐 / 冻结 / 每日上限 → 与出图同一套 402 / 403 / 429；没配 key → 501。都不扣钱。
  成功 → **202** `{ ok, id, maxImages, unitCost, prepaid }`（`prepaid = unitCost × maxImages`，管理员免单为 0），带余额头。
- **查询** `GET /api/ark/image-groups/:id`（轮询限流桶，不计费，只给本人，别人的 / 乱写的 id 一律 404）→ `{ ok, group }`，
  `group = { id, status: "running"|"done"|"failed", model, maxImages, unitCost, prepaid, charged, generated, images: [{ index, url, size }],
  failures: [{ index, code, message }], interrupted, code, message, createdAt, finishedAt }`。
  `images[].index` = 方舟的 `image_index`（从 0 起）= 提示词里第几个镜头；**被审核拦下的那一张不在 images 里、序号会跳**（它在 failures 里，
  `code` 是方舟原样，审核不过是 `OutputImageSensitiveContentDetected`）。`url` 是方舟临时链接（**24 小时有效**），客户端拿到就转存。
  `running` 时 images 是已经画好的那几张；结束（done = 至少一张 / failed = 一张没有）后带余额头。
  `GET /api/ark/image-groups` 回这个人最近 24 小时的 5 组（新的在前），App 丢了任务号时据此接回来。
- **钱**：受理时预扣 `unitCost × maxImages`；结束时按**拿到手的张数**结算（不按方舟 `usage.generated_images`，两者不等时只记日志对账 ——
  流中途断开时方舟可能还画了几张，那几张用户拿不到，差价我们吃）。一张没拿到 → 预扣**全退进 addon**（同「上游没受理」）；
  拿到 k 张 → 多扣的 `(maxImages − k) × unitCost` **冲正回 plan**（`settleOverCharge`；不进 addon —— 否则「要 15 张、只画 1 张」
  就是把当月额度洗成永久余额的路）。`charged` 是最终实收。
- **中途断开 / 进程没了**：流断了（超时 15 分钟 / 连接重置）→ 画到哪张算哪张，`interrupted: true`、`code: "INTERRUPTED"`。
  画到一半服务重启（部署）的那一组会挂在 running：这个人下次查询 / 开新的一组时，超过 20 分钟还在 running 的按已经写进库的张数结掉（懒回收）。
  先原子地把这一组改成终态、改成功的才结钱 —— 后台那一路与懒回收撞上也只结一次。
- **能力位**：`GET /api/ark/health` 回 `imageGroups: true`。老服务端没有这一位 —— App 判能力只看它（Capacitor 的 SPA 回退会把
  不存在的路径答成 200 + HTML，状态码不可信）。
- **单张出图那条路从此只出一张**（`POST /api/ark/images/generations`）：`sequential_image_generation` 不是 `disabled`、`layer_decomposition`
  不是 false、`stream` 不是 false、`n` 不是 1、`tools` 非空 —— 一律 400 `IMAGE_PARAMS_NOT_ALLOWED`，不扣钱。此前请求体原样转发、按一张收，
  带上组图开关就能用一张的钱换十五张，零症状。App 从来只发 model / prompt / image / size / response_format / watermark，不受影响。

## 真人肖像授权（方舟可信素材）

挂载点：`/api/ark/portrait/*`（`routes/arkPortrait.routes.js`），全部 `requireAuth`。
**与上面那条方舟代理不是一回事**：代理走推理网关 + API Key、烧 token 进钱包；这三条走
**管控 OpenAPI**（`open.volcengineapi.com`）+ **AK/SK 的火山 V4 签名**，不烧 token、不进钱包。
AK/SK 只在服务端（`VOLC_AK`/`VOLC_SK`），**永不进 app 包**。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ark/portrait/invite` | `{days?:1..366=365}` → `{ok,uuid,url,startSec,endSec}`。`url` 就是给本人打开/扫码那一页 |
| GET | `/api/ark/portrait/groups` | 资产**组**（授权那一层）→ `{ok,totalCount,items}`，items 原样透传方舟 |
| GET | `/api/ark/portrait/assets` | 资产组里的**素材**（出片要用的 `asset-…`）→ `{ok,totalCount,items:[{id,name,assetType,groupId,status,error?,createTime}]}`；`?groupId=` 可只看一个组 |

三条硬约束（都是踩出来的，改这块之前先读）：

- **组 ≠ 素材，是两层**。`groups` 回 `Authorized` **不代表**有素材能出片：素材要单独过内容
  审核，可能整张 `Status:"Failed"` 而组那一层照样写着已授权（2026-08-28 实测第一发就是
  `InputImageSensitiveContentDetected.PolicyViolation`）。⇒ **判"能不能出片"只准问 `assets`**，
  拿 `groups.totalCount` 当依据就会告诉用户"已有 N 条已授权素材"而他一条都用不了。
- **`assets` 是白名单挑字段，不是透传** —— 只为把方舟回的 `Items[].URL` 挡在服务端：那是带签名的
  TOS 直链（`X-Tos-Expires=41400`），指向**某个真人的肖像原图**。app 只需要 id 与能不能用，
  把直链发到端上等于把肖像原图发出去。spec 里钉了"回包里不许出现 `X-Tos-Signature`"。
- **按组过滤只有复数 `GroupIds:[…]` 生效**，单数 `GroupId` 被方舟**静默忽略** ——
  `ListAssets` 对不认识的 `Filter` 键一律无视（传垃圾 `AssetType`/`Status` 照样 200 + 全量）。
  写成单数零报错，表现是"按这个组查"悄悄返回**所有组**的素材，自动绑就可能绑上别人的肖像。
  ⚠ 验这类过滤器**必须用反例**（拿一个"结果应该为空"的条件去查）：拿"能查到预期那条"当
  证据是无效的 —— 生效与被忽略在那种测法下结果一模一样。spec 里钉了复数形式。
- **`status` 不在服务端判可用性**：成功那个字符串至今没见过（只实证到 `"Failed"`）。
  ⇒ 客户端**判否定**：`status !== "Failed"` 才当可用（`api/portrait.ts` 的 `assetUsable`，
  唯一实现）。写白名单会把将来出现的新状态一律误判成不可用 = 功能突然没了。
- 未配 AK/SK 一律 **503 `PORTRAIT_NOT_CONFIGURED`**（不是 500），app 据此退回"控制台手工授权 +
  手填 asset ID"那条路；方舟的业务错**原样** 502 透出 Code/Message，`assets` 的
  `error.message` 必须一路走到用户眼前（那是他唯一能据以补救的信息）。

## AI token 钱包

挂载点：`app.use("/api/me/wallet", require("./routes/wallet.routes"))`，全部 `requireAuth`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me/wallet` | `{ wallet: { plan, addon, planId, cycle, day, debt, debtSince, frozen, paidEver }, plans, paid, free: { welcomeTokens, dailyTokens, dailyCapTokens } }`。顺带完成初始化、跨月刷新与免费版的每日补发。`paid` = 算不算付费用户（付费套餐**或**付过任何一笔钱，`isPaidUser` 唯一判据；App 置灰档位用它）；`free` = 免费额度的三条规则（App 照这三个数说，不抄数） |
| GET | `/api/me/wallet/ledger?limit=` | token 流水（"我的钱花哪儿了"） |
| POST | `/api/me/wallet/recharge` | **已改为下单**（见下「充值」）。`{ tokens }` → **202** + 订单，余额不变 |
| POST | `/api/me/wallet/plan` | **已改为下单**。`{ planId }` → **202** + 订单，余额不变 |

- `plan` = 付费套餐的当月额度（**跨月刷新、未用完作废**）/ 免费版的每日额度（见下）；`addon` = 直充、新人额度、奖励，**永不过期**。
  扣减先 plan 后 addon；退款按扣的那两桶原样退回（见「扣费」）。
- **套餐**（2026-10-07 主人拍板）：标准 ¥30/月 **1,660,000**（约 10 段 5 秒高清）、专业 ¥98/月 **5,800,000**（约 35 段）；直充包不变。
- **免费版**：**新人一次 170,000**（建钱包那一刻进 addon，一行 `grant`；已有钱包的老账号不补发）+ **每天 2,000**（每过一个 UTC 日往 plan 里补一次、
  补到 **14,000**（= 7 天）为止，`daily_grant` 流水，靠 `tokenWallet.day` 条件原子抢占）。**只补不削**：plan 已经高于 14,000（老账号剩下的月度额度、
  失败退回 plan 的钱）原样留着。免费版**不按月刷新**（`monthlyTokens: 0`）。日界是 UTC 日，与日上限同一个日界。
- **付过钱**：`tokenWallet.paidEver`，充值（`recharge`）与买套餐（`plan_buy`）在同一次原子更新里置真、从不置回；
  老钱包第一次被读到时按账本回填一次（有过 `recharge` / `plan_buy` 流水即为真）。日上限也按「付费用户」分档（付过钱的免费版用户吃付费档的上限）。
- 用户文档**刻意没有 `tokenWallet` 的 schema default**：有没有这个字段就是"要不要初始化"的
  判据本身（`{$exists:false}` 条件原子更新抢占初始化并补一条 `grant` 流水）。给了 default，
  老账号读出来就凭空有余额、却没有对应流水，账本和余额从第一天起就对不上
- 三条不变量（并发不超付 / 没受理必须退 / 月度刷新只发生一次）见
  `server/src/services/tokenWallet.service.js` 的文件头，回归测试见 `server/tests/tokenWallet.spec.js`

## 充值（订单 + 回调）

挂载点：`app.use("/api/pay", require("./routes/pay.routes"))`。

发币的口子**只有一个**：渠道回调结算（`services/payment/order.service.js` 的 `applyCallback`）。
钱包路由的 `/recharge` 与 `/plan` 曾经是"调一下就到账"，也就是任何有登录态的人都能
给自己发 token；现在它们只下单，返回 **202 Accepted** —— 用 202 不用 200 是因为
"请求收下了"和"余额变多了"是两回事，老客户端拿 200 会把余额刷成新的然后又掉回去。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/pay/config` | 无 | `{ channels, payable, mock, packs, plans }`。`payable=false` = 现在收不了钱，UI 必须说出来 |
| POST | `/api/pay/orders` | required | `{ kind: "recharge", tokens } \| { kind: "plan", planId }` → 201 `{ order, payParams, payable }` |
| GET | `/api/pay/orders/:orderNo` | required | 查单（仅本人）。客户端付款后轮询它等 `status: "settled"` |
| GET | `/api/pay/orders?limit=` | required | 我的订单列表 |
| POST | `/api/pay/orders/:orderNo/close` | required | 用户取消（仅未支付的） |
| POST | `/api/pay/callback/:channel` | **无** | 渠道异步通知。安全**全靠** adapter 验签 |
| POST | `/api/pay/mock/pay` | required | 仅 `PAY_ALLOW_MOCK=1` 时存在，演示用 |

订单状态：`created → paid → settled`，或 `closed` / `failed`（都是终态）。

### 三条不变量

- **O1 一笔订单只发一次币。** 支付回调**必然重复**（渠道重试、运维重推、网络抖动补发）。
  靠 status 判"处理过没有"不够——读到 paid 再写 settled 中间有并发窗口。
  用**条件原子更新**抢 `settledAt: null → now`，只有抢到的那一条才真的 credit。
  重复回调返回 200（回失败渠道会一直推）。
- **O2 金额以订单快照为准。** 商品、价格、数量全读下单那一刻写进订单的快照，
  绝不读回调体里的同名字段——那是外部输入。实付 < 应付不发币。
- **O3 未注册的渠道一律 400。** 没有 adapter 就没有验签；把未知渠道当成功处理，
  等于任何人 POST 一下就白拿 token。

回归测试 `server/tests/payOrder.spec.js`（24 条）。

### ⚠ 现在一个真实渠道都没接

`services/payment/channels.js` 的注册表是空的，所以下单能下、但没人会把订单推进到
settled。这是**故意**的：宁可"充不了值"，也不要留一个谁调谁得 token 的口子。
接渠道 = 写一个 adapter（`verify` 验签是它唯一也是全部的职责）+ 注册，路由与结算不用动。

`PAY_ALLOW_MOCK=1` 打开演示用假渠道（**没有验签**）。默认关；生产环境开着会被启动自检
直接拒绝（`config/preflight.js`）。

### 价目表两边必须一致

`server/src/services/payment/order.service.js` 的 `RECHARGE_PACKS` 与
`server/src/config/tokens.js` 的 `PLANS`，必须和 **app 仓 `src/data/economy.ts`** 逐条相等。
app 那份是【报价】（按下按钮前给用户看的），server 这份是【结算】（真扣钱的）。
对不上就是"页面写 ¥25、扣了 ¥15"。两仓不在一个 CI 里，`payOrder.spec.js` 末尾把 app 那份
抄了一遍钉住，改价时会红。金额一律**整数分**。

### 客户端那份钱包是镜像，不是账本

`app/src/data/account.ts` 的 `walletOf/canAfford/spendTokens` 在远端模式下只负责
**显示余额**与**按下按钮之前提前拦一道**，被绕过不会造成任何损失（服务端不认它）。
25 处调用点因此保持同步签名不变；权威值随 `/api/ark` 的响应头覆盖回来，最多短暂偏差且自愈。
离线模式（没配 `VITE_API_BASE`）下它仍然是唯一账本——那种包本来就不出网。

## 客户端接入约定

- `app/src/api/client.ts` 统一封装：`API_BASE`（`VITE_API_BASE`，缺省时走本地 IndexedDB 离线模式）、
  JWT 存 localStorage、401 自动登出、`serverAlive()` 探活（`GET /api/health`，整个会话只探一次，
  `data/videos.ts` 与 `data/account.ts` 共用同一个结论）。
- `app/src/data/*.ts` 保留同名同签名的导出，内部按"有无 API_BASE"选择远端或本地实现，
  页面层基本不动。
- **配了地址 ≠ 跑在远端**：服务器打不通时两个数据层都把 `remoteLive` 留成 false，
  整体回退 IndexedDB（照常能登录、炼卡、看种子作品），`isRemoteMode()` 返回的也是这个
  实际值——登录页据此在"密码登录"与"本地账号"两套表单之间切换。
