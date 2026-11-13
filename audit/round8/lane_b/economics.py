"""Exact integer prize/weight arithmetic checked against the pinned fork's Balanced quote."""

import json

E = 10**18
NUM = 10**36
MINT_FEE = 10**15
MARKUP = 1500
EDGE = 500
BASEFEE = 10**9
RESTOCK = 900_000 * min(BASEFEE + 50_000_000, 5_000_000_000) + 200_000_000_000_000
AMOUNTS = {0: E // 100, 1: E // 20, 2: E // 10, 3: E // 2, 9: E // 50}
SHAPES = {0: 1, 1: 1, 2: 1, 3: 1, 9: 2}
CURATED_BASE = 3 * E // 10
CURATED_PRICE = CURATED_BASE * (10_000 + MARKUP) // 10_000


def evaluate(name, counts):
    listings = [("curated", 1, CURATED_PRICE, CURATED_BASE, 0)]
    for d, n in counts.items():
        backing = AMOUNTS[d]
        shapes = SHAPES[d]
        price = backing + shapes * MINT_FEE + backing * MARKUP // 10_000 + shapes * RESTOCK
        listings.append((str(d), n, price, backing, shapes))
    total_weight = sum(n * (NUM // price) for _, n, price, _, _ in listings)
    weighted_backing = sum(n * (NUM // price) * price for _, n, price, _, _ in listings)
    owner_proceeds = weighted_backing // total_weight
    fee = owner_proceeds * (10_000 + EDGE) // 10_000
    vrf = 2_457_000_000_000_000  # pinned fork quote at 1.05 gwei effective price
    value_ev = sum(n * (NUM // price) * value for _, n, price, value, _ in listings) // total_weight
    mint_ev = sum(n * (NUM // price) * shapes * MINT_FEE for _, n, price, _, shapes in listings) // total_weight
    restock_ev = sum(n * (NUM // price) * shapes * RESTOCK for _, n, price, _, shapes in listings) // total_weight
    markup_ev = owner_proceeds - value_ev - mint_ev - restock_ev
    largest = max(AMOUNTS[d] + SHAPES[d] * MINT_FEE for d in counts)
    full_reserve = largest + 2 * (3_200_000 * 5_000_000_000 + 500_000_000_000_000)
    return {
        "mix": name,
        "backing": sum(n * AMOUNTS[d] for d, n in counts.items()),
        "shape_count": sum(n * SHAPES[d] for d, n in counts.items()),
        "total_weight": total_weight,
        "weighted_backing_total": weighted_backing,
        "owner_proceeds_per_draw": owner_proceeds,
        "fwa_acquisition_fee": fee,
        "vrf_fee_at_1_05_gwei": vrf,
        "player_total": fee + vrf,
        "expected_player_value": value_ev,
        "player_return_bps": value_ev * 10_000 // (fee + vrf),
        "expected_mint_fee_per_draw": mint_ev,
        "expected_restock_fee_per_draw": restock_ev,
        "expected_markup_per_draw": markup_ev,
        "full_target_reserve": full_reserve,
        "odds_ppm": {label: n * (NUM // price) * 1_000_000 // total_weight for label, n, price, _, _ in listings},
    }


balanced = evaluate("Balanced", {0: 20, 1: 10, 2: 2, 3: 1, 9: 7})
assert balanced["total_weight"] == 1_911_605_302_676_359_387_351
assert balanced["weighted_backing_total"] == 40_999_999_999_999_999_998_546_800_000_000_000_000
assert balanced["fwa_acquisition_fee"] == 22_520_339_287_470_837
assert balanced["full_target_reserve"] == 534_000_000_000_000_000
print(json.dumps({
    "formula_cross_check": "Balanced exact integer totals equal the real fork output in corrected-all.stdout-stderr.txt",
    "restock_fee_per_shape_at_1_gwei": RESTOCK,
    "mixes": [balanced, evaluate("large", {0: 5, 3: 5}), evaluate("cheap", {0: 20})],
}, indent=2))
