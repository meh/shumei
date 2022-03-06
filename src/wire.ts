import * as _ from 'lodash'

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
	| Transferable

/**
 * The type of packet.
 */
export const enum Type {
	PLAIN,
	ENCODED,
}

const MARKER = Symbol('shumei.wire')

/**
 * Values that do not need any encoding.
 */
export type Plain = {
	[MARKER]: Transferable[]
	type: Type.PLAIN
	value: Clonable
}

/**
 * Values that have been encoded with special handling.
 */
export type Encoded = {
	[MARKER]: Transferable[]
	type: Type.ENCODED
	codec: string
	value: Clonable
}

export type Value = Plain | Encoded

export interface Options {
	codecs?: Record<string, UnknownCodec>
}

/**
 * This interface is used to support custom encoding and decoding of non-POJO values
 * (like, functions, channels, etc.).
 */
export interface Codec<E, S extends Clonable, D> {
	name: string
	canHandle(value: unknown): value is E
	encode(value: E, wire: Wire): [S, Transferable[]]
	decode(value: S, wire: Wire): D
}

export type UnknownCodec = Codec<unknown, Clonable, unknown>

export const codecs: Map<string, UnknownCodec> = new Map()

/**
 * Register a new codec, the name is used as discriminant.
 */
export function codec<E, C extends Clonable, D>(codec: Codec<E, C, D>): Codec<E, C, D> {
	codecs.set(codec.name, codec)
	return codec
}

export function isEncoded(value: any): value is Value {
	return _.isObject(value) && !!value[MARKER]
}

export interface Wired {
	wire?: Wire
}

export function live(): Wire {
	return Wire.live()
}

export function transfer(value: any, transfer: Transferable[]) {
	return live().transfer(value, transfer)
}

export function transferable(value: any): Transferable[] {
	return live().transferable(value)
}

export function encode(value: any): Value {
	return live().encode(value)
}

export function decode(value: Value): any {
	return live().decode(value)
}

export class Wire {
	private codecs: Map<string, Codec<unknown, Clonable, unknown>>
	private transfers: WeakMap<any, Transferable[]>

	static live(): Wire {
		if (!globalThis[MARKER]) {
			globalThis[MARKER] = new Wire()
		}

		return globalThis[MARKER]
	}

	constructor(public options?: Options) {
		this.codecs = new Map(codecs)
		this.transfers = new WeakMap()
	}

	codec<E, C extends Clonable, D>(codec: Codec<E, C, D>): Codec<E, C, D> {
		this.codecs.set(codec.name, codec)
		return codec
	}

	codecFor<E, C extends Clonable, D>(value: string | any): Codec<E, C, D> | null {
		if (_.isString(value)) {
			return this.codecs.get(value) as Codec<E, C, D>
		}

		for (const codec of this.codecs.values()) {
			if (codec.canHandle(value)) {
				return codec as Codec<E, C, D>
			}
		}

		return null
	}

	/**
	 * Register a set of transferables for a specific value.
	 */
	transfer(value: any, transfer: Transferable[]) {
		this.transfers.set(value, transfer)
		return value
	}

	/**
	 * Get any transferables for the given value.
	 */
	transferable(value: any): Transferable[] {
		const transfer = this.transfers.get(value) || []

		if (isEncoded(value)) {
			transfer.push(...value[MARKER])
		}

		return transfer
	}

	/**
	 * Encode a value.
	 */
	encode(value: any): Value {
		if (isEncoded(value)) {
			return value
		}

		if (_.isObject(value)) {
			const codec = this.codecFor(value)

			if (codec) {
				const [encoded, transfer] = codec.encode(value, this)

				return {
					[MARKER]: transfer,
					type: Type.ENCODED,
					codec: codec.name,
					value: encoded,
				}
			}
		}

		let encoding = value
		const transfer = this.transferable(value)

		if (_.isObject(value)) {
			encoding = {}

			for (const [k, v] of Object.entries(value)) {
				const encoded = this.encode(v)
				encoding[k] = encoded
				transfer.push(...encoded[MARKER])
			}
		} else if (_.isArray(value)) {
			encoding = []

			for (const v of value) {
				const encoded = this.encode(v)
				encoding.push(encoded)
				transfer.push(...encoded[MARKER])
			}
		}

		return { [MARKER]: transfer, type: Type.PLAIN, value: encoding }
	}

	/**
	 * Decode a value.
	 */
	decode(wire: Value): any {
		switch (wire.type) {
			case Type.ENCODED:
				return this.codecFor(wire.codec)!.decode(wire.value as any, this)

			case Type.PLAIN:
				let decoding = wire.value

				if (_.isObject(wire.value)) {
					decoding = {}

					for (const [k, v] of Object.entries(wire.value)) {
						decoding[k] = this.decode(v)
					}
				} else if (_.isArray(wire.value)) {
					decoding = []

					for (const v of wire.value) {
						decoding.push(this.decode(v))
					}
				}

				return decoding
		}
	}
}
