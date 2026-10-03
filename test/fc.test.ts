import { describe, expect, it } from 'vitest';
import { FcLink, apiMinor, boardInfo, eraseFlash, getBlackboxConfig, pullDataflash, setBlackboxConfig } from '../src/fc/fc.ts';
import { PROFILES, applyProfile, fieldTable } from '../src/fc/blackbox.ts';
import { HUFFMAN_EOF, defaultHuffmanTree } from '../src/fc/huffman.ts';

function huffmanEncode(data: Uint8Array): Uint8Array {
  const bits: number[] = [];
  const put = (value: number) => {
    const n = defaultHuffmanTree.find((t) => t.value === value)!;
    for (let i = n.codeLen - 1; i >= 0; i--) bits.push((n.code >> i) & 1);
  };
  for (const b of data) put(b);
  put(HUFFMAN_EOF);
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}

/** A pretend flight controller on the other end of a serial port. */
function fakeFc(flash: Uint8Array, opts: { compress: boolean; corruptFirstRead?: boolean }) {
  // Settings state of the pretend FC (API 1.47, 4 kHz PID loop, default blackbox config).
  const state = { bb: Uint8Array.from([1, 1, 1, 1, 2, 0, 2, 0, 0, 0, 0]), log: [] as string[], flashUsed: flash.length };
  let rx = new Uint8Array(0);
  let corrupted = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const reply = (code: number, payload: Uint8Array) => {
    const jumbo = payload.length >= 255;
    const head = jumbo ? [0x24, 0x4d, 0x3e, 255, code, payload.length & 0xff, payload.length >> 8] : [0x24, 0x4d, 0x3e, payload.length, code];
    const frame = new Uint8Array(head.length + payload.length + 1);
    frame.set(head); frame.set(payload, head.length);
    let sum = jumbo ? 255 ^ code ^ (payload.length & 0xff) ^ (payload.length >> 8) : payload.length ^ code;
    for (const b of payload) sum ^= b;
    frame[frame.length - 1] = sum;
    // Deliver in awkward pieces to exercise the stream parser.
    for (let i = 0; i < frame.length; i += 1000) controller.enqueue(frame.slice(i, i + 1000));
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const b = new Uint8Array(rx.length + chunk.length); b.set(rx); b.set(chunk, rx.length); rx = b;
      while (rx.length >= 6 && rx.length >= rx[3] + 6) {
        const len = rx[3], code = rx[4], p = rx.slice(5, 5 + len);
        rx = rx.slice(len + 6);
        const v = new DataView(p.buffer);
        if (code === 1) reply(1, Uint8Array.from([0, 1, 47]));
        else if (code === 4) {
          const t = (x: string) => [x.length, ...[...x].map((c) => c.charCodeAt(0))];
          reply(4, Uint8Array.from([...[...'S411'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...t('TGT'), ...t('WHOOP'), ...t('MFG'), ...new Array(32).fill(0), 0, 0, 8000 & 0xff, 8000 >> 8, 0, 0, 0, 0]));
        } else if (code === 90) reply(90, Uint8Array.from([1, 2, 0, 0, 0, 0, 0, 0]));
        else if (code === 80) reply(80, state.bb);
        else if (code === 81) { state.log.push('set ' + [...p].join(',')); state.bb = Uint8Array.from([1, ...p]); reply(81, new Uint8Array(0)); }
        else if (code === 250) { state.log.push('eeprom'); reply(250, new Uint8Array(0)); }
        else if (code === 72) { state.log.push('erase'); state.flashUsed = 0; reply(72, new Uint8Array(0)); }
        else if (code === 70) {
          const s = new Uint8Array(13); const d = new DataView(s.buffer);
          d.setUint8(0, 3); d.setUint32(5, 16 << 20, true); d.setUint32(9, state.flashUsed, true);
          reply(70, s);
        } else if (code === 71) {
          const addr = v.getUint32(0, true), size = v.getUint16(4, true);
          const raw = flash.subarray(addr, Math.min(flash.length, addr + (opts.compress ? size : size)));
          let body: Uint8Array, comp = 0;
          if (opts.compress) { const h = huffmanEncode(raw); body = new Uint8Array(2 + h.length); new DataView(body.buffer).setUint16(0, raw.length, true); body.set(h, 2); comp = 1; } else body = raw;
          const out = new Uint8Array(7 + body.length); const d = new DataView(out.buffer);
          d.setUint32(0, addr, true); d.setUint16(4, body.length, true); d.setUint8(6, comp); out.set(body, 7);
          if (opts.corruptFirstRead && !corrupted) { // right checksum for the real payload, one flipped byte
            corrupted = true;
            const bad = out.slice(); bad[20] ^= 0xff;
            const frame = new Uint8Array(bad.length + 8); // jumbo header + payload + checksum
            let sum = 255 ^ 71 ^ (out.length & 0xff) ^ (out.length >> 8);
            for (const x of out) sum ^= x;
            frame.set([0x24, 0x4d, 0x3e, 255, 71, out.length & 0xff, out.length >> 8]); frame.set(bad, 7); frame[frame.length - 1] = sum;
            controller.enqueue(frame);
          } else reply(71, out);
        }
      }
    },
  });
  return { readable, writable, open: async () => {}, close: async () => {}, state };
}

