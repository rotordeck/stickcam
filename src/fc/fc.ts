// Read the onboard blackbox flash straight off a Betaflight flight controller over WebSerial.
// A minimal MSP v1 client plus the dataflash pull loop from betaflight-configurator
// (`MSPHelper.dataflashRead`, `useDataflashPull.js`). Only what a download needs: no config, no telemetry.

import { decodeConfig, encodeConfig, type BbConfig } from './blackbox.ts';
import { defaultHuffmanLenIndex, defaultHuffmanTree, huffmanDecodeBuf } from './huffman.ts';

const MSP_API_VERSION = 1;
const MSP_BOARD_INFO = 4;
const MSP_ADVANCED_CONFIG = 90;
const MSP_DATAFLASH_SUMMARY = 70;
const MSP_DATAFLASH_READ = 71;
const MSP_DATAFLASH_ERASE = 72;
const MSP_BLACKBOX_CONFIG = 80;
const MSP_SET_BLACKBOX_CONFIG = 81;
const MSP_EEPROM_WRITE = 250;

const BLOCK_SIZE = 4096;
const MAX_RETRIES = 5;

// Minimal Web Serial typings (not in lib.dom).
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(o?: { filters?: { usbVendorId: number }[] }): Promise<SerialPortLike>;
}
const serial = (): SerialLike | undefined => (navigator as unknown as { serial?: SerialLike }).serial;

/** Vendor ids of the USB-serial bridges flight controllers use (same list as the configurator). */
const FC_VENDORS = [1027, 1155, 4292, 10473, 11836, 12619, 11914, 6790, 14743];

export const fcSupported = () => !!serial();

export class FcError extends Error {
  retryable: boolean;
  constructor(msg: string, retryable = false) { super(msg); this.name = 'FcError'; this.retryable = retryable; }
}

interface Pending { code: number; resolve(d: Uint8Array): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

export class FcLink {
  private port: SerialPortLike;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(port: SerialPortLike) {
    this.port = port;
    this.writer = port.writable!.getWriter();
    this.reader = port.readable!.getReader();
    void this.pump();
  }

  /** Ask the user for a serial port (must be called from a click) and open it. */
  static async connect(): Promise<FcLink> {
    const s = serial();
    if (!s) throw new FcError('This browser has no Web Serial support. Use Chrome, Edge or Opera.');
    let port: SerialPortLike;
    try {
      port = await s.requestPort({ filters: FC_VENDORS.map((usbVendorId) => ({ usbVendorId })) });
    } catch {
      throw new FcError('No flight controller selected.');
    }
    try {
      await port.open({ baudRate: 115200 });
    } catch (e) {
      throw new FcError(`Could not open the port (is Betaflight Configurator or another tab using it?): ${(e as Error).message}`);
    }
    return new FcLink(port);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new FcError('Disconnected'));
    try { await this.reader.cancel(); } catch { /* already gone */ }
    try { this.reader.releaseLock(); this.writer.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }

