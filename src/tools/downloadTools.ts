/**
 * Download tools. Firefox's download manager handles the response body, so
 * the tool works for any MIME type without loading file contents into memory.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";

const internetUrl = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Download URL must use HTTP or HTTPS");

const relativeFilename = z.string().trim().min(1).max(1024).superRefine((value, ctx) => {
  const segments = value.split(/[\\/]/);
  if (/^(?:[\\/]|[A-Za-z]:)/.test(value) || segments.includes("..")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Filename must be relative to the Downloads directory and cannot contain '..'" });
  }
});

export const downloadFileTool = defineTool({
  name: "download_file",
  description:
    "Download a direct HTTP(S) URL with Firefox's download manager only when the user explicitly asks to download or save it. Works with any file type, including images, video, audio, archives, documents, and text. The download is queued without reading its contents. Omit filename to use the server-provided name.",
  inputSchema: z.object({
    url: internetUrl.describe("Direct HTTP(S) URL of the resource to download"),
    filename: relativeFilename.optional().describe("Optional path relative to the Downloads directory, such as images/photo.jpg"),
    saveAs: z.boolean().optional().default(false).describe("Show Firefox's file chooser; use only when the user asks to choose a location"),
    conflictAction: z.enum(["uniquify", "overwrite", "prompt"]).optional().default("uniquify")
      .describe("What Firefox should do when the filename already exists"),
  }),
  async execute(input, ctx) {
    return ctx.gateway.downloadFile(input.url, {
      ...(input.filename ? { filename: input.filename } : {}),
      saveAs: input.saveAs,
      conflictAction: input.conflictAction,
    });
  },
});
