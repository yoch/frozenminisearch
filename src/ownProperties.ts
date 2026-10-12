/** Assign an arbitrary field/term name without invoking Object.prototype's setter. */
export function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    target[key] = value
  }
}

/** Preserve Object.assign's overwrite semantics, including an own __proto__ key. */
export function assignOwnProperties<T>(target: Record<string, T>, source: Record<string, T> | undefined): void {
  if (source != null && Object.hasOwn(source, '__proto__')) setOwnProperty(target, '__proto__', Reflect.get(source, '__proto__'))
  Object.assign(target, source)
}
