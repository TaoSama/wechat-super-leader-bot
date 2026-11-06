import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HttpLeaderModel } from '../../controller/dist/leader/model/client.js';
import { readBoundedStream } from '../../controller/dist/leader/model/transport.js';

/** Stable fingerprint for evidence that must not persist opaque reasoning content. */
export const sha256 = text => createHash('sha256').update(text).digest('hex');

/** Public evidence excludes internal reasoning; encrypted continuity stays only in the live loop's memory. */
function publicRecord(value) {
  if (Array.isArray(value)) return value.map(publicRecord);
  if (value && typeof value === 'object') {
    if (value.type === 'reasoning') return { type: 'reasoning', id: value.id,
      encryptedContentSha256: value.encrypted_content ? sha256(value.encrypted_content) : null,
      encryptedContentChars: value.encrypted_content?.length ?? 0, summaryOmitted: true };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicRecord(item)]));
  }
  return value;
}

/** Actual production HTTP client, with an observational fetch wrapper and unchanged stateless requests. */
export function recordedModel(options, records, save) {
  return new HttpLeaderModel({ ...options, timeoutMs: 120_000,
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body);
      assert.equal(payload.store, false);
      assert.equal(Object.hasOwn(payload, 'previous_response_id'), false);
      assert.equal(Object.hasOwn(payload, 'conversation'), false);
      const record = { request: publicRecord(payload), reasoningFieldPresent: Object.hasOwn(payload, 'reasoning') };
      records.push(record); await save();
      const response = await fetch(url, init);
      record.httpStatus = response.status;
      const text = await readBoundedStream(response.clone().body, 1024 * 1024, init.signal);
      try { record.response = publicRecord(JSON.parse(text)); }
      catch (error) { record.responseParseError = error.message; record.responseBodySha256 = sha256(text); }
      await save();
      return response;
    } });
}
