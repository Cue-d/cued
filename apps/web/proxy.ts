import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

export default authkitMiddleware({
  // Require authentication for all routes under /app
  middlewareAuth: {
    enabled: true,
    // TODO: Remove /assistant and /api/chat after debugging
    unauthenticatedPaths: [
      "/",
      "/sign-in",
      "/sign-up",
      "/callback",
      "/assistant",
      "/api/chat",
    ],
  },
});

export const config = {
  matcher: [
    // Apply middleware to all routes except static assets
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
