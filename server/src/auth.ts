import { betterAuth } from "better-auth";
import { pgPool } from "./db.ts";
import { env } from "./env.ts";

// Cookie domain lets the frontend (vidura.nipuntheekshana.com) share the
// session with this API (vidura-api.nipuntheekshana.com). Unset in local dev.
const cookieDomain = process.env.COOKIE_DOMAIN;

export const auth = betterAuth({
  database: pgPool,
  // With extra hosts, the base URL follows the request's Host header, limited
  // to these hosts (nginx sets Host; anything else falls back to API_BASE_URL).
  baseURL: env.apiExtraHosts.length
    ? {
      allowedHosts: [new URL(env.apiBaseUrl).host, ...env.apiExtraHosts],
      protocol: "https",
      fallback: env.apiBaseUrl,
    }
    : env.apiBaseUrl,
  secret: env.authSecret,
  // Origins allowed to start auth flows and receive redirects.
  trustedOrigins: env.webOrigins,
  emailAndPassword: { enabled: env.emailPasswordAuth },
  socialProviders: env.googleEnabled
    ? {
      google: {
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
      },
    }
    : {},
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh once per day of activity
  },
  advanced: cookieDomain
    ? {
      crossSubDomainCookies: { enabled: true, domain: cookieDomain },
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    }
    : undefined,
});

export type Auth = typeof auth;
