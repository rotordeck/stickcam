export interface ByteRange { start: number; end: number }

export interface BblHeader {
  raw: Record<string, string>;
  firmware: string;
  craft: string;
  looptime: number;
  minthrottle: number;
  maxthrottle: number;
  motorOutput: [number, number];
  gyroScale: number;
  motorPoles: number;
  acc1G: number;
  [k: string]: unknown;
}

export interface DecodeOpts { gaps?: number[]; referenceLines?: string[] | null }

export interface FlightInfo { range: ByteRange; header: BblHeader; size: number; opts: DecodeOpts }

export interface BblEvent { type: number; time?: number; flags?: number; lastFlags?: number; reason?: number; [k: string]: unknown }

export interface DecodedFlight {
  header: BblHeader;
  fields: string[];
  n: number;
  cols: Record<string, Float64Array>;
  events: BblEvent[];
  stats: Record<string, unknown>;
  quality: Uint8Array;
  slow: { names: string[]; frames: { n: number; values: number[] }[] } | null;
  gps: unknown;
  byteRange: ByteRange;
}

export const EVENT: Record<string, number>;
export function repairLegacyDump(bytes: Uint8Array): { bytes: Uint8Array; repaired: boolean; gaps: number[]; lostBytes?: number };
export function readHeader(bytes: Uint8Array, range: ByteRange, opts?: DecodeOpts): { header: BblHeader; dataStart: number; lines: string[] };
export function listFlights(bytes: Uint8Array, opts?: { gaps?: number[] }): FlightInfo[];
export function decodeFlight(bytes: Uint8Array, range: ByteRange, opts?: DecodeOpts): DecodedFlight;
