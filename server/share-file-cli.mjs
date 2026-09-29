// Thin client used by the Pi tool and shell-capable engines. Storage stays on the host.
import { pathToFileURL } from "node:url";

export async function requestShareFile(filePath, signal) {
  const response = await fetch(`${process.env.FILE_SHARE_URL}/api/internal/files/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.FILE_SHARE_TOKEN}` },
    body: JSON.stringify({ agent: process.env.FILE_SHARE_AGENT, path: filePath }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "File could not be shared");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node "$CLOUD_PI_SHARE_FILE" <workspace-file>');
    console.log(JSON.stringify(await requestShareFile(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
