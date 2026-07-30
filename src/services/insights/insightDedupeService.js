import { supabase as defaultSupabase } from '../supabaseAdmin.js';

const DEFAULT_COOLDOWN_HOURS = 24;
const DISMISSED_SUPPRESSION_HOURS = 24 * 14;
const FEEDBACK_LOOKBACK_LIMIT = 1000;
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);
const NEGATIVE_FEEDBACK = new Set(['too_frequent', 'not_relevant']);
const VALID_FEEDBACK = new Set(['helpful', 'not_helpful', 'too_frequent', 'not_relevant', 'acted_on']);
const DISMISSED_STATUSES = new Set(['dismissed', 'deleted', 'archived', 'rejected']);
const INSIGHT_DEDUPE_SELECT = [
  'id',
  'business_id',
  'dedupe_key',
  'source_event_id',
  'severity',
  'status',
  'dismissed_at',
  'snoozed_until',
  'created_at',
  'metrics',
  'tags',
].join(',');
const FEEDBACK_SELECT = 'id,business_id,insight_id,user_id,feedback,notes,created_at';

let supabase = defaultSupabase;

export function __setInsightDedupeServiceTestDeps(deps = {}) {
  supabase = deps.supabase || defaultSupabase;
}

function isMissingDbObject(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    MISSING_TABLE_CODES.has(error?.code) ||
    MISSING_COLUMN_CODES.has(error?.code) ||
    message.includes('does not exist') ||
    message.includes('could not find the table') ||
    message.includes('schema cache')
  );
}

function getDedupeKey(candidate = {}) {
  return candidate.dedupe_key || candidate.source_event_id || candidate.metrics?.dedupe_key || null;
}

function getRuleIdFromCandidate(candidate = {}) {
  return candidate.rule_id || candidate.metrics?.rule_id || null;
}

function getRuleIdFromInsight(row = {}) {
  if (row.rule_id) return row.rule_id;
  if (row.metrics?.rule_id) return row.metrics.rule_id;
  if (row.dedupe_key) return String(row.dedupe_key).split(':')[0] || null;
  const tags = Array.isArray(row.tags) ? row.tags : [];
  return tags.find((tag) => String(tag).includes('_')) || tags[1] || null;
}

function getRowDedupeKey(row = {}) {
  return row.dedupe_key || row.source_event_id || row.metrics?.dedupe_key || null;
}

function isFuture(value, nowMs = Date.now()) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

function isRecent(value, hours, nowMs = Date.now()) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return nowMs - timestamp < hours * 60 * 60 * 1000;
}

function isCritical(candidate = {}) {
  return String(candidate.severity || '').toLowerCase() === 'critical';
}

function materialityKey(candidate = {}) {
  return candidate.materiality_key || candidate.metrics?.materiality_key || null;
}

function materialityScore(candidate = {}) {
  const direct = Number(candidate.materiality_score ?? candidate.amount ?? candidate.value);
  if (Number.isFinite(direct)) return direct;
  const metrics = Array.isArray(candidate.metrics) ? candidate.metrics : [];
  const parsed = metrics
    .map((metric) => Number(String(metric?.value ?? '').replace(/[^0-9.-]/g, '')))
    .filter(Number.isFinite);
  return parsed.length ? Math.max(...parsed.map(Math.abs)) : null;
}

function materiallyWorsened(candidate = {}, row = {}) {
  if (!isCritical(candidate)) return false;

  const nextKey = materialityKey(candidate);
  const priorKey = row.materiality_key || row.metrics?.materiality_key || null;
  if (nextKey && priorKey && nextKey !== priorKey) return true;

  const nextScore = materialityScore(candidate);
  const priorScore = materialityScore(row);
  if (nextScore == null || priorScore == null || priorScore <= 0) return false;
  return nextScore >= priorScore * 1.15;
}

