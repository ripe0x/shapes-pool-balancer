/**
 * The personal manager's pack mix: how many packs of each size it builds and keeps listed on FWA's main pool. Mirrors
 * the community designer: a preset fills the mix, the pack-count control scales it, and counts can be set by hand.
 * On chain the mix is `PackAccount.design` (byte u = packs of u x 0.01 ETH) plus the matching `packUnitsMask`.
 */

/** PackAccount limits: pack sizes in 0.01 ETH units, and at most 255 packs of one size. */
export const MIN_UNITS = 3;
export const MAX_UNITS = 30;
export const MAX_PER_SIZE = 255;
/** The pack-count control's top. */
export const MAX_PACKS = 100;

/** Units -> pack count. Sizes without packs are absent or 0. */
export type PackMix = Record<number, number>;

export type PackStyle = 'small' | 'balanced' | 'large';
/** Preset proportions: units -> weight. */
export const PACK_STYLES: Record<PackStyle, PackMix> = {
  small: { 3: 1 },
  balanced: { 3: 2, 5: 1, 10: 1 },
  large: { 10: 1 },
};

/** Sizes offered for adjusting by hand, smallest first, plus any size a mix already uses. */
export const HAND_SIZES = [3, 4, 5, 6, 8, 10, 15, 20, 25, 30];

export const packCount = (m: PackMix) => Object.values(m).reduce((s, n) => s + n, 0);
export const sizesOf = (m: PackMix) => Object.keys(m).map(Number).filter((u) => m[u] > 0).sort((a, b) => a - b);

/**
 * A mix scaled to `total` packs, keeping its proportions: largest-remainder rounding, so the counts sum to `total`
 * exactly; ties go to the smaller size.
 */
export function scaleMix(m: PackMix, total: number): PackMix {
  const sizes = sizesOf(m);
  if (!sizes.length) return presetMix('small', total);
  const sum = packCount(m);
  const n = Math.max(1, Math.min(MAX_PACKS, Math.floor(total)));
  const mix: PackMix = {};
  for (const u of sizes) mix[u] = Math.floor((n * m[u]) / sum);
  const rest = sizes.map((u) => ({ u, r: (n * m[u]) % sum })).sort((a, b) => b.r - a.r || a.u - b.u);
  for (let i = 0; packCount(mix) < n; i++) mix[rest[i % rest.length].u]++;
  return Object.fromEntries(Object.entries(mix).filter(([, c]) => c > 0).map(([u, c]) => [u, Math.min(MAX_PER_SIZE, c)]));
}

export const presetMix = (style: PackStyle, total: number) => scaleMix(PACK_STYLES[style], total);

/** `PackAccount.design` and `packUnitsMask` for a mix. Throws on a size or count the contract refuses. */
export function encodeMix(m: PackMix): { design: bigint; mask: bigint } {
  let design = 0n, mask = 0n;
  for (const u of sizesOf(m)) {
    if (!Number.isInteger(u) || u < MIN_UNITS || u > MAX_UNITS) throw new Error(`No ${u / 100} ETH packs`);
    if (!Number.isInteger(m[u]) || m[u] > MAX_PER_SIZE) throw new Error(`At most ${MAX_PER_SIZE} packs of one size`);
    design |= BigInt(m[u]) << BigInt(8 * u);
    mask |= 1n << BigInt(u);
  }
  if (!design) throw new Error('Choose at least one pack');
  return { design, mask };
}

/** The mix a manager's `design` encodes (empty for 0: no counts set). */
export function decodeMix(design: bigint): PackMix {
  const m: PackMix = {};
  for (let u = MIN_UNITS; u <= MAX_UNITS; u++) {
    const n = Number((design >> BigInt(8 * u)) & 0xffn);
    if (n) m[u] = n;
  }
  return m;
}

/**
 * ETH to fund a mix: per size, `perPack[u]` (one pack's Shapes, backing, mint fees and build pay cap, from
 * PackManagerFactory.preview less its reserve) times its count, plus the operating reserve once.
 */
export function fundingFor(m: PackMix, perPack: Record<number, bigint>, reserve: bigint): bigint | undefined {
  let total = reserve;
  for (const u of sizesOf(m)) {
    if (perPack[u] === undefined) return undefined;
    total += perPack[u] * BigInt(m[u]);
  }
  return total;
}

/** VaultLib backing for a pack of `u` units: value x ratio, floored to 10,000 wei. */
export const backingOf = (u: number, bps: number) => BigInt(u) * 10n ** 16n * BigInt(bps) / 10_000n / 10_000n * 10_000n;
/** A weight's share of a total, as a probability. */
export const shareOf = (w: bigint, total: bigint) => (total > 0n ? Number((w * 10n ** 12n) / total) / 1e12 : 0);

export const sizeLabel = (u: number) => `${(u / 100).toFixed(2)} ETH pack`;
export const mixText = (m: PackMix) => sizesOf(m).map((u) => `${m[u]} × ${(u / 100).toFixed(2)}`).join(', ');
