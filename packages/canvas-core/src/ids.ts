/**
 * Identifiers.
 *
 * All ids are UUIDv7: time-ordered, so Postgres b-tree inserts stay at the right
 * edge of the index and rows sort naturally by creation. Clients mint their own
 * ids (items, operations) so a dropped image gets a stable identity before the
 * server has heard of it, and so a retried operation is idempotent.
 */

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type CanvasId = Branded<string, 'CanvasId'>;
export type ItemId = Branded<string, 'ItemId'>;
export type AssetId = Branded<string, 'AssetId'>;
export type GroupId = Branded<string, 'GroupId'>;
export type ActorId = Branded<string, 'ActorId'>;
export type OperationId = Branded<string, 'OperationId'>;

export const asCanvasId = (v: string): CanvasId => v as CanvasId;
export const asItemId = (v: string): ItemId => v as ItemId;
export const asAssetId = (v: string): AssetId => v as AssetId;
export const asGroupId = (v: string): GroupId => v as GroupId;
export const asActorId = (v: string): ActorId => v as ActorId;
export const asOperationId = (v: string): OperationId => v as OperationId;

const HEX = '0123456789abcdef';

/**
 * UUIDv7 (RFC 9562): 48-bit big-endian millisecond timestamp, then random bits.
 *
 * Uses `crypto.getRandomValues`, which exists in browsers, Node and workers —
 * this module stays free of any environment-specific import.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let ts = Math.trunc(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  // version 7
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  // RFC 9562 variant
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] as number;
    out += HEX[b >> 4];
    out += HEX[b & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

export const newItemId = (): ItemId => asItemId(uuidv7());
export const newGroupId = (): GroupId => asGroupId(uuidv7());
export const newOperationId = (): OperationId => asOperationId(uuidv7());
