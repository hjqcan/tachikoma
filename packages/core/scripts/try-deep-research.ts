
import { deepResearchTool } from '../src/tools/core/deep-research';

async function main() {
  const query = process.argv[2] || "Analyze the latest advancements in solid state batteries in 2024";

  console.log(`Starting deep research with query: "${query}"`);
  console.log("This may take a while (default timeout is 20 minutes, we'll wait)...");

  try {
    const result = await deepResearchTool.execute({
        input: query,
        timeoutMs: 120000, // 2 minutes for test
        pollIntervalMs: 2000,
    }, {
        env: process.env,
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        workspaceRoot: process.cwd(),
    } as any);

    if (result.success) {
        console.log("\nSearch Successful!");
        console.log("---------------------------------------------------");
        console.log("Interaction ID:", result.data.interactionId);
        console.log("Status:", result.data.status);
        console.log("\nReport:");
        console.log(result.data.report);
        console.log("\nCitations:");
        result.data.citations?.forEach((c: any, i: number) => {
            console.log(`[${i+1}] ${c.title || 'No Title'} - ${c.url}`);
        });
    } else {
        console.error("\nSearch Failed:", result.error);
        if (result.data) {
            console.error("Partial data:", result.data);
        }
    }

  } catch (error) {
    console.error("Error running tool:", error);
  }
}

main();
