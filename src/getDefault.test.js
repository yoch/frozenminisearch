import FrozenMiniSearch from './FrozenMiniSearch'
import { getFrozenDefault } from './searchDefaults'

describe('FrozenMiniSearch.getDefault', () => {
  test('returns built-in tokenize, processTerm, extractField', () => {
    expect(FrozenMiniSearch.getDefault('tokenize')('a-b', 'text')).toEqual(['a', 'b'])
    expect(FrozenMiniSearch.getDefault('processTerm')('Foo')).toBe('foo')
    expect(FrozenMiniSearch.getDefault('extractField')({ title: 'x' }, 'title')).toBe('x')
  })

  test('matches getFrozenDefault helper', () => {
    expect(FrozenMiniSearch.getDefault('tokenize')).toBe(getFrozenDefault('tokenize'))
  })

  test('unknown option throws', () => {
    expect(() => FrozenMiniSearch.getDefault('notExisting')).toThrow(
      'FrozenMiniSearch: unknown option "notExisting"',
    )
  })

  test('autoVacuum is not exposed as a frozen default', () => {
    expect(() => FrozenMiniSearch.getDefault('autoVacuum')).toThrow(
      'FrozenMiniSearch: unknown option "autoVacuum"',
    )
  })

  test('logger is not exposed as a frozen default', () => {
    expect(() => FrozenMiniSearch.getDefault('logger')).toThrow(
      'FrozenMiniSearch: unknown option "logger"',
    )
  })
})
