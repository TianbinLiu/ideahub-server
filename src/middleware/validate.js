const { z } = require("zod");

function validate({ body, query, params }) {
  return (req, res, next) => {
    try {
      if (body) req.body = body.parse(req.body);
      if (query) req.query = query.parse(req.query);
      if (params) req.params = params.parse(req.params);
      next();
    } catch (err) {
      next(err); // 交给 errorHandler 统一处理（ZodError）
    }
  };
}

module.exports = { validate, z };
