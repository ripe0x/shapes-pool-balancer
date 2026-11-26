import { expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import { creationAllowed, supportsCreationPause } from './factory-creation';

const admin = '0x0000000000000000000000000000000000000001' as const;
const creator = '0x0000000000000000000000000000000000000002' as const;
it('recognizes a pause dispatcher without treating a legacy factory as paused', () => {
  expect(supportsCreationPause(`0x63${toFunctionSelector('creationPaused()').slice(2)}1460`)).toBe(true);
  expect(supportsCreationPause('0x6001600055')).toBe(false);
});
it('allows only the policy admin canary while public creation is paused', () => {
  expect(creationAllowed(true, admin, creator)).toBe(false);
  expect(creationAllowed(true, admin)).toBe(false);
  expect(creationAllowed(true, admin, admin)).toBe(true);
  expect(creationAllowed(false, admin, creator)).toBe(true);
});
