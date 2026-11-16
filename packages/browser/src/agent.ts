/** Browser and operating system from the user agent (internal helpers). */

export function browserOf(ua: string): { name: string; version?: string } {
  const rules: Array<[string, RegExp]> = [
    ["Edge", /Edg\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Chrome", /Chrome\/(\d+)/],
    ["Firefox", /Firefox\/(\d+)/],
    ["Safari", /Version\/(\d+).*Safari/],
  ];
  for (const [name, pattern] of rules) {
    const match = pattern.exec(ua);
    if (match) return { name, version: match[1] };
  }
  return { name: "Unknown" };
}

export function osOf(ua: string): { name: string; version?: string } {
  if (/Windows NT 10/.test(ua)) return { name: "Windows", version: "10+" };
  if (/Windows/.test(ua)) return { name: "Windows" };
  if (/iPhone|iPad|iPod/.test(ua)) return { name: "iOS", version: /OS (\d+)/.exec(ua)?.[1] };
  if (/Mac OS X/.test(ua)) return { name: "macOS" };
  if (/Android/.test(ua)) return { name: "Android", version: /Android (\d+)/.exec(ua)?.[1] };
  if (/Linux/.test(ua)) return { name: "Linux" };
  return { name: "Unknown" };
}
