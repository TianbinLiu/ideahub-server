// PM2 配置。用法：
//     pm2 start ecosystem.config.js          # 首次
//     pm2 reload ecosystem.config.js         # 后续部署（零停机）
//
// ★ script 必须是 JS 文件，不能是 npm。
//   原先的启动方式是 `pm2 start npm -- start`。cluster 模式依赖 Node 的 cluster
//   模块 fork 出子进程并共享监听 socket —— npm 是一层 shell 包装器，pm2 没法对它
//   做 cluster，会静默退化或直接起不来。所以入口改成 src/index.js。
//
// ★ 为什么是 reload 而不是 restart：
//   restart = 停旧进程 → 起新进程，中间端口没人监听，nginx 只能返回 502。
//   实测该空档约 3 秒（优化前 9.9 秒）。
//   reload 在 cluster 模式下逐个替换实例：新实例起来并开始监听之后，才关掉旧的，
//   始终有实例在服务 → 零停机。这也是切 cluster 的主要动机。
//
// ★ 切 cluster 的前提是限流已经换成 Redis 后端。
//   限流若还是进程内 Map，多实例下每个实例各算各的，实际放行量 = 配置值 × 实例数,
//   登录防撞库会被直接稀释掉。src/config/redis.js + middleware/rateLimit.js 已处理。
module.exports = {
  apps: [
    {
      name: "ideahub-server",
      script: "src/index.js",
      cwd: "/var/www/ideahub-server",

      exec_mode: "cluster",
      // 这台机器 2 核。留有余量给 nginx / redis / mongod 客户端，用满 2 个即可；
      // "max" 会按核数自动取，但核数变化时不易察觉，这里写死更可控。
      instances: 2,

      // ★ 让 pm2 等应用真正就绪再切流量。
      //   没有这两项时，pm2 认为「进程启动了」就算就绪，而此时 MongoDB 还没连上、
      //   端口也还没监听 —— reload 会把流量切给一个还不能服务的实例，等于没有零停机。
      //   需要应用在 listen 回调里调 process.send("ready")（见 src/index.js）。
      wait_ready: true,
      listen_timeout: 15000,

      // 优雅退出：pm2 先发 SIGINT，应用排空连接后自行退出；超时才强杀。
      // 与 src/index.js 里 SHUTDOWN_DRAIN_MS(5s) 留出余量。
      kill_timeout: 8000,

      max_memory_restart: "400M",
      autorestart: true,
      // 崩溃重启的退避，防止启动即崩时疯狂重启刷爆日志
      exp_backoff_restart_delay: 200,

      env: {
        NODE_ENV: "production",
      },

      // 日志：pm2 默认会把 cluster 各实例的日志合并，加上实例号便于排查
      merge_logs: true,
      time: true,
    },
  ],
};
