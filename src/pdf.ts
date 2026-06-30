// src/pdf.ts
import { mdToPdf } from "md-to-pdf";

export async function convertToPdf(text: string, outPath: string): Promise<void> {
  await mdToPdf({ content: text }, { dest: outPath });
}
