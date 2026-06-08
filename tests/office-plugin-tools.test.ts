import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

import { execute as readDocument } from "../plugins/office/tools/read-document.ts";
import { execute as listCapabilities } from "../plugins/office/tools/list-capabilities.ts";
import { renderHtmlToPdf } from "../plugins/office/lib/html-to-pdf.ts";
import { isOfficeEnabledForAgentConfig } from "../plugins/office/lib/availability.ts";

describe("office plugin tools", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-office-plugin-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports Office capabilities without side effects", async () => {
    const result = await listCapabilities();

    expect(result.content[0].text).toContain("Office tools are available");
    expect(result.details.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "read-document", tool: "office_read-document" }),
      expect.objectContaining({ id: "html-to-pdf", tool: "office_html-to-pdf" }),
    ]));
  });

  it("is enabled by default and follows the per-agent office toggle", () => {
    expect(isOfficeEnabledForAgentConfig({})).toBe(true);
    expect(isOfficeEnabledForAgentConfig({ tools: { disabled: [] } })).toBe(true);
    expect(isOfficeEnabledForAgentConfig({ tools: { disabled: ["office"] } })).toBe(false);
  });

  it("reads xlsx workbooks as structured JSON", async () => {
    const filePath = path.join(tempDir, "report.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Summary");
    sheet.addRow(["Name", "Value"]);
    sheet.addRow(["Revenue", 42]);
    await workbook.xlsx.writeFile(filePath);

    const result = await readDocument({ filePath, outputFormat: "json" });

    expect(result.details.office.kind).toBe("xlsx");
    expect(result.details.office.workbook.sheets[0]).toMatchObject({
      name: "Summary",
      rows: [
        ["Name", "Value"],
        ["Revenue", "42"],
      ],
    });
    expect(result.content[0].text).toContain('"sheetCount": 1');
  });

  it("fails unsupported document formats explicitly", async () => {
    const filePath = path.join(tempDir, "legacy.pdf");
    fs.writeFileSync(filePath, "%PDF-1.4\n", "utf-8");

    const result = await readDocument({ filePath });

    expect(result.details.error).toMatchObject({
      code: "OFFICE_READ_FAILED",
    });
    expect(result.content[0].text).toContain("unsupported Office read format");
  });

  it("renders HTML to PDF through the desktop helper contract and stages the output", async () => {
    let observedCommand = null;
    const fakeSpawn = vi.fn((command, args) => {
      observedCommand = { command, args };
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const jobPath = args.at(-1);
        const job = JSON.parse(fs.readFileSync(jobPath, "utf-8"));
        fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
        fs.writeFileSync(job.outputPath, "%PDF-1.4\n% office test\n", "utf-8");
        child.emit("close", 0);
      });
      return child;
    });
    const stageFile = vi.fn(({ sessionPath, filePath, label }) => ({
      file: { fileId: "sf_pdf", sessionPath, filePath, label },
      mediaItem: { type: "session_file", fileId: "sf_pdf", sessionPath, filePath, label },
    }));

    const result = await renderHtmlToPdf(
      {
        html: "<!doctype html><style>@page{size:A4}</style><h1>Hello</h1>",
        filename: "hello.pdf",
      },
      {
        dataDir: tempDir,
        sessionPath: "/sessions/office.jsonl",
        stageFile,
      },
      {
        env: {
          HANA_DESKTOP_EXEC_PATH: "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent",
          HANA_DESKTOP_IS_PACKAGED: "1",
        },
        spawn: fakeSpawn,
      },
    );

    expect(observedCommand).toMatchObject({
      command: "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent",
      args: ["--hana-office-html-to-pdf", expect.stringMatching(/job\.json$/)],
    });
    expect(fs.readFileSync(result.outputPath, "utf-8")).toContain("%PDF-1.4");
    expect(stageFile).toHaveBeenCalledWith({
      sessionPath: "/sessions/office.jsonl",
      filePath: result.outputPath,
      label: "hello.pdf",
    });
    expect(result.mediaItem).toMatchObject({ type: "session_file", fileId: "sf_pdf" });
  });
});
