import { describe, expect, test } from 'bun:test';
import { isToggleShortcut, shortcutLabel } from './utils';

describe('isToggleShortcut', () => {
  const press = (event: Partial<Parameters<typeof isToggleShortcut>[0]>) =>
    isToggleShortcut({
      key: '\\',
      code: 'Backslash',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...event,
    });

  test('accepts ⌘\\ and Ctrl+\\, by character or by physical key', () => {
    expect(press({ metaKey: true })).toBe(true);
    expect(press({ ctrlKey: true })).toBe(true);
    expect(press({ ctrlKey: true, key: '#' })).toBe(true);
    expect(press({ metaKey: true, code: 'IntlBackslash' })).toBe(true);
  });

  test('rejects a bare backslash, Alt or Shift combos, and other keys', () => {
    expect(press({})).toBe(false);
    expect(press({ metaKey: true, shiftKey: true })).toBe(false);
    expect(press({ ctrlKey: true, altKey: true })).toBe(false);
    expect(press({ metaKey: true, key: 'b', code: 'KeyB' })).toBe(false);
  });
});

test('shortcutLabel shows ⌘ on Apple platforms and Ctrl elsewhere', () => {
  expect(shortcutLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('⌘\\');
  expect(shortcutLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('⌘\\');
  expect(shortcutLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Ctrl+\\');
  expect(shortcutLabel('')).toBe('Ctrl+\\');
});
