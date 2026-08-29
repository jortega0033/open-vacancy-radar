import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CV_FILE_EXTENSIONS, isSupportedCvFile, MAX_CV_FILE_BYTES, readCvFile } from '../electron/cv-text.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cv-text-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, contents: string | Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

describe('readCvFile', () => {
  it('reads .txt and .md as UTF-8 and normalizes the whitespace', async () => {
    const path = await write('cv.md', '# Jake\r\n\r\n\r\n\r\n-   Angular    architect  \r\n');
    await expect(readCvFile(path)).resolves.toEqual({
      fileName: 'cv.md',
      text: '# Jake\n\n- Angular architect',
    });
  });

  it('rejects an unsupported extension even though the dialog filtered for it', async () => {
    const path = await write('cv.docx', 'not really a docx');
    await expect(readCvFile(path)).rejects.toThrow(/unsupported CV file type "\.docx"/);
    expect(isSupportedCvFile(path)).toBe(false);
    expect(isSupportedCvFile('/somewhere/CV.PDF')).toBe(true); // extension check is case-insensitive
  });

  it('rejects an empty file with a message that says which file', async () => {
    const path = await write('blank.txt', '   \n\n  ');
    await expect(readCvFile(path)).rejects.toThrow(/"blank\.txt" is empty/);
  });

  it('refuses a file above the size bound instead of handing it to the parser', async () => {
    const path = await write('huge.txt', Buffer.alloc(MAX_CV_FILE_BYTES + 1, 0x61));
    await expect(readCvFile(path)).rejects.toThrow(/limited to 10 MB/);
  });

  it('advertises exactly the extensions the dialog filter offers', () => {
    expect([...CV_FILE_EXTENSIONS]).toEqual(['pdf', 'txt', 'md']);
  });
});