  /** One MSP v1 request/response. Requests are serialised. */
  request(code: number, payload: ArrayLike<number> = [], timeoutMs = 2000): Promise<Uint8Array> {
    const run = () => new Promise<Uint8Array>((resolve, reject) => {
      if (this.closed) return reject(new FcError('Disconnected'));
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new FcError(`No answer from the flight controller (MSP ${code})`, true));
      }, timeoutMs);
      this.pending = { code, resolve, reject, timer };
      this.writer.write(encode(code, payload)).catch((e) => this.fail(new FcError(`Write failed: ${(e as Error).message}`)));
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private fail(e: Error) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(e);
  }

  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.feed(value);
      }
    } catch (e) {
      this.fail(new FcError(`Connection lost: ${(e as Error).message}`));
    }
    if (!this.closed) { this.closed = true; this.fail(new FcError('Flight controller disconnected')); }
  }

  private feed(chunk: Uint8Array) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length);
    this.buf = b;
    for (;;) {
      // Frame: '$' 'M' ('>' ok | '!' error) len code payload checksum; len 255 = jumbo (u16 length follows the code).
      let s = 0;
      while (s + 1 < this.buf.length && !(this.buf[s] === 0x24 && this.buf[s + 1] === 0x4d)) s++;
      if (s > 0) this.buf = this.buf.subarray(s);
      const b = this.buf;
      if (b.length < 5) return;
      const dir = b[2];
      let len = b[3];
      const code = b[4];
      let head = 5;
      if (len === 255) {
        if (b.length < 7) return;
        len = b[5] | (b[6] << 8);
        head = 7;
      }
      if (b.length < head + len + 1) return;
      let sum = b[3] ^ code;
      if (b[3] === 255) sum ^= b[5] ^ b[6];
      for (let i = 0; i < len; i++) sum ^= b[head + i];
      const ok = sum === b[head + len] && (dir === 0x3e || dir === 0x21);
      const payload = b.slice(head, head + len);
      this.buf = b.subarray(head + len + 1);
      const p = this.pending;
      if (!p || p.code !== code) continue; // stray frame
      this.pending = null;
      clearTimeout(p.timer);
      if (!ok) p.reject(new FcError('Corrupt MSP frame', true));
      else if (dir === 0x21) p.reject(new FcError(`The flight controller rejected MSP ${code}`));
      else p.resolve(payload);
    }
  }
}

function encode(code: number, data: ArrayLike<number>): Uint8Array {
  const n = data.length;
  const out = new Uint8Array(n + 6);
  out.set([0x24, 0x4d, 0x3c, n, code]);
  let sum = n ^ code;
  for (let i = 0; i < n; i++) { out[5 + i] = data[i]; sum ^= data[i]; }
  out[5 + n] = sum;
  return out;
}

export interface FlashSummary { ready: boolean; supported: boolean; total: number; used: number }

export async function flashSummary(link: FcLink): Promise<FlashSummary> {
  const d = await link.request(MSP_DATAFLASH_SUMMARY);
  if (d.length < 13) return { ready: false, supported: false, total: 0, used: 0 };
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const flags = v.getUint8(0);
  return { ready: !!(flags & 1), supported: !!(flags & 2), total: v.getUint32(5, true), used: v.getUint32(9, true) };
}

/** Read one block. Returns the (decompressed) bytes; empty means end of log. */
async function readBlock(link: FcLink, address: number): Promise<Uint8Array> {
  const req = [address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff, (address >>> 24) & 0xff, BLOCK_SIZE & 0xff, BLOCK_SIZE >> 8, 1];
  const d = await link.request(MSP_DATAFLASH_READ, req, 3000);
  if (d.length < 7) throw new FcError('Short dataflash reply', true);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (v.getUint32(0, true) !== address) throw new FcError('Dataflash address mismatch', true);
  const size = v.getUint16(4, true);
  const comp = v.getUint8(6);
  if (comp === 0) return d.subarray(7, 7 + size);
  if (comp === 1) {
    const chars = v.getUint16(7, true);
    return huffmanDecodeBuf(d.subarray(9, 7 + size), chars, defaultHuffmanTree, defaultHuffmanLenIndex);
  }
  throw new FcError(`Unknown dataflash compression type ${comp}`);
}

