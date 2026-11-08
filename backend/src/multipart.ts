// Minimal, strict multipart/form-data parser for an already size-limited body.
// No dependency: the uploads are small (at most 3 frames of 2.5 MiB) and come
// from our own camera, so a buffered parser with hard limits is enough.

export class MultipartError extends Error {}

export interface Part {
  name: string;
  filename?: string;
  contentType: string;
  data: Buffer;
}

const MAX_PARTS = 8;
const MAX_HEADER_BYTES = 2048;

export function boundaryFrom(contentType: string | undefined): string {
  const ct = contentType ?? '';
  if (!/^multipart\/form-data\s*;/i.test(ct)) throw new MultipartError('Content-Type must be multipart/form-data');
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))(?=[;\s]|$)/i.exec(ct);
  const b = m?.[1] ?? m?.[2];
  if (!b) throw new MultipartError('missing or invalid multipart boundary');
  return b;
}

function parseHeaders(block: string): { name: string; filename?: string; contentType: string } {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType = 'text/plain';
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i <= 0) throw new MultipartError('malformed part header');
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'content-disposition') {
      if (!/^form-data\b/i.test(value)) throw new MultipartError('part is not form-data');
      const n = /;\s*name="([^"]*)"/i.exec(value) ?? /;\s*name=([^;\s]+)/i.exec(value);
      const f = /;\s*filename="([^"]*)"/i.exec(value);
      name = n?.[1];
      filename = f?.[1];
    } else if (key === 'content-type') {
      contentType = value.toLowerCase();
    }
  }
  if (!name) throw new MultipartError('part without a name');
  return { name, filename, contentType };
}

export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  const parts: Part[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new MultipartError('multipart body has no boundary');
  for (;;) {
    pos += delim.length;
    // Closing delimiter.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts;
    // Allow transport padding (spaces/tabs) before the CRLF.
    while (body[pos] === 0x20 || body[pos] === 0x09) pos++;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) throw new MultipartError('malformed boundary line');
    pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
    if (headerEnd < 0 || headerEnd - pos > MAX_HEADER_BYTES) throw new MultipartError('malformed part headers');
    const headers = parseHeaders(body.subarray(pos, headerEnd).toString('utf8'));
    const dataStart = headerEnd + 4;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n', 'latin1'), delim]), dataStart);
    if (next < 0) throw new MultipartError('multipart body is truncated');
    parts.push({ ...headers, data: body.subarray(dataStart, next) });
    if (parts.length > MAX_PARTS) throw new MultipartError('too many parts');
    pos = next + 2;
  }
}
