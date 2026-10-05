import { createGunzip, type Gunzip } from 'node:zlib';

/**
 * Bounded streaming reader for the MPSV `volna-mista` snapshot (`{ "polozky": [ {...}, ... ] }`).
 *
 * The full current snapshot is ~17 MB gzip-compressed and ~185 MB decoded (checked 2026-10-05), so
 * it must never be buffered or handed to `JSON.parse` in one piece. This reader keeps only the
 * object currently being assembled: chunks are decoded as UTF-8 incrementally, a small state
 * machine tracks string/escape/depth state, and each completed `polozky[]` entry is parsed on its
 * own and handed to `onRecord`. Peak memory is one record (capped at `maxRecordChars`), regardless
 * of snapshot size.
 *
 * Transport note (verified live): `data.mpsv.cz` serves `volna-mista.json.gz` with
 * `Content-Encoding: gzip`, so a standards-compliant `fetch` already hands this reader decoded JSON
 * bytes. A transport that does not decode (or a raw `.gz` fixture) delivers the gzip stream
 * itself, so the first two bytes are sniffed: `1f 8b` routes the bytes through an incremental
 * `zlib` gunzip first, anything else is treated as plain JSON. A corrupt or truncated archive
 * fails with a fixed message that never echoes payload text.
 *
 * Error messages in this module are deliberately fixed strings. `JSON.parse` messages can quote
 * the offending text, and the payload carries personal contact fields, so no error ever includes
 * record content.
 */
export class MpsvSnapshotError extends Error {
  public readonly kind: 'drift' | 'corrupt' | 'truncated' | 'limit';

  public constructor(kind: MpsvSnapshotError['kind'], message: string) {
    super(message);
    this.name = 'MpsvSnapshotError';
    this.kind = kind;
  }
}

/** Thrown by `onRecord` consumers to stop reading early (a capped parse); not a failure. */
export class MpsvScanLimitReached extends Error {
  public constructor() {
    super('scan limit reached');
    this.name = 'MpsvScanLimitReached';
  }
}

export type MpsvSnapshotParserOptions = {
  /** Receives one parsed `polozky[]` entry. Must be synchronous. */
  onRecord: (record: unknown) => void;
  /** Largest single entry accepted, in UTF-16 code units. */
  maxRecordChars?: number;
  /** Largest decoded body accepted, in UTF-16 code units. */
  maxDecodedChars?: number;
};

const DEFAULT_MAX_RECORD_CHARS = 2 * 1024 * 1024;
const DEFAULT_MAX_DECODED_CHARS = 1_500_000_000;
const ITEMS_KEY = 'polozky';

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

class JsonRecordSplitter {
  readonly #onRecord: (record: unknown) => void;
  readonly #maxRecordChars: number;
  readonly #maxDecodedChars: number;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #decodedChars = 0;
  #depth = 0;
  #inString = false;
  #escape = false;
  #expectKey = false;
  #collectingKey = false;
  #keyBuffer = '';
  #topKey = '';
  #sawRoot = false;
  #inItems = false;
  #itemsClosed = false;
  #rootClosed = false;
  #recording = false;
  #recordParts: string[] = [];
  #recordChars = 0;
  recordCount = 0;

  public constructor(options: Required<MpsvSnapshotParserOptions>) {
    this.#onRecord = options.onRecord;
    this.#maxRecordChars = options.maxRecordChars;
    this.#maxDecodedChars = options.maxDecodedChars;
  }

  public write(bytes: Uint8Array): void {
    let text: string;
    try {
      text = this.#decoder.decode(bytes, { stream: true });
    } catch {
      throw new MpsvSnapshotError('drift', 'snapshot is not valid UTF-8');
    }
    this.#scan(text);
  }

  public finish(): number {
    try {
      this.#scan(this.#decoder.decode());
    } catch (error) {
      if (error instanceof MpsvSnapshotError) throw error;
      throw new MpsvSnapshotError('drift', 'snapshot is not valid UTF-8');
    }
    if (!this.#sawRoot) {
      throw new MpsvSnapshotError('truncated', 'snapshot is empty or not a JSON object');
    }
    if (!this.#rootClosed || !this.#itemsClosed) {
      throw new MpsvSnapshotError('truncated', 'snapshot ended before the document was complete');
    }
    return this.recordCount;
  }

