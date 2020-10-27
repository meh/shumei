import * as _ from "lodash";
import { Channel } from "./channel";

export class Mailbox<T> {
  private buffer: Array<T>;

  constructor(private channel: Channel<T>) {
    if (!((channel as any) instanceof Channel)) {
      debugger;
    }

    this.buffer = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.channel[Symbol.asyncIterator]();
  }

  send(value: T) {
    this.channel.send(value);
  }

  async recv(): Promise<T> {
    if (_.isEmpty(this.buffer)) {
      return this.channel.recv();
    }

    return this.buffer.shift();
  }

  async match(pred: { (_: T): boolean }): Promise<T> {
    if (!_.isEmpty(this.buffer)) {
      for (const msg of this.buffer) {
        if (pred(msg)) {
          return msg;
        }
      }
    }

    for await (const msg of this.channel) {
      if (pred(msg)) {
        return msg;
      }

      this.buffer.push(msg);
    }
  }

  close() {
    this.channel.close();
  }
}