/** Download the whole onboard flash log. `onProgress` gets 0..1. */
export async function pullDataflash(link: FcLink, onProgress: (frac: number, bytes: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  let sum = await flashSummary(link);
  for (let i = 0; i < 10 && sum.supported && !sum.ready; i++) { // flash may still be warming up
    await new Promise((r) => setTimeout(r, 300));
    sum = await flashSummary(link);
  }
  if (!sum.supported) {
    throw new FcError('This flight controller has no onboard flash. If it logs to an SD card, take the card out and drop the .bbl here.');
  }
  if (sum.used <= 0) throw new FcError('The flight controller has no blackbox data. Arm and fly (or hop around) with logging enabled first.');

  const out = new Uint8Array(sum.used);
  let addr = 0;
  let fails = 0;
  while (addr < sum.used) {
    if (signal?.aborted) throw new FcError('Cancelled');
    let chunk: Uint8Array;
    try {
      chunk = await readBlock(link, addr);
    } catch (e) {
      if (e instanceof FcError && e.retryable && ++fails <= MAX_RETRIES) continue;
      throw e;
    }
    fails = 0;
    if (chunk.length === 0) break;
    const n = Math.min(chunk.length, sum.used - addr);
    out.set(chunk.subarray(0, n), addr);
    addr += n;
    onProgress(addr / sum.used, addr);
  }
  return out.subarray(0, addr);
}

// ---------- blackbox settings ----------

/** Minor of the MSP API version (1.<minor>). Throws if it isn't a Betaflight-style 1.x API. */
export async function apiMinor(link: FcLink): Promise<number> {
  const d = await link.request(MSP_API_VERSION);
  if (d.length < 3 || d[1] !== 1) throw new FcError('Unexpected MSP API version: is this a Betaflight flight controller?');
  return d[2];
}

export interface BoardInfo { name: string; pidHz: number }

/** Board name and the PID loop rate (gyro rate / pid_process_denom), 0 if it can't be worked out. */
export async function boardInfo(link: FcLink): Promise<BoardInfo> {
  let name = '', gyroHz = 0, denom = 0;
  try {
    const d = await link.request(MSP_BOARD_INFO);
    let o = 4 + 2 + 1 + 1; // identifier, hardware revision, board type, capabilities
    const text = () => { const n = d[o++]; const t = String.fromCharCode(...d.subarray(o, o + n)); o += n; return t; };
    text(); // target name
    name = text();
    text(); // manufacturer
    o += 32 + 1 + 1; // signature, mcu type, configuration state
    gyroHz = d[o] | (d[o + 1] << 8);
  } catch { /* older firmware: no sample rate */ }
  try {
    const a = await link.request(MSP_ADVANCED_CONFIG);
    denom = a[1];
  } catch { /* leave 0 */ }
  return { name, pidHz: gyroHz && denom ? gyroHz / denom : 0 };
}

export async function getBlackboxConfig(link: FcLink, minor: number): Promise<BbConfig> {
  return decodeConfig(await link.request(MSP_BLACKBOX_CONFIG), minor);
}

/** Write the blackbox config, persist it, then read it back and check it stuck. */
export async function setBlackboxConfig(link: FcLink, cfg: BbConfig, minor: number): Promise<BbConfig> {
  await link.request(MSP_SET_BLACKBOX_CONFIG, encodeConfig(cfg, minor));
  await link.request(MSP_EEPROM_WRITE, [], 5000);
  const back = await getBlackboxConfig(link, minor);
  if (back.sampleRate !== cfg.sampleRate || back.device !== cfg.device || (cfg.mask !== null && back.mask !== cfg.mask)) {
    throw new FcError('The flight controller did not keep the new settings. Try again, or paste the CLI commands into Betaflight Configurator.');
  }
  return back;
}

const isTimeout = (e: unknown) => e instanceof FcError && e.retryable;

/**
 * Erase the onboard flash and wait until it reports empty. Some flash chips stop the FC from answering MSP
 * while they erase (configurator: `useDataflashErase.ts`), so a missing reply, to the erase or to a summary
 * poll, means "still busy" until the overall deadline. A full 16 MB chip erase takes tens of seconds.
 */
export async function eraseFlash(link: FcLink, onWait?: (elapsedMs: number) => void, deadlineMs = 180_000, replyMs = 60_000, pollMs = 500): Promise<void> {
  const t0 = Date.now();
  try {
    await link.request(MSP_DATAFLASH_ERASE, [], replyMs);
  } catch (e) {
    if (!isTimeout(e)) throw e;
  }
  while (Date.now() - t0 < deadlineMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    onWait?.(Date.now() - t0);
    let s: FlashSummary;
    try {
      s = await flashSummary(link);
    } catch (e) {
      if (isTimeout(e)) continue;
      throw e;
    }
    if (s.ready && s.used === 0) return;
  }
  throw new FcError('Erasing is taking too long. Check the flash in Betaflight Configurator (Blackbox tab).');
}