  #scan(text: string): void {
    this.#decodedChars += text.length;
    if (this.#decodedChars > this.#maxDecodedChars) {
      throw new MpsvSnapshotError('limit', 'snapshot exceeds the decoded size limit');
    }
    let sliceStart = this.#recording ? 0 : -1;
    for (let index = 0; index < text.length; index += 1) {
      const char = text.charCodeAt(index);
      if (this.#inString) {
        if (this.#escape) {
          this.#escape = false;
        } else if (char === 0x5c) {
          this.#escape = true;
        } else if (char === 0x22) {
          this.#inString = false;
          if (this.#collectingKey) {
            this.#collectingKey = false;
            this.#topKey = this.#keyBuffer;
            if (this.#topKey !== ITEMS_KEY) {
              throw new MpsvSnapshotError('drift', 'snapshot has an unexpected top-level key');
            }
          }
        } else if (this.#collectingKey) {
          this.#keyBuffer += text[index];
          if (this.#keyBuffer.length > 64) {
            throw new MpsvSnapshotError('drift', 'snapshot has an unexpected top-level key');
          }
        }
        continue;
      }
      if (this.#rootClosed) {
        if (!isWhitespace(char)) {
          throw new MpsvSnapshotError('drift', 'snapshot has content after the root object');
        }
        continue;
      }
      if (!this.#sawRoot) {
        if (isWhitespace(char) || char === 0xfeff) continue;
        if (char !== 0x7b) throw new MpsvSnapshotError('drift', 'snapshot is not a JSON object');
        this.#sawRoot = true;
        this.#depth = 1;
        this.#expectKey = true;
        continue;
      }
      switch (char) {
        case 0x22: // "
          if (this.#depth === 2 && this.#inItems && !this.#recording) {
            throw new MpsvSnapshotError('drift', 'polozky entries must be objects');
          }
          this.#inString = true;
          if (this.#depth === 1 && this.#expectKey) {
            this.#collectingKey = true;
            this.#keyBuffer = '';
          } else if (this.#depth === 1) {
            throw new MpsvSnapshotError('drift', 'snapshot has an unexpected top-level value');
          }
          break;
        case 0x7b: // {
          if (this.#depth === 1) {
            throw new MpsvSnapshotError('drift', 'snapshot has an unexpected top-level value');
          }
          if (this.#depth === 2 && this.#inItems && !this.#recording) {
            this.#recording = true;
            this.#recordParts = [];
            this.#recordChars = 0;
            sliceStart = index;
          }
          this.#depth += 1;
          break;
        case 0x5b: // [
          if (this.#depth === 1) {
            if (this.#topKey !== ITEMS_KEY || this.#inItems || this.#itemsClosed) {
              throw new MpsvSnapshotError('drift', 'snapshot has an unexpected top-level value');
            }
            this.#inItems = true;
          } else if (this.#depth === 2 && this.#inItems && !this.#recording) {
            throw new MpsvSnapshotError('drift', 'polozky entries must be objects');
          }
          this.#depth += 1;
          break;
        case 0x7d: // }
          this.#depth -= 1;
          if (this.#recording && this.#depth === 2) {
            this.#recordParts.push(text.slice(sliceStart, index + 1));
            sliceStart = -1;
            this.#recording = false;
            this.#completeRecord();
          } else if (this.#depth === 0) {
            this.#rootClosed = true;
          } else if (this.#depth < 0) {
            throw new MpsvSnapshotError('drift', 'snapshot structure is malformed');
          }
          break;
        case 0x5d: // ]
          this.#depth -= 1;
          if (this.#depth === 1 && this.#inItems) {
            this.#inItems = false;
            this.#itemsClosed = true;
          } else if (this.#depth < 1) {
            throw new MpsvSnapshotError('drift', 'snapshot structure is malformed');
          }
          break;
        case 0x2c: // ,
          if (this.#depth === 1) this.#expectKey = true;
          break;
        case 0x3a: // :
          if (this.#depth === 1) this.#expectKey = false;
          break;
        default:
          if (this.#depth === 1 && !isWhitespace(char)) {
            throw new MpsvSnapshotError('drift', 'snapshot has an unexpected top-level value');
          }
          if (this.#depth === 2 && this.#inItems && !this.#recording && !isWhitespace(char)) {
            throw new MpsvSnapshotError('drift', 'polozky entries must be objects');
          }
      }
    }
    if (this.#recording && sliceStart >= 0) {
      const part = text.slice(sliceStart);
      this.#recordChars += part.length;
      this.#recordParts.push(part);
      if (this.#recordChars > this.#maxRecordChars) {
        throw new MpsvSnapshotError('limit', 'a snapshot entry exceeds the record size limit');
      }
    }
  }

  #completeRecord(): void {
    const text = this.#recordParts.join('');
    this.#recordParts = [];
    this.#recordChars = 0;
    if (text.length > this.#maxRecordChars) {
      throw new MpsvSnapshotError('limit', 'a snapshot entry exceeds the record size limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new MpsvSnapshotError('drift', 'a snapshot entry is not valid JSON');
    }
    this.recordCount += 1;
    this.#onRecord(parsed);
  }
}

/**
 * Synchronous `write(chunk)` entry point (what `SafeHttpClient.streamGet`'s `onChunk` requires)
 * plus an awaited `finish()` that settles any pending gunzip work and verifies the document was
 * complete.
 */
export class MpsvSnapshotParser {
  readonly #splitter: JsonRecordSplitter;
  #mode: 'sniff' | 'json' | 'gzip' = 'sniff';
  #head: Uint8Array = new Uint8Array(0);
  #gunzip: Gunzip | null = null;
  #failure: unknown = null;
  #gzipDone: Promise<void> | null = null;

