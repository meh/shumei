import asyncify from "callback-to-async-iterator";
import { codec, encode, decode } from "./protocol";

export interface PortLike {
  onmessage: (ev: MessageEvent) => any;
  onmessageerror: (ev: MessageEvent) => any;
  postMessage(message: any, transfer: Transferable[]): void;
}

export interface Receiver<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export interface Sender<T> {
  postMessage(message: any, transfer: Transferable[]): void;
}

export class Channel<T, P extends PortLike = MessagePort>
  implements Sender<T>, Receiver<T> {
  protected iter: AsyncIterator<T>;

  constructor(public port: P) {
    this.iter = asyncify(
      (next) =>
        new Promise((_, reject) => {
          port.onmessage = (e: MessageEvent) => next(decode(e.data));
          port.onmessageerror = (e: MessageEvent) => reject(e);
        })
    );
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iter;
  }

  postMessage(message: any, transfer: Transferable[]) {
    this.port.postMessage(message, transfer);
  }

  send(value: T) {
    send(this, value);
  }

  async recv(): Promise<T> {
    return await recv(this);
  }
}

export function pair<T>(): [Channel<T>, Channel<T>] {
  const channel = new MessageChannel();
  return [new Channel(channel.port1), new Channel(channel.port2)];
}

export function send<T>(sender: Sender<T>, value: T) {
  const [message, transfer] = encode(value);
  sender.postMessage(message, transfer);
}

export async function recv<T>(receiver: Receiver<T>): Promise<T> {
  return (await receiver[Symbol.asyncIterator]().next()).value;
}

codec("CHANNEL", {
  canHandle: <T>(value: unknown): value is Channel<T> =>
    value instanceof Channel,
  encode: <T>(channel: Channel<T>) => [channel, [channel.port]],
  decode: <T>(value: any): Channel<T> => value as Channel<T>,
});
