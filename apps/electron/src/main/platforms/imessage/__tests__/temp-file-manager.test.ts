import { lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecureAttachmentTempFile } from "../temp-file-manager";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("iMessage temp-file manager", () => {
  it("creates a secure temp copy with 600 permissions and deterministic cleanup", async () => {
    const root = await makeTempRoot("cued-imessage-test-");
    const sourcePath = join(root, "photo.jpg");
    await writeFile(sourcePath, "image-bytes", { encoding: "utf8" });

    const prepared = await createSecureAttachmentTempFile(sourcePath, {
      tempRootDir: root,
    });

    const copiedStats = await lstat(prepared.path);
    expect(copiedStats.isFile()).toBe(true);
    expect(copiedStats.mode & 0o777).toBe(0o600);
    expect(await readFile(prepared.path, "utf8")).toBe("image-bytes");

    const preparedDir = dirname(prepared.path);
    await prepared.cleanup();

    await expect(lstat(prepared.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(preparedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-regular source paths", async () => {
    const root = await makeTempRoot("cued-imessage-test-");
    const realFilePath = join(root, "real.jpg");
    const symlinkPath = join(root, "linked.jpg");

    await writeFile(realFilePath, "data", { encoding: "utf8" });
    await symlink(realFilePath, symlinkPath);

    await expect(
      createSecureAttachmentTempFile(symlinkPath, { tempRootDir: root })
    ).rejects.toThrow("Attachment path must be a regular file");
  });

  it("cleanup does not follow symlink targets", async () => {
    const root = await makeTempRoot("cued-imessage-test-");
    const sourcePath = join(root, "source.png");
    const protectedPath = join(root, "protected.txt");

    await writeFile(sourcePath, "attachment", { encoding: "utf8" });
    await writeFile(protectedPath, "do-not-delete", { encoding: "utf8" });

    const prepared = await createSecureAttachmentTempFile(sourcePath, {
      tempRootDir: root,
    });

    await unlink(prepared.path);
    await symlink(protectedPath, prepared.path);

    await prepared.cleanup();

    expect(await readFile(protectedPath, "utf8")).toBe("do-not-delete");
  });
});
