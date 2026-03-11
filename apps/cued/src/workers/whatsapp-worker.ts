async function main(): Promise<void> {
  process.stdout.write(JSON.stringify({
    ok: true,
    bundle: {
      sourceAccounts: [],
      rawEvents: [],
      sourceCursor: {
        note: "whatsapp_sync_via_realtime_helper",
      },
      syncMode: "incremental",
      hasMore: false,
    },
  }));
}

void main();
