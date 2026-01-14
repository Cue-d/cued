// Task 1.14: Sign-in route that redirects to WorkOS authentication
import { redirect } from "next/navigation";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

export async function GET() {
  const authorizationUrl = await getSignInUrl();
  return redirect(authorizationUrl);
}