async function fetchSimilarInsights(businessId, dedupeKey) {
  const rows = [];
  const seenIds = new Set();

  const fetchByColumn = async (column) => {
    const { data, error } = await supabase
      .from('insights')
      .select(INSIGHT_DEDUPE_SELECT)
      .eq('business_id', businessId)
      .eq(column, dedupeKey)
      .limit(100)
      .order('created_at', { ascending: false });

    if (error) {
      if (isMissingDbObject(error)) return false;
      throw error;
    }

    for (const row of data || []) {
      const key = row.id || `${getRowDedupeKey(row)}:${row.created_at}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      rows.push(row);
    }
    return true;
  };

  const checkedDedupeColumn = await fetchByColumn('dedupe_key');
  const checkedSourceEventColumn = await fetchByColumn('source_event_id');

  if (!checkedDedupeColumn && !checkedSourceEventColumn) return [];
  return rows.filter((row) => getRowDedupeKey(row) === dedupeKey);
}

async function hasRecentNegativeFeedback({ businessId, dedupeKey, ruleId, cooldownHours }) {
  const { data: feedbackRows, error } = await supabase
    .from('insight_feedback')
    .select(FEEDBACK_SELECT)
    .eq('business_id', businessId)
    .in('feedback', [...NEGATIVE_FEEDBACK])
    .limit(FEEDBACK_LOOKBACK_LIMIT)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingDbObject(error)) return null;
    throw error;
  }
  if (!feedbackRows?.length) return null;

  const insightIds = [...new Set(feedbackRows.map((row) => row.insight_id).filter(Boolean))];
  if (!insightIds.length) return null;

  const { data: insightRows, error: insightError } = await supabase
    .from('insights')
    .select(INSIGHT_DEDUPE_SELECT)
    .eq('business_id', businessId)
    .in('id', insightIds);

  if (insightError) {
    if (isMissingDbObject(insightError)) return null;
    throw insightError;
  }

  const insightsById = new Map((insightRows || []).map((row) => [row.id, row]));
  const suppressionHours = Math.max(cooldownHours, DISMISSED_SUPPRESSION_HOURS);
  const nowMs = Date.now();
  const ruleFeedback = [];

  for (const feedback of feedbackRows) {
    if (!isRecent(feedback.created_at, suppressionHours, nowMs)) continue;
    const insight = insightsById.get(feedback.insight_id);
    if (!insight) continue;
    if (getRowDedupeKey(insight) === dedupeKey) {
      return { feedback, insight };
    }
    if (ruleId && getRuleIdFromInsight(insight) === ruleId) ruleFeedback.push({ feedback, insight });
  }

  return ruleFeedback.length >= 2 ? ruleFeedback[0] : null;
}

export async function shouldInsertInsight({
  businessId,
  candidate,
  cooldownHours = DEFAULT_COOLDOWN_HOURS,
  force = false,
} = {}) {
  if (!businessId) {
    return { shouldInsert: false, reason: 'missing_business_id' };
  }

  const dedupeKey = getDedupeKey(candidate);
  if (!dedupeKey) {
    return { shouldInsert: true, reason: 'no_dedupe_key' };
  }

  const nowMs = Date.now();
  let existingRows = [];
  try {
    existingRows = await fetchSimilarInsights(businessId, dedupeKey);
  } catch {
    return { shouldInsert: false, reason: 'dedupe_check_failed' };
  }

  const snoozed = existingRows.find((row) => isFuture(row.snoozed_until, nowMs));
  if (snoozed) {
    return { shouldInsert: false, reason: 'snoozed', existingInsightId: snoozed.id };
  }

  if (force) {
    return { shouldInsert: true, reason: 'force' };
  }

  const dismissed = existingRows.find((row) => {
    const status = String(row.status || '').toLowerCase();
    return (
      DISMISSED_STATUSES.has(status) ||
      isRecent(row.dismissed_at, DISMISSED_SUPPRESSION_HOURS, nowMs)
    );
  });
  if (dismissed && !isCritical(candidate)) {
    return { shouldInsert: false, reason: 'recently_dismissed', existingInsightId: dismissed.id };
  }

  const recent = existingRows.find((row) => isRecent(row.created_at, cooldownHours, nowMs));
  if (recent && !materiallyWorsened(candidate, recent)) {
    return { shouldInsert: false, reason: 'cooldown', existingInsightId: recent.id };
  }

  let negativeFeedback = null;
  try {
    negativeFeedback = await hasRecentNegativeFeedback({
      businessId,
      dedupeKey,
      ruleId: getRuleIdFromCandidate(candidate),
      cooldownHours,
    });
  } catch {
    negativeFeedback = null;
  }
  if (negativeFeedback && !isCritical(candidate)) {
    return {
      shouldInsert: false,
      reason: `feedback_${negativeFeedback.feedback.feedback}`,
      existingInsightId: negativeFeedback.insight.id,
    };
  }

  return { shouldInsert: true, reason: recent ? 'materially_worsened' : 'new' };
}

export async function markInsightFeedback({ businessId, insightId, feedback, userId = null, notes = null } = {}) {
  if (!businessId || !insightId || !feedback) {
    return { ok: false, error: 'missing_required_fields' };
  }
  if (!VALID_FEEDBACK.has(feedback)) {
    return { ok: false, error: 'invalid_feedback' };
  }

  const scopedInsight = await supabase
    .from('insights')
    .select('id')
    .eq('business_id', businessId)
    .eq('id', insightId)
    .limit(1);

  if (scopedInsight.error) {
    if (isMissingDbObject(scopedInsight.error)) return { ok: false, error: 'insights_table_missing' };
    return { ok: false, error: 'insight_lookup_failed' };
  }
  if (!scopedInsight.data?.length) {
    return { ok: false, error: 'insight_not_found' };
  }

  const row = {
    business_id: businessId,
    insight_id: insightId,
    user_id: userId || null,
    feedback,
    notes: notes || null,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('insight_feedback')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    if (isMissingDbObject(error)) return { ok: false, error: 'feedback_table_missing' };
    return { ok: false, error: 'feedback_insert_failed' };
  }

  return { ok: true, id: data?.id || null };
}

export async function getRuleSensitivityAdjustments(businessId) {
  const defaults = { ok: true, rules: {}, missingFeedbackTable: false };
  if (!businessId) return defaults;

  const { data: feedbackRows, error } = await supabase
    .from('insight_feedback')
    .select(FEEDBACK_SELECT)
    .eq('business_id', businessId)
    .in('feedback', [...NEGATIVE_FEEDBACK])
    .limit(FEEDBACK_LOOKBACK_LIMIT)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingDbObject(error)) return { ...defaults, missingFeedbackTable: true };
    return defaults;
  }
  if (!feedbackRows?.length) return defaults;

  const insightIds = [...new Set(feedbackRows.map((row) => row.insight_id).filter(Boolean))];
  if (!insightIds.length) return defaults;

  const { data: insightRows, error: insightError } = await supabase
    .from('insights')
    .select(INSIGHT_DEDUPE_SELECT)
    .eq('business_id', businessId)
    .in('id', insightIds);

  if (insightError || !insightRows?.length) return defaults;

  const byId = new Map(insightRows.map((row) => [row.id, row]));
  const byRule = {};

  for (const feedbackRow of feedbackRows) {
    const insight = byId.get(feedbackRow.insight_id);
    const ruleId = getRuleIdFromInsight(insight);
    if (!ruleId) continue;
    byRule[ruleId] ||= { feedbackCount: 0, tooFrequent: 0, notRelevant: 0 };
    byRule[ruleId].feedbackCount += 1;
    if (feedbackRow.feedback === 'too_frequent') byRule[ruleId].tooFrequent += 1;
    if (feedbackRow.feedback === 'not_relevant') byRule[ruleId].notRelevant += 1;
  }

  const rules = {};
  for (const [ruleId, counts] of Object.entries(byRule)) {
    const negativeCount = counts.tooFrequent + counts.notRelevant;
    if (negativeCount < 2) continue;
    rules[ruleId] = {
      feedbackCount: counts.feedbackCount,
      tooFrequent: counts.tooFrequent,
      notRelevant: counts.notRelevant,
      cooldownMultiplier: Math.min(2, 1 + counts.tooFrequent * 0.25),
      minConfidenceBump: Math.min(10, counts.notRelevant * 3),
    };
  }

  return { ok: true, rules, missingFeedbackTable: false };
}

export default {
  shouldInsertInsight,
  markInsightFeedback,
  getRuleSensitivityAdjustments,
};
