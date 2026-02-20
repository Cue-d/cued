// Task 1.14: Sign-up route that redirects to WorkOS registration
import { redirect } from "next/navigation";
import { getSignUpUrl } from "@workos-inc/authkit-nextjs";

export async function GET() {
  const state = Buffer.from(JSON.stringify({ returnPathname: "/download" })).toString(
    "base64"
  );
  const authorizationUrl = await getSignUpUrl({ state });
  return redirect(authorizationUrl);
}
