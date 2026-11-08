import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

let tmpCounter = 0;
const chains = new Map<string, Promise<unknown>>();

// Writes a file atomically (temp file, then rename). Writes to the same path
// are serialised, so two quick updates can never interleave or share a temp file.
export function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  });
  chains.set(file, next);
  void next.finally(() => { if (chains.get(file) === next) chains.delete(file); }).catch(() => {});
  return next;
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
