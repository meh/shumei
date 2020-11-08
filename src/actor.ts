import * as _ from 'lodash';
import { v4 as uuid } from 'uuid';
import * as worker from './worker';
import * as wire from './wire';
import { Sender, Receiver } from './channel';
import { Mailbox, FilterFn, Receiver as MailboxReceiver } from './mailbox';

export interface Spawn<T> {
	(self?: Actor<T>): AsyncGenerator<FilterFn<T> | undefined, any, T>;
}

/**
 * A stage runs multiple actors.
 */
export interface Stage extends Sender<Message.Any> {
	id: string;
}

export type Handle = {
	/**
	 * UUID of the actor.
	 */
	id: string;

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
	handle: Handle;
}

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
		actor: Handle;
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
		actor: Handle;
		message: any;
	};

	export function isSend(msg: any): msg is Request {
		return msg.type == Type.SEND && _.isObject(msg['actor']);
	}

	export type Any = Stage | WhoisActor | Actor | Send;
}
