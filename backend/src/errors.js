export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name || "AppError";
    this.statusCode = options.statusCode || 500;
    this.code = options.code || "INTERNAL_ERROR";
    this.details = options.details || null;
    this.expose = options.expose ?? this.statusCode < 500;
    this.cause = options.cause;
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { statusCode: 400, code: "VALIDATION_ERROR", details, name: "ValidationError" });
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, { statusCode: 404, code: "NOT_FOUND", name: "NotFoundError" });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", code = "AUTH_REQUIRED") {
    super(message, { statusCode: 401, code, name: "UnauthorizedError" });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code = "FORBIDDEN", details = null) {
    super(message, { statusCode: 403, code, details, name: "ForbiddenError" });
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests", details = null) {
    super(message, { statusCode: 429, code: "RATE_LIMITED", details, name: "RateLimitError" });
  }
}

export class ExternalServiceError extends AppError {
  constructor(message, details = null, code = "EXTERNAL_SERVICE_ERROR") {
    super(message, { statusCode: 502, code, details, name: "ExternalServiceError" });
  }
}
