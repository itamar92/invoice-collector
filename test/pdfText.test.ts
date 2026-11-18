import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, PdfError } from '../server/core/pdfText.js';

/** Minimal one-page PDF with correct xref offsets. `content` is the page content stream. */
function buildPdf(content: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('extractPdfText returns the text of a text PDF', async () => {
  const text = 'Invoice 2026 Total 59.90 paid in full by card, thank you for your business today';
  const pdf = buildPdf(`BT /F1 10 Tf 10 100 Td (${text}) Tj ET`);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages, 1);
  assert.equal(r.isScan, false);
  assert.match(r.text, /Invoice 2026 Total 59\.90/);
});

test('extractPdfText flags a page without text as a scan', async () => {
  const r = await extractPdfText(buildPdf('0 0 m 10 10 l S'));
  assert.equal(r.pages, 1);
  assert.equal(r.isScan, true);
  assert.equal(r.text.trim(), '');
});

test('extractPdfText throws PdfError unreadable_pdf on garbage', async () => {
  await assert.rejects(
    () => extractPdfText(Buffer.from('not a pdf at all')),
    (e: unknown) => e instanceof PdfError && e.code === 'unreadable_pdf',
  );
});
