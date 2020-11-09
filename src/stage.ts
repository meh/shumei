import * as _ from 'lodash';
import { Channel as Queue } from 'queueable';
import { v4 as uuid } from 'uuid';
import * as worker from './worker';
import * as wire from './wire';
import { Sender, Receiver } from './channel';
import * as channel from './channel';
import { Mailbox, FilterFn } from './mailbox';

/**
* A value that can be used to spawn a new actor.
*/
export interface Spawn<T> {
	(self?: Actor<T>): AsyncGenerator<FilterFn<T> | undefined, any, T>;
}

/**
 * A stage is an environment that can run actors.
 */
export interface Stage extends Sender<Message.Any> {
	id: string;
}

/**
 * The fully qualified address for an actor.
 */
export type Address = {
	/**
	 * UUID of the actor.
	 */
	actor: string;

	/**
	 * UUID of the stage.
	 */
	stage: string;
};

/**
 * The interface every actor implementation has to expose.
 */
export interface Actor<T> extends Sender<T> {
	/**
	 * The full handle for this actor.
	 */
	address: Address;
}

export class Live {
	id: string;

	// FIXME(meh): There will need to be some way to garbage collect dead references;
	//             consider abusing WeakMap.
	private isReady: boolean;
	private messages: Queue<Message.Any>;
	private channel: Mailbox<Message.Any>;

	private names: Map<string, string>;
	private actors: Map<string, LocalActor<any> | RemoteActor<any>>;
	private stages: Map<string, { as: 'parent' | 'child'; instance: Remote }>;

	constructor() {
		this.id = uuid();

		this.names = new Map();
		this.stages = new Map();
		this.actors = new Map();

		this.isReady = false;
		this.messages = new Queue<Message.Any>();
		this.channel = new Mailbox(
			channel.fromQueue<Message.Any>(this.messages)
		);

		// FIXME(meh): The way things are designed there might be the need of an LRU
		//             saving seen packets and dropping them just in case of some broadcast
		//             spam of messages in cycles.

		// When the worker is dedicated we gotta hook the main worker channel to the stage mailbox.
		if (worker.isDedicated(self)) {
			this.link('parent', worker.channel<Message.Any>());
		}

		// When the worker is shared we gotta hook all the incoming channels instead.
		if (worker.isShared(self)) {
			(async () => {
				for await (const channel of worker.channels<Message.Any>()) {
					this.link('parent', channel);
				}
			})();
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
				});
			}

			return;
		}

		if (this.isReady) {
			return;
		}

		this.isReady = true;

		for (const stage of this.stages.values()) {
			if (stage.as == 'parent') {
				stage.instance.send({
					type: Message.Type.STAGE,
					stage: this.id,
				});
			}
		}
	}

	private async link(
		as: 'parent' | 'child',
		channel: Sender<Message.Any> & Receiver<Message.Any>
	): Promise<Stage> {
		const identify = await channel.recv();
		if (!Message.isStage(identify)) {
			throw new Error('the parent is not a stage?');
		}

		(async () => {
			for await (const msg of channel) {
				this.handle(channel, msg as Message.WhoisActor | Message.Send);
			}
		})();

		const stage = new Remote(identify.stage, channel);
		this.stages.set(stage.id, { as, instance: stage });

		if (as == 'parent') {
			this.ready(stage.id);
		}

		return stage;
	}

	// This whole blob basically just internally responds to the ARP-like messages
	// (STAGE and ACTOR) and broadcasts all SENDs that don't belong to this stage.
	private async handle(
		channel: Sender<Message.Any>,
		msg: Message.WhoisActor | Message.Send
	): Promise<void> {
		if (Message.isWhoisActor(msg)) {
			const alias = this.names.get(msg.whois);
			if (alias) {
				return channel.send({
					id: msg.id,
					type: Message.Type.ACTOR,
					actor: { actor: alias, stage: this.id },
				});
			}

			const act = this.actors.get(msg.whois);
			if (act) {
				return channel.send({
					id: msg.id,
					type: Message.Type.ACTOR,
					actor: act.address,
				});
			}

			// TODO(meh): Ask neighbors.

			return;
		}

		// Forward or broadcast the message if it's not for us, otherwise accept it.
		if (Message.isSend(msg)) {
			if (msg.to.stage == this.id) {
				return this.actors.get(msg.to.actor)!.send(msg.message);
			}

			if (this.stages.has(msg.to.stage)) {
				return this.stages.get(msg.to.stage)!.instance.send(msg);
			}

			// XXX(meh): This is likely going to break with shared workers, need that LRU.
			for (const stage of this.stages.values()) {
				if (stage.instance.channel === channel) {
					continue;
				}

				stage.instance.send(msg);
			}
		}

		this.messages.push(msg);
	}

	send(msg: Message.Any): void {
		for (const stage of this.stages.values()) {
			stage.instance.send(msg);
		}
	}

	async actor<T>(id: string): Promise<Actor<T> | null> {
		let handle: Actor<T>;

		if ((handle = this.actors.get(id))) {
			return handle;
		}

		const request = <Message.WhoisActor>{
			id: uuid(),
			type: Message.Type.WHOIS_ACTOR,
			whois: id,
		};
		this.send(request);
		const response = (await this.channel.match(
			(msg: any) => msg.id == request.id
		)) as Message.Actor;

		handle = new RemoteActor<T>(response.actor!);
		this.actors.set(id, handle as RemoteActor<unknown>);
		return handle;
	}

	async dedicated(source: URL | string): Promise<Stage> {
		const dedicated = worker.dedicated<Message.Any>(source);
		dedicated.send({ type: Message.Type.STAGE, stage: this.id });

		return this.link('child', dedicated);
	}

	async shared(source: URL | string): Promise<Stage> {
		const shared = worker.shared<Message.Any>(source);
		shared.send({ type: Message.Type.STAGE, stage: this.id });

		return this.link('child', shared);
	}

	spawn<T>(fn: Spawn<T>): Actor<T> {
		const act = new LocalActor(fn);
		this.actors.set(act.address.actor, act);
		return act;
	}

	register<T>(name: string, fn: Spawn<T> | LocalActor<T>): Actor<T> {
		const act = fn instanceof LocalActor ? fn : this.spawn(fn);
		this.names.set(name, act.address.actor);
		return act;
	}
}

