import * as _ from 'lodash';
import * as queuable from 'queueable';
import { v4 as uuid } from 'uuid';
import * as worker from './worker';
import * as wire from './wire';
import { Sender, Receiver } from './channel';
import * as channel from './channel';
import { Mailbox, FilterFn } from './mailbox';
import { Message, Actor, Stage, Handle, Spawn } from './actor';

export class Live {
	id: string;

	// FIXME(meh): There will need to be some way to garbage collect dead references;
	//             consider abusing WeakMap.
	private isReady: boolean;
	private messages: queuable.Channel<Message.Any>;
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
		this.messages = new queuable.Channel<Message.Any>();
		this.channel = new Mailbox(
			channel.fromQueuable<Message.Any>(this.messages)
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
	async handle(
		channel: Sender<Message.Any>,
		msg: Message.WhoisActor | Message.Send
	): Promise<void> {
		if (Message.isWhoisActor(msg)) {
			const alias = this.names.get(msg.whois);
			if (alias) {
				return channel.send({
					id: msg.id,
					type: Message.Type.ACTOR,
					actor: { id: alias, stage: this.id },
				});
			}

			const act = this.actors.get(msg.whois);
			if (act) {
				return channel.send({
					id: msg.id,
					type: Message.Type.ACTOR,
					actor: act.handle,
				});
			}

			// TODO(meh): Ask neighbors.

			return;
		}

		// Forward or broadcast the message if it's not for us, otherwise accept it.
		if (Message.isSend(msg)) {
			if (msg.actor.stage == this.id) {
				return this.actors.get(msg.actor.id)!.send(msg.message);
			}

			if (this.stages.has(msg.actor.stage)) {
				return this.stages.get(msg.actor.stage)!.instance.send(msg);
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
		this.actors.set(act.handle.id, act);
		return act;
	}

	register<T>(name: string, fn: Spawn<T> | LocalActor<T>): Actor<T> {
		const act = fn instanceof LocalActor ? fn : this.spawn(fn);
		this.names.set(name, act.handle.id);
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
	constructor(public handle: Handle) {}

	async send(msg: T): Promise<void> {
		if (self[LIVE].id === this.handle.stage) {
			return (await self[LIVE].actor<T>(this.handle.id)).send(msg);
		}

		self[LIVE].send(<Message.Send>{
			id: uuid(),
			type: Message.Type.SEND,
			actor: this.handle,
			message: msg,
		});
	}
}

export class LocalActor<T> implements Actor<T> {
	private id: string;
	private messages: queuable.Channel<T>;
	private channel: Mailbox<T>;

	constructor(spawn: Spawn<T>) {
		this.id = uuid();
		this.messages = new queuable.Channel<T>();
		this.channel = new Mailbox<T>(channel.fromQueuable<T>(this.messages));

		// Call the generator function with a reference to self.
		const iter = spawn(
			new RemoteActor<T>({ id: this.id, stage: self[LIVE].id })
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

	get handle() {
		return { stage: self[LIVE].id, id: this.id };
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
	encode: <T>(value: Actor<T>) => [value.handle, []],
	decode: <T>(value: Handle): Actor<T> => new RemoteActor(value),
});
