import { isDeepStrictEqual } from 'node:util';
import { ForecastV1Error } from './forecastV1Service.js';

export function malformedClaim(reason) {
  return new ForecastV1Error('forecast_claim_response_invalid', 503, { reason });
}

// The deployed RPC contract is a forecast_runs JSON object, or SQL null when
// another writer holds a live claim. Never treat arbitrary empty output as busy.
export function parseOperatingClaim(raw, { businessId, payload, fingerprint, routine, matches, now, timezone }) {
  if (raw === null) return { outcome: 'verify_busy' };
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw malformedClaim('not_run_object');
  if (typeof raw.id !== 'string' || !raw.id || raw.business_id !== businessId) throw malformedClaim('run_identity');
  if (raw.model_version !== payload.model_version || !isDeepStrictEqual(raw.model_config, payload.model_config)) throw malformedClaim('model_identity');
  if (['history_start', 'history_end', 'forecast_start', 'forecast_end'].some(k => raw[k] !== payload[k])) throw malformedClaim('window_identity');
  if (typeof raw.input_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.input_fingerprint)) throw malformedClaim('input_identity');
  if (raw.status === 'completed') {
    if (!Number.isFinite(Date.parse(raw.generated_at))) throw malformedClaim('completed_timestamp');
    if (matches(raw)) return { outcome: 'reused', run: raw };
    const day = date => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    if (routine && timezone && day(new Date(raw.generated_at)) === day(now)) return { outcome: 'routine_limited', run: raw };
    throw malformedClaim('unexpected_completed_input');
  }
  if (raw.status !== 'generating') throw malformedClaim('unexpected_run_status');
  if (raw.input_fingerprint !== fingerprint) throw malformedClaim('claim_input_mismatch');
  if (!Number.isFinite(Date.parse(raw.generation_started_at)) || !Number.isFinite(Date.parse(raw.generation_lease_expires_at))) throw malformedClaim('claim_lease_missing');
  if (Date.parse(raw.generation_started_at) > Date.parse(raw.generation_lease_expires_at)) throw malformedClaim('claim_lease_order');
  if (Date.parse(raw.generation_lease_expires_at) <= now.getTime()) return { outcome: 'expired', run: raw };
  return { outcome: 'claimed', run: raw };
}

export function forecastGenerationHttpStatus(forecast) {
  if (forecast.outcome === 'busy' || forecast.data_status === 'generation_in_progress') return 202;
  if (forecast.outcome === 'unchanged' || forecast.outcome === 'routine_limited') return 200;
  return forecast.data_status === 'available' ? 201 : 409;
}
