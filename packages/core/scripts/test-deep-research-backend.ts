
import { GeminiDeepResearchBackend } from '../src/worker/backends/gemini-deep-research-backend';
import type { WorkerTask, WorkerExecutionOptions } from '../src/worker/types';

async function main() {
  const query = process.argv[2] || "What is the capital of France?";
  console.log(`Starting backend test with query: "${query}"`);

  const backend = new GeminiDeepResearchBackend({
      // apiKey will be picked up from env
  });

  const task: WorkerTask = {
      id: 'test-task-1',
      type: 'atomic',
      objective: query,
      constraints: [],
  };

  const options: WorkerExecutionOptions = {
      env: process.env as Record<string, string>,
      timeout: 120000,
  };

  try {
      console.log("Capabilities:", backend.getCapabilities());
      console.log("Is Available:", backend.isAvailable());
      
      console.log("\nExecuting task...");
      const generator = backend.execute(task, [], options);

      for await (const msg of generator) {
          console.log(`[${new Date(msg.timestamp).toISOString()}] [${msg.type}]`, 
              msg.type === 'thinking' ? msg.content : 
              msg.type === 'output' ? '(Output Content)' : 
              msg.type === 'error' ? msg.error : 
              msg.type === 'status' ? msg.status : ''
          );
          
          if (msg.type === 'output') {
              console.log("\n--- OUTPUT START ---");
              console.log(msg.content);
              console.log("--- OUTPUT END ---\n");
          }
      }

  } catch (error) {
      console.error("Test failed:", error);
  }
}

main();
