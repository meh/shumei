import * as _ from 'lodash'
import { Channel as Queue } from 'queueable'
import { Channel } from './channel'

export class Dedicated<T> extends Channel<T, Worker> {
	constructor(public worker: Worker) {
		super(worker)
	}
}

export class Shared<T> extends Channel<T> {
	constructor(public worker: SharedWorker) {
		super(worker.port)
	}
}

/**
 * Spawn a dedicated worker.
 */
export function dedicated<T>(source: URL | string): Dedicated<T> {
	if (!(source instanceof URL)) {
		source = URL.createObjectURL(new Blob([source]))
	}

	return new Dedicated(new Worker(source))
}

/**
 * Spawn a shared worker.
 */
export function shared<T>(source: URL | string): Shared<T> {
	if (!isTab(self)) {
		throw new Error('this function can only be called in a `Window`.')
	}

	if (!(source instanceof URL)) {
		source = URL.createObjectURL(new Blob([source]))
	}

	return new Shared(new SharedWorker(source.toString()))
}

/**
 * Get a channel for the current `Worker`.
 *
 * This function can only be called once per worker.
 */
export function channel<T>(): Channel<T, DedicatedWorkerGlobalScope> {
	if (!isDedicated(self)) {
		throw new Error('this function can only be called in a `Worker`.')
	}

	return new Channel(self)
}

/**
 * Get an iterator of channels for the current `SharedWorker`.
 *
 * This function can only be called once per worker.
 */
export function channels<T>(): AsyncIterableIterator<Channel<T>> {
	if (!isShared(self)) {
		throw new Error('this function can only be called in a `SharedWorker`.')
	}

	const channel = new Queue<Channel<T>>()

	self.addEventListener('connect', (e) => {
		for (const port of e.ports) {
			channel.push(new Channel(port))
		}
	})

	return channel.wrap()
}

/**
 * Check whether the passed value is a tab or not.
 */
export function isTab(self: unknown): self is Window {
	return _.isFunction(self['Window']) && self instanceof self['Window']
}

/**
 * Check whether the passed value is a dedicated worker or not.
 */
export function isDedicated(self: unknown): self is DedicatedWorkerGlobalScope {
	return (
		_.isFunction(self['DedicatedWorkerGlobalScope']) &&
		self instanceof self['DedicatedWorkerGlobalScope']
	)
}

/**
 * Check whether the passed value is a shared worker or not.
 */
export function isShared(self: unknown): self is SharedWorkerGlobalScope {
	return (
		_.isFunction(self['SharedWorkerGlobalScope']) && self instanceof self['SharedWorkerGlobalScope']
	)
}
