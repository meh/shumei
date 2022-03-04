import { v4 as uuid } from 'uuid'
import * as _ from 'lodash'
import * as wire from './wire'
import { Sender, Receiver, Channel, pair as mkChannelPair } from './channel'
import { Mailbox, Receiver as MailboxReceiver } from './mailbox'
import { Deferred } from 'queueable'

/**
 * Messages for the remote value protocol.
 */
export namespace Message {
	export type ID = string

	export const enum Type {
		CONSTRUCT = 0x20,
		APPLY,
		GET,
		SET,
		DELETE,
	}

	/**
	 * Equivalent of `Proxy.construct`.
	 */
	export namespace Construct {
		export type Request = {
			id: ID
			seq: ID
			type: Type.CONSTRUCT
			arguments: any
		}

		export type Response = {
			id: ID
			seq: ID
			type: Type.CONSTRUCT
			value: wire.Value
		}
	}

	/**
	 * Equivalent of `Proxy.apply`.
	 */
	export namespace Apply {
		export type Request = {
			id: ID
			seq: ID
			type: Type.APPLY
			arguments: any
		}

		export type Response = {
			id: ID
			seq: ID
			type: Type.APPLY
			value: wire.Value
		}
	}

	/**
	 * Equivalent of `Proxy.get`.
	 */
	export namespace Get {
		export type Request = {
			id: ID
			seq: ID
			type: Type.GET
			prop: PropertyKey
		}

		export type Response = {
			id: ID
			seq: ID
			type: Type.GET
			value: wire.Value
		}
	}

	/**
	 * Equivalent of `Proxy.set`.
	 */
	export namespace Set {
		export type Request = {
			id: ID
			seq: ID
			type: Type.SET
			prop: PropertyKey
			value: wire.Value
		}

		export type Response = {
			id: ID
			seq: ID
			type: Type.SET
		}
	}

	/**
	 * Equivalent of `Proxy.delete`.
	 */
	export namespace Delete {
		export interface Request {
			id: ID
			seq: ID
			type: Type.DELETE
			prop: PropertyKey
		}

		export interface Response {
			id: ID
			seq: ID
			type: Type.DELETE
		}
	}

	/**
	 * Any request message.
	 */
	export type Request =
		| Construct.Request
		| Apply.Request
		| Get.Request
		| Set.Request
		| Delete.Request

	/**
	 * Any response message.
	 */
	export type Response =
		| Construct.Response
		| Apply.Response
		| Get.Response
		| Set.Response
		| Delete.Response

	/**
	 * Any message.
	 */
	export type Any = Request | Response
}

const MARKER = Symbol('shumei.remote')

export function isValue(value: any): value is Marked {
	return _.isObject(value) && !!value[MARKER]
}

/**
 * A value marked as remote.
 */
export interface Marked {
	[MARKER]: true
}

/**
 * Mark a value as remote.
 */
export function value<T extends object>(value: T): T & Marked {
	return Object.assign(value, { [MARKER]: true }) as any
}

/**
 * Turns a type into a Promise if it is not one already.
 */
type AsPromise<T> = T extends Promise<unknown> ? T : Promise<T>

/**
 * The inverse of `AsPromise<T>`.
 */
type AsNotPromise<P> = P extends Promise<infer T> ? T : P

/**
 * Either sync or async value.
 */
type MaybePromise<T> = Promise<T> | T

export namespace Local {
	/**
	 * Turns a value into a local or leaves it as a clonable.
	 */
	export type AsValue<T> = T extends Remote.Object<Marked>
		? Value<T>
		: T extends wire.Clonable
		? T
		: never

	/**
	 * A local property.
	 */
	export type Property<T> = T extends Function | Marked ? Value<T> : AsNotPromise<T>

	/**
	 * A local object.
	 */
	export type Object<T> = { [P in keyof T]: Property<T[P]> }

	/**
	 * A local value.
	 */
	export type Value<T> = Object<T> &
		(T extends (...args: infer Arguments) => infer Return
			? (
				...args: { [I in keyof Arguments]: Remote.AsValue<Arguments[I]> }
			) => MaybePromise<AsValue<AsNotPromise<Return>>>
			: unknown) &
		(T extends { new(...args: infer Arguments): infer Instance }
			? {
				new(
					...args: {
						[I in keyof Arguments]: Remote.AsValue<Arguments[I]>
					}
				): MaybePromise<Value<AsNotPromise<Instance>>>
			}
			: unknown)
}

export namespace Remote {
	/**
	 * Turns a value into a remote or makes it be cloned.
	 */
	export type AsValue<T> = T extends Marked ? Value<T> : T extends wire.Clonable ? T : never

	/**
	 * A remote property.
	 */
	export type Property<T> = T extends Function | Marked ? Value<T> : AsPromise<T>

	/**
	 * A remote object.
	 */
	export type Object<T> = { [P in keyof T]: Property<T[P]> }

	/**
	 * A remote value.
	 */
	export type Value<T> = Object<T> &
		(T extends (...args: infer Arguments) => infer Return
			? (
				...args: { [I in keyof Arguments]: Local.AsValue<Arguments[I]> }
			) => AsPromise<AsValue<AsNotPromise<Return>>>
			: unknown) &
		(T extends { new(...args: infer Arguments): infer Instance }
			? {
				new(
					...args: {
						[I in keyof Arguments]: Local.AsValue<Arguments[I]>
					}
				): AsPromise<Value<Instance>>
			}
			: unknown)
}

/**
 * A remotely accessible value.
 */
