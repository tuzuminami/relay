import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));

async function rewriteDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarations(path);
    } else if (entry.name.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      const output = source.replace(/(["'](?:\.\.?(?:\/|$))[^"']*)\.ts(["'])/g, "$1.js$2");
      if (output !== source) {
        await writeFile(path, output);
      }
    }
  }
}

await rewriteDeclarations(distDirectory);
