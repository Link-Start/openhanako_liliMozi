import { readOfficeDocument } from "../lib/read-document.ts";

export { isOfficeEnabledForAgentConfig as isEnabledForAgentConfig } from "../lib/availability.ts";

export const name = "read-document";

export const description = [
  "Read supported Office/text documents into structured text for the Agent.",
  "Use for .docx, .xlsx, .txt, .md, .csv, .tsv, and .html files.",
  "Requires an absolute filePath. Does not modify files. Unsupported legacy formats such as .doc, .xls, .ppt, .pptx, and .pdf fail explicitly.",
].join(" ");

export const parameters = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description: "Absolute path to the document to read.",
    },
    outputFormat: {
      type: "string",
      enum: ["text", "html", "json"],
      description: "text by default. docx also supports html; xlsx also supports json.",
    },
    maxChars: {
      type: "number",
      description: "Maximum characters returned for text/html output. Default 20000.",
    },
    sheetLimit: {
      type: "number",
      description: "xlsx only. Maximum sheets to read. Default 8.",
    },
    rowLimit: {
      type: "number",
      description: "xlsx only. Maximum rows per sheet. Default 200.",
    },
    columnLimit: {
      type: "number",
      description: "xlsx only. Maximum columns per sheet. Default 50.",
    },
  },
  required: ["filePath"],
};

export async function execute(input) {
  try {
    const result = await readOfficeDocument(input);
    const text = result.format === "json"
      ? JSON.stringify(result.workbook, null, 2)
      : result.content;
    return {
      content: [{
        type: "text",
        text,
      }],
      details: {
        office: result,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: "text",
        text: `Office read failed: ${message}`,
      }],
      details: {
        error: {
          code: "OFFICE_READ_FAILED",
          message,
        },
      },
    };
  }
}
