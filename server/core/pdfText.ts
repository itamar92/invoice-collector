export class PdfError extends Error {
  constructor(public code: 'unreadable_pdf', message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

const MIN_CHARS_PER_PAGE = 40;

/**
 * Extracts the text of a PDF. Items are joined with spaces per page, pages with '\n'.
 * Hebrew items may come out in visual order; the parsers normalize that.
 * `isScan` is true when the average non-space characters per page is under 40.
 */
export async function extractPdfText(pdf: Buffer): Promise<{ text: string; pages: number; isScan: boolean }> {
  // The legacy build is the one that runs under Node without a DOM.
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(pdf),
      // Untrusted document: no eval, no font fetching, no worker.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableWorker: true,
      verbosity: 0,
    }).promise;
  } catch (err) {
    throw new PdfError('unreadable_pdf', `unreadable PDF: ${(err as Error).message}`);
  }
  try {
    const pageTexts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pageTexts.push(
        (content.items as any[]).map((i) => String(i.str ?? '')).filter((s) => s.trim() !== '').join(' '),
      );
    }
    const text = pageTexts.join('\n');
    const pages: number = doc.numPages;
    const chars = text.replace(/\s/g, '').length;
    return { text, pages, isScan: pages === 0 || chars / pages < MIN_CHARS_PER_PAGE };
  } catch (err) {
    throw new PdfError('unreadable_pdf', `unreadable PDF: ${(err as Error).message}`);
  } finally {
    await doc.destroy?.();
  }
}
