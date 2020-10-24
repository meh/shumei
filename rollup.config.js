import pkg from './package.json';
import path from 'path';

import resolve from '@rollup/plugin-node-resolve';
import alias from '@rollup/plugin-alias';
import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';

const dev = process.env.NODE_ENV !== 'production';

export default {
	input: 'src/index.ts',

	output: [{
		file: pkg.main,
		format: 'cjs',
		sourcemap: dev,
	}, {
		file: pkg.module,
		format: 'es',
		sourcemap: dev,
	}],

	plugins: [
		resolve({
			browser: true,
			preferBuiltins: false,
		}),
		alias({
			resolve: ['.js', '.mjs', '.html', '.ts'],
			entries:[{
				find: '~',
				replacement: path.join(__dirname, './src')
			}]
		}),
		commonjs(),
		typescript({ sourceMap: dev }),
	]
};
