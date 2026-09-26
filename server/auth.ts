// Owner gate. Spacefast's Functions proxy drops Set-Cookie, so the key travels in a header.
// Browser navigations (the Spotify connect link) cannot set a header, so the key may also ride
// in a `key` query parameter on those routes only.

export function ownerKeySet(env: Record<string, unknown>): boolean {
  return typeof env.OWNER_KEY === "string" && env.OWNER_KEY.length > 0;
}

export function isOwner(request: Request, env: Record<string, unknown>, allowQuery = false): boolean {
  const expected = env.OWNER_KEY;
  if (typeof expected !== "string" || expected.length === 0) return true; // unlocked until a key is set
  const given = request.headers.get("x-crate-key") ?? (allowQuery ? new URL(request.url).searchParams.get("key") : null) ?? "";
  return timingSafeEqual(given, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
