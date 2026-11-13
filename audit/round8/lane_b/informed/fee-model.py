"""Exact integer formulas for hypothetical Shapes admin fee changes; no admin action is executed."""
import json

E = 10**18
NUM = 10**36
COUNTS = {0: 20, 1: 10, 2: 2, 3: 1, 9: 7}
AMOUNTS = {0: E // 100, 1: E // 20, 2: E // 10, 3: E // 2, 9: E // 50}
SHAPES = {0: 1, 1: 1, 2: 1, 3: 1, 9: 2}
MARKUP = 1500
RESTOCK = 900_000 * 1_050_000_000 + 200_000_000_000_000
CURATED_BASE = 3 * E // 10
CURATED_PRICE = CURATED_BASE * (10_000 + MARKUP) // 10_000
VRF_AT_1_05_GWEI = 2_457_000_000_000_000
MAX_KEEPER = 3_200_000 * 5_000_000_000 + 500_000_000_000_000


def assess(fee):
    listings = [(1, CURATED_PRICE, CURATED_BASE)]
    price_by_d = {}
    for d, count in COUNTS.items():
        v = AMOUNTS[d]
        shapes = SHAPES[d]
        price = v + shapes * fee + v * MARKUP // 10_000 + shapes * RESTOCK
        price_by_d[d] = price
        listings.append((count, price, v))
    total_w = sum(n * (NUM // price) for n, price, _ in listings)
    owner = sum(n * (NUM // price) * price for n, price, _ in listings) // total_w
    fee_quote = owner * 10500 // 10000
    player_value = sum(n * (NUM // price) * value for n, price, value in listings) // total_w
    shape_count = sum(COUNTS[d] * SHAPES[d] for d in COUNTS)
    backing = sum(COUNTS[d] * AMOUNTS[d] for d in COUNTS)
    largest = max(AMOUNTS[d] + SHAPES[d] * fee for d in COUNTS)
    full_reserve = largest + 2 * MAX_KEEPER
    units = shape_count + 3
    opening_reserve = backing + shape_count * fee + largest + ((units + 4) // 5 + 1) * MAX_KEEPER
    return {"mint_fee_wei": fee, "mint_fees_for_47_shapes_wei": shape_count * fee,
            "price_by_d_wei": price_by_d, "full_target_reserve_wei": full_reserve,
            "opening_reserve_wei": opening_reserve, "draw_fee_wei": fee_quote,
            "player_total_at_1_05_gwei_wei": fee_quote + VRF_AT_1_05_GWEI,
            "player_value_ev_wei": player_value,
            "player_return_bps": player_value * 10000 // (fee_quote + VRF_AT_1_05_GWEI),
            "curated_odds_ppm": (NUM // CURATED_PRICE) * 1_000_000 // total_w}


rows = [assess(int(x * E)) for x in (0.001, 0.005, 0.01)]
assert rows[0]["draw_fee_wei"] == 22_520_339_287_470_837
assert rows[0]["full_target_reserve_wei"] == 534_000_000_000_000_000
print(json.dumps({"scope": "hypothetical full relisting at each fee, 1 gwei basefee, 1.05 gwei tx price, 15% markup", "rows": rows}, indent=2))
