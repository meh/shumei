export namespace Wire {
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
    | Raw
    | Encoded;

  export const enum Type {
    RAW,
    ENCODED,
  }

  export interface Raw {
    type: Type.RAW;
    value: Serializable;
  }

  export interface Encoded {
    type: Type.ENCODED;
    codec: string;
    value: Serializable;
  }

  export type Value = Raw | Encoded;
}

export interface Codec<E, S extends Wire.Serializable, D> {
  canHandle(value: unknown): value is E;
  encode(value: E): [S, Transferable[]];
  decode(value: S): D;
}

export const codecs = new Map<
  string,
  Codec<unknown, Wire.Serializable, unknown>
>();

export function codec<E, S extends Wire.Serializable, D>(
  name: string,
  codec: Codec<E, S, D>
) {
  codecs.set(name, codec);
  return codec;
}

const transfers = new WeakMap<any, Transferable[]>();
export function transfer(value: any, transfer: Transferable[]) {
  transfers.set(value, transfer);
  return value;
}

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

  return [{ type: Wire.Type.RAW, value: value }, transfers.get(value) || []];
}

export function decode(wire: Wire.Value): any {
  switch (wire.type) {
    case Wire.Type.ENCODED:
      return codecs.get(wire.codec)!.decode(wire.value as any);

    case Wire.Type.RAW:
      return wire.value;
  }
}
