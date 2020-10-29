import asyncify from "callback-to-async-iterator";
import * as wire  from "./wire";

/**
 * Anything that behaves like a `MessagePort`.
 */
export interface PortLike {
  onmessage: (ev: MessageEvent) => any;
  onmessageerror: (ev: MessageEvent) => any;
  postMessage(message: any, transfer: Transferable[]): void;
  close?(): void;
}

/**
 * A value that can receive messages.
 */
export interface Receiver<T> {
  recv(): Promise<T>;
}

/**
 * A value that can send messages.
 */
export interface Sender<T> {
  send(value: T): void;
}

/**
 * A channel to send messages through.
 *
 * This channel can be used to wrap around anything that behaves like a `MessagePort`,
 * this includes `Worker` itself, and global scopes for workers.
 */
export class Channel<T, P extends PortLike = MessagePort>
  implements Sender<T>, Receiver<T> {
  protected iter: AsyncIterator<T>;

  constructor(public port: P) {
    this.iter = asyncify(
      (next) =>
        new Promise((_, reject) => {
          port.onmessage = (e: MessageEvent) => next(wire.decode(e.data));
          port.onmessageerror = (e: MessageEvent) => reject(e.data);
        })
    );
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iter;
  }

  send(value: T) {
    const [message, transfer] = wire.encode(value);
    this.port.postMessage(message, transfer);
  }

  async recv(): Promise<T> {
    return (await this.iter.next()).value;
  }

  close() {
    this.port.close();
  }
}

/**
 * Create a pair of connected `Channel`s, allowing the channels to be sent across borders.
 */
export function pair<T>(): [Channel<T>, Channel<T>] {
  const channel = new MessageChannel();
  return [new Channel(channel.port1), new Channel(channel.port2)];
}

/**
 * Create a `BroadcastChannel`.
 */
export function broadcast<T>(name: string): Channel<T, BroadcastChannel> {
  return new Channel(new BroadcastChannel(name));
}

/**
 * Create an `AsyncIterator` that can receive messages from multiple channels.
 */
export function select<T extends unknown[]>(
  ...channels: Channel<T>[]
): AsyncIterator<{ channel: Channel<T>; value: T }> {
  return asyncify(
    (next) =>
      new Promise((_) => {
        const recv = (channel: Channel<T>) => {
          channel.recv().then((value) => {
            next({ channel, value });
            recv(channel);
          });
        };

        for (const channel of channels) {
          recv(channel);
        }
      })
  );
}

wire.codec("Channel", {
  canHandle: <T>(value: unknown): value is Channel<T> =>
    value instanceof Channel,
  encode: <T>(channel: Channel<T>) => [channel.port, [channel.port]],
  decode: <T>(value: MessagePort): Channel<T> => new Channel(value),
});
