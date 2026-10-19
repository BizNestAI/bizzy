/* global process, Buffer */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.TEST_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const apiUrl = process.env.TEST_BIZZI_API_URL;
if (!url?.startsWith("http://127.0.0.1:") || !apiUrl?.startsWith("http://127.0.0.1:")) {
  throw new Error("local_disposable_endpoints_required");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const password = `Runtime-${randomUUID()}-Aa1!`;
const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  if (!pass) throw new Error(`${name}: ${detail}`);
};

async function makeUser(label) {
  const email = `sensitive-${label}-${randomUUID()}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  await admin.from("user_profiles").upsert({ id: data.user.id, email, role: "owner" });
  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signed, error: signError } = await authClient.auth.signInWithPassword({ email, password });
  assert.ifError(signError);
  return { id: data.user.id, token: signed.session.access_token, client: authClient };
}

async function makeBusiness(user, label) {
  const { data, error } = await admin.from("business_profiles").insert({
    user_id: user.id,
    business_name: `Synthetic ${label}`,
    industry: "Test",
    team_size: 1,
    state: "NY",
    services_offered: "Test",
  }).select("id").single();
  assert.ifError(error);
  assert.ifError((await admin.from("user_business_link").insert({ user_id: user.id, business_id: data.id, role: "owner" })).error);
  assert.ifError((await admin.from("business_billing").insert({ business_id: data.id, subscription_status: "active", subscription_status_test: "active" })).error);
  return data.id;
}

function headers(user, businessId) {
  return { Authorization: `Bearer ${user.token}`, "x-business-id": businessId };
}

async function api(path, user, businessId, options = {}) {
  return fetch(`${apiUrl}${path}`, { ...options, headers: { ...headers(user, businessId), ...(options.headers || {}) } });
}

async function adminApi(path, token, businessId, options = {}) {
  return fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { "x-bizzi-admin-view": token, "x-business-id": businessId, ...(options.headers || {}) },
  });
}

async function uploadDoc(user, businessId, filename = "marker.pdf", bytes = Buffer.from("%PDF-1.7\n"), type = "application/pdf") {
  const body = new FormData();
  body.append("file", new Blob([bytes], { type }), filename);
  body.append("year", "2026");
  body.append("month", "9");
  body.append("document_type", "bank_statement");
  body.append("business_id", businessId);
  return api("/api/docs/accounting/upload", user, businessId, { method: "POST", body });
}

async function uploadRawFilename(user, businessId, filename) {
  const boundary = `----bizzi-${randomUUID()}`;
  const body = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="year"\r\n\r\n2026`,
    `--${boundary}\r\nContent-Disposition: form-data; name="month"\r\n\r\n9`,
    `--${boundary}\r\nContent-Disposition: form-data; name="document_type"\r\n\r\nbank_statement`,
    `--${boundary}\r\nContent-Disposition: form-data; name="business_id"\r\n\r\n${businessId}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`,
    `--${boundary}--\r\n`,
  ].join("\r\n"));
  return api("/api/docs/accounting/upload", user, businessId, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

for (const [id, options] of [
  ["bizzy-docs", { public: false, fileSizeLimit: 25 * 1024 * 1024, allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"] }],
  ["financial-reports", { public: false, fileSizeLimit: 10 * 1024 * 1024, allowedMimeTypes: ["application/pdf"] }],
]) {
  const existing = await admin.storage.getBucket(id);
  if (existing.error) assert.ifError((await admin.storage.createBucket(id, options)).error);
  assert.ifError((await admin.storage.updateBucket(id, options)).error);
}
record("bucket update API", true);

const userA = await makeUser("a");
const userB = await makeUser("b");
const former = await makeUser("former");
const internalAdmin = await makeUser("admin");
const businessA = await makeBusiness(userA, "A");
const businessB = await makeBusiness(userB, "B");
assert.ifError((await admin.from("internal_staff_users").upsert({ user_id: internalAdmin.id, role: "accountant", active: true })).error);
const adminViewToken = randomBytes(32).toString("base64url");
assert.ifError((await admin.from("internal_admin_view_sessions").insert({
  staff_user_id: internalAdmin.id,
  staff_role: "accountant",
  business_id: businessA,
  source: "monthly_review",
  read_only: true,
  capabilities: [],
  session_token_hash: createHash("sha256").update(adminViewToken).digest("hex"),
  started_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
})).error);

for (const table of ["bizzy_docs", "report_metadata"]) {
  const anonRead = await anon.from(table).select("id");
  record(`anonymous ${table} denied`, Boolean(anonRead.error) || anonRead.data.length === 0);
  const userRead = await userA.client.from(table).select("id");
  record(`authenticated ${table} denied`, Boolean(userRead.error) || userRead.data.length === 0);
  const userWrite = await userA.client.from(table).delete().eq("id", randomUUID());
  record(`authenticated ${table} mutation denied`, Boolean(userWrite.error));
}

for (const actor of [anon, userA.client, former.client]) {
  for (const bucket of ["bizzy-docs", "financial-reports"]) {
    const listed = await actor.storage.from(bucket).list("");
    record(`direct ${bucket} list denied`, Boolean(listed.error) || listed.data.length === 0);
    const uploaded = await actor.storage.from(bucket).upload(`${businessA}/${randomUUID()}.pdf`, Buffer.from("%PDF-1.7\n"), { contentType: "application/pdf" });
    record(`direct ${bucket} upload denied`, Boolean(uploaded.error));
  }
}

const uploadA = await uploadDoc(userA, businessA);
record("Business A valid PDF upload", uploadA.status === 200, `${uploadA.status}`);
const uploadedA = await uploadA.json();
const uploadB = await uploadDoc(userB, businessB);
record("Business B valid PDF upload", uploadB.status === 200, `${uploadB.status}`);
const uploadedB = await uploadB.json();
record("same filenames receive distinct IDs", uploadedA.data.id !== uploadedB.data.id);
const storedA = (await admin.from("bizzy_docs").select("storage_path").eq("id", uploadedA.data.id).single()).data;
for (const [name, operation] of [
  ["download", () => userA.client.storage.from("bizzy-docs").download(storedA.storage_path)],
  ["update", () => userA.client.storage.from("bizzy-docs").update(storedA.storage_path, Buffer.from("%PDF-1.7\n"), { contentType: "application/pdf" })],
  ["move", () => userA.client.storage.from("bizzy-docs").move(storedA.storage_path, `${businessA}/moved.pdf`)],
  ["copy", () => userA.client.storage.from("bizzy-docs").copy(storedA.storage_path, `${businessA}/copied.pdf`)],
]) {
  record(`direct Storage ${name} denied`, Boolean((await operation()).error));
}
const directDelete = await userA.client.storage.from("bizzy-docs").remove([storedA.storage_path]);
const stillPresent = await admin.storage.from("bizzy-docs").list(storedA.storage_path.slice(0, storedA.storage_path.lastIndexOf("/")), {
  search: storedA.storage_path.slice(storedA.storage_path.lastIndexOf("/") + 1),
});
record("direct Storage delete denied", Boolean(directDelete.error) || stillPresent.data?.some((row) => storedA.storage_path.endsWith(`/${row.name}`)));

const listAResponse = await api("/api/docs/accounting?year=2026", userA, businessA);
const listA = await listAResponse.json();
record("A lists only A document", listAResponse.ok && listA.data.length === 1 && listA.data[0].id === uploadedA.data.id);
record("document list minimizes fields", !JSON.stringify(listA).match(/storage_(?:bucket|path)|signed_url/));
const listBResponse = await api("/api/docs/accounting?year=2026", userB, businessB);
const listB = await listBResponse.json();
record("B lists only B document", listBResponse.ok && listB.data.length === 1 && listB.data[0].id === uploadedB.data.id);

const crossDownload = await api(`/api/docs/accounting/${uploadedB.data.id}/download`, userA, businessA);
record("A cannot sign B document", crossDownload.status === 404);
const conflictDownload = await api(`/api/docs/accounting/${uploadedA.data.id}/download?business_id=${businessB}`, userA, businessA);
record("conflicting business rejected", conflictDownload.status === 400);
const ownDownload = await api(`/api/docs/accounting/${uploadedA.data.id}/download`, userA, businessA);
const ownDownloadBody = await ownDownload.json();
record("same-business signed download", ownDownload.ok && /^http:\/\/127\.0\.0\.1:54321\//.test(ownDownloadBody.signed_url || ""));
record("signed response no-store", /no-store/i.test(ownDownload.headers.get("cache-control") || ""));
const crossDelete = await api(`/api/docs/accounting/${uploadedB.data.id}`, userA, businessA, { method: "DELETE" });
record("A cannot delete B document", crossDelete.status === 404);

for (const [name, filename, bytes, type] of [
  ["zero byte", "empty.pdf", Buffer.alloc(0), "application/pdf"],
  ["over 25 MB", "oversized.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(25 * 1024 * 1024)]), "application/pdf"],
  ["fake PDF", "fake.pdf", Buffer.from("<svg"), "application/pdf"],
  ["MIME mismatch", "fake.pdf", Buffer.from("%PDF-1.7\n"), "text/html"],
  ["HTML", "page.html", Buffer.from("<html>"), "text/html"],
  ["SVG", "image.svg", Buffer.from("<svg>"), "image/svg+xml"],
  ["JavaScript", "script.js", Buffer.from("alert(1)"), "text/javascript"],
  ["executable", "program.exe", Buffer.from("MZ"), "application/x-msdownload"],
  ["CSV", "data.csv", Buffer.from("a,b"), "text/csv"],
  ["XLS", "data.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), "application/vnd.ms-excel"],
  ["XLSX", "data.xlsx", Buffer.from("PK"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["double extension", "page.html.pdf", Buffer.from("%PDF-1.7\n"), "application/pdf"],
]) {
  const response = await uploadDoc(userA, businessA, filename, bytes, type);
  record(`${name} rejected`, response.status >= 400 && response.status < 500, `${response.status}`);
}
const separatorResponse = await uploadRawFilename(userA, businessA, "folder/file.pdf");
const separatorBody = await separatorResponse.json();
record(
  "separator rejected or removed by multipart parser",
  separatorResponse.status >= 400 || separatorBody?.data?.original_filename === "file.pdf",
  `${separatorResponse.status}`
);
const controlResponse = await uploadRawFilename(userA, businessA, "control\u0001.pdf");
record("control character rejected before durable success", controlResponse.status >= 400, `${controlResponse.status}`);

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
record("PNG accepted", (await uploadDoc(userA, businessA, "marker.png", png, "image/png")).ok);
record("JPEG accepted", (await uploadDoc(userA, businessA, "marker.jpg", jpg, "image/jpeg")).ok);

for (const [businessId, publisher] of [[businessA, userA], [businessB, userB]]) {
  const reportId = randomUUID();
  const path = `${businessId}/2026-09-${reportId}.pdf`;
  assert.ifError((await admin.storage.from("financial-reports").upload(path, Buffer.from("%PDF-1.7\n"), { contentType: "application/pdf", upsert: false })).error);
  assert.ifError((await admin.from("report_metadata").insert({ id: reportId, business_id: businessId, year: 2026, month: 9, storage_path: path, accounting_method: "Cash", monthly_review_published_at: new Date().toISOString(), monthly_review_published_by: publisher.id, monthly_review_source: "monthly_review", publication_status: "published" })).error);
}
const reports = (await admin.from("report_metadata").select("id,business_id")).data;
const reportA = reports.find((row) => row.business_id === businessA);
const reportB = reports.find((row) => row.business_id === businessB);
const archiveAResponse = await api("/api/accounting/pnl/archive", userA, businessA);
const archiveA = await archiveAResponse.json();
record("A archive only A", archiveAResponse.ok && archiveA.reports.length === 1 && archiveA.reports[0].id === reportA.id);
record("archive minimizes fields", !JSON.stringify(archiveA).match(/storage_(?:bucket|path)|signed_url/));
record("A cannot view B report", (await api(`/api/accounting/pnl/archive/${reportB.id}/view`, userA, businessA)).status === 404);
const reportView = await api(`/api/accounting/pnl/archive/${reportA.id}/view`, userA, businessA);
record("A can view A report", reportView.ok && /no-store/i.test(reportView.headers.get("cache-control") || ""));

const legacyId = randomUUID();
const legacyPath = `${businessA}/2026/09/${legacyId}.csv`;
assert.ifError((await admin.storage.from("bizzy-docs").upload(legacyPath, Buffer.from("%PDF-1.7\n"), {
  contentType: "application/pdf",
  upsert: false,
})).error);
assert.ifError((await admin.from("bizzy_docs").insert({
  id: legacyId,
  business_id: businessA,
  title: "legacy.csv",
  category: "financials",
  content: { format: "accounting_document" },
  filename: "legacy.csv",
  size: 9,
  year: 2026,
  month: 9,
  original_filename: "legacy.csv",
  mime_type: "text/csv",
  file_size: 9,
  document_type: "other_accounting_document",
  storage_bucket: "bizzy-docs",
  storage_path: legacyPath,
  user_id: userA.id,
  uploaded_by_user_id: userA.id,
})).error);
const legacyView = await api(`/api/docs/accounting/${legacyId}/download`, userA, businessA);
record("legacy disallowed-MIME metadata remains readable", legacyView.ok && /no-store/i.test(legacyView.headers.get("cache-control") || ""));
const retired = await api("/api/accounting/pnl/pdf", userA, businessA, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ business_id: businessA, year: 2026, month: 9 }) });
record("customer P&L generation retired", retired.status === 403);
const conflictingRetired = await api("/api/accounting/pnl/pdf", userA, businessA, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ business_id: businessB, year: 2026, month: 9 }) });
record("cross-tenant P&L rejected", conflictingRetired.status === 400);
const sync = await api("/api/accounting/reports-sync", userA, businessA, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ business_id: businessA }) });
record("customer report sync retired", sync.status === 403);
record("revoked former user denied API", (await api("/api/docs/accounting", former, businessA)).status === 403);

