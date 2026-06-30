// src/pdf.ts
import { mdToPdf } from "md-to-pdf";

const PDF_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 11pt;
    line-height: 1.7;
    color: #1a1a2e;
    background: #ffffff;
    padding: 0;
  }

  /* Cover strip at top of first page */
  body::before {
    content: '';
    display: block;
    height: 6px;
    background: linear-gradient(90deg, #6366f1, #8b5cf6, #06b6d4);
    margin-bottom: 48px;
  }

  h1 {
    font-size: 26pt;
    font-weight: 700;
    color: #1a1a2e;
    letter-spacing: -0.5px;
    margin-bottom: 6px;
  }

  h1 + p {
    font-size: 10.5pt;
    color: #6b7280;
    margin-bottom: 36px;
    padding-bottom: 24px;
    border-bottom: 1px solid #e5e7eb;
  }

  h2 {
    font-size: 14pt;
    font-weight: 600;
    color: #1a1a2e;
    margin-top: 32px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 2px solid #6366f1;
  }

  h3 {
    font-size: 11.5pt;
    font-weight: 600;
    color: #374151;
    margin-top: 20px;
    margin-bottom: 6px;
  }

  p {
    margin-bottom: 12px;
    color: #374151;
  }

  ul, ol {
    margin: 0 0 14px 22px;
    color: #374151;
  }

  li {
    margin-bottom: 5px;
  }

  li::marker {
    color: #6366f1;
    font-weight: 600;
  }

  strong {
    font-weight: 600;
    color: #1a1a2e;
  }

  code {
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    font-size: 9.5pt;
    background: #f3f4f6;
    color: #6366f1;
    padding: 1px 5px;
    border-radius: 4px;
  }

  blockquote {
    border-left: 3px solid #6366f1;
    background: #f5f3ff;
    margin: 16px 0;
    padding: 10px 16px;
    border-radius: 0 6px 6px 0;
  }

  blockquote p {
    color: #4c1d95;
    margin: 0;
    font-style: italic;
  }

  hr {
    border: none;
    border-top: 1px solid #e5e7eb;
    margin: 28px 0;
  }

  /* Page footer */
  @page {
    margin: 18mm 20mm 22mm 20mm;
    @bottom-center {
      content: "ARCHIE Architecture Report  ·  Page " counter(page) " of " counter(pages);
      font-family: 'Inter', sans-serif;
      font-size: 8pt;
      color: #9ca3af;
    }
  }
`;

export async function convertToPdf(text: string, outPath: string): Promise<void> {
  await mdToPdf(
    { content: text },
    {
      dest: outPath,
      css: PDF_CSS,
      pdf_options: {
        format: "A4",
        printBackground: true,
        margin: { top: "18mm", right: "20mm", bottom: "22mm", left: "20mm" },
      },
    }
  );
}
