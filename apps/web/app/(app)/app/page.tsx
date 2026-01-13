"use client";

import { useQuery } from "convex/react";
import { api } from "@prm/convex";
import { signOut } from "@workos-inc/authkit-nextjs";

export default function AppPage() {
  const currentUser = useQuery(api.users.getCurrentUser);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Welcome to PRM
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            This is a protected route. If you can see this, you&apos;re authenticated.
          </p>
        </div>
        <form
          action={async () => {
            await signOut();
          }}
        >
          <button
            type="submit"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Sign Out
          </button>
        </form>
      </div>

      {currentUser === undefined && (
        <div className="mt-8 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">Loading user identity...</p>
        </div>
      )}

      {currentUser === null && (
        <div className="mt-8 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            No authenticated user found
          </p>
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
            JWT token may not be properly passed to Convex
          </p>
        </div>
      )}

      {currentUser && (
        <div className="mt-8 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900">
          <h2 className="text-sm font-semibold text-green-900 dark:text-green-100">
            Authenticated User Identity
          </h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div>
              <dt className="inline font-medium text-green-800 dark:text-green-200">
                Subject:
              </dt>
              <dd className="ml-2 inline text-green-700 dark:text-green-300">
                {currentUser.subject}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-green-800 dark:text-green-200">
                Email:
              </dt>
              <dd className="ml-2 inline text-green-700 dark:text-green-300">
                {currentUser.email}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-green-800 dark:text-green-200">
                Name:
              </dt>
              <dd className="ml-2 inline text-green-700 dark:text-green-300">
                {currentUser.name || "(not provided)"}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-green-800 dark:text-green-200">
                Email Verified:
              </dt>
              <dd className="ml-2 inline text-green-700 dark:text-green-300">
                {currentUser.emailVerified ? "Yes" : "No"}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
