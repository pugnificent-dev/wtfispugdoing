import { runDriveLogin } from "./drive.mjs";

runDriveLogin().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
