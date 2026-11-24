import { describe, expect, it } from 'vitest';
import { MANAGER_PARAMS, GAS_FIELDS, localMainPoolPreview, primaryMintCount } from './main-pool';
import { parseSettings, settingsDraft } from './MainPoolSettings';
import { packManagerAbi, packManagerFactoryAbi, packVaultAbi } from '../../shared/main-pool-abi';

describe('main account owner settings', () => {
  it('round-trips every economic field and named gas coefficient without accepting a different mint fee', () => {
    const draft = settingsDraft(MANAGER_PARAMS);
    const changed = { ...draft, backingRatioBps: '80000', 'gas.scan': '0', gasCeiling: '1.25', acceptedMintFee: '999' };
    const result = parseSettings(changed, MANAGER_PARAMS);
    expect(result.backingRatioBps).toBe(80000);
    expect(result.gasSchedule.scan).toBe(0);
    expect(result.gasCeiling).toBe(1250000000n);
    expect(result.acceptedMintFee).toBe(MANAGER_PARAMS.acceptedMintFee);
    expect(GAS_FIELDS).toHaveLength(28);
    expect(parseSettings(draft, MANAGER_PARAMS)).toEqual(MANAGER_PARAMS);
  });
  it('permits disabling fresh builds and rejects invalid pack values or imprecise gas integers', () => {
    const draft = settingsDraft(MANAGER_PARAMS);
    expect(parseSettings({ ...draft, packUnitsMask: '0' }, MANAGER_PARAMS).packUnitsMask).toBe(0n);
    expect(() => parseSettings({ ...draft, packUnitsMask: '4' }, MANAGER_PARAMS)).toThrow();
    expect(() => parseSettings({ ...draft, 'gas.scan': '4294967296' }, MANAGER_PARAMS)).toThrow();
    expect(() => parseSettings({ ...draft, 'gas.scan': '1.5' }, MANAGER_PARAMS)).toThrow();
    expect(() => parseSettings({ ...draft, backingRatioBps: '9007199254740993' }, MANAGER_PARAMS)).toThrow();
  });
  it('never enables a production preview, including with an explicitly set preview flag', () => {
    expect(localMainPoolPreview(1, 'true')).toBe(false);
    expect(localMainPoolPreview(31337, 'true')).toBe(true);
    expect(localMainPoolPreview(31337, 'false')).toBe(false);
    expect(localMainPoolPreview(31337, undefined)).toBe(false);
  });
  it('counts paid fresh mints for the selected recipe', () => {
    expect(primaryMintCount(3n)).toBe(3n);
    expect(primaryMintCount(5n)).toBe(1n);
    expect(primaryMintCount(30n)).toBe(3n);
  });
  it('exports the account-owned schedule and configuration guard instead of an external policy', () => {
    for (const abi of [packManagerAbi, packManagerFactoryAbi, packVaultAbi]) {
      expect(abi.filter((entry) => 'name' in entry && ['keeperPolicy', 'setPolicy', 'policy', 'cancelRedeem'].includes(entry.name))).toEqual([]);
    }
    const create = packManagerFactoryAbi.find((entry) => entry.type === 'function' && entry.name === 'create');
    expect(create?.inputs.map((input) => input.type)).toEqual(['address', 'tuple', 'bytes32']);
    const params = create?.inputs.find((input) => input.type === 'tuple');
    const gas = params && 'components' in params ? params.components.find((input) => input.name === 'gasSchedule') : undefined;
    expect(gas && 'components' in gas ? gas.components.map((input) => input.name) : []).toEqual(GAS_FIELDS);
    const holder = packVaultAbi.find((entry) => entry.type === 'function' && entry.name === 'holderState');
    expect(holder?.outputs.map((output) => output.name)).toEqual(['shares', 'locked', 'claimable']);
  });
});
