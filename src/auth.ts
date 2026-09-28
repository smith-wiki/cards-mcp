// Cloudflare Access: every /mcp request must carry the Access-signed Cf-Access-Jwt-Assertion.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

/** True when the request carries a valid Access token for this application. */
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (env.DEV_AUTH_BYPASS === "1") return true;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let jwks = jwksByTeam.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByTeam.set(issuer, jwks);
  }
  try {
    await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"] });
    return true;
  } catch {
    return false;
  }
}
