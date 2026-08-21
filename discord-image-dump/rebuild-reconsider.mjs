import { Client, GatewayIntentBits } from "discord.js";
import { TOKEN, rebuildReconsiderThread, assertBotLockFree } from "./lib.mjs";

assertBotLockFree("rebuild-reconsider.mjs");

if (!TOKEN) {
  console.error("Set DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  try {
    const result = await rebuildReconsiderThread(client, async (text) => {
      console.log(text);
    });
    console.log(`Done. Posted ${result.posted.length} unique images. Gaps: ${result.gaps.length}.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

await client.login(TOKEN);
