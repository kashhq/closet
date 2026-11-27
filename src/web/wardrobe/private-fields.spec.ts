import { describe, expect, it } from 'vitest';
import {
  type PrivateFields,
  withoutUnread,
  withPrivateFields,
} from './private-fields';

describe('the private fields of an edit or a clone (#680)', () => {
  it('lets an edit stand only on a read that holds both, nulls included', () => {
    const read = { id: 1, price: null, notes: 'Hem' };
    expect(withPrivateFields(read)).toBe(read);
    expect(() => withPrivateFields({ id: 1, notes: 'Hem' })).toThrow();
    expect(() => withPrivateFields({ id: 1, price: '9.00' })).toThrow();
  });

  it('starts a clone with none of what its reader could not read', () => {
    const unread: { id: number } & PrivateFields = { id: 1 };
    expect(withoutUnread(unread)).toEqual({
      id: 1,
      price: null,
      notes: null,
    });
    expect(withoutUnread({ id: 1, price: '9.00', notes: 'Hem' })).toEqual({
      id: 1,
      price: '9.00',
      notes: 'Hem',
    });
  });
});
