import stylistic from '@stylistic/eslint-plugin'
import neostandard from 'neostandard'
import globals from 'globals'

const tseslint = neostandard.plugins['typescript-eslint']

const styleConfig = stylistic.configs.customize({
  severity: 'warn',
  semi: false,
  quotes: 'single',
  indent: 2,
  braceStyle: '1tbs'
})

export default [
  ...neostandard({ ts: true, noStyle: true }),
  styleConfig,
  {
    rules: {
      'no-prototype-builtins': 'off',
      'no-use-before-define': 'off',
      // Not part of legacy standard; mostly `if (x) return` one-liners.
      '@stylistic/max-statements-per-line': 'off'
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
    files: ['src/**/*.test.{js,ts}'],
    languageOptions: {
      globals: globals.jest
    }
  }
]
