import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const { decodeVerifiedVector } = await import(
  pathToFileURL(resolve('evals/lib/product-vector-cache.mjs')).href
);
const bytes = (values: number[]) =>
  Buffer.from(new Float32Array(values).buffer);
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('product comparison cached vector validation', () => {
  it('preserves a valid Float32 vector exactly, including sliced buffers', () => {
    const vector = [1, ...Array<number>(1023).fill(0)];
    const original = bytes(vector);
    const padded = Buffer.concat([Buffer.alloc(7), original, Buffer.alloc(5)]);
    const slice = padded.subarray(7, 7 + original.length);
    expect(decodeVerifiedVector(slice, sha(original))).toEqual(vector);
  });

  it('rejects wrong dimensions even when their stored checksum agrees', () => {
    const wrong = bytes([1, 0]);
    expect(() => decodeVerifiedVector(wrong, sha(wrong))).toThrow(
      'dimension mismatch',
    );
  });

  it('rejects corrupt values, zero vectors, and unnormalized vectors despite valid checksums', () => {
    for (const value of [NaN, Infinity, 0, 2]) {
      const wrong = bytes([value, ...Array<number>(1023).fill(0)]);
      expect(() => decodeVerifiedVector(wrong, sha(wrong))).toThrow();
    }
  });

  it('rejects a checksum that does not bind the actual vector', () => {
    const valid = bytes([1, ...Array<number>(1023).fill(0)]);
    expect(() => decodeVerifiedVector(valid, '0'.repeat(64))).toThrow(
      'hash mismatch',
    );
  });
});
