interface RequestSnapshot {
  url: string;
  method: string;
  contentType: string;
  body: string | null;
}

export function isSlackApiTokenRequest(
  urlValue: string,
  method: string,
  contentType: string,
  contentLength?: string,
): boolean {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) ||
    !/^\/api\/(?:auth\.test|client\.(?:boot|userBoot|init)|conversations\.(?:list|history|replies|info)|users\.(?:info|list|conversations)|team\.info)$/.test(
      url.pathname,
    )
  )
    return false;
  if (method === "GET") return urlValue.length <= 65_536;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return (
    method === "POST" &&
    (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") &&
    (contentLength === undefined ||
      (Number.isFinite(Number(contentLength)) &&
        Number(contentLength) >= 0 &&
        Number(contentLength) <= 65_536))
  );
}

export class SlackRequestTokenCapture {
  private readonly tokens = new Set<string>();
  private stopped = false;

  async observe(request: RequestSnapshot): Promise<void> {
    if (this.stopped || !isSlackApiTokenRequest(request.url, request.method, request.contentType))
      return;
    const url = new URL(request.url);
    let token: unknown;
    if (request.method === "GET") token = url.searchParams.get("token");
    else if (request.method === "POST" && request.body && request.body.length <= 65_536) {
      const type = request.contentType.split(";")[0]?.trim().toLowerCase();
      try {
        if (type === "application/x-www-form-urlencoded")
          token = new URLSearchParams(request.body).get("token");
        else if (type === "multipart/form-data") {
          const form = await new Response(request.body, {
            headers: { "content-type": request.contentType },
          }).formData();
          token = form.get("token");
        }
      } catch {
        return;
      }
    }
    if (typeof token !== "string" || !/^xoxc-[a-zA-Z0-9-]{10,512}$/.test(token)) return;
    if (this.stopped) return;
    this.tokens.delete(token);
    this.tokens.add(token);
    while (this.tokens.size > 5) this.tokens.delete(this.tokens.values().next().value!);
  }

  candidates(): string[] {
    return [...this.tokens].reverse();
  }
  stop(): void {
    this.stopped = true;
    this.tokens.clear();
  }
}
