import { describe, expect, it } from 'vitest';
import { hostAllowlist, onlyLoopback } from './allowed-hosts';

describe('hostAllowlist (#702)', () => {
  const allows = hostAllowlist(['closet.example.com', 'closet:3000']);

  it.each([
    'closet.example.com',
    'CLOSET.Example.com',
    'closet.example.com:443',
    'closet.example.com:80',
    'closet:3000',
    // The HEALTHCHECK, the smoke test, the dev server and Playwright.
    'localhost',
    'localhost:3802',
    '127.0.0.1:3000',
    '[::1]:3000',
  ])('allows %s', (host) => {
    expect(allows(host)).toBe(true);
  });

  it.each([
    'attacker.example',
    'closet.example.com.attacker.example',
    // A listed name at another port is another authority.
    'closet.example.com:8443',
    'closet',
    'closet:3001',
    // A loopback-looking name that resolves wherever its owner says.
    'localhost.attacker.example',
    '127.0.0.2',
    '',
    'closet.example.com/path',
    'user@closet.example.com',
  ])('refuses %j', (host) => {
    expect(allows(host)).toBe(false);
  });
});

describe('onlyLoopback, the boot warning (#702)', () => {
  it.each([
    [['localhost:3000'], true],
    [['127.0.0.1'], true],
    [['localhost:3000', 'closet.home.arpa'], false],
    [['closet.example.com'], false],
  ])('%j: %s', (hosts, expected) => {
    expect(onlyLoopback(hosts)).toBe(expected);
  });
});
