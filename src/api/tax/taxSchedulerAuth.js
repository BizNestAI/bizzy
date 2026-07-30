export function assertInternalSchedulerAccess(req) {
  const expected = process.env.TAX_SCHEDULER_INTERNAL_SECRET;
  const provided = req.headers?.["x-internal-cron-secret"] || req.headers?.["x-tax-scheduler-secret"];
  if (!expected || provided !== expected) {
    const err = new Error("Internal scheduler access required.");
    err.status = 403;
    err.code = "internal_scheduler_access_required";
    throw err;
  }
  return true;
}
