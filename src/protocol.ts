import devalue from "devalue";

export namespace Wire {
  export const enum Type {
    RAW,
    ENCODED,
  }

  export interface Raw {
    id?: string;
    type: Type.RAW;
    value: string;
  }

  export interface Encoded {
    id?: string;
    type: Type.ENCODED;
    name: string;
    value: unknown;
  }

  export type Value = Raw | Encoded;
}

export interface Codec<T, S> {
  canHandle(value: unknown): value is T;
  encode(value: T): [S, Transferable[]];
  decode(value: S): T;
}

export const codecs = new Map<string, Codec<unknown, unknown>>();
export function codec<T, S>(name: string, codec: Codec<T, S>) {
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
			console.log([name, codec]);
      const [encoded, transfer] = codec.encode(value);
      return [{ type: Wire.Type.ENCODED, name, value: encoded }, transfer];
    }
  }

  return [
    { type: Wire.Type.RAW, value: devalue(value) },
    transfers.get(value) || [],
  ];
}

export function decode(value: Wire.Value): any {
  switch (value.type) {
    case Wire.Type.ENCODED:
      return codecs.get(value.name)!.decode(value.value as any);

    case Wire.Type.RAW:
      return (0, eval)("(" + value.value + ")");
  }
}

codec("FUNCTION", {
  canHandle: (value): value is Function => value instanceof Function,
  encode: (value) => [value, []],
  decode: (value) => value,
});

codec("EVENT", {
  canHandle: (value): value is Event => value instanceof Event,
  encode: (value: Event) => [value, []],
  decode: (value) => (value as unknown) as Event,
});
