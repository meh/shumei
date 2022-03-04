import * as _ from 'lodash'
import { Channel as Queue } from 'queueable'
import { v4 as uuid } from 'uuid'
import * as worker from './worker'
import * as wire from './wire'
import { Channel, Sender } from './channel'
import * as channel from './channel'
import * as remote from './remote'
import { Mailbox, Receiver as MailboxReceiver, FilterFn } from './mailbox'

/**
 * A value that can be used to spawn a new actor.
 *
 * In practice this abuses asynchronous generators to implement Erlang-style
 * processes with ergonomics that do not suck.
 *
 * This allows for example to have infinite loops handling incoming messages:
 *
 * ```ts
 * stage.spawn(async function*(self: Actor<number>) {
 *   while (true) {
 *     console.log(yield * 2);
 *   }
 * });
 * ```
 *
 * This also allows interleaved message handling:
 *
 * ```ts
 * stage.spawn(async function*(self) {
 *   while (true) {
 *     const { from, times } = yield;
 *     from.send({ from: self, times + 2 });
 *     const { print, effects } = yield;
 *     console.log(print(effects));
 *   }
 * });
 * ```
 */
export interface Spawn<T> {
	(self?: Actor<T>): AsyncGenerator<FilterFn<T> | undefined, any, T>
}

/**
 * A stage is an environment that can run actors.
 */
export interface Stage extends Sender<Message.Any> {
	id: string
}

/**
 * The fully qualified address for an actor.
 */
export type Address = {
	/**
	 * UUID of the actor.
	 */
	actor: string

	/**
	 * UUID of the stage.
	 */
	stage: string
}

/**
 * The interface every actor implementation has to expose.
 */
export interface Actor<T> extends Sender<T> {
	/**
	 * The full handle for this actor.
	 */
	address: Address
}

export enum Link {
	PARENT,
	CHILD,
}

export class Live implements Stage, MailboxReceiver<Message.Any> {
	id: string

	// FIXME(meh): There will need to be some way to garbage collect dead references;
	//             consider abusing WeakMap.
	private isReady: boolean
	private messages: Queue<Message.Any>
	private channel: Mailbox<Message.Any>

	private names: Map<string, string>
	private actors: Map<string, LocalActor<any> | RemoteActor<any>>
	private stages: Map<string, { as: Link.PARENT | Link.CHILD; instance: Remote }>

	constructor() {
		this.id = uuid()

		this.names = new Map()
		this.stages = new Map()
		this.actors = new Map()

		this.isReady = false
		this.messages = new Queue<Message.Any>()
		this.channel = new Mailbox(channel.fromQueue<Message.Any>(this.messages))

		// FIXME(meh): The way things are designed there might be the need of an LRU
		//             saving seen packets and dropping them just in case of some broadcast
		//             spam of messages in cycles.

		// When the worker is dedicated we gotta hook the main worker channel to the stage mailbox.
		if (worker.isDedicated(self)) {
			this.link(Link.PARENT, worker.channel<Message.Any>())
		}

		// When the worker is shared we gotta hook all the incoming channels instead.
		if (worker.isShared(self)) {
			;(async () => {
				for await (const channel of worker.channels<Message.Any>()) {
					this.link(Link.PARENT, channel)
				}
			})()
		}
	}

	/**
	 * Mark the stage as ready, unblocking the worker that created the stage.
	 */
	ready(parent?: string): void {
		if (parent) {
			if (this.isReady) {
				this.stages.get(parent)!.instance.send({
					type: Message.Type.STAGE,
					stage: this.id,
				})
			}

			return
		}

		if (this.isReady) {
			return
		}

		this.isReady = true

		for (const stage of this.stages.values()) {
			if (stage.as == Link.PARENT) {
				stage.instance.send({
					type: Message.Type.STAGE,
					stage: this.id,
				})
			}
		}
	}

	/**
	 * Link a stage as parent or child.
	 */
	private async link(
		as: Link.PARENT | Link.CHILD,
		channel: Channel<Message.Any, any>
	): Promise<Stage> {
		channel.wire.codec({
			name: 'Remote.Value',

			canHandle: (value: unknown): value is remote.Marked => remote.isValue(value),

			encode: (value, wire) => {
				const id = remote.spawn(value, this.channel as unknown as Mailbox<remote.Message.Any>)

				console.log(id)

				return [{ id }, []]
			},

			decode: <T>(value, wire): remote.Remote.Value<T> => {
				return remote.remote(value.id, this.channel as unknown as Mailbox<remote.Message.Any>)
			},
		})

		const identify = await channel.recv()
		if (!Message.isStage(identify)) {
			throw new Error('the parent is not a stage?')
		}

		;(async () => {
			for await (const msg of channel) {
				this.handle(channel, msg as Message.WhoisActor | Message.Send)
			}
		})()

		const stage = new Remote(identify.stage, channel)
		this.stages.set(stage.id, { as, instance: stage })

		if (as == Link.PARENT) {
			this.ready(stage.id)
		}

		return stage
	}

