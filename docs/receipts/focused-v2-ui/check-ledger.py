import json
from pathlib import Path
p = Path(__file__).with_name('postflight.json')
x = json.loads(p.read_text())
w = lambda value: int(value)
e = x['events']
claim = w(x['claim']['amountWei'])
assert w(e['capitalDeposits']) + w(e['sales']) - w(e['keeperPaid']) - w(e['mintCosts']) - claim == w(x['claim']['after']['cash']) == 0
assert w(e['mintCosts']) == 253000000000000000  # 23 actual .01 Shape mints, each with .001 mint fee.
assert len(x['wins']) == 3
assert w(x['finalBackingWei']) == 200000000000000000  # .23 minted backing minus .03 delivered backing.
assert w(x['topUp']['actualUsedWei']) + claim == w(x['topUp']['before']['fees'])
assert w(x['topUp']['after']['capital']) - w(x['topUp']['before']['capital']) == w(x['topUp']['actualUsedWei'])
assert w(x['claim']['after']['capital']) == w(x['topUp']['after']['capital'])
assert w(x['finalBackingWei']) - w(x['claim']['after']['capital']) == w(x['signedBankrollResultWei'])
assert w(x['claim']['walletAfter']) - w(x['claim']['walletBefore']) + w(x['claim']['actualGasWei']) == claim
assert x['transactionCount'] == 20 <= 30
assert x['elapsedMs'] <= 900000
assert w(x['forwardValueWei']) <= 500000000000000000
assert w(x['gasWei']) <= 1000000000000000000
assert x['newFundingWei'] == '0'
print('PASS: full cash destination ledger, minted/delivered/retained backing, fee/capital reclassification, actual wallet receipt and cumulative batch caps')
print('Native deposits:', e['capitalDeposits'], 'owner receipts:', e['sales'], 'mint backing+fees:', e['mintCosts'], 'keeper rewards:', e['keeperPaid'], 'creator withdrawal:', claim, 'remaining cash: 0')