export function remote<T>(
	id: string,
	channel: Sender<Message.Any> & MailboxReceiver<Message.Any>
): Remote.Value<T> {
	// XXX(meh): If the `target` is not a function then `apply` won't be called,
	//           and we need that.
	return new Proxy(() => { }, {
		async construct(_target: any, argArray: any, _newTarget?: any): Promise<object> {
			const seq = uuid()
			const args = wire.encode(argArray)
			const message = <Message.Construct.Request>{
				id,
				seq,
				type: Message.Type.CONSTRUCT,
				arguments: args,
			}

			wire.transfer(message, wire.transferable(args))
			channel.send(message)

			const response = (await channel.match(
				(msg: Message.Any) => msg.id == id && msg.seq == seq
			)) as Message.Construct.Response

			return response.value
		},

		async apply(_target: any, _thisArg: any, argArray?: any): Promise<any> {
			const seq = uuid()
			channel.send(<Message.Apply.Request>{
				id,
				seq,
				type: Message.Type.APPLY,
				arguments: argArray,
			})

			const response = (await channel.match(
				(msg: Message.Any) => msg.id == id && msg.seq == seq
			)) as Message.Apply.Response

			return response.value
		},

		async get(_target: any, p: PropertyKey, _receiver: any): Promise<any> {
			// XXX(meh): When a `Proxy` is awaited "then" is requested, this should return a value
			//           with a `then` property or it's going to lead to infinite recursion.
			if (p == 'then') {
				return Promise.resolve(this)
			}

			const seq = uuid()
			channel.send(<Message.Get.Request>{
				id,
				seq,
				type: Message.Type.GET,
				prop: p,
			})

			const response = (await channel.match(
				(msg: Message.Any) => msg.id == id && msg.seq == seq
			)) as Message.Get.Response

			return response.value
		},

		set(_target: any, p: PropertyKey, value: any, _receiver: any): boolean {
			const seq = uuid()
			channel.send(<Message.Set.Request>{
				id,
				seq,
				type: Message.Type.SET,
				prop: p,
				value,
			})

			channel.match((msg: Message.Any) => msg.id == id && msg.seq == seq)

			return true
		},

		deleteProperty(_target: any, p: PropertyKey): boolean {
			const seq = uuid()
			channel.send(<Message.Delete.Request>{
				id,
				seq,
				type: Message.Type.DELETE,
				prop: p,
			})

			channel.match((msg: Message.Any) => msg.id == id && msg.seq == seq)

			return true
		},
	})
}

/**
 * Spawn a new remote handler that can respond to control messages.
 */
export function spawn(
	value: any,
	channel: Sender<Message.Any> & MailboxReceiver<Message.Any> & wire.Wired
) {
	const id = uuid()
	const handle = async () => {
		const msg = await channel.match(
			(msg) => msg.type >= Message.Type.CONSTRUCT && msg.type <= Message.Type.DELETE && msg.id == id
		)

		switch (msg.type) {
			case Message.Type.CONSTRUCT:
				{
					const request = msg as Message.Construct.Request
					channel.send(<Message.Construct.Response>{
						id: msg.id,
						seq: msg.seq,
						type: Message.Type.CONSTRUCT,
						value: wire.encode(Reflect.construct(value, request.arguments)),
					})
				}
				break

			case Message.Type.APPLY:
				{
					const request = msg as Message.Apply.Request
					channel.send(<Message.Apply.Response>{
						id: msg.id,
						seq: msg.seq,
						type: Message.Type.APPLY,
						value: wire.encode(Reflect.apply(value, undefined, request.arguments)),
					})
				}
				break

			case Message.Type.GET:
				{
					const request = msg as Message.Get.Request
					channel.send(<Message.Get.Response>{
						id: msg.id,
						seq: msg.seq,
						type: Message.Type.GET,
						value: wire.encode(Reflect.get(value, request.prop)),
					})
				}
				break

			case Message.Type.SET:
				{
					const request = msg as Message.Set.Request

					Reflect.set(value, request.prop, request.value)
					channel.send(<Message.Set.Response>{
						id: msg.id,
						seq: msg.seq,
						type: Message.Type.SET,
					})
				}
				break

			case Message.Type.DELETE:
				{
					const request = msg as Message.Delete.Request

					Reflect.deleteProperty(value, request.prop)
					channel.send(<Message.Delete.Response>{
						id: msg.id,
						seq: msg.seq,
						type: Message.Type.DELETE,
					})
				}
				break
		}

		handle()
	}
	handle()

	return id
}

wire.codec({
	name: 'Remote.Value',
	canHandle: (value: unknown): value is Marked => isValue(value),

	encode: (value, wire) => {
		const [master, slave] = mkChannelPair<Message.Any>()
		const id = spawn(value, new Mailbox(master))
		const channel = wire.encode(slave)

		return [{ id, channel }, wire.transferable(channel)]
	},

	decode: <T>(value, wire): Remote.Value<T> =>
		remote(value.id, new Mailbox(wire.decode(value.channel))),
})

wire.codec({
	name: 'Function',
	canHandle: (value: unknown): value is Function => _.isFunction(value),

	encode: (value, wire) => wire.codecFor('Remote.Value').encode(value, wire),

	decode: (value: any, wire) =>
		wire.codecFor('Remote.Value').decode(value, wire) as Remote.Value<Function>,
})

wire.codec({
	name: 'Deferred',
	canHandle: <T>(value: unknown): value is Deferred<T> => value instanceof Deferred,

	encode: (value, wire) => wire.codecFor('Remote.Value').encode(value, wire),

	decode: <T>(value: any, wire) =>
		wire.codecFor('Remote.Value').decode(value) as Remote.Value<Deferred<T>>,
})