	/**
	 * Handle any messages that do not need to be forwarded.
	 */
	private async handle(channel: Sender<Message.Any>, msg: any): Promise<void> {
		if (Message.isWhoisActor(msg)) {
			const alias = this.names.get(msg.whois)
			if (alias) {
				return channel.send({
					id: msg.id,
					type: Message.Type.ACTOR,
					actor: { actor: alias, stage: this.id },
				})
			}

			const act = this.actors.get(msg.whois)
			if (act) {
				return channel.send({
					id: msg.id,
					type: Message.Type.ACTOR,
					actor: act.address,
				})
			}

			// TODO(meh): Ask neighbors.

			return
		}

		if (Message.isSend(msg)) {
			// If it's for us, we just handle it.
			if (msg.to.stage == this.id) {
				return this.actors.get(msg.to.actor)!.send(msg.message)
			}

			// If we know the stage we send the message directly to it.
			if (this.stages.has(msg.to.stage)) {
				return this.stages.get(msg.to.stage)!.instance.send(msg)
			}

			// Otherwise we just forward the message to every stage we know except
			// the one asking us.
			//
			// XXX(meh): This is likely going to break with shared workers, need that LRU.
			for (const stage of this.stages.values()) {
				if (stage.instance.channel === channel) {
					continue
				}

				stage.instance.send(msg)
			}

			return
		}

		this.messages.push(msg)
	}

	[Symbol.asyncIterator](): AsyncIterator<Message.Any> {
		return this.channel[Symbol.asyncIterator]()
	}

	async recv(): Promise<Message.Any> {
		return this.channel.recv()
	}

	async match(pred: FilterFn<Message.Any>): Promise<Message.Any> {
		return this.channel.match(pred)
	}

	/**
	 * Send a message to every linked stage.
	 */
	send(msg: Message.Any): void {
		for (const stage of this.stages.values()) {
			stage.instance.send(msg)
		}
	}

	/**
	 * Try and get an actor from the swarm.
	 */
	async actor<T>(id: string): Promise<Actor<T> | null> {
		let handle: Actor<T>

		if ((handle = this.actors.get(id))) {
			return handle
		}

		const request = <Message.WhoisActor>{
			id: uuid(),
			type: Message.Type.WHOIS_ACTOR,
			whois: id,
		}
		this.send(request)
		const response = (await this.channel.match((msg: any) => msg.id == request.id)) as Message.Actor

		handle = new RemoteActor<T>(response.actor!)
		this.actors.set(id, handle as RemoteActor<unknown>)
		return handle
	}

	/**
	 * Spawn a stage as a dedicated worker.
	 */
	async dedicated(source: URL | string): Promise<Stage> {
		const dedicated = worker.dedicated<Message.Any>(source)
		dedicated.send({ type: Message.Type.STAGE, stage: this.id })

		return this.link(Link.CHILD, dedicated)
	}

	/**
	 * Spawn a stage as a shared worker.
	 */
	async shared(source: URL | string): Promise<Stage> {
		const shared = worker.shared<Message.Any>(source)
		shared.send({ type: Message.Type.STAGE, stage: this.id })

		return this.link(Link.CHILD, shared)
	}

	/**
	 * Spawn an actor from the given generator.
	 */
	spawn<T = any>(fn: Spawn<T>): Actor<T> {
		const act = new LocalActor(fn)
		this.actors.set(act.address.actor, act)
		return act
	}

	/**
	 * Register an actor under a specific name.
	 */
	register<T = any>(name: string, fn: Spawn<T> | LocalActor<T>): Actor<T> {
		const act = fn instanceof LocalActor ? fn : this.spawn(fn)
		this.names.set(name, act.address.actor)
		return act
	}

	/**
	 * Spawn an actor with a mildly fancier runner, think gen_server from Erlang.
	 */
	act(name: string, klass: any): Actor<any> {
		const handler = new klass(self)

		return this.register<any>(name, async function* (self) {
			while (true) {
				const msg = yield
				msg.result?.resolve(handler[msg.type]!(...msg.args))
			}
		})
	}
}

/**
 * A remotely accessible stage.
 */
export class Remote {
	constructor(public id: string, public channel: Sender<Message.Any>) {}

	send(msg: Message.Any): void {
		this.channel.send(msg)
	}
}

const LIVE = Symbol('shumei.stage.live')

