export namespace Wire {
  /**
   * Types that can be serialized through a `postMessage`.
   */
  export type Serializable =
    | bigint
    | boolean
    | number
    | string
    | null
    | undefined
    | RegExp
    | Date
    | Blob
    | File
    | FileList
    | ArrayBuffer
    | ArrayBufferView
    | ImageBitmap
    | ImageData
    | Serializable[]
    | { [name: string]: Serializable }
    | Map<Serializable, Serializable>
    | Set<Serializable>
    | Error
    | Transferable
    | Plain
    | Encoded;

  /**
   * The type of packet.
   */
  export const enum Type {
    PLAIN,
    ENCODED,
  }

  /**
   * Values that do not need any encoding.
   */
  export interface Plain {
    type: Type.PLAIN;
    value: Serializable;
  }

  /**
   * Values that have been encoded with special handling.
   */
  export interface Encoded {
    type: Type.ENCODED;
    codec: string;
    value: Serializable;
  }

  export type Value = Plain | Encoded;
}

/**
 * This interface is used to support custom encoding and decoding of non-POJO values
 * (like, functions, channels, etc.).
 */
export interface Codec<E, S extends Wire.Serializable, D> {
  canHandle(value: unknown): value is E;
  encode(value: E): [S, Transferable[]];
  decode(value: S): D;
}

/**
 * Map of registered codecs.
 */
export const codecs = new Map<
  string,
  Codec<unknown, Wire.Serializable, unknown>
>();

/**
 * Register a new codec, the name is used as discriminant.
 */
export function codec<E, S extends Wire.Serializable, D>(
  name: string,
  codec: Codec<E, S, D>
) {
  codecs.set(name, codec);
  return codec;
}

/**
 * Map of registered transferables.
 */
const transfers = new WeakMap<any, Transferable[]>();

/**
 * Register a set of transferables for a specific value.
 */
export function transfer(value: any, transfer: Transferable[]) {
  transfers.set(value, transfer);
  return value;
}

/**
 * Encode a value.
 */
export function encode(value: any): [Wire.Value, Transferable[]] {
  for (const [name, codec] of codecs) {
    if (codec.canHandle(value)) {
      const [encoded, transfer] = codec.encode(value);
      return [
        { type: Wire.Type.ENCODED, codec: name, value: encoded },
        transfer,
      ];
    }
  }

  return [{ type: Wire.Type.PLAIN, value: value }, transfers.get(value) || []];
}

/**
 * Decode a value.
 */
export function decode(wire: Wire.Value): any {
  switch (wire.type) {
    case Wire.Type.ENCODED:
      return codecs.get(wire.codec)!.decode(wire.value as any);

    case Wire.Type.PLAIN:
      return wire.value;
  }
}
