const UA = "valcroft-availability-monitor/1.0 (+contact: djhojd)";

export async function fetchPage(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (res.status >= 500) {
        lastErr = new Error(`upstream ${res.status}`);
      } else if (!res.ok) {
        throw new Error(`fetch failed: ${res.status}`);
      } else {
        return await res.text();
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}
