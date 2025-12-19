import { getDemoData } from "../../services/demo/demoClient.js";

function cloneArray(items = []) {
  return (items || []).map((item) => ({ ...item }));
}

function buildDemoJobsData() {
  const demo = getDemoData();
  const jobs = demo?.jobs || {};
  const pipeline = jobs.pipeline || {};
  return {
    summary: { ...(jobs.summary || {}) },
    pipeline: {
      scheduled: cloneArray(pipeline.scheduled || []),
      in_progress: cloneArray(pipeline.in_progress || []),
      completed: cloneArray(pipeline.completed || []),
    },
    topUnpaid: cloneArray(jobs.topUnpaid || []),
    activity: cloneArray(jobs.activity || []),
  };
}

export const MOCK_JOBS_SUMMARY = buildDemoJobsData().summary;
export const MOCK_PIPELINE = buildDemoJobsData().pipeline;
export const MOCK_TOP_UNPAID = buildDemoJobsData().topUnpaid;

export function getDemoJobsSummary() {
  return buildDemoJobsData().summary;
}

export function getDemoJobsPipeline() {
  return buildDemoJobsData().pipeline;
}

export function getDemoJobsTopUnpaid() {
  return buildDemoJobsData().topUnpaid;
}

export function getDemoJobsActivity() {
  return buildDemoJobsData().activity;
}
