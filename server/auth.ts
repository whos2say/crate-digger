// Owner gate. Spacefast's Functions proxy drops Set-Cookie, so the key travels in a header.
// Phase 2 swaps this for Spotify-connected identity; the check stays in one place.

export function ownerKeySet(env: Record<string, unknown>): boolean {
  return typeof env.OWNER_KEY === "string" && env.OWNER_KEY.length > 0;
}

export function isOwner(request: Request, env: Record<string, unknown>): boolean {
  const expected = env.OWNER_KEY;
  if (typeof expected !== "string" || expected.length === 0) return true; // unlocked until a key is set
  const given = request.headers.get("x-crate-key") ?? "";
  return timingSafeEqual(given, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
