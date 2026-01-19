"use client";

import { signOut } from "@workos-inc/authkit-nextjs";
import { useQuery } from "convex/react";
import { api } from "@prm/convex";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@prm/ui";

export default function AppPage() {
  const currentUser = useQuery(api.users.getCurrentUser);
  const userProfile = useQuery(api.users.getProfile);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Welcome to PRM</h1>
          <p className="mt-2 text-muted-foreground">
            This is a protected route. If you can see this, you&apos;re
            authenticated.
          </p>
        </div>
        <form
          action={async () => {
            await signOut();
          }}
        >
          <Button type="submit" variant="outline">
            Sign Out
          </Button>
        </form>
      </div>

      {currentUser === undefined && (
        <Card className="mt-8 border-border">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Loading user identity...
            </p>
          </CardContent>
        </Card>
      )}

      {currentUser === null && (
        <Card className="mt-8 border-destructive bg-destructive/10">
          <CardHeader>
            <CardTitle className="text-destructive">
              No authenticated user found
            </CardTitle>
            <CardDescription>
              JWT token may not be properly passed to Convex
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {currentUser && (
        <Card className="mt-8 border-green-500/50 bg-green-500/10">
          <CardHeader>
            <CardTitle className="text-green-700 dark:text-green-400">
              Authenticated User Identity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="inline font-medium">Subject:</dt>
                <dd className="ml-2 inline text-muted-foreground">
                  {currentUser.subject}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Email:</dt>
                <dd className="ml-2 inline text-muted-foreground">
                  {currentUser.email ?? userProfile?.email ?? "(not provided)"}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">First Name:</dt>
                <dd className="ml-2 inline text-muted-foreground">
                  {userProfile?.firstName ?? "(not provided)"}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Last Name:</dt>
                <dd className="ml-2 inline text-muted-foreground">
                  {userProfile?.lastName ?? "(not provided)"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
