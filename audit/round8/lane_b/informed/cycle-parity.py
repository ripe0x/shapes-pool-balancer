"""Compare exact one-win destination arithmetic with the retained pinned-fork lifecycle log."""
import json
import re
from pathlib import Path

log = Path('audit/round8/lane_b/final-focused.stdout-stderr.txt').read_text()


def value(label):
    m = re.search(r'^  ' + re.escape(label) + r' (\d+)$', log, re.M)
    assert m, label
    return int(m.group(1))


draw_fee = value('draw fee')
vrf_fee = value('vrf fee')
keeper_reward = value('keeper reward')
pool_delta = value('pool balance delta')
no_win_reclaim = value('retired creator reclaim')
one_win_reclaim = value('post-draw creator reclaim')
assert draw_fee == 22_520_339_287_470_837
assert vrf_fee == 2_457_000_000_000_000
assert keeper_reward == 1_145_000_000_000_000
owner_proceeds = 21_447_942_178_543_655  # exact weighted listing-price EV from the fork-matched model
new_shape_cost = 11_000_000_000_000_000  # 0.01 ETH backing + 0.001 ETH Shapes mint fee
assert owner_proceeds - new_shape_cost - keeper_reward == pool_delta
assert one_win_reclaim - no_win_reclaim == pool_delta
assert one_win_reclaim == 3_933_103_955_478_543_655
assert value('keeper credit after') == 0
print(json.dumps({
    'scope': 'one 0.01 ETH Shape win/restock, close/unlist/retire/withdraw, winner redemption; pinned Foundry fork',
    'payer_note': 'Foundry pre-read p.inventoryVersion() inside vm.prank expression consumed the prank; test contract funded purchase. Separate code-free Anvil EOA-payer receipt (`keeper-receipts-eoa.json`) proves same quote and draw.',
    'draw_fee_wei': draw_fee, 'vrf_fee_wei': vrf_fee,
    'owner_proceeds_wei': owner_proceeds, 'new_shape_cost_wei': new_shape_cost,
    'keeper_reward_wei': keeper_reward, 'predicted_and_observed_balancer_delta_wei': pool_delta,
    'no_win_creator_reclaim_wei': no_win_reclaim, 'one_win_creator_reclaim_wei': one_win_reclaim,
    'creator_net_after_one_win_excluding_returned_nft_wei': one_win_reclaim - 4_000_000_000_000_000_000,
    'winning_shape_backing_redeemed_wei': 10_000_000_000_000_000,
    'cumulative_shapes_mint_fees_wei': 48_000_000_000_000_000,
    'pool_liquid_after_final_claim_wei': 0,
}, indent=2))
