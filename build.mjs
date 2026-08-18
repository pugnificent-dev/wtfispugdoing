import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "discord-oauth"), { recursive: true });
mkdirSync(join(dist, "circuit"), { recursive: true });
mkdirSync(join(dist, "assets"), { recursive: true });

cpSync(join(root, "index.html"), join(dist, "index.html"));
cpSync(join(root, "styles.css"), join(dist, "styles.css"));
cpSync(join(root, "assets"), join(dist, "assets"), { recursive: true });
cpSync(join(root, "discord-oauth.html"), join(dist, "discord-oauth.html"));
cpSync(join(root, "discord-oauth.html"), join(dist, "discord-oauth/index.html"));
cpSync(join(root, "circuit.html"), join(dist, "circuit/index.html"));

for (const skip of ["ref-mockup.png", "meagan-source.png", "pug-hero-alt.jpg"]) {
  rmSync(join(dist, "assets", skip), { force: true });
}

console.log("built dist/");
