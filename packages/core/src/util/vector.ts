/** Vector math on Float32Array (all helpers assume equal length). */

export function toFloat32(v: ArrayLike<number> | Float32Array): Float32Array {
  return v instanceof Float32Array ? v : Float32Array.from(v);
}

export function l2Normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] as number) * (v[i] as number);
  const n = Math.sqrt(s);
  if (n === 0 || Math.abs(n - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / n;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** Cosine similarity for arbitrary vectors (normalises on the fly). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    d += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return d / Math.sqrt(na * nb);
}

/** Weighted mean of vectors, L2-normalised. */
export function combine(vectors: { v: Float32Array; w: number }[]): Float32Array {
  const dims = vectors[0]?.v.length ?? 0;
  const out = new Float32Array(dims);
  for (const { v, w } of vectors)
    for (let i = 0; i < dims; i++) out[i] = (out[i] as number) + w * (v[i] as number);
  return l2Normalize(out);
}

/** Matryoshka-style truncation followed by re-normalisation. */
export function truncateDims(v: Float32Array, dims: number): Float32Array {
  if (dims >= v.length) return v;
  return l2Normalize(v.slice(0, dims));
}

/** Decode a base64 little-endian float32 payload (OpenAI `encoding_format: base64`). */
export function decodeBase64Float32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