/** Create a stage for the current worker.
 */
export function live(): Live {
	if (!self[LIVE]) {
		self[LIVE] = new Live()
	}

	return self[LIVE]
}

/**
 * Check if the current context is running a stage.
 */
export function isLive(): boolean {
	return !!self[LIVE]
}

/**
 * @see Live.ready
 */
export function ready(): void {
	return live().ready()
}

/**
 * @see Live.dedicated
 */
export async function dedicated(source: URL | string): Promise<Stage> {
	return live().dedicated(source)
}

/**
 * @see Live.shared
 */
export async function shared(source: URL | string): Promise<Stage> {
	return live().shared(source)
}

/**
 * @see Live.actor
 */
export async function actor<T>(id: string): Promise<Actor<T> | null> {
	return live().actor(id)
}

/**
 * @see Live.spawn
 */
export async function spawn<T>(fn: Spawn<T>): Promise<Actor<T>> {
	return live().spawn(fn)
}

/**
 * @see Live.register
 */
export async function register<T>(name: string, fn: Spawn<T> | LocalActor<T>): Promise<Actor<T>> {
	return live().register(name, fn)
}

export class RemoteActor<T> implements Actor<T> {
	constructor(public address: Address) {}

	async send(msg: T): Promise<void> {
		if (self[LIVE].id === this.address.stage) {
			return (await self[LIVE].actor<T>(this.address.actor)).send(msg)
		}

		self[LIVE].send(<Message.Send>{
			id: uuid(),
			type: Message.Type.SEND,
			to: this.address,
			message: msg,
		})
	}
}

export class LocalActor<T> implements Actor<T> {
	private id: string
	private messages: Queue<T>
	private channel: Mailbox<T>

	constructor(spawn: Spawn<T>) {
		this.id = uuid()
		this.messages = new Queue<T>()
		this.channel = new Mailbox<T>(channel.fromQueue<T>(this.messages))

		// Call the generator function with a reference to self.
		const iter = spawn(new RemoteActor<T>({ actor: this.id, stage: self[LIVE].id }))

		// Promise-oriented handling of a local actor, this gets spawned onto the event-loop.
		const handle = async (
			// The generator that we spawned.
			iter: AsyncGenerator<FilterFn<T> | undefined, any, T>,
			// The message for the previous yield.
			message?: T
		) => {
			// Return result of previous receive and get a filter for the next receive if any.
			const { done, value } = await iter.next(message)
			if (done) return

			return value
				? handle(iter, await this.channel.match(value as FilterFn<T>))
				: handle(iter, await this.channel.recv())
		}

		handle(iter)
	}

	get address() {
		return { stage: self[LIVE].id, actor: this.id }
	}

	async send(msg: T): Promise<void> {
		this.messages.push(msg)
	}
}

wire.codec({
	name: 'Actor<T>',
	canHandle: <T>(value: any): value is Actor<T> =>
		_.isObject(value) && _.isObject(value['handle']) && _.isFunction(value['send']),
	encode: <T>(value: Actor<T>) => [value.address, []],
	decode: <T>(value: Address): Actor<T> => new RemoteActor(value),
})

/**
 * The protocol spoken between stages.
 */
export namespace Message {
	export type ID = string

	export const enum Type {
		STAGE,
		WHOIS_ACTOR,
		ACTOR,
		SEND,
	}

	/**
	 * Ask a stage to identify itself.
	 */
	export type Stage = {
		type: Type.STAGE
		stage: ID
	}

	export function isStage(msg: any): msg is Stage {
		return msg.type == Type.STAGE
	}

	/**
	 * Ask a stage to fully qualify an actor.
	 */
	export type WhoisActor = {
		id: ID
		type: Type.WHOIS_ACTOR
		whois: ID
	}

	export function isWhoisActor(msg: any): msg is WhoisActor {
		return msg.type == Type.WHOIS_ACTOR && _.isString(msg.whois)
	}

	export type Actor = {
		id: ID
		type: Type.ACTOR
		actor: Address
	}

	/**
	 * Check if the message is an actor message.
	 */
	export function isActor(msg: any): msg is Actor {
		return msg.type == Type.ACTOR && _.isObject(msg.actor)
	}

	/**
	 * Send a message to a specific actor.
	 *
	 * The message is internally forwarded to the proper stage or all stages.
	 */
	export type Send = {
		id: ID
		type: Type.SEND
		to: Address
		message: any
	}

	/**
	 * Check if the message is a send message.
	 */
	export function isSend(msg: any): msg is Send {
		return msg.type == Type.SEND && _.isObject(msg['actor'])
	}

	export type Any = Stage | WhoisActor | Actor | Send
}
