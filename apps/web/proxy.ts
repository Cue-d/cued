import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

export default authkitMiddleware({
  // Require authentication for all routes under /app
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [
      "/",
      "/sign-in",
      "/sign-up",
      "/manifesto",
      "/callback",
      // API routes that handle their own auth or are called by external services
      "/api/chat",
      "/api/nango/webhook",
      "/api/nango/pull-gmail",
      "/api/nango/pull-google-contacts",
      "/api/gmail/send",
      // Electron app sync routes (use Bearer token auth)
      "/api/sync/social",
    ],
  },
});

export const config = {
  matcher: [
    // Apply middleware to all routes except static assets
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
