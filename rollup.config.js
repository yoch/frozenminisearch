import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'
import terser from '@rollup/plugin-terser'

const production = process.env.NODE_ENV === 'production'

const config = ({ format, input, output, dir, extension = 'js', exports = undefined }) => {
  const shouldMinify = process.env.MINIFY === 'true' && output !== 'dts'
  const outDir = `dist/${dir || format}`

  return {
    input,
    output: {
      sourcemap: !production,
      dir: `dist/${dir || format}`,
      exports,
      format,
      entryFileNames: shouldMinify ? `[name].min.${extension}` : `[name].${extension}`,
      plugins: shouldMinify
        ? [terser({
          mangle: {
            properties: {
              regex: /^_/
            }
          }
        })]
        : []
    },
    plugins: [
      output === 'dts'
        ? dts()
        : typescript(production
          ? { sourceMap: false, compilerOptions: { outDir } }
          : { compilerOptions: { outDir } })
    ]
  }
}

const benchmarks = {
  input: 'benchmarks/index.js',
  output: {
    sourcemap: true,
    dir: 'benchmarks/dist',
    format: 'commonjs',
    entryFileNames: '[name].cjs',
    plugins: []
  },
  external: ['benchmark'],
  plugins: [typescript({ compilerOptions: { outDir: 'benchmarks/dist' } })]
}

const packedRadixBench = {
  input: 'benchmarks/packedRadixTree.js',
  output: {
    sourcemap: true,
    dir: 'benchmarks/dist',
    format: 'commonjs',
    entryFileNames: 'packedRadixTree.cjs',
    plugins: []
  },
  external: ['benchmark'],
  plugins: [
    typescript({
      include: ['benchmarks/**/*.js', 'src/**/*.ts'],
      compilerOptions: { outDir: 'benchmarks/dist', rootDir: '.' },
    }),
  ],
}

function rollupExports () {
  if (process.env.PACKED_RADIX_BENCH === 'true') return [packedRadixBench]
  if (process.env.BENCHMARKS === 'true') return [benchmarks]
  return [
  config({ format: 'es', input: 'src/index.ts', output: 'es6', dir: 'es' }),
  config({ format: 'cjs', input: 'src/index.ts', output: 'cjs', dir: 'cjs', extension: 'cjs', exports: 'named' }),
  config({ format: 'es', input: 'src/index.ts', output: 'dts', dir: 'es', extension: 'd.ts' })
  ]
}

export default rollupExports()
