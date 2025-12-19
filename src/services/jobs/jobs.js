import { apiUrl, safeFetch } from "../../utils/safeFetch";
import {
  getDemoJobsSummary,
  getDemoJobsPipeline,
  getDemoJobsTopUnpaid,
  getDemoJobsActivity,
} from "../../pages/LeadsJobs/jobsMockData";
import { shouldUseDemoData } from "../demo/demoClient.js";

const ENV_FORCE_DEMO = String(
  import.meta?.env?.VITE_USE_DEMO_JOBS ||
    import.meta?.env?.VITE_DEMO_DATA ||
    (typeof process !== "undefined" ? process.env?.VITE_USE_DEMO_JOBS : "")
)
  .toLowerCase()
  .trim() === "true";

const hdr = (businessId) => ({ headers: { "x-business-id": businessId } });

function useDemoData(businessId) {
  if (ENV_FORCE_DEMO) return true;
  if (shouldUseDemoData(businessId)) return true;
  if (shouldUseDemoData()) return true;
  return !businessId;
}

export async function getJobsSummary(businessId) {
  if (useDemoData(businessId)) return getDemoJobsSummary();
  const url = new URL(apiUrl("/api/jobs/summary"));
  url.searchParams.set("business_id", businessId);
  return safeFetch(url.toString(), hdr(businessId));
}

export async function getJobsPipeline(businessId) {
  if (useDemoData(businessId)) return getDemoJobsPipeline();
  const url = new URL(apiUrl("/api/jobs/pipeline"));
  url.searchParams.set("business_id", businessId);
  return safeFetch(url.toString(), hdr(businessId));
}

export async function getJobsTopUnpaid(businessId) {
  if (useDemoData(businessId)) return getDemoJobsTopUnpaid();
  const url = new URL(apiUrl("/api/jobs/top-unpaid"));
  url.searchParams.set("business_id", businessId);
  return safeFetch(url.toString(), hdr(businessId));
}

export async function getJobsActivity(businessId) {
  if (useDemoData(businessId)) return getDemoJobsActivity();
  const url = new URL(apiUrl("/api/jobs/activity"));
  url.searchParams.set("business_id", businessId);
  return safeFetch(url.toString(), hdr(businessId));
}
