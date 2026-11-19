import { afterEach, describe, expect, it } from 'vitest';
import { releasePrototypeLeaks } from '../support/prototype-hygiene';

type Probed = Record<string, () => string>;

// A leak is reported for the file that made it, then hidden: left enumerable
// it would fail every later file in the worker (#620, #629).
describe('releasePrototypeLeaks', () => {
  const KEY = '__prototypeHygieneProbe';

  afterEach(() => {
    Reflect.deleteProperty(Array.prototype, KEY);
  });

  it('names an enumerable key, then hides it so the next file starts clean', () => {
    Object.defineProperty(Array.prototype, KEY, {
      value: () => 'kept',
      enumerable: true,
      configurable: true,
    });
    expect(releasePrototypeLeaks()).toEqual([`Array.prototype.${KEY}`]);
    expect(releasePrototypeLeaks()).toEqual([]);
    // Hidden, not removed: the library that added it still calls it.
    expect((Array.prototype as unknown as Probed)[KEY]()).toBe('kept');
  });
});
