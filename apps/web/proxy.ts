import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

export default authkitMiddleware({
  // Require authentication for all routes under /app
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [
      "/",
      "/sign-in",
      "/sign-up",
      "/callback",
      // API routes that handle their own Bearer token auth
      "/api/memories/:path*",
    ],
  },
});

export const config = {
  matcher: [
    // Apply middleware to all routes except static assets
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
