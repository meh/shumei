import * as _ from "lodash";
import { Wire, codec } from "./protocol";

export namespace Message {
  export type ID = string;

  export const enum Type {
    GET,
    SET,
    APPLY,
    CONSTRUCT,
    ENDPOINT,
    RELEASE,
  }

  export interface Get {
    id?: ID;
    type: Type.GET;
    path: string[];
  }

  export interface Set {
    id?: ID;
    type: Type.SET;
    path: string[];
    value: Wire.Value;
  }

  export interface Apply {
    id?: ID;
    type: Type.APPLY;
    path: string[];
    argumentList: Wire.Value[];
  }

  export interface Construct {
    id?: ID;
    type: Type.CONSTRUCT;
    path: string[];
    argumentList: Wire.Value[];
  }

  export interface Endpoint {
    id?: ID;
    type: Type.ENDPOINT;
  }

  export interface Release {
    id?: ID;
    type: Type.RELEASE;
    path: string[];
  }

  export type Any = Get | Set | Apply | Construct | Endpoint | Release;
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

    encode({ value }) {
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

    decode(encoded: Encoded) {
      throw encoded.isError
        ? Object.assign(new Error(encoded.value.message), encoded.value)
        : encoded.value;
    },
  });
}
