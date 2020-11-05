import * as _ from 'lodash';
import { map } from 'axax/esnext/map';
import * as queueable from 'queueable';
import * as channel from './channel';

export interface FilterFn<T> {
	(value: T): boolean;
}

export interface FilterMapFn<T, U = T> {
	(value: T): U | null;
}

export interface Sender<T> extends channel.Sender<T> {}

export interface Receiver<T> extends channel.Receiver<T> {
	match(pred: FilterFn<T>): Promise<T>;
}

export class Mailbox<T> implements Sender<T>, Receiver<T> {
	private channel: queueable.Channel<channel.Select<T>>;
	private buffer: Array<channel.Select<T>>;
	private receivers: channel.Receiver<T>[];
	private senders: channel.Sender<T>[];

	constructor(private filter?: FilterMapFn<channel.Select<T>>) {
		this.channel = new queueable.Channel<channel.Select<T>>();
		this.buffer = [];

		this.receivers = [];
		this.senders = [];
	}

	handle(channel: channel.Sender<T> & channel.Receiver<T>): this {
		this.receiver(channel);
		this.sender(channel);

		return this;
	}

	receiver(channel: channel.Receiver<T>): this {
		this.receivers.push(channel);

		/// Message filtering happens inside here.
		(async () => {
			for await (const value of channel) {
				let payload = <channel.Select<T>>{ channel, value };

				if (this.filter) {
					payload = this.filter(payload);
				}

				if (payload) {
					this.channel.push(payload);
				}
			}
		})();

		return this;
	}

	sender(channel: Sender<T>): this {
		this.senders.push(channel);

		return this;
	}

	send(value: T) {
		for (const sender of this.senders) {
			sender.send(value);
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return map((msg: channel.Select<T>) => msg.value)(this.channel);
	}

	async recv(): Promise<T> {
		if (_.isEmpty(this.buffer)) {
			return (await this.channel.next()).value.value;
		}

		return this.buffer.shift().value;
	}

	async match(pred: FilterFn<T>): Promise<T> {
		if (!_.isEmpty(this.buffer)) {
			for (const [i, msg] of this.buffer.entries()) {
				if (pred(msg.value)) {
					return this.buffer.splice(i, 1)[0].value;
				}
			}
		}

		for await (const msg of this.channel) {
			if (pred(msg.value)) {
				return msg.value;
			}

			this.buffer.push(msg);
		}
	}

	close() {
		this.channel.close();
	}
}
