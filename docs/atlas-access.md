# Atlas 数据库访问：账号拆分与轮换记录

2026-08-20 拆分，动机见「事故背景」。本文是**唯一**的口径：谁能连库、从哪连、写入走哪条路。

## 现状（2026-08-20 起）

| 用户 | 角色 | 能到的集群 | 密码放哪 |
|---|---|---|---|
| `ideahub-ecs` | `readWrite@ideahub` + `dbAdmin@ideahub` | 仅 `ideahub` | **只在** 生产 ECS `/var/www/ideahub-server/.env`（Atlas 控制台可随时重置） |
| `ideahub-dev-ro` | `read@ideahub` | 仅 `ideahub` | 开发机 `server/.env` |

网络白名单（Network Access → IP Access List）**没有 0.0.0.0/0**，只放行具名 /32：

- `8.217.8.225/32` — 生产 ECS（香港，出口 IP 已实测 = 绑定公网 IP）
- `99.39.67.34/32` — 开发机家庭宽带（2026-08-20；**IP 会漂**，见下）
- `129.210.115.230/32`、`129.210.115.227/32` — SCU 校园网（注册时代留，是否保留自行决定）

⚠ 第二个集群 `tliu7`：两个新用户都**够不到**它（cluster 作用域只给了 `ideahub`）。
旧的 atlasAdmin 用户删掉之后，**当前没有任何数据库用户能连 `tliu7`**——控制台的
Data Explorer 还能看。如果它不是废弃实验，去 Database Access 给某个用户加上这个集群。

## 日常怎么用

- **开发机默认只读**。跑 `npm run dev` 读线上数据没问题；任何写操作会收到
  `user is not allowed to do action [insert]`——这是设计，不是故障。
- **维护性写入（backfill / seed / cleanup / 找回）首选上 ECS 跑**：
  `ssh deploy@8.217.8.225`，然后在 `/var/www/ideahub-server` 里 `node scripts/xxx.js`。
  那台机器本来就持有读写账号，不需要任何提权，跑完也不留新凭据。
- 确实要在**本机**写（例如需要本地调试器）：Atlas 控制台 → Database Access →
  临时给 `ideahub-dev-ro` 加 `readWrite@ideahub`，**用完立刻撤掉**；或者建一个勾选
  Temporary User（6h/1d/1w 自动删除）的临时用户。别把提权状态留过夜。

## 家宽 IP 变了 / 换了工作地点

症状：本机连库超时（`Server selection timed out`）。
处理：控制台 → Network Access → ADD IP ADDRESS →「ADD CURRENT IP ADDRESS」，
注释里写日期与地点；顺手把旧的家宽条目删掉。**别**为了省事加回 0.0.0.0/0。

## 本机脚本连不上：querySrv ECONNREFUSED

这台开发机的系统 DNS 拒答 SRV 查询。服务端代码走 `.env` 的 `DNS_SERVERS` 兜底；
自己写的一次性脚本要么也读它，要么开头加：
`require("dns").setServers(["223.5.5.5","119.29.29.29","8.8.8.8"])`。

## 事故背景（为什么拆）

- 仓库是**公开**的，[`e1309ae`](https://github.com/TianbinLiu/ideahub-server/commit/e1309ae)
  （2026-02-11）把带真实密码的 `.env.example` 提交进了历史，02-15 才删——那串
  `l1965921542_db_user` 的 URI 在公网历史里躺了半年，且角色是 **atlasAdmin@admin +
  All Resources**，GitHub secret scanning 2026-02-11 即告警（alert #1）。
- 同时开发机与生产共用这一个账号 + 白名单 0.0.0.0/0：开发机失窃 = 生产库全量读写外泄。
- 2026-08-20 处置：建上表两个最小权限账号 → 两侧 .env 切换并验证（ECS 走 deploy.sh
  零停机，公网 `GET /api/branch/videos` 过库验证）→ 删 0.0.0.0/0 与北京旧 ECS 条目
  `39.106.7.215/32` → **删除旧用户**（实测旧 URI `bad auth`）→ alert #1 标记 revoked。
- 历史里的那串 URI 不再有效，故未做 git 历史改写（BFG）。若哪天想顺手洗历史，
  记得它是公开仓库，改写会打断所有 fork/clone。

## 铁律对照

- 密码只进 `.env`（铁律三）；两侧 `.env` 都在 .gitignore。
- 新凭据先在目标机器上探通（`ping` + 读 + 写权限探测）**再**落盘重启（铁律七）。
- 改白名单永远「先加新条目、验证、再删旧条目」——顺序反了会把生产锁在门外。
