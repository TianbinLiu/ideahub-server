// Simple in-memory rate limiter for abuse protection.
// Note: in-memory is per-process; for production consider Redis-backed limiter.

const buckets = new Map();

function rateLimit({ windowMs = 60 * 1000, max = 10 } = {}) {
  return (req, res, next) => {
    try {
      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'anon';
      const now = Date.now();
      const key = ip;
      let entry = buckets.get(key);
      if (!entry) {
        entry = { count: 1, start: now };
        buckets.set(key, entry);
        return next();
      }

      if (now - entry.start > windowMs) {
        // reset window
        entry.count = 1;
        entry.start = now;
        buckets.set(key, entry);
        return next();
      }

      if (entry.count >= max) {
        res.status(429).json({ ok: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, slow down' });
        return;
      }

      entry.count += 1;
      buckets.set(key, entry);
      return next();
    } catch (e) {
      return next();
    }
  };
}

module.exports = { rateLimit };
