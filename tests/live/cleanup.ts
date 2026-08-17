import {
  LiveGitHubFixtureManager,
  LiveRunManifest,
  loadLiveTestConfiguration,
} from "./support/github-fixture.js";
import { redactKnownSecrets } from "@thor/domain";

const manifestPaths = process.argv.slice(2);
if (manifestPaths.length === 0) {
  throw new Error("usage: npm run test:live:cleanup -- <manifest-path> [manifest-path ...]");
}

const configuration = await loadLiveTestConfiguration();
let failures = 0;
for (const manifestPath of manifestPaths) {
  try {
    const manifest = await LiveRunManifest.load(manifestPath);
    const fixtures = new LiveGitHubFixtureManager(configuration, manifest);
    await fixtures.cleanupRecordedArtifacts();
    process.stdout.write(`Cleaned live-test artifacts recorded in ${manifest.filePath}\n`);
  } catch (error) {
    failures += 1;
    const message = redactKnownSecrets(error instanceof Error ? error.message : String(error));
    process.stderr.write(`Failed to clean ${manifestPath}: ${message}\n`);
  }
}
if (failures > 0) process.exitCode = 1;
