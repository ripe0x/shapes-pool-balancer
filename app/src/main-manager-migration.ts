import { BaseError, ContractFunctionRevertedError, decodeFunctionData, decodeEventLog, encodeFunctionData, parseAbi, type Abi, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { packManagerAbi, packManagerFactoryAbi, fwaV2Abi } from '../../shared/main-pool-abi';
import { MANAGER_FACTORY, readManager, type Manager } from './main-pool';
import { assertExitReplacementNonce, checkExitSpend, exitBatches, reserveExitReplacement, signedExitMaximum, type ExitCall, type ExitReview, type ExitSpend, type SavedExitSpend } from './main-pool-exit';
import { managerQueueAbi, requireManagerQueueProgress } from './main-manager-exit';
import { assertTransactionIntent, prepareTransfer, prepareWrite, reviewedIntent, type TransactionIntent } from './tx';

export const migrationAbi = parseAbi(['function importPacks(uint256[] ids,bytes32 expected)', 'function unlistForWithdrawal(uint256[] ids)', 'function withdrawRecoveryPack(address to,uint256 index,uint256 expectedPackId)', 'error BadBatch()']);
const assetAbi = parseAbi(['function ownerOf(uint256 id) view returns(address)', 'function claimantOf(uint256 id) view returns(address)', 'function contentsOf(uint256 id) view returns(uint256[])', 'function valueOf(uint256 id) view returns(uint256)', 'function packOf(uint256 id) view returns(uint256)', 'function backingOf(uint256 id) view returns(uint256)', 'function shapes() view returns(address)', 'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type MigrationPending = NonNullable<SavedExitSpend['pending']> & { hash: Hash; nonce: number };
export interface MigrationReceipt { pending: MigrationPending; blockNumber: string; blockHash: Hash; success: boolean; packIds: string[] }
interface Anchor { number: string; hash: Hash }
export interface Migration { destination: Address; packIds: string[]; ethAmount: string; ethSent: boolean; manualIds?: string[]; proofCursor?: number; recoveryCursor?: string;
  receipts?: MigrationReceipt[]; anchor?: Anchor; recheck?: { cursor: number; head: Anchor }; blocked?: string }
export function migrationObservations(migration: Migration, receipts: MigrationReceipt[], trusted: boolean): Migration {
  const canonical = trusted ? receipts : [];
  return { ...migration, receipts, packIds: [...new Set([...(migration.manualIds ?? []), ...canonical.filter((r) => r.success).flatMap((r) => r.packIds)])],
    ethSent: canonical.some((r) => r.success && r.pending.input === '0x' && r.pending.to?.toLowerCase() === migration.destination.toLowerCase() && r.pending.value === migration.ethAmount),
    proofCursor: 0 };
}
export function replaceMigrationReceipt(migration: Migration, receipt: MigrationReceipt): MigrationReceipt[] {
  const records = migration.receipts ?? [];
  const at = records.findIndex((r) => r.pending.nonce === receipt.pending.nonce);
  return at < 0 ? [...records, receipt] : records.map((r, i) => i === at ? receipt : r);
}
export function invalidateMigrationObservation(saved: SavedExitSpend, receipt: MigrationReceipt): SavedExitSpend {
  const migration = saved.migration!;
  return { ...saved, pending: { ...receipt.pending }, migration: { ...migrationObservations(migration, migration.receipts ?? [], false),
    anchor: undefined, recheck: undefined, blocked: 'A migration receipt was orphaned or replaced. Resolve this exact nonce before another step.' } };
}
export function migrationPendingContext(migration: Migration, pending: NonNullable<SavedExitSpend['pending']>): Migration {
  let ids: string[] = [];
  if (pending.input !== '0x') {
    const decoded = decodeFunctionData({ abi: [...packManagerAbi, ...migrationAbi, ...managerQueueAbi], data: pending.input });
    if (decoded.functionName === 'importPacks') ids = ((decoded.args as readonly unknown[])[0] as bigint[]).map(String);
  }
  return { ...migration, ethSent: false, ethAmount: pending.input === '0x' ? pending.value : migration.ethAmount,
    packIds: [...new Set([...migration.packIds, ...ids])] };
}
export const migrationEthAttempted = (migration: Migration) => (migration.receipts ?? []).some((receipt) => receipt.pending.input === '0x');
export function changeMigrationDetails(current: Migration, requested: Migration): Migration {
  if (migrationEthAttempted(current) && current.ethAmount !== requested.ethAmount) throw new Error('The ETH amount is fixed after its first signed attempt. Resolve that nonce instead of authorizing another transfer.');
  return migrationObservations({ ...current, ethAmount: requested.ethAmount, manualIds: requested.manualIds, proofCursor: 0 }, current.receipts ?? [], !!current.anchor && !current.recheck && !current.blocked);
}
export function assertMigrationReady(saved: SavedExitSpend) {
  if (saved.pending) throw new Error('A migration wallet outcome is unresolved. Track its canonical transaction before another step.');
  if (saved.migration?.blocked || saved.migration?.recheck) throw new Error(saved.migration.blocked ?? 'Checking another bounded page of canonical migration receipts. Review again.');
}

export interface RecoveryCandidate { index: bigint; packId: bigint; unsealed: boolean; claimant: Address; holder?: Address; importable?: boolean }
export function migrationRecoveryPage(count: bigint, cursor?: string) {
  const requested = BigInt(cursor ?? '0');
  const start = requested >= 0n && requested < count ? requested : 0n;
  const end = start + 16n < count ? start + 16n : count;
  return { start, end, indexes: Array.from({ length: Number(end - start) }, (_, i) => start + BigInt(i)), next: end < count ? end : 0n };
}
export const sealedMigrationRecovery = (source: Address, candidates: RecoveryCandidate[]) => candidates.find((candidate) =>
  !candidate.unsealed && same(candidate.claimant, '0x0000000000000000000000000000000000000000') && candidate.holder !== undefined && same(candidate.holder, source) && candidate.importable === true);
/** Match the on-chain importer: bounded gas, at most 1024 returndata bytes and 1..30 actual Shapes. */
export function boundedMigrationContents(data: Hex | undefined): bigint[] | undefined {
  if (!data || !/^0x[0-9a-fA-F]+$/.test(data) || data.length < 194 || data.length > 2050 || (data.length - 2) % 64 !== 0) return undefined;
  if (BigInt(`0x${data.slice(2, 66)}`) !== 32n) return undefined;
  const count = BigInt(`0x${data.slice(66, 130)}`);
  if (count < 1n || count > 30n || data.length !== 130 + Number(count) * 64) return undefined;
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(`0x${data.slice(130 + i * 64, 194 + i * 64)}`));
  return new Set(ids.map(String)).size === ids.length ? ids : undefined;
}
export function migrationPackCustody(packId: bigint, packs: Address, value: bigint, shapes: { holder: Address; packId: bigint; backing: bigint }[]) {
  return shapes.length > 0 && shapes.length <= 30 && value > 0n && value % 10000000000000000n === 0n
    && shapes.every((shape) => same(shape.holder, packs) && shape.packId === packId && shape.backing > 0n)
    && shapes.reduce((sum, shape) => sum + shape.backing, 0n) === value;
}
function unsupportedPackRead(error: unknown) {
  if (!(error instanceof BaseError)) return false;
  return !!error.walk((cause) => {
    const item = cause as { name?: string; code?: number; message?: string };
    return item.name === 'ContractFunctionRevertedError' || item.name === 'ExecutionRevertedError'
      || ((item.code === -32000 || item.code === -32003) && /out of gas|gas required exceeds allowance/i.test(item.message ?? ''));
  });
}
async function importableMigrationPack(pub: PublicClient, source: Address, packs: Address, shapes: Address, packId: bigint, blockNumber: bigint) {
  try {
    const [holder, claimant, actualShapes] = await Promise.all([
      pub.readContract({ address: packs, abi: assetAbi, functionName: 'ownerOf', args: [packId], blockNumber }),
      pub.readContract({ address: packs, abi: assetAbi, functionName: 'claimantOf', args: [packId], blockNumber }),
      pub.readContract({ address: packs, abi: assetAbi, functionName: 'shapes', blockNumber }),
    ]);
    if (!same(holder, source) || !same(claimant, '0x0000000000000000000000000000000000000000') || !same(actualShapes, shapes)) return false;
    const raw = await pub.call({ to: packs, data: encodeFunctionData({ abi: assetAbi, functionName: 'contentsOf', args: [packId] }), gas: 150000n, blockNumber });
    const ids = boundedMigrationContents(raw.data);
    if (!ids) return false;
    const [value, contents] = await Promise.all([
      pub.readContract({ address: packs, abi: assetAbi, functionName: 'valueOf', args: [packId], blockNumber }),
      Promise.all(ids.map(async (shapeId) => {
        const [holder, parent, backing] = await Promise.all([
          pub.readContract({ address: shapes, abi: assetAbi, functionName: 'ownerOf', args: [shapeId], blockNumber }),
          pub.readContract({ address: packs, abi: assetAbi, functionName: 'packOf', args: [shapeId], blockNumber }),
          pub.readContract({ address: shapes, abi: assetAbi, functionName: 'backingOf', args: [shapeId], blockNumber }),
        ]);
        return { holder, packId: parent, backing };
      })),
    ]);
    return migrationPackCustody(packId, packs, value, contents);
  } catch (error) {
    if (unsupportedPackRead(error)) return false;
    throw error;
  }
}
async function readMigrationRecovery(pub: PublicClient, source: Address, packs: Address, shapes: Address, blockNumber: bigint, cursor?: string) {
  const read = <T,>(functionName: string, args: bigint[] = []) => pub.readContract({ address: source, abi: packManagerAbi as Abi, functionName, args, blockNumber }) as Promise<T>;
  const count = await read<bigint>('recoveryPackCount');
  const page = migrationRecoveryPage(count, cursor);
  const candidates = await Promise.all(page.indexes.map(async (index): Promise<RecoveryCandidate> => {
    const packId = await read<bigint>('recoveryPackAt', [index]);
    const [unsealed, claimant] = await Promise.all([
      read<boolean>('recoveryUnsealed', [packId]), pub.readContract({ address: packs, abi: assetAbi, functionName: 'claimantOf', args: [packId], blockNumber }),
    ]);
    const holder = unsealed || !same(claimant, '0x0000000000000000000000000000000000000000') ? undefined
      : await pub.readContract({ address: packs, abi: assetAbi, functionName: 'ownerOf', args: [packId], blockNumber });
    return { index, packId, unsealed, claimant, holder };
  }));
  for (const candidate of candidates) {
    if (candidate.unsealed || !candidate.holder || !same(candidate.holder, source) || !same(candidate.claimant, '0x0000000000000000000000000000000000000000')) continue;
    candidate.importable = await importableMigrationPack(pub, source, packs, shapes, candidate.packId, blockNumber);
    if (candidate.importable) break;
  }
  return { ...page, count, selected: sealedMigrationRecovery(source, candidates) };
}
export const migrationIdPage = (migration: Migration) => migration.packIds.slice(migration.proofCursor ?? 0, (migration.proofCursor ?? 0) + 16).map(BigInt);
export const migrationSpendKey = (chain: number, source: Address, owner: Address, destination: Address) => `main-manager-migration:${chain}:${source.toLowerCase()}:${owner.toLowerCase()}:${destination.toLowerCase()}`;
/** Solady LibClone.clone runtime, including its exact optimized 44-byte instruction sequence. */
export const managerCloneCode = (implementation: Address) => `0x3d3d3d3d363d3d37363d73${implementation.slice(2).toLowerCase()}5af43d3d93803e602a57fd5bf3`;
export function assertMigrationIdentity(input: { source: Address; destination: Address; owner: Address; owners: Address[]; factory: Address; implementations: Address[]; codes: Hex[]; recognized: boolean[]; assets: Address[][]; paused?: boolean; exiting?: boolean }) {
  if (same(input.source, input.destination)) throw new Error('Choose a different destination manager.');
  if (input.owners.some((owner) => !same(owner, input.owner))) throw new Error('Both managers must still belong to the connected owner.');
  if (input.recognized.some((yes) => !yes) || input.codes.some((code, i) => code.toLowerCase() !== managerCloneCode(input.implementations[i]))) throw new Error('Both managers must be recognized clones of the configured official factory.');
  if (input.assets[0].some((asset, i) => !same(asset, input.assets[1][i]))) throw new Error('Managers must use the same canonical FWA, Shapes and ShapePacks contracts.');
  if (input.exiting) throw new Error('Leave exit mode before preserving packs. Exit mode permits keeper liquidation.');
}
export async function validateMigration(pub: PublicClient, source: Address, owner: Address, destination: Address) {
  if (!MANAGER_FACTORY) throw new Error('No official manager factory is configured.');
  const blockNumber = await pub.getBlockNumber();
  const implementation = await pub.readContract({ address: MANAGER_FACTORY, abi: packManagerFactoryAbi, functionName: 'implementation', blockNumber });
  const facts = await Promise.all([source, destination].map(async (address) => {
    const read = (functionName: string) => pub.readContract({ address, abi: packManagerAbi as Abi, functionName, blockNumber }) as Promise<Address>;
    const [registered, code, ownerNow, factory, fwa, shapes, packs] = await Promise.all([
      pub.readContract({ address: MANAGER_FACTORY!, abi: packManagerFactoryAbi, functionName: 'isManager', args: [address], blockNumber }),
      pub.getCode({ address, blockNumber }), read('owner'), read('factory'), read('fwa'), read('shapes'), read('packs'),
    ]);
    return { registered: registered && same(factory, MANAGER_FACTORY!), code: code ?? '0x' as Hex, owner: ownerNow, assets: [fwa, shapes, packs] };
  }));
  // The implementation supplies the canonical immutable asset tuple, independently of either destination getter.
  const canonical = await Promise.all(['fwa', 'shapes', 'packs'].map((functionName) => pub.readContract({ address: implementation, abi: packManagerAbi as Abi, functionName, blockNumber }) as Promise<Address>));
  assertMigrationIdentity({ source, destination, owner, owners: facts.map((f) => f.owner), factory: MANAGER_FACTORY,
    implementations: [implementation, implementation], codes: facts.map((f) => f.code), recognized: facts.map((f) => f.registered), assets: [canonical, facts[0].assets] });
  if (facts[1].assets.some((a, i) => !same(a, canonical[i]))) throw new Error('Destination assets do not match the official implementation.');
  const expected = await pub.readContract({ address: destination, abi: packManagerAbi, functionName: 'configurationHash', blockNumber });
  try {
    await pub.simulateContract({ address: destination, account: owner, abi: migrationAbi, functionName: 'importPacks', args: [[], expected], blockNumber });
    throw new Error('Unexpected empty import success.');
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null : undefined;
    if (reverted?.data?.errorName !== 'BadBatch') throw new Error('Destination import support could not be verified. No packs will be moved.');
  }

  const exiting = await Promise.all([source, destination].map((address) => pub.readContract({ address, abi: packManagerAbi, functionName: 'windingDown', blockNumber })));
  if (exiting.some(Boolean)) throw new Error('Both managers must leave exit mode before preserving packs. Exit mode permits keeper liquidation.');
  return { fwa: canonical[0], shapes: canonical[1], packs: canonical[2], blockNumber };
}
export function migrationCalls(m: Pick<Manager, 'manager' | 'owner' | 'exiting' | 'listingPaused' | 'book' | 'balance' | 'fwa'>, owner: Address, migration: Migration, idleIds: bigint[], imports: bigint[], destinationHash: Hex, queued: boolean, recovery?: Pick<RecoveryCandidate, 'index' | 'packId'>): ExitCall[] {
  if (!same(m.owner, owner)) throw new Error('The source manager owner changed.');
  if (m.exiting) throw new Error('Leave exit mode before preserving packs.');
  if (!m.listingPaused) return [{ label: 'Pause source listings for pack migration', functionName: 'setListingPaused', args: [true] }];
  if (imports.length) return [{ label: 'Import preserved packs into destination', functionName: 'importPacks', args: [imports, destinationHash], target: migration.destination }];
  if (idleIds.length) return [{ label: 'Transfer idle packs intact to destination', functionName: 'withdrawPacks', args: [migration.destination, BigInt(idleIds.length)] }];
  if (recovery) return [{ label: 'Transfer selected sealed recovery pack intact', functionName: 'withdrawRecoveryPack', args: [migration.destination, recovery.index, recovery.packId] }];
  const batches = exitBatches(m.book.ids);
  const calls: ExitCall[] = [];
  if (m.book.openCount > 0n || m.book.pendingReceipts > 0n) {
    for (const ids of batches.length ? batches : [[]]) calls.push({ label: 'Recover source settlements without redemption', functionName: 'recover', args: [ids, m.book.witness ?? 0n] });
    for (const ids of batches) calls.push({ label: 'Unlist source packs intact', functionName: 'unlistForWithdrawal', args: [ids] });
    if (queued) calls.push({ label: 'Process eligible FWA queue for migration', functionName: 'processAcquisitions', args: [16n], target: m.fwa });
    return calls;
  }
  if (m.book.idle > 0) throw new Error('Unsupported ordinary idle pack remains at the withdrawal tail. It stays tracked at the source; migration cannot skip that tail with withdrawPacks.');
  if (m.book.recovery > 0) throw new Error('Recovery inventory remains. Check another bounded page or wait for the unsealed claim recovery path. No pack will be redeemed.');
  if (m.book.credit > 0n) return [{ label: 'Collect remaining source earnings', functionName: 'harvest', args: [[], 0n] }];
  if (m.balance > 0n) return [{ label: 'Withdraw remaining source ETH to owner', functionName: 'withdraw', args: [owner, m.balance] }];
  if (!migration.ethSent && BigInt(migration.ethAmount) > 0n && migrationEthAttempted(migration)) throw new Error('The signed ETH transfer has not succeeded canonically. No automatic retry at a new nonce is allowed; resolve its exact transaction outcome.');
  if (!migration.ethSent && BigInt(migration.ethAmount) > 0n) return [{ label: 'Transfer reviewed wallet ETH to destination', functionName: '', args: [], target: migration.destination, value: BigInt(migration.ethAmount), transfer: true }];
  return [];
}
export function assertMigrationIntent(source: Address, owner: Address, migration: Migration, fwa: Address, intent: Pick<TransactionIntent, 'from' | 'to' | 'input' | 'value'>) {
  if (!same(intent.from, owner)) throw new Error('Migration must be signed by the current owner.');
  if (intent.input === '0x') {
    if (!same(intent.to, migration.destination) || intent.value !== BigInt(migration.ethAmount) || intent.value <= 0n || migration.ethSent) throw new Error('Wallet transfer does not match the reviewed migration recipient and amount.');
    return;
  }
  if (intent.value !== 0n) throw new Error('Pack migration calls attach no ETH.');
  if (same(intent.to, fwa)) {
    if (intent.input !== encodeFunctionData({ abi: managerQueueAbi, functionName: 'processAcquisitions', args: [16n] })) throw new Error('Migration queue call must remain bounded.');
    return;
  }
  const decoded = decodeFunctionData({ abi: [...packManagerAbi, ...migrationAbi], data: intent.input });
  const args = decoded.args as readonly unknown[];
  const ids = (x: unknown) => Array.isArray(x) && x.length <= 16 && x.every((v) => typeof v === 'bigint' && v >= 0n);
  if (same(intent.to, migration.destination)) {
    if (decoded.functionName === 'setListingPaused' && args[0] === true) return;
    if (decoded.functionName !== 'importPacks' || !ids(args[0]) || !(args[0] as bigint[]).every((id) => migration.packIds.includes(String(id)))) throw new Error('Destination call must import only the preserved migration pack IDs.');
    return;
  }
  if (!same(intent.to, source)) throw new Error('Migration targets another contract.');
  const valid = decoded.functionName === 'setListingPaused' ? args[0] === true
    : decoded.functionName === 'recover' ? ids(args[0]) && typeof args[1] === 'bigint'
    : decoded.functionName === 'unlistForWithdrawal' ? ids(args[0])
    : decoded.functionName === 'withdrawPacks' ? same(String(args[0]), migration.destination) && typeof args[1] === 'bigint' && args[1] > 0n && args[1] <= 16n
    : decoded.functionName === 'withdrawRecoveryPack' ? args.length === 3 && same(String(args[0]), migration.destination) && typeof args[1] === 'bigint' && args[1] >= 0n && typeof args[2] === 'bigint' && args[2] >= 0n
    : decoded.functionName === 'harvest' ? ids(args[0]) && args[1] === 0n
    : decoded.functionName === 'withdraw' ? same(String(args[0]), owner) && typeof args[1] === 'bigint' && args[1] > 0n : false;
  if (!valid) throw new Error('Migration cannot enter exit mode, redeem packs or change recipients.');
}
export const migrationReviewIntent = (review: Exclude<ExitReview, { done: true }>): TransactionIntent => review.call.transfer
  ? { chainId: review.prepared.chainId!, from: review.prepared.account!, to: review.call.target!, input: '0x', value: review.call.value! }
  : reviewedIntent(review.prepared);
export async function reviewMigration(pub: PublicClient, source: Address, owner: Address, spend: ExitSpend, migration: Migration): Promise<ExitReview & { migration?: Migration; checkedOnly?: boolean; checkMessage?: string }> {
  const canonical = await validateMigration(pub, source, owner, migration.destination);
  const m = await readManager(pub, source);
  const idleCount = await pub.readContract({ address: source, abi: packManagerAbi, functionName: 'idlePackCount', blockNumber: m.blockNumber });
  const idleIds: bigint[] = [];
  let idleIssue: string | undefined;
  for (let i = 0n; i < idleCount && i < 16n; i++) {
    const packId = await pub.readContract({ address: source, abi: packManagerAbi, functionName: 'idlePackAt', args: [idleCount - i - 1n], blockNumber: m.blockNumber });
    if (!await importableMigrationPack(pub, source, canonical.packs, canonical.shapes, packId, m.blockNumber)) {
      idleIssue = `Idle pack ${packId} is not importable. It stays tracked at the source. Ordinary withdrawal cannot skip the unsupported tail.`;
      break;
    }
    idleIds.push(packId);
  }
  const imports: bigint[] = [];
  const cursor = migration.proofCursor ?? 0;
  for (const id of migrationIdPage(migration)) {
    const held = await pub.readContract({ address: canonical.packs, abi: assetAbi, functionName: 'ownerOf', args: [id] });
    const value = await pub.readContract({ address: migration.destination, abi: packManagerAbi, functionName: 'inventoryShapeCount', args: [id] });
    if (!same(held, migration.destination) && value === 0n) throw new Error(`Pack ${id} is not held or tracked by the destination. Verify its actual transfer before continuing.`);
    if (same(held, migration.destination) && value === 0n) imports.push(id);
  }
  if (!imports.length && cursor + 16 < migration.packIds.length) return { done: true, migration: { ...migration, proofCursor: cursor + 16 }, checkedOnly: true };
  const nextMigration = { ...migration, proofCursor: imports.length ? cursor : migration.packIds.length };
  const destinationHash = await pub.readContract({ address: migration.destination, abi: packManagerAbi, functionName: 'configurationHash' });
  const queued = m.book.openCount > 0n && await pub.readContract({ address: m.fwa, abi: fwaV2Abi, functionName: 'unsettledAcquisitionCount' }) > 0n;
  const destinationPaused = await pub.readContract({ address: migration.destination, abi: packManagerAbi, functionName: 'listingPaused' });
  const recovery = m.listingPaused && destinationPaused && !imports.length && !idleIds.length && m.book.recovery > 0
    ? await readMigrationRecovery(pub, source, canonical.packs, canonical.shapes, m.blockNumber, migration.recoveryCursor) : undefined;
  if (recovery) nextMigration.recoveryCursor = String(recovery.selected ? recovery.start : recovery.next);
  const recoveryMessage = recovery && !recovery.selected
    ? `Checked recovery indices ${recovery.start}–${recovery.end > recovery.start ? recovery.end - 1n : recovery.end}. No importable sealed pack in this page. Unsupported packs stay tracked at the source. Continue to the next page or wait for unsealed claim recovery. This is not a complete-book search.` : undefined;
  const inventoryMessage = [idleIssue, recoveryMessage].filter(Boolean).join(' ');
  if (m.listingPaused && destinationPaused && !imports.length && !idleIds.length && inventoryMessage && !recovery?.selected && m.book.openCount === 0n && m.book.pendingReceipts === 0n) return { done: true, migration: nextMigration, checkedOnly: true, checkMessage: inventoryMessage };
  const candidates = !m.listingPaused ? migrationCalls(m, owner, migration, idleIds, imports, destinationHash, queued, recovery?.selected)
    : !destinationPaused ? [{ label: 'Pause destination listings during migration', functionName: 'setListingPaused', args: [true], target: migration.destination }]
    : migrationCalls(m, owner, migration, idleIds, imports, destinationHash, queued, recovery?.selected);
  if (!candidates.length) return { done: true, migration: nextMigration };
  let failure: Error | undefined;
  for (const call of candidates) {
    try {
      const prepared = call.transfer ? { ...(await prepareTransfer(pub, owner, call.target!, call.value!)).prepared, address: call.target! }
        : await prepareWrite(pub, owner, { address: call.target ?? source, abi: (call.functionName === 'processAcquisitions' ? managerQueueAbi : [...packManagerAbi, ...migrationAbi]) as Abi, functionName: call.functionName, args: call.args, value: 0n });
      const review = { done: false as const, call, prepared: prepared as never, maximumDebit: checkExitSpend(spend, prepared.gas, prepared.maxFeePerGas, call.value ?? 0n), expectedWalletGas: 0n, configHash: m.configHash, reviewedBlock: m.blockNumber, reviewedLimit: spend.limit };
      assertMigrationIntent(source, owner, migration, m.fwa, migrationReviewIntent(review));
      if (call.functionName === 'processAcquisitions') await requireManagerQueueProgress(pub, prepared);
      if (prepared.gas > 16777216n) throw new Error('Migration exceeds the network transaction gas cap.');
      const block = await pub.getBlock({ blockNumber: m.blockNumber });
      const price = block.baseFeePerGas === null ? prepared.maxFeePerGas : block.baseFeePerGas + prepared.maxPriorityFeePerGas < prepared.maxFeePerGas ? block.baseFeePerGas + prepared.maxPriorityFeePerGas : prepared.maxFeePerGas;
      review.expectedWalletGas = prepared.gas * 10n / 13n * price;
      return { ...review, migration: nextMigration };
    } catch (e) {
      if (e instanceof Error && e.message.includes('spending limit')) failure = e;
      else if (!failure && call.functionName === 'withdrawRecoveryPack') failure = new Error('Recovery selection changed or cannot move intact. Refresh this bounded page. Unsealed claims remain excluded.');
      else if (!failure && call.functionName === 'importPacks') failure = new Error('Import cannot execute. Only sealed canonical packs with at most 30 Shapes are supported. Preheld packs remain at the destination for owner recovery.');
    }
  }
  if (!failure && inventoryMessage) return { done: true, migration: nextMigration, checkedOnly: true, checkMessage: inventoryMessage };
  throw failure ?? new Error('Pack-preserving migration waits for FWA settlement, its request deadline, crown delay or another bounded inventory page.');
}
async function canonicalMigrationReceipt(pub: PublicClient, saved: SavedExitSpend, pending: NonNullable<SavedExitSpend['pending']>, packs: Address): Promise<MigrationReceipt | undefined> {
  if (!pending.hash) return undefined;
  const receipt = await pub.getTransactionReceipt({ hash: pending.hash }).catch((error: Error) => {
    if (error.name === 'TransactionReceiptNotFoundError') return undefined;
    throw error;
  });
  if (!receipt) return undefined;
  const transaction = await pub.getTransaction({ hash: pending.hash }).catch((error: Error) => {
    if (error.name === 'TransactionNotFoundError') return undefined;
    throw error;
  });
  if (!transaction) return undefined;
  try {
    assertExitReplacementNonce(pending, transaction.nonce);
    assertTransactionIntent({ chainId: saved.chainId, from: saved.holder, to: pending.to ?? saved.vault, input: pending.input, value: BigInt(pending.value) }, transaction);
  } catch { return undefined; }
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  if (receipt.transactionHash !== pending.hash || transaction.hash !== pending.hash || receipt.blockHash !== block.hash || transaction.blockHash !== block.hash || transaction.blockNumber !== receipt.blockNumber) return undefined;
  const ids = receipt.status !== 'success' ? [] : receipt.logs.filter((log) => same(log.address, packs)).flatMap((log) => {
    try { const decoded = decodeEventLog({ abi: assetAbi, data: log.data, topics: log.topics });
      return decoded.eventName === 'Transfer' && same(decoded.args.from, saved.vault) && same(decoded.args.to, saved.migration!.destination) ? [String(decoded.args.tokenId)] : [];
    } catch { return []; }
  });
  return { pending: { ...pending, hash: pending.hash, nonce: transaction.nonce }, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
    success: receipt.status === 'success', packIds: ids };
}
async function canonicalAnchor(pub: PublicClient, anchor: Anchor) {
  const block = await pub.getBlock({ blockNumber: BigInt(anchor.number) }).catch((error: Error) => {
    if (error.name === 'BlockNotFoundError') return undefined;
    throw error;
  });
  return block?.hash === anchor.hash;
}
/** A canonical anchor proves the already checked receipts remain ancestors. Reorgs rescan at most 16 per refresh. */
export async function reconcileMigration(pub: PublicClient, saved: SavedExitSpend): Promise<SavedExitSpend> {
  const migration = saved.migration;
  if (!migration) return saved;
  if (await pub.getChainId() !== saved.chainId) throw new Error('Migration belongs to another network.');
  const { packs } = await validateMigration(pub, saved.vault, saved.holder, migration.destination);
  if (!migration.receipts && (migration.ethSent || migration.packIds.some((id) => !(migration.manualIds ?? []).includes(id)))) throw new Error('Legacy migration observations lack canonical receipts. Reconcile their transaction hashes before continuing.');
  const head = await pub.getBlock();
  const headAnchor = { number: String(head.number), hash: head.hash! };
  const previousValid = !!migration.anchor && await canonicalAnchor(pub, migration.anchor);
  let next = saved;
  if (saved.pending?.hash) {
    const receipt = await canonicalMigrationReceipt(pub, saved, saved.pending, packs);
    if (!receipt) return { ...saved, migration: { ...migrationObservations(migration, migration.receipts ?? [], false), anchor: undefined,
      blocked: 'The migration transaction has no canonical receipt yet. Its nonce remains reserved.' } };
    // Keep the actual signed maximum, including an authorized replacement increase, before recording any effect.
    const transaction = await pub.getTransaction({ hash: receipt.pending.hash });
    const bounded = reserveExitReplacement(saved, signedExitMaximum(transaction));
    const records = replaceMigrationReceipt(migration, { ...receipt, pending: { ...receipt.pending, maximumDebit: bounded.pending!.maximumDebit } });
    const trusted = (migration.receipts?.length ?? 0) === 0 || (!!migration.anchor && await canonicalAnchor(pub, migration.anchor));
    const latest = await pub.getBlock();
    const confirmedAnchor = { number: String(latest.number), hash: latest.hash! };
    if (BigInt(receipt.blockNumber) > latest.number || !await canonicalAnchor(pub, { number: receipt.blockNumber, hash: receipt.blockHash }) || !await canonicalAnchor(pub, confirmedAnchor)) throw new Error('The chain changed while validating migration. Refresh before continuing.');
    next = { ...bounded, migration: { ...migrationObservations(migration, records, trusted),
      anchor: trusted ? confirmedAnchor : undefined, recheck: trusted ? undefined : { cursor: 0, head: confirmedAnchor }, blocked: undefined } };
    return next;
  }
  if (previousValid) {
    const derived = migrationObservations(migration, migration.receipts ?? [], true);
    if (derived.ethSent === migration.ethSent && JSON.stringify(derived.packIds) === JSON.stringify(migration.packIds)) return saved;
    return { ...saved, migration: { ...derived, proofCursor: migration.proofCursor } };
  }
  const recheck = migration.recheck && await canonicalAnchor(pub, migration.recheck.head) ? migration.recheck : { cursor: 0, head: headAnchor };
  const records = [...(migration.receipts ?? [])];
  const end = Math.min(records.length, recheck.cursor + 16);
  for (let i = recheck.cursor; i < end; i++) {
    const observed = await canonicalMigrationReceipt(pub, saved, records[i].pending, packs);
    if (!observed) return invalidateMigrationObservation(saved, records[i]);
    if (BigInt(observed.blockNumber) > BigInt(recheck.head.number)) return { ...saved, migration: { ...migrationObservations(migration, records, false), recheck: { cursor: 0, head: headAnchor }, anchor: undefined, blocked: undefined } };
    records[i] = observed;
  }
  if (!await canonicalAnchor(pub, recheck.head)) throw new Error('The chain changed while checking migration history. Refresh before continuing.');
  const complete = end === records.length;
  return { ...saved, migration: { ...migrationObservations(migration, records, complete), anchor: complete ? recheck.head : undefined,
    recheck: complete ? undefined : { ...recheck, cursor: end }, blocked: undefined } };
}