const adminDocsA = await adminApi("/api/docs/accounting?year=2026", adminViewToken, businessA);
const adminDocsABody = await adminDocsA.json();
record("Admin View fixed to A reads A only", adminDocsA.ok && adminDocsABody.data.every((row) => row.id !== uploadedB.data.id));
record("Admin View cannot switch to B", (await adminApi("/api/docs/accounting?year=2026", adminViewToken, businessB)).status === 403);
record("Admin View cannot upload", (await adminApi("/api/docs/accounting/upload", adminViewToken, businessA, { method: "POST" })).status === 403);
record("Admin View cannot delete", (await adminApi(`/api/docs/accounting/${uploadedA.data.id}`, adminViewToken, businessA, { method: "DELETE" })).status === 403);
record("Admin View cannot regenerate report", (await adminApi("/api/accounting/pnl/pdf", adminViewToken, businessA, { method: "POST" })).status === 403);
record("Admin View cannot sync reports", (await adminApi("/api/accounting/reports-sync", adminViewToken, businessA, { method: "POST" })).status === 403);

const beforeRejected = (await admin.from("bizzy_docs").select("id", { count: "exact", head: true }).eq("business_id", businessA)).count;
record("rejected uploads leave no metadata", beforeRejected === 5);
const ownDelete = await api(`/api/docs/accounting/${uploadedA.data.id}`, userA, businessA, { method: "DELETE" });
record("same-business delete succeeds", ownDelete.ok);
const repeatedDelete = await api(`/api/docs/accounting/${uploadedA.data.id}`, userA, businessA, { method: "DELETE" });
record("repeated delete is safe not-found", repeatedDelete.status === 404);

console.log(JSON.stringify({ ok: true, passed: results.length, results }, null, 2));
