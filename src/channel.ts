import * as queueable from 'queueable';
import * as wire from './wire';

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
  [Symbol.asyncIterator](): AsyncIterator<T>;
  close?(): void;
}

/**
 * A value that can send messages.
 */
export interface Sender<T> {
  send(value: T): void;
  close?(): void;
}

/**
 * A channel to send messages through.
 *
 * This channel can be used to wrap around anything that behaves like a `MessagePort`,
 * this includes `Worker` itself, and global scopes for workers.
 */
export class Channel<T, P extends PortLike = MessagePort>
  implements Sender<T>, Receiver<T> {
  protected channel: queueable.Channel<T>;
  protected iter: AsyncIterator<T>;

  constructor(public port: P) {
    const channel = (this.channel = new queueable.Channel());
    port.onmessage = (e: MessageEvent) => channel.push(wire.decode(e.data));
    port.onmessageerror = (e: MessageEvent) => channel.return(e.data);
    this.iter = channel.wrap(() => port.close());
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
    this.channel.return();
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
 * Convert a `queueable.Channel` into one of our own.
 */
export function fromQueuable<T>(
  channel: queueable.Channel<T> = new queueable.Channel<T>()
): Sender<T> & Receiver<T> {
  return {
    send(value: T) {
      channel.push(value);
    },

    async recv(): Promise<T> {
      return (await channel.next()).value;
    },

    [Symbol.asyncIterator](): AsyncIterator<T> {
      return channel[Symbol.asyncIterator]();
    },
  };
}

export type Select<T, R = any> = {
  channel: R;
  value: T;
};

/**
 * Create an `AsyncIterator` that can receive messages from multiple channels.
 */
export function select<T extends unknown[], R extends Receiver<T>>(
  ...channels: R[]
): Receiver<Select<T, R>> {
  const channel = new queueable.Channel<Select<T, R>>();

  for (const ch of channels) {
    (async () => {
      for await (const value of ch) {
        channel.push({ channel: ch, value });
      }
    })();
  }

  const iter = channel.wrap(() => {
    for (const ch of channels) {
      ch.close();
    }
  });

  return {
    [Symbol.asyncIterator](): AsyncIterator<Select<T, R>> {
      return iter;
    },

    async recv(): Promise<Select<T, R>> {
      return (await channel.next()).value;
    },

    close() {
      channel.close();
    },
  };
}

/**
 * Create an object that sends the same message to multiple channels.
 */
export function multicast<T extends unknown[]>(
  ...channels: Sender<T>[]
): Sender<T> {
  return {
    send(value: T): void {
      for (const ch of channels) {
        ch.send(value);
      }
    },

    close() {
      for (const ch of channels) {
        ch.close();
      }
    },
  };
}

wire.codec('Channel', {
  canHandle: <T>(value: unknown): value is Channel<T> =>
    value instanceof Channel,
  encode: <T>(channel: Channel<T>) => [channel.port, [channel.port]],
  decode: <T>(value: MessagePort): Channel<T> => new Channel(value),
});
