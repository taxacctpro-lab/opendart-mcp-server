import { FastMCP } from "fastmcp";
import { registerDisclosureTools } from "./tools/disclosure.js";
import { registerDocumentTools } from "./tools/document.js";
import { registerFinancialTools } from "./tools/financial.js";
import { ensureCorpCodes } from "./utils/corp-code.js";

// Auto-download corp codes on first run
await ensureCorpCodes();

const server = new FastMCP({
  name: "OpenDART",
  version: "1.0.0",
  instructions:
    "Korean DART (금융감독원 전자공시시스템) data access server. " +
    "Provides tools to search companies, disclosures, and financial statements from DART OpenAPI.",
});

registerDisclosureTools(server);
registerFinancialTools(server);
registerDocumentTools(server);

const port = process.env.PORT ? Number(process.env.PORT) : undefined;

if (port) {
  await server.start({
    transportType: "httpStream",
    httpStream: { port, host: "0.0.0.0" },
  });
} else {
  await server.start({
    transportType: "stdio",
  });
}
