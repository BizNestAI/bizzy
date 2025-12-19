export class HttpError extends Error {
  constructor(status = 500, message = 'Server error', meta = null) {
    super(message); this.status = status; this.meta = meta;
  }
}
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
