#!/usr/bin/env bash
# Fail closed when Forge's cache contains ABI-only artifacts, which forge test silently omits.
set -euo pipefail
cd "$(dirname "$0")/.."
forge --version | grep -q 'Version: 1.8.1' || { echo 'focused gas evidence needs Foundry 1.8.1' >&2; exit 1; }
python3 - <<'PY'
import json
from pathlib import Path
suites = {
    'FocusedERC20Callbacks': ['FocusedERC20CallbacksTest'],
    'FocusedReleaseFlow': ['FocusedReleaseFlowTest'],
    'FocusedInventoryGas': ['FocusedInventoryGasTest'],
    'InventoryBatches': ['InventoryBatchesTest'],
    'ERC20Recovery': ['ERC20RecoveryTest'],
    'FactoryPause': ['FactoryPauseTest'],
    'AuthenticRefundRecovery': ['AuthenticRefundRecoveryTest'],
    'AuthenticEconomicFlows': ['AuthenticEconomicFlowsTest', 'AuthenticPositiveProceedsTest'],
    'AuthenticContinuation': ['AuthenticContinuationTest'],
    'AuthenticSequence': ['AuthenticSequenceTest'],
    'CreatorFeeReinvestment': ['CreatorFeeReinvestmentTest'],
    'CostFirstProceeds': ['CostFirstProceedsTest'],
}
missing = []
for source, contracts in suites.items():
    for contract in contracts:
        path = Path(f'out/{source}.t.sol/{contract}.json')
        if not path.exists() or json.loads(path.read_text()).get('bytecode', {}).get('object', '') in ('', '0x'):
            missing.append(f'test/{source}.t.sol')
if missing:
    raise SystemExit('Missing executable test artifacts. Restore only these sources, then retry:\nCANDIDATE_RUN=1 forge build ' + ' '.join(sorted(set(missing))) + ' --no-cache')
PY
CANDIDATE_RUN=1 forge test --match-contract '^(FocusedERC20CallbacksTest|FocusedReleaseFlowTest|FocusedInventoryGasTest|InventoryBatchesTest|ERC20RecoveryTest|FactoryPauseTest|AuthenticRefundRecoveryTest|AuthenticEconomicFlowsTest|AuthenticPositiveProceedsTest|AuthenticContinuationTest|AuthenticSequenceTest|CreatorFeeReinvestmentTest|CostFirstProceedsTest)$' --threads 1 -vv
