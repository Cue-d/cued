import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const TEMP_FILE_PREFIX = "cued-imessage-attachment-";
const DEFAULT_TEMP_ROOT_DIR = join(homedir(), "Pictures");

export interface PreparedAttachmentFile {
  path: string;
  cleanup: () => Promise<void>;
}

interface PrepareAttachmentOptions {
  tempRootDir?: string;
}

function buildSafeFilename(sourcePath: string): string {
  const rawExt = extname(sourcePath);
  const safeExt = rawExt.replace(/[^a-zA-Z0-9.]/g, "");
  const rawBase = basename(sourcePath, rawExt);
  const safeBase =
    rawBase.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "attachment";
  return `${safeBase}${safeExt}`;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isFile() || stats.isSymbolicLink()) {
      await unlink(filePath);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

/**
 * Create a secure temp copy for attachment sends.
 * Uses mkdtemp for atomic path creation and chmod 600 for file permissions.
 */
export async function createSecureAttachmentTempFile(
  sourcePath: string,
  options: PrepareAttachmentOptions = {}
): Promise<PreparedAttachmentFile> {
  const sourceStats = await lstat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error("Attachment path must be a regular file");
  }

  const tempRootDir = options.tempRootDir ?? DEFAULT_TEMP_ROOT_DIR;
  await mkdir(tempRootDir, { recursive: true });

  let tempDir: string | null = null;
  let tempFilePath: string | null = null;
  try {
    tempDir = await mkdtemp(join(tempRootDir, TEMP_FILE_PREFIX));
    await chmod(tempDir, 0o700);

    tempFilePath = join(tempDir, buildSafeFilename(sourcePath));
    await copyFile(sourcePath, tempFilePath, fsConstants.COPYFILE_EXCL);
    await chmod(tempFilePath, 0o600);

    const copiedStats = await lstat(tempFilePath);
    if (!copiedStats.isFile()) {
      throw new Error("Failed to create secure attachment copy");
    }
  } catch (error) {
    if (tempFilePath) {
      await safeUnlink(tempFilePath).catch(() => undefined);
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }

  if (!tempDir || !tempFilePath) {
    throw new Error("Failed to prepare secure attachment copy");
  }

  const finalizedTempDir = tempDir;
  const finalizedTempFilePath = tempFilePath;
  let cleanedUp = false;
  return {
    path: finalizedTempFilePath,
    cleanup: async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await safeUnlink(finalizedTempFilePath).catch(() => undefined);
      await rm(finalizedTempDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
