import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bestZip from "bestzip";

const root = fileURLToPath(new URL("../", import.meta.url));
const extension = path.join(root, "tmp_extension/quo-crm-extension");
const publicDir = path.join(root, "public");
const manifestPath = path.join(extension, "manifest.json");
const releasePath = path.join(publicDir, "extension-release.json");
const bundledPath = path.join(extension, "release.json");
const zipPath = path.join(publicDir, "Donut.zip");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

async function sourceHash(directory = extension, prefix = "") {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  const values = [];
  for (const entry of entries) {
    if (!prefix && entry.name === "release.json") continue;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) values.push(await sourceHash(path.join(directory, entry.name), `${name}/`));
    else {
      const bytes = await readFile(path.join(directory, entry.name));
      // Git checks out text with different line endings on Windows and Linux.
      const content = /\.(js|json|css|html|md|txt)$/.test(name) ? bytes.toString("utf8").replace(/\r\n/g, "\n") : bytes;
      values.push(`${name}:${hash(content)}`);
    }
  }
  return hash(values.join("\n"));
}

async function check() {
  const [manifest, release, bundled] = await Promise.all([json(manifestPath), json(releasePath), json(bundledPath)]);
  if (manifest.version !== release.version || bundled.version !== release.version ||
    bundled.releasedAt !== release.releasedAt || bundled.sourceSha256 !== release.sourceSha256 ||
    release.sourceSha256 !== await sourceHash() || release.packageSha256 !== hash(await readFile(zipPath))) {
    throw new Error("Extension source, release metadata or ZIP is out of sync. Run npm run extension:release -- <new-version> \"Release notes\" and commit the generated files.");
  }
  console.log(`Donut v${release.version} • ${release.releasedAt} • source and ZIP verified`);
}

async function release(version, summary) {
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version || "") || version.split(".").some((part) => Number(part) > 65535) || !summary?.trim()) {
    throw new Error('Usage: npm run extension:release -- 1.5.0 "Release notes" (use a higher Chrome-compatible version)');
  }
  let previous;
  try { previous = await json(releasePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const old = (previous?.version || manifest.version).split(".").map(Number);
  const next = version.split(".").map(Number);
  const difference = Array.from({ length: 4 }, (_, i) => (next[i] || 0) - (old[i] || 0)).find((value) => value !== 0);
  if (!difference || difference < 0) throw new Error("Every extension release must have a higher version than the previous release.");
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const release = { name: "Donut", version, releasedAt: new Date().toISOString(), summary: summary.trim(), sourceSha256: await sourceHash() };
  await writeFile(bundledPath, `${JSON.stringify(release, null, 2)}\n`);
  const temporary = path.join(publicDir, ".Donut.next.zip");
  // Start a fresh archive so removed extension files cannot survive an update.
  await rm(temporary, { force: true });
  await bestZip({ cwd: path.dirname(extension), source: path.basename(extension), destination: temporary, followSymLinks: false });
  release.packageSha256 = hash(await readFile(temporary));
  await rename(temporary, zipPath);
  await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  await check();
}

try {
  if (process.argv[2] === "--check") await check();
  else await release(process.argv[2], process.argv.slice(3).join(" "));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
