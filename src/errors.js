// 统一业务错误：HTTP 层按 status/code 映射，message 不含敏感内容。
export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (code, message, details) => new ServiceError(400, code, message, details);
export const unauthorized = (message = '缺少身份信息') => new ServiceError(401, 'unauthorized', message);
export const forbidden = (code, message, details) => new ServiceError(403, code, message, details);
export const notFound = (code, message) => new ServiceError(404, code, message);
export const conflict = (code, message, details) => new ServiceError(409, code, message, details);
export const unprocessable = (code, message, details) => new ServiceError(422, code, message, details);