async function connectTo(port: unknown): Promise<FcLink> {
  Object.defineProperty(globalThis.navigator, 'serial', { value: { requestPort: async () => port }, configurable: true });
  return FcLink.connect();
}

const flashImage = () => {
  const a = new Uint8Array(10_000);
  for (let i = 0; i < a.length; i++) a[i] = i % 7 === 0 ? 0 : (i * 31) & 0xff;
  return a;
};

describe('flight controller dataflash download', () => {
  for (const compress of [false, true]) {
    it(`pulls the whole flash (${compress ? 'huffman' : 'raw'})`, async () => {
      const flash = flashImage();
      const link = await connectTo(fakeFc(flash, { compress }));
      const progress: number[] = [];
      const got = await pullDataflash(link, (f) => progress.push(f));
      await link.close();
      expect(got).toEqual(flash);
      expect(progress.at(-1)).toBe(1);
    });
  }
  it('survives a corrupt frame by retrying', async () => {
    const flash = flashImage();
    const link = await connectTo(fakeFc(flash, { compress: false, corruptFirstRead: true }));
    const got = await pullDataflash(link, () => {});
    await link.close();
    expect(got).toEqual(flash);
  });
});

describe('blackbox settings over MSP', () => {
  it('reads the config, applies the StickCam profile, persists and verifies', async () => {
    const fc = fakeFc(flashImage(), { compress: false });
    const link = await connectTo(fc);
    const minor = await apiMinor(link);
    expect(minor).toBe(47);
    const info = await boardInfo(link);
    expect(info.pidHz).toBe(4000); // 8 kHz gyro / pid_process_denom 2
    const cur = await getBlackboxConfig(link, minor);
    expect(cur.mask).toBe(0);
    const next = applyProfile(cur, PROFILES[0], fieldTable(minor));
    const back = await setBlackboxConfig(link, next, minor);
    await link.close();
    expect(back.mask).toBe(next.mask);
    expect(back.sampleRate).toBe(4);
    // set first, EEPROM write after it, and the exact wire bytes (mask = everything but RC and gyro off)
    expect(fc.state.log[1]).toBe('eeprom');
    const mask = next.mask!;
    expect(fc.state.log[0]).toBe(`set 1,1,1,4,0,4,${mask & 255},${(mask >> 8) & 255},0,0`);
  });
  it('erases the flash and waits for it to report empty', async () => {
    const fc = fakeFc(flashImage(), { compress: false });
    const link = await connectTo(fc);
    await eraseFlash(link);
    await link.close();
    expect(fc.state.log).toEqual(['erase']);
  });
});
