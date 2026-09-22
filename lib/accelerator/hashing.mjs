import { createHash } from 'node:crypto';

/** Return a lowercase SHA-256 digest for bytes or UTF-8 text. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Hash delimited values without making concatenation ambiguous.  Values are
 * intentionally length-prefixed so a path/content boundary cannot collide.
 */
export function hashParts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part), 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length); hash.update(bytes);
  }
  return hash.digest('hex');
}

export function workspaceId(manifestHash) {
  return `ws_v1_${manifestHash}`;
}
