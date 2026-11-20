import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import { useApp } from './ui.js';

/** Long side of the photo sent to the server: enough for the small print of a long till receipt. */
const MAX_SIDE = 3000;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

/**
 * What is sent for a picked file: a PDF as it is; any image the browser can show (JPEG, PNG, HEIC on iPhone)
 * redrawn upright as a JPEG, scaled down when huge. The server accepts PDF, JPEG and PNG.
 */
async function prepare(file: File): Promise<Blob> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return file;
  try {
    const img = await loadImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff'; // transparent PNGs would turn black as JPEG
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (blob) return blob;
  } catch { /* fall through */ }
  if (file.type === 'image/jpeg') return file;
  throw new ApiError(400, 'unsupported_file');
}

/**
 * Receipt upload from the phone's camera, its photo library or a file. One hidden input serves every button
 * that calls `pick`. After one file the owner lands on its item page; after several, on the full list.
 */
export function useUploadReceipt(): { input: ReactNode; pick: () => void; busy: boolean; error: string | null } {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { refreshSummary } = useApp();

  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true); setError(null);
    const done: { id: string; duplicate: boolean }[] = [];
    try {
      for (const f of files) done.push(await api.upload(await prepare(f), f.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await refreshSummary();
      if (done.length === 1) navigate(`/items/${done[0].id}`, { state: { uploaded: done[0].duplicate ? 'duplicate' : 'new' } });
      else if (done.length > 1) navigate('/invoices');
    }
  };

  const input = (
    <input ref={ref} type="file" accept="image/*,application/pdf" multiple hidden
      onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void onFiles(files); }} />
  );
  return { input, pick: () => ref.current?.click(), busy, error };
}
