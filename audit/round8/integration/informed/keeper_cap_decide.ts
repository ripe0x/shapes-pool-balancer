import { decide } from '../../../../keeper/keeper';

const gasEstimate = 3_281_532n; // highest eth_estimateGas in gas_delta_v3.output
const baseFee = 57_954_497n; // pinned block basefee
const priorityFee = 50_000_000n; // keeper default
const expectedReward = 3_200_000n * (baseFee + priorityFee) + 500_000_000_000_000n;
const normal = decide({ gasEstimate, expectedReward, baseFee, priorityFee, maxLossWei: 200_000_000_000_000n });
const override = decide({ gasEstimate, expectedReward, baseFee, priorityFee, maxLossWei: 1_000_000_000_000_000_000n });
console.log(JSON.stringify({
  gasEstimate: gasEstimate.toString(), baseFee: baseFee.toString(), priorityFee: priorityFee.toString(),
  expectedReward: expectedReward.toString(), normal, override,
}));
