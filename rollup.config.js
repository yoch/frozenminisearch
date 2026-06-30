import typescript from '@rollup/plugin-typescript'
import resolve from '@rollup/plugin-node-resolve'
import dts from 'rollup-plugin-dts'
import terser from '@rollup/plugin-terser'

const production = process.env.NODE_ENV === 'production'
const terserPlugin = terser({
  compress: {
    passes: 2,
    pure_getters: true,
    unsafe_arrows: true,
    dead_code: true,
  },
  mangle: {
    properties: {
      regex: /^_/
    }
  },
  format: {
    comments: false,
  },
})

const config = ({ format, input, output, dir, extension = 'js', exports = undefined }) => {
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
      entryFileNames: `[name].${extension}`,
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
  external: [/^node:/, 'benchmark', 'minisearch/SearchableMap'],
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
  external: [/^node:/, 'minisearch', 'minisearch/SearchableMap'],
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
  external: [/^node:/, 'benchmark', 'minisearch', 'minisearch/SearchableMap'],
  plugins: packedRadixBenchPlugins,
}

const packedRadixEmitSubtreeBench = {
  input: 'benchmarks/packedRadixEmitSubtree.js',
  output: {
    sourcemap: true,
    dir: 'benchmarks/dist',
    format: 'commonjs',
    entryFileNames: 'packedRadixEmitSubtree.cjs',
    plugins: [],
  },
  external: [/^node:/, 'minisearch/SearchableMap'],
  plugins: packedRadixBenchPlugins,
}

function rollupExports () {
  if (process.env.PACKED_RADIX_BENCH === 'true') {
    return [packedRadixBench, packedRadixFuzzyBench, packedRadixFuzzySweepBench, packedRadixEmitSubtreeBench]
  }
  return [
  config({ format: 'es', input: 'src/index.ts', output: 'es6', dir: 'es' }),
  config({ format: 'cjs', input: 'src/index.ts', output: 'cjs', dir: 'cjs', extension: 'cjs', exports: 'named' }),
  config({ format: 'es', input: 'src/index.ts', output: 'dts', dir: 'es', extension: 'd.ts' }),
  {
    input: 'src/browser.ts',
    treeshake: {
      moduleSideEffects: false,
    },
    output: {
      sourcemap: !production,
      file: 'dist/browser/index.js',
      format: 'es',
      plugins: production ? [terserPlugin] : [],
    },
    plugins: [
      resolve({
        browser: true,
      }),
      typescript(production
        ? { sourceMap: false, compilerOptions: { outDir: 'dist/browser', sourceMap: false } }
        : { sourceMap: true, compilerOptions: { outDir: 'dist/browser', sourceMap: true } }),
    ],
  },
  {
    input: 'src/browser.ts',
    output: {
      file: 'dist/browser/index.d.ts',
      format: 'es',
    },
    plugins: [dts()],
  },
  ]
}

export default rollupExports()
