import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConnectorSpec } from "./connectorSpec.js";

const publicUrl = process.env.BRIDGE_PUBLIC_URL ?? "http://localhost:8787";
const outPath = resolve(process.cwd(), process.env.OUT_SPEC ?? "spec/connector.openapi.json");

const spec = loadConnectorSpec(publicUrl);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
console.log(`Wrote connector spec for ${publicUrl} -> ${outPath}`);
