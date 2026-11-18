import { resolveInternalStaff } from "./internalStaffAuth.js";

export async function requireStatementPendingAdministrator(req, db) {
  const staff = await resolveInternalStaff({ req, roles: ["owner_admin"], ...(db ? { supabase: db } : {}) });
  req.internalStaff = staff;
  return { id: staff.userId };
}
