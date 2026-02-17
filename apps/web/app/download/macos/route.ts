import { NextResponse } from "next/server";

const RELEASE_API_URL = "https://api.github.com/repos/Cue-d/cued-releases/releases/latest";
const RELEASE_FALLBACK_URL = "https://github.com/Cue-d/cued-releases/releases/latest";

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type GithubRelease = {
  html_url?: string;
  assets?: ReleaseAsset[];
};

function pickBestDmgAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  const dmgAssets = assets.filter((asset) => {
    const name = asset.name ?? "";
    return name.endsWith(".dmg") && !name.endsWith(".dmg.blockmap");
  });

  if (dmgAssets.length === 0) {
    return undefined;
  }

  const neutralArch = dmgAssets.find((asset) => {
    const name = (asset.name ?? "").toLowerCase();
    return !name.includes("arm64") && !name.includes("x64");
  });
  if (neutralArch) {
    return neutralArch;
  }

  const arm64 = dmgAssets.find((asset) => (asset.name ?? "").toLowerCase().includes("arm64"));
  return arm64 ?? dmgAssets[0];
}

export async function GET() {
  try {
    const response = await fetch(RELEASE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      return NextResponse.redirect(RELEASE_FALLBACK_URL);
    }

    const release = (await response.json()) as GithubRelease;
    const assets = release.assets ?? [];
    const dmgAsset = pickBestDmgAsset(assets);
    const redirectUrl = dmgAsset?.browser_download_url || release.html_url || RELEASE_FALLBACK_URL;

    return NextResponse.redirect(redirectUrl);
  } catch {
    return NextResponse.redirect(RELEASE_FALLBACK_URL);
  }
}
