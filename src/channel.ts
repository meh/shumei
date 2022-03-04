import { Channel as Queue } from 'queueable'
import { Wire, Wired, codec } from './wire'

/**
 * Anything that behaves like a `MessagePort`.
 */
export interface PortLike {
	onmessage: (ev: MessageEvent) => any
	onmessageerror: (ev: MessageEvent) => any
	postMessage(message: any, transfer: Transferable[]): void
	close?(): void
}

/**
 * A value that can receive messages.
 */
export interface Receiver<T> extends AsyncIterable<T> {
	recv(): Promise<T>
	close?(): void
}

/**
 * A value that can send messages.
 */
export interface Sender<T> {
	send(value: T): void
	close?(): void
}

/**
 * A channel to send messages through.
 *
 * This channel can be used to wrap around anything that behaves like a `MessagePort`,
 * this includes `Worker` itself, and global scopes for workers.
 */
export class Channel<T, P extends PortLike = MessagePort> implements Sender<T>, Receiver<T>, Wired {
	protected queue: Queue<T>
	protected iter: AsyncIterator<T>
	public wire: Wire

	constructor(public port: P, wire?: Wire) {
		this.wire = wire || Wire.live()

		const queue = (this.queue = new Queue())
		port.onmessage = (e: MessageEvent) => queue.push(this.wire.decode(e.data))
		port.onmessageerror = (e: MessageEvent) => queue.return(e.data)
		this.iter = queue.wrap(() => port.close())
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this.iter
	}

	push(value: T) {
		this.queue.push(value)
	}

	send(value: T) {
		const message = this.wire.encode(value)
		this.port.postMessage(message, this.wire.transferable(message))
	}

	async recv(): Promise<T> {
		return (await this.iter.next()).value
	}

	close() {
		this.queue.return()
	}
}

/**
 * Create a pair of connected `Channel`s, allowing the channels to be sent across borders.
 */
export function pair<T>(): [Channel<T>, Channel<T>] {
	const channel = new MessageChannel()
	return [new Channel(channel.port1), new Channel(channel.port2)]
}

/**
 * Create a `BroadcastChannel`.
 */
export function broadcast<T>(name: string): Channel<T, BroadcastChannel> {
	return new Channel(new BroadcastChannel(name))
}

/**
 * Convert a `Queue` into one of our own.
 */
export function fromQueue<T>(queue: Queue<T> = new Queue<T>()): Sender<T> & Receiver<T> {
	return {
		send(value: T) {
			queue.push(value)
		},

		async recv(): Promise<T> {
			return (await queue.next()).value
		},

		[Symbol.asyncIterator](): AsyncIterator<T> {
			return queue[Symbol.asyncIterator]()
		},
	}
}

export type Select<T, R = any> = {
	channel: R
	value: T
}

/**
 * Create an `AsyncIterator` that can receive messages from multiple channels.
 */
export function select<T extends unknown[], R extends Receiver<T>>(
	...channels: R[]
): Receiver<Select<T, R>> {
	const queue = new Queue<Select<T, R>>()

	for (const ch of channels) {
		; (async () => {
			for await (const value of ch) {
				queue.push({ channel: ch, value })
			}
		})()
	}

	const iter = queue.wrap(() => {
		for (const ch of channels) {
			ch.close()
		}
	})

	return {
		[Symbol.asyncIterator](): AsyncIterator<Select<T, R>> {
			return iter
		},

		async recv(): Promise<Select<T, R>> {
			return (await queue.next()).value
		},

		close() {
			queue.close()
		},
	}
}

/**
 * Create an object that sends the same message to multiple channels.
 */
export function multicast<T extends unknown[], S extends Sender<T>>(...channels: S[]): Sender<T> {
	return {
		send(value: T): void {
			for (const ch of channels) {
				ch.send(value)
			}
		},

		close() {
			for (const ch of channels) {
				ch.close()
			}
		},
	}
}

codec({
	name: 'Channel<T>',
	canHandle: <T>(value: unknown): value is Channel<T> => value instanceof Channel,
	encode: <T>(channel: Channel<T>, options?) => [channel.port, [channel.port]],
	decode: <T>(value: MessagePort, options?): Channel<T> => new Channel(value, options),
})
