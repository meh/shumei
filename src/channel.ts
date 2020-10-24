import asyncify from "callback-to-async-iterator";
import { codec, encode, decode } from "./protocol";

export interface PortLike {
  onmessage: (ev: MessageEvent) => any;
  onmessageerror: (ev: MessageEvent) => any;
  postMessage(message: any, transfer: Transferable[]): void;
  close?(): void;
}

export interface Receiver<T> {
  recv(): Promise<T>;
}

export interface Sender<T> {
  send(value: T): void;
}

export class Channel<T, P extends PortLike = MessagePort>
  implements Sender<T>, Receiver<T> {
  protected iter: AsyncIterator<T>;

  constructor(public port: P) {
    this.iter = asyncify(
      (next) =>
        new Promise((_, reject) => {
          port.onmessage = (e: MessageEvent) => next(decode(e.data));
          port.onmessageerror = (e: MessageEvent) => reject(e.data);
        })
    );
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iter;
  }

  send(value: T) {
    const [message, transfer] = encode(value);
    this.port.postMessage(message, transfer);
  }

  async recv(): Promise<T> {
    return (await this.iter.next()).value;
  }

  close() {
    this.port.close();
  }
}

export function pair<T>(): [Channel<T>, Channel<T>] {
  const channel = new MessageChannel();
  return [new Channel(channel.port1), new Channel(channel.port2)];
}

export function broadcast<T>(name: string): Channel<T, BroadcastChannel> {
  return new Channel(new BroadcastChannel(name));
}

codec("CHANNEL", {
  canHandle: <T>(value: unknown): value is Channel<T> =>
    value instanceof Channel,
  encode: <T>(channel: Channel<T>) => [channel, [channel.port]],
  decode: <T>(value: any): Channel<T> => value as Channel<T>,
});
