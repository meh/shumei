import * as _ from 'lodash';
import { Deferred } from 'queueable';
import * as channel from './channel';

export interface FilterFn<T> {
	(value: T): boolean;
}

export interface Sender<T> extends channel.Sender<T> {}

export interface Receiver<T> extends channel.Receiver<T> {
	match(pred: FilterFn<T>): Promise<T>;
}

export class Mailbox<T> implements Sender<T>, Receiver<T> {
	private buffer: Array<T>;

	constructor(private channel: channel.Sender<T> & channel.Receiver<T>) {
		this.buffer = [];
	}

	send(value: T) {
		this.channel.send(value);
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this.channel[Symbol.asyncIterator]();
	}

	async recv(): Promise<T> {
		if (_.isEmpty(this.buffer)) {
			return await this.channel.recv();
		}

		return this.buffer.shift();
	}

	async match(pred: FilterFn<T>): Promise<T> {
		if (!_.isEmpty(this.buffer)) {
			for (const [i, msg] of this.buffer.entries()) {
				if (pred(msg)) {
					return this.buffer.splice(i, 1)[0];
				}
			}
		}

		const result = new Deferred<T>();
		const handle = async (channel: channel.Receiver<T>) => {
			const msg = await channel.recv();

			if (pred(msg)) {
				result.resolve(msg);
			} else {
				this.buffer.push(msg);
				return handle(channel);
			}
		};
		handle(this.channel);
		return result.promise;
	}

	close() {
		this.channel.close();
	}
}
