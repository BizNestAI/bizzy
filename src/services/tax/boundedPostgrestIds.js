import { Buffer } from "node:buffer";
import { validationError } from "./taxErrors.js";

export const TAX_ID_FILTER_BYTES = 2500;
export const TAX_URL_BYTES = 4096;

// Match PostgrestFilterBuilder.in and URLSearchParams, including reserved IDs.
export function serializedIdFilter(values, field = "transaction_id") {
  const cleaned = [...new Set(values)].map((value) => {
    const text = String(value);
    return /[,()]/.test(text) ? `"${text}"` : text;
  }).join(",");
  return new URLSearchParams({ [field]: `in.(${cleaned})` }).toString();
}
export function boundedIdChunks(values, size = 50) {
  const batches = [];
  let batch = [];
  for (const value of values) {
    if (Buffer.byteLength(serializedIdFilter([value])) > TAX_ID_FILTER_BYTES) {
      throw validationError("invalid_source_id", "Source identifier is too long.");
    }
    const proposed = [...batch, value];
    if (batch.length && (proposed.length > Math.min(size, 50) || Buffer.byteLength(serializedIdFilter(proposed)) > TAX_ID_FILTER_BYTES)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(value);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export function boundedTaxQuery(query) {
  // PostgREST builders expose the exact URL that their fetch implementation sends.
  if (query.url) {
    const url = new URL(query.url);
    if (Buffer.byteLength(url.href) > TAX_URL_BYTES) throw validationError("tax_query_url_too_long", "Tax source query exceeds its URL budget.");
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("in.(") && Buffer.byteLength(new URLSearchParams({ [key]: value }).toString()) > TAX_ID_FILTER_BYTES) {
        throw validationError("tax_id_filter_too_long", "Tax source query exceeds its ID-filter budget.");
      }
    }
  }
  return query;
}
