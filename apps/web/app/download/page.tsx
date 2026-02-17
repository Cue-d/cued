"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DownloadIcon, ExternalLinkIcon, ArrowRightIcon } from "lucide-react";
import { Button, CuedMark } from "@cued/ui";
import { MarketingHeader } from "../(marketing)/marketing-header";

const MAC_DOWNLOAD_URL = "/download/macos";
const DEEP_LINK_URL = "cued://";

type Platform = "unknown" | "macos" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();
  const isMac = platform.includes("mac") || userAgent.includes("macintosh");

  return isMac ? "macos" : "other";
}

export default function DownloadPage() {
  const [platform, setPlatform] = useState<Platform>("unknown");

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setPlatform(detectPlatform());
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  const isMac = platform === "macos";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6">
      <MarketingHeader />

      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <CuedMark size={40} className="text-foreground" />

        <h1 className="mt-6 text-2xl font-semibold tracking-tight sm:text-3xl">
          Cued for Mac
        </h1>
        <p className="mt-2 text-pretty text-sm text-muted-foreground">
          A unified inbox that enriches your network and surfaces opportunities
          for you.
        </p>

        {isMac ? (
          <div className="mt-8 flex w-full flex-col items-center gap-6">
            <div className="flex w-full flex-col items-center gap-2">
              <Button
                nativeButton={false}
                render={<a href={MAC_DOWNLOAD_URL} />}
                className="h-auto w-full gap-2.5 rounded-xl px-6 py-3.5 text-base active:scale-[0.98]"
              >
                <DownloadIcon className="size-[18px]" />
                Download for macOS
              </Button>
              <p className="text-xs text-muted-foreground">
                Latest stable release
              </p>
            </div>

            <div className="h-px w-12 bg-border" />

            <a
              href={DEEP_LINK_URL}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Already installed? Open Cued
              <ExternalLinkIcon className="size-3" />
            </a>
          </div>
        ) : (
          <div className="mt-8 flex w-full flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground">
              Cued Desktop is currently macOS only.
            </p>
            <Link
              href="/inbox"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.98]"
            >
              Continue to the web app
              <ArrowRightIcon className="size-4" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
