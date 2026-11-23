import type { CSSProperties } from 'react';
import { parseEther } from 'viem';
import { BY_VALUE, DENOMS, MAX_KEEPER_REWARD, capitalOf, economics, evaluate, prizeLabel, reserveBreakdownAt, restockFeeAt, type Counts } from '../../shared/planner';
import { ethNeeded, playerView, presetCounts, type DesignInputs, type Style } from '../../shared/design';
import { useVault } from './MainPool';
import { MANAGER_FACTORY, VAULT } from './main-pool';

// One worked example: a 0.2 ETH NFT, 20 small Shapes, 15% markup, 0.001 ETH mint fee and 1 gwei basefee.
const EXAMPLE: DesignInputs = {
  curatedBases: [parseEther('0.2')], markupBps: 1500, edgeBps: 500, mintFee: parseEther('0.001'), restockFee: restockFeeAt(10n ** 9n),
  have: Array(16).fill(0), baseFee: 10n ** 9n, gasPrice: 1_050_000_000n, v1Preview: true,
};
const SMALL = 20;
const STYLES: { key: Style; label: string }[] = [
  { key: 'lowPrice', label: 'Low draw price' }, { key: 'balanced', label: 'Balanced' },
  { key: 'bigWins', label: 'More big wins' }, { key: 'jackpot', label: 'Jackpot' },
];
const SHADES = ['#333', '#555', '#7a7a7a', '#b5b5b5'];
const eth = (wei: bigint, d = 3) => (Number(wei) / 1e18).toFixed(d).replace(/\.?0+$/, '');
const pct = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
const oneIn = (p: number) => `1 in ${1 / p < 10 ? (1 / p).toFixed(1) : Math.round(1 / p).toLocaleString()}`;

/** Groups of a mix, smallest value first, with shade, chance per draw and worth against the draw price. */
function groups(counts: Counts) {
  const ev = evaluate(counts, EXAMPLE);
  const view = playerView(ev);
  const sizes = BY_VALUE.filter((i) => counts[i] > 0);
  const shade = (k: number): CSSProperties => ({ background: sizes.length > 1 && k === sizes.length - 1 ? '#fff' : SHADES[Math.min(SHADES.length - 1, k)] });
  const out = sizes.map((i, k) => {
    const t = view.tiers.find((x) => x.kind === 'shape' && x.size === i)!;
    return { key: `s${i}`, label: prizeLabel(i), n: counts[i], odds: t.odds, multiple: t.multiple, style: shade(k), nft: false };
  });
  out.push({ key: 'nft', label: 'Your NFT', n: 1, odds: view.curated, multiple: view.tiers.find((t) => t.kind === 'curated')!.multiple, style: { border: '1.5px solid #fff' }, nft: true });
  return { ev, view, list: out };
}

function Squares({ counts, size = 18 }: { counts: Counts; size?: number }) {
  const { list } = groups(counts);
  return (
    <div className="hiw-squares" style={{ gridTemplateColumns: `repeat(auto-fill, ${size}px)` }} aria-hidden="true">
      {list.flatMap((g) => Array.from({ length: g.n }, (_, j) => <span key={`${g.key}${j}`} style={{ ...g.style, width: size, height: size }} />))}
    </div>
  );
}

