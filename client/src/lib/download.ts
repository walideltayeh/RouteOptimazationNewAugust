/**
 * Save a fetch response as a file, under the name the server gave it
 * (RFC 5987 filename* first, so Arabic or accented names survive).
 */
export async function saveResponseAsFile(res: Response, fallbackName: string): Promise<string> {
  const cd = res.headers.get("Content-Disposition") || "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(cd)?.[1];
  let name = fallbackName;
  try { name = star ? decodeURIComponent(star) : plain || fallbackName; } catch { name = plain || fallbackName; }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  return name;
}
