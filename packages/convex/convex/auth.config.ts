// Task 1.14: Convex auth configuration for WorkOS AuthKit
// Validates WorkOS JWT tokens for both SSO and user management flows

import { convexEnv } from "@cued/env/convex";

const clientId = convexEnv.WORKOS_CLIENT_ID;

export default {
  providers: [
    // SSO authentication flow
    {
      type: "customJwt",
      issuer: `https://api.workos.com/`,
      algorithm: "RS256",
      applicationID: clientId,
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
    },
    // User management authentication flow
    {
      type: "customJwt",
      issuer: `https://api.workos.com/user_management/${clientId}`,
      algorithm: "RS256",
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
    },
  ],
};
