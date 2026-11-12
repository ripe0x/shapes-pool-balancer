import type { CSSProperties } from 'react';
import { parseEther } from 'viem';
import { BY_VALUE, DENOMS, capitalOf, economics, prizeLabel, restockFeeAt, type Counts } from '../../shared/planner';
import { describe, ethNeeded, mixOf, playerView, styleBonus, type DesignInputs, type Style } from '../../shared/design';

// One worked example used by every visual: a 0.2 ETH NFT, 20 small Shapes, 15% markup, today's mint fee, 1 gwei gas.
const EXAMPLE: DesignInputs = {
  curatedBases: [parseEther('0.2')], markupBps: 1500, edgeBps: 500, mintFee: parseEther('0.001'), restockFee: restockFeeAt(10n ** 9n),
  have: Array(16).fill(0),
};
const SMALL = 20;
const STYLES: { key: Style; label: string }[] = [
  { key: 'steady', label: 'Low draw price' }, { key: 'board', label: 'Balanced' },
  { key: 'balanced', label: 'More big wins' }, { key: 'jackpot', label: 'Jackpot' },
];
const SHADES = ['#333', '#555', '#7a7a7a', '#b5b5b5'];
const eth = (wei: bigint, d = 3) => (Number(wei) / 1e18).toFixed(d).replace(/\.?0+$/, '');
const pct = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
const oneIn = (p: number) => `1 in ${1 / p < 10 ? (1 / p).toFixed(1) : Math.round(1 / p).toLocaleString()}`;

