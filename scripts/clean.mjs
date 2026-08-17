import { rm } from "node:fs/promises";
import { glob } from "node:fs/promises";

const generated = ["coverage", ".temporal", "dist-tests"];
for await (const entry of glob("{apps,packages}/*/{dist,*.tsbuildinfo}")) {
  generated.push(entry);
}

await Promise.all(generated.map((path) => rm(path, { force: true, recursive: true })));
