Shumei
======
>Shūmei (襲名, "name succession") are grand naming ceremonies held in kabuki
>theatre. Most often, a number of actors will participate in a single ceremony,
>taking on new stage-names.

Shumei brings an actor system and other concurrency plumbing primitives to the
web.

Example
=======
This is an example using [rollup-plugin-rollup](https://github.com/meh/rollup-plugin-rollup)
to be able to inline the worker code.

A file named `worker.rollup.js`:
```js
import path from 'path';
import resolve from '@rollup/plugin-node-resolve';
import alias from '@rollup/plugin-alias';
import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';
import rust from '@wasm-tool/rollup-plugin-rust';
import rollup from 'rollup-plugin-rollup';
import json from '@rollup/plugin-json';
import { terser } from 'rollup-plugin-terser';

const dev = process.env.NODE_ENV !== 'production';

export default {
  input: 'src/worker.ts',

  output: {
    format: 'es',
    sourcemap: dev && 'inline',
  },

  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    alias({
      resolve: ['.js', '.mjs', '.html', '.ts'],
      entries:[{
        find: '~',
        replacement: path.join(__dirname, '.')
      }]
    }),
    commonjs({
      include: '../node_modules/**'
    }),
    typescript({ sourceMap: dev }),
    rust({ debug: dev }),
    json(),
    rollup(),
    !dev && terser(),
  ]
}
```


A file named `worker.ts`:
```ts
import { stage } from "shumei";

stage.register("add", async function*() {
  while (true) {
    const { from, a, b } = yield;
    from.send(a + b);
  }
});

stage.register("sub", async function*() {
  while (true) {
    const { from, a, b } = yield;
    from.send(a - b);
  }
});

stage.ready();
```

A file named `index.ts`:
```ts
import WORKER from 'worker.rollup';
import { stage, Actor } from "shumei";

(async () => {
  await stage.dedicated(WORKER);

  stage.spawn(async function*(self: Actor<number>) {
    const add = await stage.actor("add");
    const sub = await stage.actor("sub");

    let result = 0;
    add.send({ from: self, a: 2, b: 3 });
    result = yield;
    sub.send({ from: self, a: result, b: 2 });
    result = yield;

    console.log(`IT'S ${result} GODDAMMIT!`);
  });
})();
```

Actor System
============
This section is not going to explain what the actor system is and why this is a
good idea, but instead explain how the system works and how to use it.

Channel
-------
TODO

Remote Values
-------------
TODO