/** A horizontal bar split into labelled parts, each sized by its share. */
function Bar({ parts }: { parts: { label: string; share: number; style: CSSProperties; note?: string }[] }) {
  return (
    <>
      <div className="hiw-bar" role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.share)}`).join(', ')}>
        {parts.map((p) => <span key={p.label} style={{ ...p.style, flexGrow: p.share }} />)}
      </div>
      <div className="legend" style={{ marginTop: 12 }}>
        {parts.map((p) => <div key={p.label}><span className="sw" style={p.style} /><span><b>{pct(p.share)}</b> {p.label}{p.note && <span className="muted"> · {p.note}</span>}</span></div>)}
      </div>
    </>
  );
}

export function HowItWorks({ onDesign }: { onDesign: () => void }) {
  const counts = presetCounts('balanced', EXAMPLE, SMALL);
  const { ev, view, list } = groups(counts);
  const econ = economics(counts, EXAMPLE);
  const draw = Number(ev.drawPrice) / 1e18;
  const creatorShare = econ.creatorEarningsPerDraw / draw;
  const retainedShare = econ.retainedRevenuePerDraw / draw;
  const edgeShare = (draw - econ.ownerProceeds) / draw;
  const inPrizes = capitalOf(counts);
  const needed = ethNeeded(counts, EXAMPLE);
  const capital = reserveBreakdownAt(counts, EXAMPLE.have, EXAMPLE.mintFee, 0, MAX_KEEPER_REWARD, EXAMPLE.baseFee);
  const deposit = needed;
  const initialCosts = capital.inventoryCost - inPrizes + capital.listingBudget;
  const reserve = capital.workingBuffer;
  return (
    <main className="page hiw">
      {VAULT && <p className="note hiw-switch">Community pools · <a className="link" href="#how-main">Main pool</a></p>}
      <h1 className="title">How it works</h1>
      <p className="lead">A pool is a prize inventory on FWA. Players pay a draw price and win one prize at random. You put in ETH and, optionally, your NFTs; keepers replenish prizes from available operating capital.</p>
      <p className="note" style={{ marginTop: 10 }}>Every number below comes from one example: a 0.2 ETH NFT, the Balanced style at 20 small Shapes, and a 15% markup.</p>

      <section className="hiw-sec">
        <h2 className="h3">1. One inventory, two kinds of prizes</h2>
        <p className="hiw-p"><b>Your NFTs</b>, if you add any, are the prizes you give away. <b>Shapes</b> fill the rest: each is a token holding a fixed amount of ETH (0.01 to 100), which the winner can redeem. Values between the Shape sizes, like 0.02 or 0.25 ETH, are <b>Packs</b>: one token holding a few Shapes.</p>
        <Squares counts={counts} />
        <div className="legend">
          {list.map((g) => <div key={g.key}><span className="sw" style={g.style} /><span><b>{g.n}</b> × {g.label}{g.nft ? ` (${eth(EXAMPLE.curatedBases[0])} ETH)` : ''}</span></div>)}
        </div>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">2. How a draw picks a prize</h2>
        <p className="hiw-p">FWA gives each prize a chance in proportion to 1 ÷ its price: a prize priced 20 times higher comes up 20 times less often, so a prize is rare exactly when it costs many times the others.</p>
        <Bar parts={list.map((g) => ({ label: g.label, share: g.odds, style: g.style, note: `${g.multiple.toFixed(2)}× the price` }))} />
        <div className="hiw-stats">
          <div><span className="figure-s">{eth(ev.drawPrice, 4)}</span><span className="unit">ETH</span><p className="note">Draw price</p></div>
          <div><span className="figure-s">{oneIn(view.winMore)}</span><p className="note">Win more than the draw price</p></div>
          <div><span className="figure-s">{oneIn(view.curated)}</span><p className="note">Win your NFT</p></div>
        </div>
        <p className="note" style={{ marginTop: 10 }}>Players also pay FWA's randomness (VRF) fee and gas, which are set at draw time.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">3. Won prizes are restocked</h2>
        <p className="hiw-p">You choose a target mix. When a prize is won, upkeep replenishes it when the pool has enough operating ETH. Prizes can be replaced in stages. Your NFTs are not replaced.</p>
        <ol className="hiw-cycle">
          <li><b>A player draws</b><span>and wins, say, a 0.05 ETH Shape.</span></li>
          <li><b>Draws continue</b><span>Players draw from the current inventory while the admission gate permits purchases.</span></li>
          <li><b>Upkeep restocks</b><span>Anyone can run it; keepers do. It mints a new 0.05 ETH Shape from the pool's ETH and lists it.</span></li>
          <li><b>Back to the mix</b><span>The target is restored when funding and upkeep are available.</span></li>
        </ol>
        <p className="note">Keepers are paid from your pool's ETH for each upkeep that restocks prizes or records draws; the restocking fee in each prize's price is your income toward that pay. V1 reimburses gas up to 5 gwei. Low inventory can pause purchases. If operating ETH is insufficient, lower gas alone may not restart the pool; add ETH or reduce the target.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">4. Where each draw's ETH goes</h2>
        <p className="hiw-p">On average, of every draw price:</p>
        <Bar parts={[
          { label: 'is allocated to pool creator earnings', share: creatorShare, style: { background: '#fff' } },
          { label: 'is retained for pool operations', share: retainedShare, style: { background: '#b5b5b5' } },
          { label: "is FWA's fee", share: edgeShare, style: { background: '#333' } },
        ]} />
        <p className="hiw-p" style={{ marginTop: 14 }}>Running costs are priced on top of your markup. Each Shape prize's price includes its Shapes mint fee (0.001 ETH a Shape in this example) and a restocking fee set from the gas price when the prize is listed ({eth(EXAMPLE.restockFee, 5)} ETH a Shape at 1 gwei). It is your income toward keeper pay: keepers are paid from the pool's ETH for each call that restocks or records draws, and FWA's draw price spreads the fee over all buyers. Your earnings are what the markup brings in above 10%: {econ.creatorRevenueBps / 100}% of sales, about {econ.creatorEarningsPerDraw.toFixed(4)} ETH per draw in this example. That rate is stored when the pool is created and changes only when you change it in Settings.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">5. Your ETH</h2>
        <p className="hiw-p">At the example gas price, this target needs {eth(deposit, 6)} ETH:</p>
        <Bar parts={[
          { label: 'buys the prizes', share: Number(inPrizes) / Number(deposit), style: { background: '#b5b5b5' }, note: `${eth(inPrizes)} ETH` },
          { label: 'funds minting and initial paid listing', share: Number(initialCosts) / Number(deposit), style: { background: '#555' }, note: `${eth(initialCosts, 6)} ETH` },
          { label: 'is the maintenance buffer', share: Number(reserve) / Number(deposit), style: { border: '1.5px solid #555' }, note: `${eth(reserve, 6)} ETH` },
        ]} />
        <p className="hiw-p" style={{ marginTop: 14 }}>With paid upkeep enabled, the operating requirement covers missing inventory, its paid listing budget, outstanding draw reconciliation and a maintenance buffer. With payment disabled, only missing inventory needs pool ETH; an unpaid caller pays maintenance gas. It changes with gas and the work left. Keeper payments consume operating capital; successful sales replenish it. Fees inside unsold prizes are expected income, not ETH already collected. Closing releases unnecessary operating capital; outstanding work still affects withdrawals. Unlisted Shapes and Packs redeem for their exact backing.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">6. Shape styles</h2>
        <p className="hiw-p">A Shape style decides which Shapes sit next to your NFTs. The Shape pool size slider sets how many Shape prizes there are, in the style's proportions.</p>
        <div className="hiw-styles">
          {STYLES.map((s) => {
            const c = presetCounts(s.key, EXAMPLE, SMALL);
            const g = groups(c);
            return (
              <div key={s.key}>
                <b>{s.label}</b>
                <Squares counts={c} size={12} />
                <p className="note">Draw {eth(g.ev.drawPrice, 4)} ETH · {oneIn(g.view.winMore)} win more than paid · top Shape {eth(BY_VALUE.filter((i) => c[i] > 0).map((i) => DENOMS[i]).reduce((a, b) => (b > a ? b : a), 0n))} ETH</p>
              </div>
            );
          })}
        </div>
        <button className="btn" style={{ marginTop: 24 }} onClick={onDesign}>Design a community pool</button>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">Questions</h2>
        <div className="hiw-faq">
          {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
        </div>
      </section>
    </main>
  );
}

const FAQ: [string, string][] = [
  ['What is a Shape?', 'An NFT from the Shapes project that holds a fixed amount of ETH. Whoever owns it can redeem it for exactly that ETH at any time, or keep it.'],
  ['What is a Pack?', 'One token holding a few Shapes, used for values between the Shape sizes (0.02, 0.03, 0.2, 0.25, 2, 2.5 and 25 ETH). It redeems for the sum of its Shapes.'],
  ['Who owns the pool?', 'A contract created for you owns the FWA pool permanently; you are its pool creator. You can hand the pool creator role to another address, which has to accept.'],
  ['What happens when someone wins my NFT?', 'It goes to them. If other curated NFTs remain, purchases continue while the inventory gate permits them. If it was your last NFT, Shapes keep selling; only a pool that requires a curated NFT pauses until you add another.'],
  ['Can I lose money?', 'Mint fees and restocking charges are built into prize prices. Successful purchases generate proceeds; refunded draws do not. Keepers are paid from your operating ETH, so low volume, large wins and gas costs can consume your capital. Fees in unsold prizes are not cash. Initial mint and keeper costs remain costs even if nobody buys. Shapes and Packs retain their redeemable backing.'],
  ['How do I get my ETH and NFTs back?', 'Accrued pool creator earnings can be claimed even while inventory is underfunded. Operating ETH above the reserve can also be withdrawn. To take everything out, close purchases, unlist the prizes (each is redeemed for its ETH), withdraw your NFTs, then withdraw the rest.'],
  ['Do purchases pause after draws?', 'Purchases may continue with a partially stocked target. They pause when the inventory gate is below 70% of the target weight, or at the busy threshold. If you chose to require a curated NFT, they also pause while none is available. A Shapes mint fee above the accepted amount stops restocking, not sales of listed prizes. The actual remaining inventory sets the current draw price and odds.'],
  ['Why does my design pause after a few unsettled draws?', 'A draw stays unsettled until its random number arrives and upkeep records which prize it won. Until then the pool cannot tell which prize is gone, so it assumes each unsettled draw took a 0.01 ETH Shape, the Shape most likely to be won. It accepts a new purchase only if the prizes left would still be at least 70% of your design, so a new player gets close to the odds shown. A mix with many small Shapes absorbs several unsettled draws; a mix with few small Shapes pauses sooner. A new purchase is also refused when at least five draws are unsettled; a batch can already be in flight. Settlement can release that busy condition, but an inventory or ETH shortage may still need pool creator action.'],
  ['Can sales replenish every shortage?', 'Only while purchases remain available and players keep buying. If inventory is too low to admit purchases and no sales are waiting to be collected, add ETH, reduce the target mix, or close and recover the remaining assets. No refill time is guaranteed.'],
  ['What does the player pay on top of the draw price?', "FWA's randomness (VRF) fee and the transaction's gas. Both are set by the network at draw time."],
  ['When does a new earnings rate apply?', 'Changing the rate collects currently available owner proceeds using the old percentage, then stores the new percentage. Later collections use the new percentage, including earlier purchases that settle afterward. Existing credit stays unchanged. A 100% rate leaves no new proceeds for operations.'],
  ['Can I change the design later?', "Yes. Prices & mix shows the current pool next to your changes before you save. A new markup applies to Shape prizes listed after the change; prizes already listed keep their price."],
];

/** The main pool page: what the shared vault and personal managers do with ETH. Live figures come from the vault. */
export function HowItWorksMain() {
  const { data: v } = useVault();
  const backing = v?.edge[2] ? `about ${eth(v.edge[1], 4)} ETH` : 'an amount set from FWA\'s live fees';
  return (
    <main className="page hiw">
      <p className="note hiw-switch"><a className="link" href="#how">Community pools</a> · Main pool</p>
      <h1 className="title">How the main pool works</h1>
      <p className="lead">The shared vault{MANAGER_FACTORY ? ' and personal managers' : ''} put ETH to work on FWA's main pool. Each builds Shape packs and lists them with ETH backing.</p>

      <section className="hiw-sec">
        <h2 className="h3">1. The pack</h2>
        <p className="hiw-p">Each pack is one 0.05 ETH Shape and one 0.01 ETH Shape, minted straight into a ShapePack: <b>0.06 ETH</b> of Shapes that redeem for exactly that ETH.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">2. Listing with backing</h2>
        <p className="hiw-p">A pack is listed on FWA's main pool with <b>{backing}</b> of backing. While it is listed it earns a share of every acquisition fee on the pool. Backing is set so that a buyer who draws the pack does better keeping it than taking FWA's bid.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">3. Keep or bid</h2>
        <p className="hiw-p">When FWA selects a pack, the buyer chooses. <b>Keep</b>: the buyer takes the pack, the backing comes back less FWA's settlement fee, and a new pack is built. <b>Bid</b>: the buyer takes FWA's bid instead, which is paid from the backing; the pack comes back and is listed again.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">4. The shared vault's checkpoints</h2>
        <p className="hiw-p">Holders own shares that can't be transferred. Deposits and redemptions wait for the next <b>checkpoint</b>, which runs at most once every 12 hours, in FWA's quiet window, and prices them together.</p>
        <p className="hiw-p">A deposit can be cancelled for a full refund until it is priced. A redemption locks shares; each checkpoint fills it from the vault's free ETH and the rest stays invested until filled. Filled ETH waits for you to <b>claim</b> it.</p>
      </section>

      {MANAGER_FACTORY && (
        <section className="hiw-sec">
          <h2 className="h3">5. Personal managers</h2>
          <p className="hiw-p">A manager runs the same strategy with only your ETH, in a contract only you can withdraw from. The factory that created it keeps no control. There are no shares or checkpoints: idle ETH can be withdrawn at any time.</p>
          <p className="hiw-p"><b>Exit mode</b> unlists every pack and turns it back into ETH. A pack a buyer has already drawn returns once FWA settles it. You can leave exit mode later; listing stays paused until you resume it.</p>
        </section>
      )}

      <section className="hiw-sec">
        <h2 className="h3">{MANAGER_FACTORY ? '6' : '5'}. Costs</h2>
        <p className="hiw-p">Every Shape minted pays the Shapes mint fee, which goes to the Shapes creator. Keepers who build, list and sync packs are paid from the account's own ETH, within budgets that refill daily. {v ? (v.requestCharge > 0n ? `A vault deposit or redemption request pays a ${eth(v.requestCharge, 6)} ETH request charge toward its checkpoint` : 'Vault requests pay a request charge toward their checkpoint') : 'Vault requests pay a request charge toward their checkpoint'}, and a deposit's building and listing charge stays in the vault. There is no vault fee and no factory fee.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">{MANAGER_FACTORY ? '7' : '6'}. Risks</h2>
        <p className="hiw-p">Results quoted for the main pool are model results, not forecasts. Small amounts have a wide loss tail: with few packs the outcome is mostly the luck of which listings are drawn and whether buyers keep or bid. FWA's owner can change fees and settings, and its conditions can pause new investment; withdrawals and redemptions continue.</p>
      </section>
    </main>
  );
}
