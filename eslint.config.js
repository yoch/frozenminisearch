import neostandard from 'neostandard'
import globals from 'globals'

const tseslint = neostandard.plugins['typescript-eslint']

export default [
  ...neostandard({ ts: true, noStyle: true }),
  {
    rules: {
      'no-prototype-builtins': 'off',
      'no-use-before-define': 'off',
      // Formatter-owned: prettier-style reflow splits `if (x) return y`
      // one-liners into multi-line statements without adding braces.
      'curly': 'off'
    }
  },
  {
    files: ['**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: false, variables: false }
      ]
    }
  },
  {
    files: ['src/**/*.test.{js,ts}', 'benchmarks/**/*.test.{js,ts}'],
    languageOptions: {
      globals: globals.vitest
    }
  }
]
