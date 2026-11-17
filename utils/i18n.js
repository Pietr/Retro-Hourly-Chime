import { getText } from '@zos/i18n'

export function t(key, fallback) {
  try {
    const val = getText(key)
    if (typeof val === 'string' && val.length > 0 && val !== key) {
      return val
    }
  } catch (e) {}
  return fallback !== undefined ? fallback : key
}
