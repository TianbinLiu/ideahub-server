function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Not Found - ${req.method} ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode).json({
    ok: false,
    message: err.message || "Server Error",
  });
}

module.exports = { notFound, errorHandler };
