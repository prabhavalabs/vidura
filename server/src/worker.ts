import { getBoss, PROCESS_VIDEO_QUEUE, type ProcessVideoJobData } from "./jobs/boss.ts";
import { runProcessVideoJob } from "./jobs/process-video.ts";

// Background worker: consumes the process-video queue. Run as a separate
// process from the API (bun run worker) so long translations never block
// request handling.
const boss = await getBoss();

await boss.createQueue(PROCESS_VIDEO_QUEUE);

// batchSize MUST stay 1. pg-boss hands the handler an array and marks EVERY
// job in the fetched batch complete once the handler resolves — so fetching 2
// while only ever running the first silently completed the second without
// running it, stranding that video at 0% forever. One job per fetch makes
// that impossible, and each job keeps its own expiration window rather than
// sharing one with whatever it was batched beside.
await boss.work<ProcessVideoJobData>(
  PROCESS_VIDEO_QUEUE,
  { batchSize: 1 },
  async (jobs) => {
    // Still loop: the contract is an array, so nothing is dropped even if the
    // fetch size is ever raised again.
    for (const job of jobs) {
      console.log(`process-video: job ${job.data.jobId} started`);
      await runProcessVideoJob(job.data);
      console.log(`process-video: job ${job.data.jobId} done`);
    }
  },
);

console.log("Vidura worker ready, consuming", PROCESS_VIDEO_QUEUE);
