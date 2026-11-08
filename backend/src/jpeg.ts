// Reads what the server needs from a JPEG without decoding pixels: that it is
// a JPEG, that it is complete, its dimensions, and any comment segments.
// Pure JavaScript, no native code.

export interface JpegInfo {
  width: number;
  height: number;
  progressive: boolean;
  comments: string[];
}

export class JpegError extends Error {}

function isSof(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

export function readJpeg(buf: Buffer): JpegInfo {
  if (buf.length < 8 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new JpegError('not a JPEG');
  // Must end with EOI. Some encoders pad with zero bytes after it.
  let end = buf.length;
  while (end > 2 && buf[end - 1] === 0x00 && buf.length - end < 64) end--;
  if (buf[end - 2] !== 0xff || buf[end - 1] !== 0xd9) throw new JpegError('JPEG is truncated (no end marker)');

  let pos = 2;
  let width = 0;
  let height = 0;
  let progressive = false;
  const comments: string[] = [];
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) throw new JpegError('corrupt JPEG marker');
    let marker = buf[pos + 1];
    // Fill bytes.
    while (marker === 0xff && pos + 2 < buf.length) {
      pos++;
      marker = buf[pos + 1];
    }
    pos += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9) break;
    if (pos + 2 > buf.length) break;
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) throw new JpegError('corrupt JPEG segment');
    if (isSof(marker)) {
      if (len < 7) throw new JpegError('corrupt JPEG frame header');
      height = buf.readUInt16BE(pos + 3);
      width = buf.readUInt16BE(pos + 5);
      progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
    } else if (marker === 0xfe) {
      comments.push(buf.subarray(pos + 2, pos + len).toString('latin1'));
    }
    if (marker === 0xda) break; // start of scan: entropy-coded data follows
    pos += len;
  }
  if (!width || !height) throw new JpegError('JPEG has no frame header');
  return { width, height, progressive, comments };
}
