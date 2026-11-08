// Builds JPEG-shaped test files: valid markers, a real frame header with the
// requested size, an optional comment, filler scan data and an end marker.
// They pass the server's header checks but do not decode to a picture, so
// use them only with the mock provider.
//
// The mock provider reads the comment: "mock:ready", "mock:unsure",
// "mock:partial", "mock:retake:glare", "mock:fail", "mock:flaky", "mock:slow".

export interface TestJpegOptions {
  width?: number;
  height?: number;
  comment?: string;
  bytes?: number; // total size; padded with filler data
}

export function makeTestJpeg(opts: TestJpegOptions = {}): Buffer {
  const width = opts.width ?? 1600;
  const height = opts.height ?? 1200;
  const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (opts.comment) {
    const c = Buffer.from(opts.comment, 'latin1');
    const h = Buffer.alloc(4);
    h[0] = 0xff; h[1] = 0xfe; h.writeUInt16BE(c.length + 2, 2);
    chunks.push(h, c);
  }
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2);
  sof[4] = 8; sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  for (let i = 0; i < 3; i++) { sof[10 + i * 3] = i + 1; sof[11 + i * 3] = 0x11; sof[12 + i * 3] = 0; }
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  chunks.push(sof, sos);
  const head = chunks.reduce((n, c) => n + c.length, 0);
  // Default filler gives about 0.1 bytes per pixel, which looks like a normal photo.
  const target = opts.bytes ?? Math.max(head + 64, Math.round(width * height * 0.1));
  const fill = Math.max(16, target - head - 2);
  chunks.push(Buffer.alloc(fill, 0x55), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(chunks);
}