  public constructor(options: MpsvSnapshotParserOptions) {
    this.#splitter = new JsonRecordSplitter({
      onRecord: options.onRecord,
      maxRecordChars: options.maxRecordChars ?? DEFAULT_MAX_RECORD_CHARS,
      maxDecodedChars: options.maxDecodedChars ?? DEFAULT_MAX_DECODED_CHARS,
    });
  }

  public write(chunk: Uint8Array): void {
    this.#throwIfFailed();
    if (chunk.byteLength === 0) return;
    if (this.#mode === 'sniff') {
      const merged = new Uint8Array(this.#head.byteLength + chunk.byteLength);
      merged.set(this.#head, 0);
      merged.set(chunk, this.#head.byteLength);
      if (merged.byteLength < 2) {
        this.#head = merged;
        return;
      }
      this.#head = new Uint8Array(0);
      if (merged[0] === 0x1f && merged[1] === 0x8b) {
        this.#startGzip();
        this.#mode = 'gzip';
      } else {
        this.#mode = 'json';
      }
      this.#route(merged);
      return;
    }
    this.#route(chunk);
  }

  public async finish(): Promise<number> {
    this.#throwIfFailed();
    if (this.#mode === 'sniff') {
      if (this.#head.byteLength > 0) this.#splitter.write(this.#head);
      return this.#splitter.finish();
    }
    if (this.#mode === 'gzip') {
      this.#gunzip?.end();
      await this.#gzipDone;
      this.#throwIfFailed();
    }
    return this.#splitter.finish();
  }

  /** Releases any gunzip resources after a failure or an intentionally abandoned read. */
  public dispose(): void {
    this.#gunzip?.destroy();
    this.#gunzip = null;
  }

  #route(bytes: Uint8Array): void {
    if (this.#mode === 'gzip') {
      // Backpressure is not available here: `SafeHttpClient.streamGet` requires a synchronous
      // `onChunk` and cannot be paused, so a `false` return from `write` cannot stop the download.
      // Memory is instead bounded by `maxResponseBytes` on the compressed transfer (the gzip path
      // only runs for a transport that does not decode; `fetch` normally hands over decoded JSON),
      // and the decoded side by `maxDecodedChars` plus the per-record cap.
      this.#gunzip?.write(bytes);
    } else {
      this.#splitter.write(bytes);
    }
  }

  #startGzip(): void {
    const gunzip = createGunzip();
    this.#gunzip = gunzip;
    this.#gzipDone = new Promise<void>((resolve) => {
      gunzip.on('data', (buffer: Buffer) => {
        if (this.#failure !== null) return;
        try {
          this.#splitter.write(buffer);
        } catch (error) {
          this.#failure = error;
          gunzip.destroy();
        }
      });
      gunzip.on('error', () => {
        this.#failure ??= new MpsvSnapshotError(
          'corrupt',
          'gzip archive is corrupt or was truncated',
        );
        resolve();
      });
      gunzip.on('end', resolve);
      gunzip.on('close', resolve);
    });
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) {
      this.dispose();
      throw this.#failure;
    }
  }
}
