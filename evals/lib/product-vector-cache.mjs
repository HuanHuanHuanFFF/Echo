import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function decodeVerifiedVector(bytes, expectedSha, dimensions = 1024) {
  assert.ok(Buffer.isBuffer(bytes), 'Cached vector must be a byte buffer');
  assert.equal(
    bytes.length,
    dimensions * 4,
    'Cached vector dimension mismatch',
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expectedSha,
    'Cached vector hash mismatch',
  );
  const vector = Array.from(
    new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
  );
  assert.ok(
    vector.every(Number.isFinite),
    'Cached vector contains non-finite values',
  );
  assert.ok(
    Math.abs(Math.hypot(...vector) - 1) < 1e-5,
    'Cached vector is not unit normalized',
  );
  return vector;
}
