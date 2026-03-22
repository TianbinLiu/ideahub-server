class AppError extends Error {
  /**
   * Backward compatible signatures:
   * 1) new AppError({ code, message, status, details })
   * 2) new AppError(message, status?, code?, details?)
   */
  constructor(input, statusArg, codeArg, detailsArg) {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const { code, message, status = 400, details } = input;
      super(message || "Error");
      this.code = code;
      this.status = status;
      this.details = details;
      return;
    }

    const message = typeof input === "string" ? input : "Error";
    const status = typeof statusArg === "number" ? statusArg : 400;
    const code = typeof codeArg === "string" ? codeArg : undefined;

    super(message);
    this.code = code;
    this.status = status;
    this.details = detailsArg;
  }
}
module.exports = AppError;
