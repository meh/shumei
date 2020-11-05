/**
 * Types that can be serialized through a `postMessage`.
 */
export type Clonable =
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
	| Clonable[]
	| { [name: string]: Clonable }
	| Map<Clonable, Clonable>
	| Set<Clonable>
	| Error
	| Transferable;

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
export type Plain = {
	type: Type.PLAIN;
	value: Clonable;
};

/**
 * Values that have been encoded with special handling.
 */
export type Encoded = {
	type: Type.ENCODED;
	codec: string;
	value: Clonable;
};

export type Value = Plain | Encoded;

/**
 * This interface is used to support custom encoding and decoding of non-POJO values
 * (like, functions, channels, etc.).
 */
export interface Codec<E, S extends Clonable, D> {
	canHandle(value: unknown): value is E;
	encode(value: E): [S, Transferable[]];
	decode(value: S): D;
}

/**
 * Map of registered codecs.
 */
export const codecs = new Map<string, Codec<unknown, Clonable, unknown>>();

/**
 * Register a new codec, the name is used as discriminant.
 */
export function codec<E, C extends Clonable, D>(
	name: string,
	codec: Codec<E, C, D>
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
export function encode(value: any): [Value, Transferable[]] {
	for (const [name, codec] of codecs) {
		if (codec.canHandle(value)) {
			const [encoded, transfer] = codec.encode(value);
			return [{ type: Type.ENCODED, codec: name, value: encoded }, transfer];
		}
	}

	return [{ type: Type.PLAIN, value: value }, transfers.get(value) || []];
}

/**
 * Decode a value.
 */
export function decode(wire: Value): any {
	switch (wire.type) {
		case Type.ENCODED:
			return codecs.get(wire.codec)!.decode(wire.value as any);

		case Type.PLAIN:
			return wire.value;
	}
}
