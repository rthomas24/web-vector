import { createHash } from 'node:crypto';

/** sha256 → base64url (22 chars when truncated). */
export function sha256(input: string | Uint8Array, length = 22): string {
  return createHash('sha256').update(input).digest('base64url').slice(0, length);
}

/** Normalise text before hashing so trivial whitespace/case differences dedupe. */
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function contentHash(text: string): string {
  return sha256(normalizeForHash(text));
}

/** Deterministic UUID v5-like id derived from a string (for stores requiring UUIDs). */
export function uuidFromString(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32).split('');
  // Set version (5) and variant bits so it is a syntactically valid RFC 4122 UUID.
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] as string, 16) % 4] as string;
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
