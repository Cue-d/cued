import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { buildDoctorReport } from "./diagnostics/doctor.js";
import { openCuedDatabase } from "./db/database.js";
import { resolveInstalledAppPath } from "./macos/install.js";

type SetupDoctorReport = {
  daemon?: unknown;
  checks?: unknown;
  overview?: {
    messages?: number;
    contacts?: number;
  };
  recentRuns?: unknown[];
};

function printSection(title: string): void {
  output.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

function summarizeChecks(checks: unknown): string[] {
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.map((check) => {
    const row = check as { name?: string; status?: string; summary?: string };
    return `- ${row.name ?? "unknown"}: ${row.status ?? "unknown"} — ${row.summary ?? ""}`;
  });
}

export async function runSetupTUI(): Promise<void> {
  const db = openCuedDatabase();
  const rl = readline.createInterface({ input, output });

  try {
    let done = false;
    while (!done) {
      const doctor = await buildDoctorReport(db) as SetupDoctorReport;
      const appPath = resolveInstalledAppPath();

      output.write("\x1b[2J\x1b[H");
      printSection("Cued Setup");
      output.write(`App bundle: ${appPath ?? "not installed"}\n`);
      output.write(`Socket: ${doctor.daemon ? "daemon known" : "daemon not running"}\n`);

      printSection("Permissions");
      for (const line of summarizeChecks(doctor.checks)) {
        output.write(`${line}\n`);
      }

      printSection("Actions");
      output.write("1. Install/refresh app bundle and CLI\n");
      output.write("2. Install launch agent\n");
      output.write("3. Request macOS permissions\n");
      output.write("4. Show local source status\n");
      output.write("5. Connect Slack\n");
      output.write("6. Connect LinkedIn\n");
      output.write("7. Quit\n");

      const answer = (await rl.question("\nChoose an action: ")).trim();
      switch (answer) {
        case "1":
          output.write("\nRun: cued install\n");
          break;
        case "2":
          output.write("\nRun: cued launchd install\n");
          break;
        case "3":
          output.write("\nRun: cued permissions request --all\n");
          break;
        case "4":
          output.write(`\nMessages: ${doctor.overview?.messages ?? 0}\n`);
          output.write(`Contacts: ${doctor.overview?.contacts ?? 0}\n`);
          output.write(`Recent sync runs: ${(doctor.recentRuns as unknown[] | undefined)?.length ?? 0}\n`);
          break;
        case "5":
          output.write("\nRun: cued integrations connect slack default\n");
          break;
        case "6":
          output.write("\nRun: cued integrations connect linkedin default\n");
          break;
        case "7":
        case "q":
        case "quit":
          done = true;
          break;
        default:
          output.write("\nUnknown action.\n");
      }

      if (!done) {
        await rl.question("\nPress Enter to continue...");
      }
    }
  } finally {
    rl.close();
    db.close();
  }
}

export function hasInstalledAppBundle(): boolean {
  const appPath = resolveInstalledAppPath();
  return Boolean(appPath && existsSync(appPath));
}
