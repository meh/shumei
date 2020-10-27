import { v4 as uuid } from "uuid";
import * as _ from "lodash";
import { Wire, codec, transfer, encode, decode } from "./protocol";
import { Channel, pair as mkChannelPair } from "./channel";
import { Mailbox } from "./mailbox";

export namespace Message {
  export type ID = string;

  export const enum Type {
    APPLY,
    GET,
    SET,
    DELETE,
  }

  export namespace Apply {
    export interface Request {
      id: ID;
      type: Type.APPLY;
      arguments: Wire.Value[];
    }

    export interface Response {
      id: ID;
      type: Type.APPLY;
      value: Wire.Value;
    }
  }

  export namespace Get {
    export interface Request {
      id: ID;
      type: Type.GET;
      prop: PropertyKey;
    }

    export interface Response {
      id: ID;
      type: Type.GET;
      value: Wire.Value;
    }
  }

  export namespace Set {
    export interface Request {
      id: ID;
      type: Type.SET;
      prop: PropertyKey;
      value: Wire.Value;
    }

    export interface Response {
      id: ID;
      type: Type.SET;
    }
  }

  export namespace Delete {
    export interface Request {
      id: ID;
      type: Type.DELETE;
      prop: PropertyKey;
    }

    export interface Response {
      id: ID;
      type: Type.DELETE;
    }
  }

  export type Request =
    | Apply.Request
    | Get.Request
    | Set.Request
    | Delete.Request;

  export type Response =
    | Apply.Response
    | Get.Response
    | Set.Response
    | Delete.Response;

  export type Any = Request | Response;
}

export namespace Thrown {
  const MARKER = Symbol("shumei.thrown");

  export interface Value {
    [MARKER]: unknown;
    value: unknown;
  }

  export type Encoded =
    | { isError: true; value: Error }
    | { isError: false; value: unknown };

  codec("THROW", {
    canHandle: (value: any): value is Value =>
      _.isObject(value) && MARKER in value,

    encode: ({ value }) => {
      let encoded: Encoded = {
        isError: false,
        value,
      };

      if (value instanceof Error) {
        encoded = {
          isError: true,
          value: {
            message: value.message,
            name: value.name,
            stack: value.stack,
          },
        };
      }

      return [encoded, []];
    },

    decode: (encoded: Encoded) => {
      throw encoded.isError
        ? Object.assign(new Error(encoded.value.message), encoded.value)
        : encoded.value;
    },
  });
}

export class Remote<T extends object> {
  private mbox: Mailbox<Message.Any>;

  constructor(channel: Channel<Message.Any>) {
    this.mbox = new Mailbox(channel);
    return new Proxy(() => {}, this);
  }

  static handler(value: any): Channel<Message.Any> {
    const [master, slave] = mkChannelPair<Message.Any>();
    const handle = (channel: Channel<Message.Any>) => {
      channel.recv().then((msg) => {
        switch (msg.type) {
          case Message.Type.APPLY:
            {
              const request = msg as Message.Apply.Request;
              const [encoded, transferable] = encode(
                Reflect.apply(value, undefined, request.arguments)
              );

              const message = <Message.Apply.Response>{
                id: msg.id,
                type: Message.Type.APPLY,
                value: encoded,
              };

              transfer(message, transferable);
              master.send(message);
            }
            break;

          case Message.Type.GET:
            {
              const request = msg as Message.Get.Request;
              const [encoded, transferable] = encode(
                Reflect.get(value, request.prop)
              );

              const message = <Message.Get.Response>{
                id: msg.id,
                type: Message.Type.GET,
                value: encoded,
              };

              transfer(message, transferable);
              master.send(message);
            }
            break;

          case Message.Type.SET:
            {
              const request = msg as Message.Set.Request;
              Reflect.set(value, request.prop, request.value);

              const message = <Message.Set.Response>{
                id: msg.id,
                type: Message.Type.SET,
              };

              master.send(message);
            }
            break;

          case Message.Type.DELETE:
            {
              const request = msg as Message.Delete.Request;
              Reflect.deleteProperty(value, request.prop);

              const message = <Message.Delete.Response>{
                id: msg.id,
                type: Message.Type.DELETE,
              };

              master.send(message);
            }
            break;
        }

        handle(channel);
      });
    };

    handle(master);
    return slave;
  }

  async apply(_target: any, _thisArg: any, argArray?: any): Promise<any> {
    const id = uuid();
    const [args, transferable] = _.reduce(
      argArray,
      ([args, transferable], val: any) => {
        const [arg, transfer] = encode(val);
        return [
          [...args, arg],
          [...transferable, ...transfer],
        ];
      },
      [[], []]
    );

    const message = <Message.Apply.Request>{
      id,
      type: Message.Type.APPLY,
      arguments: args,
    };

    transfer(message, transferable);
    this.mbox.send(message);

    const response = (await this.mbox.match(
      (msg: Message.Any) => msg.id == id
    )) as Message.Apply.Response;

    return response.value;
  }

  async get(_target: any, p: PropertyKey, _receiver: any): Promise<any> {
    // XXX(meh): When a `Proxy` is awaited "then" is gotten, this should return a value
    //           with a `then` property or it's going to lead to infinite recursion.
    if (p == "then") {
      return Promise.resolve(this);
    }

    const id = uuid();
    const message = <Message.Get.Request>{
      id,
      type: Message.Type.GET,
      prop: p,
    };

    this.mbox.send(message);

    const response = (await this.mbox.match(
      (msg: Message.Any) => msg.id == id
    )) as Message.Get.Response;

    return response.value;
  }

  set(_target: any, p: PropertyKey, value: any, _receiver: any): boolean {
    const id = uuid();
    const [encoded, transferable] = encode(value);

    const message = <Message.Set.Request>{
      id,
      type: Message.Type.SET,
      prop: p,
      value: encoded,
    };

    transfer(message, transferable);
    this.mbox.send(message);
    this.mbox.match((msg: Message.Any) => msg.id == id);

    return true;
  }

  deleteProperty(_target: any, p: PropertyKey): boolean {
    const id = uuid();
    const message = <Message.Delete.Request>{
      id,
      type: Message.Type.DELETE,
      prop: p,
    };

    this.mbox.send(message);
    this.mbox.match((msg: Message.Any) => msg.id == id);

    return true;
  }
}

export function value<T>(value: T): T & Marked {
  return Object.assign(value, { [MARKER]: true }) as any;
}

export const MARKER = Symbol("shumei.remote");

export interface Marked {
  [MARKER]: true;
}

codec("Function", {
  canHandle: (value: unknown): value is Function => _.isFunction(value),
  encode: (value) => encode(Remote.handler(value)),
  decode: <T extends object>(value: any) => new Remote<T>(decode(value)),
});

codec("Remote", {
  canHandle: (value: unknown): value is Marked =>
    _.isObject(value) && (value as Marked)[MARKER],
  encode: (value) => encode(Remote.handler(value)),
  decode: <T extends object>(value: any) => new Remote<T>(decode(value)),
});
