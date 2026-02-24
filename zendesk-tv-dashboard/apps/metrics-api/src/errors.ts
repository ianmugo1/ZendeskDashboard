import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger.js";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Internal Server Error";
  const details = error instanceof HttpError ? error.details : undefined;

  logger.error(
    {
      err: error,
      status_code: statusCode,
      path: req.path,
      method: req.method
    },
    "Request failed"
  );

  res.status(statusCode).json({
    error: message,
    ...(details !== undefined ? { details } : {})
  });
}
