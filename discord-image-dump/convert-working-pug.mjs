import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, "assets", "working-pug.bin");
const gifOut = path.join(root, "assets", "working-pug.gif");
const webpOut = path.join(root, "assets", "working-pug.webp");

const buf = await readFile(src);
await writeFile(webpOut, buf);
const meta = await sharp(buf, { animated: true, pages: -1 }).metadata();
console.log(JSON.stringify({
  format: meta.format,
  width: meta.width,
  height: meta.height,
  pages: meta.pages,
  delay: meta.delay,
  size: buf.length,
}, null, 2));

await sharp(buf, { animated: true, pages: -1 })
  .gif({ effort: 4, reuse: true })
  .toFile(gifOut);
const gif = await readFile(gifOut);
console.log(`wrote gif ${gif.length} bytes`);
