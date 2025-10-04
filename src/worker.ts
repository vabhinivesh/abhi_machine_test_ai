// Load environment variables first
import dotenv from 'dotenv';
dotenv.config();

import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities/quote.activities';
import * as path from 'path';

async function run() {
  // Step 1: Connect to the Temporal server
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });

  // Step 2: Register Workflows and Activities with the Worker
  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows/quote.workflow'),
    activities,
    taskQueue: 'cpq-queue',
  });

  console.log('Worker started and connected to Temporal server. Press Ctrl+C to exit.');
  
  // Step 3: Start accepting tasks on the 'cpq-queue' queue
  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed to start', err);
  process.exit(1);
});
