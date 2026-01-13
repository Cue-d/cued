export default function AppPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
        Welcome to PRM
      </h1>
      <p className="mt-4 text-zinc-600 dark:text-zinc-400">
        This is a protected route. If you can see this, you&apos;re authenticated.
      </p>
    </div>
  );
}
