import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'
import terser from '@rollup/plugin-terser'

const production = process.env.NODE_ENV === 'production'

const config = ({ format, input, output, dir, extension = 'js', exports = undefined }) => {
  const shouldMinify = process.env.MINIFY === 'true' && output !== 'dts'
  const outDir = `dist/${dir || format}`

  return {
    input,
    // Node builtins (e.g. node:zlib) stay external: they are resolved by the Node runtime,
    // never bundled. Declaring them silences Rollup's "Unresolved dependencies" warning.
    external: [/^node:/],
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

const packedRadixBenchPlugins = [
  typescript({
    include: ['benchmarks/**/*.js', 'src/**/*.ts'],
    compilerOptions: { outDir: 'benchmarks/dist', rootDir: '.' },
  }),
]

const packedRadixBench = {
  input: 'benchmarks/packedRadixTree.js',
  output: {
    sourcemap: true,
    dir: 'benchmarks/dist',
    format: 'commonjs',
    entryFileNames: 'packedRadixTree.cjs',
    plugins: [],
  },
  external: ['benchmark'],
  plugins: packedRadixBenchPlugins,
}

const packedRadixFuzzyBench = {
  input: 'benchmarks/packedRadixFuzzy.js',
  output: {
    sourcemap: true,
    dir: 'benchmarks/dist',
    format: 'commonjs',
    entryFileNames: 'packedRadixFuzzy.cjs',
    plugins: [],
  },
  external: ['benchmark'],
  plugins: packedRadixBenchPlugins,
}

const packedRadixFuzzySweepBench = {
  input: 'benchmarks/packedRadixFuzzySweep.js',
  output: {
    sourcemap: true,
    dir: 'benchmarks/dist',
    format: 'commonjs',
    entryFileNames: 'packedRadixFuzzySweep.cjs',
    plugins: [],
  },
  external: ['benchmark'],
  plugins: packedRadixBenchPlugins,
}

function rollupExports () {
  if (process.env.PACKED_RADIX_BENCH === 'true') {
    return [packedRadixBench, packedRadixFuzzyBench, packedRadixFuzzySweepBench]
  }
  if (process.env.BENCHMARKS === 'true') return [benchmarks]
  return [
  config({ format: 'es', input: 'src/index.ts', output: 'es6', dir: 'es' }),
  config({ format: 'cjs', input: 'src/index.ts', output: 'cjs', dir: 'cjs', extension: 'cjs', exports: 'named' }),
  config({ format: 'es', input: 'src/index.ts', output: 'dts', dir: 'es', extension: 'd.ts' })
  ]
}

export default rollupExports()
