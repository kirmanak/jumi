const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;

export const SPAN_KIND_INTERNAL = 1;
export const STATUS_CODE_OK = 1;
export const STATUS_CODE_ERROR = 2;

export type OtlpValue = string | number | boolean;

export interface OtlpSpan {
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId?: Uint8Array;
  name: string;
  kind?: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, OtlpValue>;
  statusCode?: number;
  statusMessage?: string;
}

export interface OtlpResource {
  attributes: Record<string, OtlpValue>;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function varint(value: number | bigint): Uint8Array {
  let n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) n = 0n;
  const bytes: number[] = [];
  while (n > 127n) {
    bytes.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Uint8Array.from(bytes);
}

function tag(field: number, wire: number): Uint8Array {
  return varint((field << 3) | wire);
}

function fieldVarint(field: number, value: number | bigint): Uint8Array {
  return concat([tag(field, WIRE_VARINT), varint(value)]);
}

function fieldLen(field: number, value: Uint8Array): Uint8Array {
  return concat([tag(field, WIRE_LEN), varint(value.byteLength), value]);
}

function fieldFixed64(field: number, value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return concat([tag(field, WIRE_64BIT), bytes]);
}

function encodeString(field: number, value: string): Uint8Array {
  return fieldLen(field, new TextEncoder().encode(value));
}

function encodeAnyValue(value: OtlpValue): Uint8Array {
  if (typeof value === "string") return encodeString(1, value);
  if (typeof value === "boolean") return fieldVarint(2, value ? 1 : 0);
  return fieldVarint(3, Math.trunc(value));
}

function encodeKeyValue(key: string, value: OtlpValue): Uint8Array {
  return concat([encodeString(1, key), fieldLen(2, encodeAnyValue(value))]);
}

function encodeAttributes(attrs: Record<string, OtlpValue>, field: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    chunks.push(fieldLen(field, encodeKeyValue(key, value)));
  }
  return chunks;
}

function encodeStatus(span: OtlpSpan): Uint8Array | undefined {
  if (span.statusCode == null && !span.statusMessage) return undefined;
  const parts: Uint8Array[] = [];
  if (span.statusMessage) parts.push(encodeString(1, span.statusMessage));
  if (span.statusCode != null) parts.push(fieldVarint(2, span.statusCode));
  return fieldLen(15, concat(parts));
}

function encodeSpan(span: OtlpSpan): Uint8Array {
  const parts: Uint8Array[] = [fieldLen(1, span.traceId), fieldLen(2, span.spanId)];
  if (span.parentSpanId && span.parentSpanId.byteLength > 0) parts.push(fieldLen(4, span.parentSpanId));
  parts.push(encodeString(5, span.name));
  parts.push(fieldVarint(6, span.kind ?? SPAN_KIND_INTERNAL));
  parts.push(fieldFixed64(7, span.startTimeUnixNano));
  parts.push(fieldFixed64(8, span.endTimeUnixNano));
  parts.push(...encodeAttributes(span.attributes, 9));
  const status = encodeStatus(span);
  if (status) parts.push(status);
  return concat(parts);
}

export function encodeTracesRequest(resource: OtlpResource, spans: OtlpSpan[], scopeName = "jumi"): Uint8Array {
  const scope = encodeString(1, scopeName);
  const scopeSpansParts: Uint8Array[] = [fieldLen(1, scope)];
  for (const span of spans) scopeSpansParts.push(fieldLen(2, encodeSpan(span)));
  const resourceParts = encodeAttributes(resource.attributes, 1);
  const resourceSpans = concat([fieldLen(1, concat(resourceParts)), fieldLen(2, concat(scopeSpansParts))]);
  return fieldLen(1, resourceSpans);
}