export class Remote {
	constructor(public id: string, public channel: Sender<Message.Any>) {}

	send(msg: Message.Any): void {
		this.channel.send(msg);
	}
}

const LIVE = Symbol('shumei.stage.live');

/** Create a stage for the current worker.
 */
export function live(): Live {
	if (!self[LIVE]) {
		self[LIVE] = new Live();
	}

	return self[LIVE];
}

export function ready(): void {
	return live().ready();
}

export async function dedicated(source: URL | string): Promise<Stage> {
	return live().dedicated(source);
}

export async function shared(source: URL | string): Promise<Stage> {
	return live().shared(source);
}

export async function actor<T>(id: string): Promise<Actor<T> | null> {
	return live().actor(id);
}

export async function spawn<T>(fn: Spawn<T>): Promise<Actor<T>> {
	return live().spawn(fn);
}

export async function register<T>(
	name: string,
	fn: Spawn<T> | LocalActor<T>
): Promise<Actor<T>> {
	return live().register(name, fn);
}

export class RemoteActor<T> implements Actor<T> {
	constructor(public address: Address) {}

	async send(msg: T): Promise<void> {
		if (self[LIVE].id === this.address.stage) {
			return (await self[LIVE].actor<T>(this.address.actor)).send(msg);
		}

		self[LIVE].send(<Message.Send>{
			id: uuid(),
			type: Message.Type.SEND,
			to: this.address,
			message: msg,
		});
	}
}

export class LocalActor<T> implements Actor<T> {
	private id: string;
	private messages: Queue<T>;
	private channel: Mailbox<T>;

	constructor(spawn: Spawn<T>) {
		this.id = uuid();
		this.messages = new Queue<T>();
		this.channel = new Mailbox<T>(channel.fromQueue<T>(this.messages));

		// Call the generator function with a reference to self.
		const iter = spawn(
			new RemoteActor<T>({ actor: this.id, stage: self[LIVE].id })
		);

		// Promise-oriented handling of a local actor, this gets spawned onto the event-loop.
		const handle = async (
			// The generator that we spawned.
			iter: AsyncGenerator<FilterFn<T> | undefined, any, T>,
			// The message for the previous yield.
			message?: T
		) => {
			// Return result of previous receive and get a filter for the next receive if any.
			const { done, value } = await iter.next(message);
			if (done) return;

			return value
				? handle(iter, await this.channel.match(value as FilterFn<T>))
				: handle(iter, await this.channel.recv());
		};

		handle(iter);
	}

	get address() {
		return { stage: self[LIVE].id, actor: this.id };
	}

	async send(msg: T): Promise<void> {
		this.messages.push(msg);
	}
}

wire.codec('Actor<T>', {
	canHandle: <T>(value: any): value is Actor<T> =>
		_.isObject(value) &&
		_.isObject(value['handle']) &&
		_.isFunction(value['send']),
	encode: <T>(value: Actor<T>) => [value.address, []],
	decode: <T>(value: Address): Actor<T> => new RemoteActor(value),
});

/**
 * The protocol spoken between stages.
 */
export namespace Message {
	export type ID = string;

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
		type: Type.STAGE;
		stage: ID;
	};

	export function isStage(msg: any): msg is Stage {
		return msg.type == Type.STAGE;
	}

	/**
	 * Ask a stage to fully qualify an actor.
	 */
	export type WhoisActor = {
		id: ID;
		type: Type.WHOIS_ACTOR;
		whois: ID;
	};

	export function isWhoisActor(msg: any): msg is WhoisActor {
		return msg.type == Type.WHOIS_ACTOR && _.isString(msg.whois);
	}

	export type Actor = {
		id: ID;
		type: Type.ACTOR;
		actor: Address;
	};

	export function isActor(msg: any): msg is Actor {
		return msg.type == Type.ACTOR && _.isObject(msg.actor);
	}

	/**
	 * Send a message to a specific actor.
	 *
	 * The message is internally forwarded to the proper stage or all stages.
	 */
	export type Send = {
		id: ID;
		type: Type.SEND;
		to: Address;
		message: any;
	};

	export function isSend(msg: any): msg is Send {
		return msg.type == Type.SEND && _.isObject(msg['actor']);
	}

	export type Any = Stage | WhoisActor | Actor | Send;
}
