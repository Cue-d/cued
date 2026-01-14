// Task 1.14: OAuth callback handler for WorkOS authentication
import { handleAuth } from "@workos-inc/authkit-nextjs";

export const GET = handleAuth();
