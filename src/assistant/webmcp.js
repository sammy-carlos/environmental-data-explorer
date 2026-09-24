import { TOOLS, runTool } from "./tools.js";

// WebMCP lets browser agents (Chrome and others) call the same tools as the built-in
// assistant, without scraping the page. It is a no-op where the API is unavailable.
// Charts only render inside the conversation, so browser agents get every other tool.
const HIDDEN = new Set(["create_chart"]);

export function registerWebMcpTools() {
  const context = navigator.modelContext;
  if (!context?.registerTool) return;
  for (const tool of TOOLS.filter((item) => !HIDDEN.has(item.name))) {
    try {
      context.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        async execute(input) {
          const result = await runTool(tool.name, input ?? {});
          return { content: [{ type: "text", text: result.content }], isError: Boolean(result.isError) };
        },
      });
    } catch (error) {
      console.warn(`WebMCP could not register ${tool.name}`, error);
    }
  }
}
