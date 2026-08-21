import { applyPlaceholderToNumber, ensurePlaceholderFile, loadSequence, saveSequence } from "./lib.mjs";

const src = process.argv[2];
await ensurePlaceholderFile(src);
const sequence = await loadSequence();
for (const n of sequence.gaps) {
  await applyPlaceholderToNumber(n);
  const item = sequence.items[n - 1];
  if (item) {
    item.placeholder = true;
    item.dirty = true;
  }
}
await saveSequence(sequence);
console.log(`PLACEHOLDER.jpg ready; applied to ${sequence.gaps.length} gap slots`);
