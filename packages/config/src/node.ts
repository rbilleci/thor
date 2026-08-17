import { readFile } from "node:fs/promises";

import { parseDeliveryProjectDeclaration } from "./compiler.js";
import type { DeliveryProjectDeclaration } from "./schema.js";

export async function loadDeliveryProjectDeclaration(
  filePath: string,
): Promise<DeliveryProjectDeclaration> {
  const text = await readFile(filePath, "utf8");
  const value: unknown = JSON.parse(text);
  return parseDeliveryProjectDeclaration(value);
}
