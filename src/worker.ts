import asyncify from "callback-to-async-iterator";
import { Channel } from "./channel";

export class Dedicated<T> extends Channel<T, Worker> {
  constructor(public worker: Worker) {
    super(worker);
  }
}

export function dedicated<T>(source: URL | string): Dedicated<T> {
  if (!(source instanceof URL)) {
    source = URL.createObjectURL(new Blob([source]));
  }

  return new Dedicated(new Worker(source));
}

export class Shared<T> extends Channel<T> {
  constructor(public worker: SharedWorker) {
    super(worker.port);
  }
}

export function shared<T>(source: URL | string): Shared<T> {
  if (!(source instanceof URL)) {
    source = URL.createObjectURL(new Blob([source]));
  }

  return new Shared(new SharedWorker(source.toString()));
}

export function channel<T>(): Channel<T, DedicatedWorkerGlobalScope> {
  return new Channel((self as unknown) as DedicatedWorkerGlobalScope);
}

export function channels<T>(): AsyncIterator<Channel<T>> {
  return asyncify(
    (next) =>
      new Promise(
        () =>
          (((self as unknown) as SharedWorkerGlobalScope).onconnect = (e) => {
            for (const port of e.ports) {
              next(new Channel(port));
            }
          })
      )
  );
}
