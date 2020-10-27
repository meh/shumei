import { v4 as uuid } from "uuid";
import * as _ from "lodash";
import { Wire, codec, transfer, encode, decode } from "./protocol";
import { Channel, pair as mkChannelPair } from "./channel";
import { Mailbox } from "./mailbox";

namespace Message {
  export type ID = string;

  export const enum Type {
    CONSTRUCT,
    APPLY,
    GET,
    SET,
    DELETE,
  }

  export namespace Construct {
    export interface Request {
      id: ID;
      type: Type.CONSTRUCT;
      arguments: Wire.Value[];
    }

    export interface Response {
      id: ID;
      type: Type.CONSTRUCT;
      value: Wire.Value;
    }
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
    | Construct.Request
    | Apply.Request
    | Get.Request
    | Set.Request
    | Delete.Request;

  export type Response =
    | Construct.Response
    | Apply.Response
    | Get.Response
    | Set.Response
    | Delete.Response;

  export type Any = Request | Response;
}

export namespace Thrown {
  const MARKER = Symbol("shumei.thrown");

  export interface Value {
    [MARKER]: true;
    value: Wire.Clonable;
  }

  export type Encoded =
    | { isError: true; value: Error }
    | { isError: false; value: Wire.Clonable };

  codec("throw", {
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

const MARKER = Symbol("shumei.remote");

/**
 * A value marked as remote.
 */
interface Marked {
  [MARKER]: true;
}

/**
 * Mark a value as remote.
 */
export function value<T extends object>(value: T): T & Marked {
  return Object.assign(value, { [MARKER]: true }) as any;
}

/**
 * Turns a type into a Promise if it is not one already.
 */
type AsPromise<T> = T extends Promise<unknown> ? T : Promise<T>;

/**
 * The inverse of `AsPromise<T>`.
 */
type AsNotPromise<P> = P extends Promise<infer T> ? T : P;

/**
 * Either sync or async value.
 */
type MaybePromise<T> = Promise<T> | T;

export namespace Local {
  /**
   * Turns a value into a local or leaves it as a clonable.
   */
  export type AsValue<T> = T extends Remote.Object<Marked>
    ? Value<T>
    : T extends Wire.Clonable
    ? T
    : never;

  /**
   * A local property.
   */
  export type Property<T> = T extends Function | Marked
    ? Value<T>
    : AsNotPromise<T>;

  /**
   * A local object.
   */
  export type Object<T> = { [P in keyof T]: Property<T[P]> };

  /**
   * A local value.
   */
  export type Value<T> = Object<T> &
    (T extends (...args: infer Arguments) => infer Return
      ? (
          ...args: { [I in keyof Arguments]: Remote.AsValue<Arguments[I]> }
        ) => MaybePromise<AsValue<AsNotPromise<Return>>>
      : unknown) &
    (T extends { new (...args: infer Arguments): infer Instance }
      ? {
          new (
            ...args: {
              [I in keyof Arguments]: Remote.AsValue<Arguments[I]>;
            }
          ): MaybePromise<Value<AsNotPromise<Instance>>>;
        }
      : unknown);
}

export namespace Remote {
  /**
   * Turns a value into a remote or makes it be cloned.
   */
  export type AsValue<T> = T extends Marked
    ? Value<T>
    : T extends Wire.Clonable
    ? T
    : never;

  /**
   * A remote property.
   */
  export type Property<T> = T extends Function | Marked
    ? Value<T>
    : AsPromise<T>;

  /**
   * A remote object.
   */
  export type Object<T> = { [P in keyof T]: Property<T[P]> };

  /**
   * A remote value.
   */
  export type Value<T> = Object<T> &
    (T extends (...args: infer Arguments) => infer Return
      ? (
          ...args: { [I in keyof Arguments]: Local.AsValue<Arguments[I]> }
        ) => AsPromise<AsValue<AsNotPromise<Return>>>
      : unknown) &
    (T extends { new (...args: infer Arguments): infer Instance }
      ? {
          new (
            ...args: {
              [I in keyof Arguments]: Local.AsValue<Arguments[I]>;
            }
          ): AsPromise<Value<Instance>>;
        }
      : unknown);
}

/**
 * A remotely accessible value.
 */
export function remote<T>(channel: Channel<Message.Any>): Remote.Value<T> {
  const mbox = new Mailbox(channel);
  const encodeAll = (args: any) => _.reduce(
    args,
    ([args, transferable], val: any) => {
      const [arg, transfer] = encode(val);
      return [
        [...args, arg],
        [...transferable, ...transfer],
      ];
    },
    [[], []]
  );

  // XXX(meh): If the `target` is not a function then `apply` won't be called,
  //           and we need that.
  return new Proxy(() => {}, {
    async construct(_target: any, argArray: any, _newTarget?: any): Promise<object> {
      const id = uuid();
      const [args, transferable] = encodeAll(argArray);
      const message = <Message.Construct.Request>{
        id,
        type: Message.Type.CONSTRUCT,
        arguments: args,
      };

      transfer(message, transferable);
      mbox.send(message);

      const response = (await mbox.match(
        (msg: Message.Any) => msg.id == id
      )) as Message.Construct.Response;

      return response.value;
    },

    async apply(_target: any, _thisArg: any, argArray?: any): Promise<any> {
      const id = uuid();
      const [args, transferable] = encodeAll(argArray || []);
      const message = <Message.Apply.Request>{
        id,
        type: Message.Type.APPLY,
        arguments: args,
      };

      transfer(message, transferable);
      mbox.send(message);

      const response = (await mbox.match(
        (msg: Message.Any) => msg.id == id
      )) as Message.Apply.Response;

      return response.value;
    },

    async get(_target: any, p: PropertyKey, _receiver: any): Promise<any> {
      // XXX(meh): When a `Proxy` is awaited "then" is requested, this should return a value
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

      mbox.send(message);

      const response = (await mbox.match(
        (msg: Message.Any) => msg.id == id
      )) as Message.Get.Response;

      return response.value;
    },

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
      mbox.send(message);
      mbox.match((msg: Message.Any) => msg.id == id);

      return true;
    },

    deleteProperty(_target: any, p: PropertyKey): boolean {
      const id = uuid();
      const message = <Message.Delete.Request>{
        id,
        type: Message.Type.DELETE,
        prop: p,
      };

      mbox.send(message);
      mbox.match((msg: Message.Any) => msg.id == id);

      return true;
    },
  });
}

/**
 * Spawn a new remote handler that can respond to control messages.
 */
export function spawn(value: any): Channel<Message.Any> {
  const [master, slave] = mkChannelPair<Message.Any>();
  const handle = (channel: Channel<Message.Any>) => {
    channel.recv().then((msg) => {
      switch (msg.type) {
        case Message.Type.CONSTRUCT:
          {
            const request = msg as Message.Construct.Request;
            const [encoded, transferable] = encode(
              Reflect.construct(value, request.arguments)
            );

            const message = <Message.Construct.Response>{
              id: msg.id,
              type: Message.Type.CONSTRUCT,
              value: encoded,
            };

            transfer(message, transferable);
            master.send(message);
          }
          break;

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

codec("Function", {
  canHandle: (value: unknown): value is Function => _.isFunction(value),
  encode: (value) => encode(spawn(value)),
  decode: (value: any): Remote.Value<Function> => remote(decode(value)),
});

codec("Remote", {
  canHandle: (value: unknown): value is Marked =>
    _.isObject(value) && (value as Marked)[MARKER],
  encode: (value) => encode(spawn(value)),
  decode: <T>(value: any): Remote.Value<T> => remote(decode(value)),
});
