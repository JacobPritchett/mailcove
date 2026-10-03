import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  AUTH_TOKEN?: string;
}

/** The automation credential's principal (the AUTH_TOKEN bearer). */
export const API_TOKEN_PRINCIPAL = "api-token";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(env: AuthEnv) {
  jwks ??= createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
  return jwks;
}

/** Test-only: reset the module-scoped JWKS cache so each test can stub its own keys. */
export function resetJwksCacheForTest() {
  jwks = null;
}

// Constant-time string compare. Always iterates the full length of the longer
// input so timing does not leak the position of the first mismatch.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export async function verifyAccess(req: Request, env: AuthEnv): Promise<string | null> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (token) {
    try {
      const { payload } = await jwtVerify(token, getJwks(env), {
        issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
        audience: env.ACCESS_AUD,
      });
      const email = (payload as any).email;
      if (typeof email === "string") return email;
      // Valid assertion but no email claim (e.g. an Access service token that
      // cleared the edge under a different app). Not a principal by itself —
      // fall through to the bearer check, which is an independent
      // full-strength credential. This grants nothing a bearer-only request
      // could not already get.
    } catch {
      // Unverifiable or foreign-audience assertion — same reasoning: fall
      // through rather than hard-fail, so service-token-fronted automation
      // can present the bearer credential.
    }
  }
  // AUTH_TOKEN is an intentional automation credential, secondary to the Access
  // JWT above. Compare in constant time so a network attacker can't recover it
  // byte-by-byte from response timing.
  const auth = req.headers.get("Authorization");
  if (env.AUTH_TOKEN && auth?.startsWith("Bearer ")) {
    const presented = auth.slice("Bearer ".length);
    if (timingSafeEqual(presented, env.AUTH_TOKEN)) return API_TOKEN_PRINCIPAL;
  }
  return null;
}