/** Groups of a mix, smallest value first, with shade, chance per draw and worth against the draw price. */
function groups(counts: Counts) {
  const ev = describe(counts, EXAMPLE);
  const view = playerView(ev, 0n);
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
  const counts = mixOf(SMALL, styleBonus('board', EXAMPLE, SMALL));
  const { ev, view, list } = groups(counts);
  const econ = economics(counts, EXAMPLE);
  const edge = EXAMPLE.edgeBps / 10_000;
  const draw = econ.ownerProceeds * (1 + edge);
  const markupShare = econ.markupPerDraw / draw;
  const feeShare = (econ.mintFeesPerDraw + econ.restockFeesPerDraw) / draw;
  const edgeShare = edge / (1 + edge);
  const valueShare = 1 - markupShare - feeShare - edgeShare;
  const inPrizes = capitalOf(counts);
  const needed = ethNeeded(counts, EXAMPLE);
  // A deposit covering what the pool needs, rounded up to the next 0.5 ETH, plus 0.5 ETH left unused.
  const half = parseEther('0.5');
  const deposit = ((needed + half - 1n) / half + 1n) * half;
  const reserve = needed - inPrizes;
  const unused = deposit - needed;
  return (
    <main className="page hiw">
      <h1 className="title">How it works</h1>
      <p className="lead">A pool is a prize inventory on FWA. Players pay a draw price and win one prize at random. You put in your NFTs and ETH; the pool keeps itself stocked.</p>
      <p className="note" style={{ marginTop: 10 }}>Every number below comes from one example: a 0.2 ETH NFT, the Balanced style at 20 small Shapes, and a 15% markup.</p>

      <section className="hiw-sec">
        <h2 className="h3">1. One inventory, two kinds of prizes</h2>
        <p className="hiw-p"><b>Your NFTs</b> are the prizes you give away. <b>Shapes</b> fill the rest: each is a token holding a fixed amount of ETH (0.01 to 100), which the winner can redeem. Values between the Shape sizes, like 0.02 or 0.25 ETH, are <b>Packs</b>: one token holding a few Shapes.</p>
        <Squares counts={counts} />
        <div className="legend">
          {list.map((g) => <div key={g.key}><span className="sw" style={g.style} /><span><b>{g.n}</b> × {g.label}{g.nft ? ` (${eth(EXAMPLE.curatedBases[0])} ETH)` : ''}</span></div>)}
        </div>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">2. How a draw picks a prize</h2>
        <p className="hiw-p">FWA gives each prize a chance in proportion to 1 ÷ its price. A 0.01 ETH Shape comes up 20 times as often as a 0.2 ETH NFT. So every prize carries the same expected value per draw, and a prize is rare exactly when it is worth many times the others.</p>
        <Bar parts={list.map((g) => ({ label: g.label, share: g.odds, style: g.style, note: `${g.multiple.toFixed(2)}× the price` }))} />
        <div className="hiw-stats">
          <div><span className="figure-s">{eth(ev.drawPrice, 4)}</span><span className="unit">ETH</span><p className="note">Draw price</p></div>
          <div><span className="figure-s">{oneIn(view.winMore)}</span><p className="note">Win more than they paid</p></div>
          <div><span className="figure-s">{oneIn(view.curated)}</span><p className="note">Win your NFT</p></div>
        </div>
        <p className="note" style={{ marginTop: 10 }}>Players also pay FWA's randomness (VRF) fee and gas, which are set at draw time.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">3. Won prizes are restocked</h2>
        <p className="hiw-p">You choose the mix once. When a prize is won, the pool replaces it with the same prize, so it keeps that mix draw after draw. Your NFTs are not replaced.</p>
        <ol className="hiw-cycle">
          <li><b>A player draws</b><span>and wins, say, a 0.05 ETH Shape.</span></li>
          <li><b>Draws continue</b><span>Other players keep drawing from the prizes still listed.</span></li>
          <li><b>Upkeep restocks</b><span>Anyone can run it; keepers do. It mints a new 0.05 ETH Shape from the pool's ETH and lists it.</span></li>
          <li><b>Back to the mix</b><span>Same prizes, same odds, usually within a block or two.</span></li>
        </ol>
        <p className="note">Keepers are paid only from the restocking fees in prize prices. When gas costs more than those fees, keepers wait; if the prizes left fall under 70% of your mix, purchases pause until gas comes down.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">4. Where each draw's ETH goes</h2>
        <p className="hiw-p">On average, of every draw price:</p>
        <Bar parts={[
          { label: 'goes back to players as prizes', share: valueShare, style: { background: '#7a7a7a' } },
          { label: 'is your markup', share: markupShare, style: { background: '#fff' } },
          { label: 'pays mint fees and keepers', share: feeShare, style: { background: '#b5b5b5' } },
          { label: "is FWA's fee", share: edgeShare, style: { background: '#333' } },
        ]} />
        <p className="hiw-p" style={{ marginTop: 14 }}>Running costs are priced on top of your markup. Each Shape prize's price includes the Shapes mint fee for its replacement (0.001 ETH a Shape today) and a restocking fee that pays keepers, set from the gas price when the prize is listed ({eth(EXAMPLE.restockFee, 5)} ETH a Shape at 1 gwei). Keepers are paid only from restocking fees, so your markup is yours: about {econ.markupPerDraw.toFixed(4)} ETH a draw in this example.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">5. Your ETH</h2>
        <p className="hiw-p">Say you create this pool with {eth(deposit, 1)} ETH:</p>
        <Bar parts={[
          { label: 'buys the prizes', share: Number(inPrizes) / Number(deposit), style: { background: '#b5b5b5' }, note: `${eth(inPrizes)} ETH` },
          { label: 'is held as reserve', share: Number(reserve) / Number(deposit), style: { background: '#555' }, note: `${eth(reserve)} ETH` },
          { label: 'is unused', share: Number(unused) / Number(deposit), style: { border: '1.5px solid #555' }, note: `${eth(unused)} ETH, withdraw any time` },
        ]} />
        <p className="hiw-p" style={{ marginTop: 14 }}>The reserve covers mint fees, a spare top prize (so a big win is restocked straight away) and keeper rewards. While the pool is open it stays in the pool; it is still your money: when you close the pool and unlist the prizes, each is redeemed for its exact ETH and everything can be withdrawn.</p>
      </section>

      <section className="hiw-sec">
        <h2 className="h3">6. Game styles</h2>
        <p className="hiw-p">A style decides which prizes sit next to your NFTs. The pool size slider sets how many small Shapes there are.</p>
        <div className="hiw-styles">
          {STYLES.map((s) => {
            const c = mixOf(SMALL, styleBonus(s.key, EXAMPLE, SMALL));
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
        <button className="btn" style={{ marginTop: 24 }} onClick={onDesign}>Design a pool</button>
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
  ['Who owns the pool?', 'A contract created for you owns the FWA pool permanently; you are its creator. You can hand the creator role to another address, which has to accept.'],
  ['What happens when someone wins my NFT?', 'It goes to them. If you have other NFTs listed, the pool keeps running with the same prizes. If it was your last NFT, purchases stop until you add another.'],
  ['Can I lose money?', 'Mint fees and keepers are paid from fees in prize prices, never from your markup. Stocking the pool when you open it costs gas, and prizes still listed when you close keep their mint fees. Single draws and short runs vary either way. Prizes always redeem for their exact ETH.'],
  ['How do I get my ETH and NFTs back?', 'Unused ETH can be withdrawn at any time. To take everything out, close purchases, unlist the prizes (each is redeemed for its ETH), withdraw your NFTs, then withdraw the rest.'],
  ['Do purchases pause after draws?', 'No. Players can keep drawing while upkeep restocks won prizes, usually within a block or two. Purchases pause only when restocking falls far behind (the prizes left are under 70% of your design), when five draws are still settling, or when the Shapes mint fee rises above the one you accepted.'],
  ['What does the player pay on top of the draw price?', "FWA's randomness (VRF) fee and the transaction's gas. Both are set by the network at draw time."],
  ['Can I change the design later?', "Yes. Prices & mix shows the current pool next to your changes before you save. A new markup applies to prizes listed after the change; prizes already listed keep their price."],
];
