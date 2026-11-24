import json,urllib.request,subprocess
from pathlib import Path
rpc='http://127.0.0.1:18647';vault='0xb0858bf1b8a167188847499b3008e597b57eaebc';actor='0x37Dcd875c4E367e080f1e05F18F10dB0D45a65B5';out=Path('/tmp/shapes-app-ui-preview')
def call(method,params):
 x=json.load(urllib.request.urlopen(urllib.request.Request(rpc,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})))
 if 'error'in x:raise RuntimeError(x['error'])
 return x['result']
end=int(call('eth_blockNumber',[]),16);rows=[]
for n in range(26484919,end+1):
 b=call('eth_getBlockByNumber',[hex(n),True])
 for t in b['transactions']:
  if t['from'].lower()==actor.lower():rows.append({'transaction':t,'receipt':call('eth_getTransactionReceipt',[t['hash']])})
assert len(rows)==16 and all(r['receipt']['status']=='0x1' for r in rows)
def read(sig,*args):return subprocess.check_output(['cast','call',vault,sig,*args,'--block',str(end),'--rpc-url',rpc],text=True).strip()
state={'block':end,'holderState':read('holderState(address)(uint256,uint256,uint256)',actor),'pendingDeposit':read('pendingDeposits(address)(uint128,uint128)',actor),'openListings':read('openListingCount()(uint256)'),'idlePacks':read('idlePackCount()(uint256)'),'refunds':{str(i):read('checkpointRefund(uint256)(uint256)',str(i))for i in range(7,12)}}
assert state['holderState'].splitlines()==['0','0','0'];assert state['pendingDeposit'].splitlines()[0]=='0';assert state['openListings']==state['idlePacks']=='0';assert all(x=='0'for x in state['refunds'].values())
cases=[]
for name,begin,finish in [('cancellable-and-liquid',26484918,26484929),('productive-book-exit',26484929,end)]:
 selected=[r for r in rows if begin<int(r['receipt']['blockNumber'],16)<=finish]
 gas=sum(int(r['receipt']['gasUsed'],16)*int(r['receipt']['effectiveGasPrice'],16)for r in selected)
 sent=sum(int(r['transaction']['value'],16)for r in selected)
 before=int(call('eth_getBalance',[actor,hex(begin)]),16);after=int(call('eth_getBalance',[actor,hex(finish)]),16)
 refunds=[r for r in selected if r['transaction']['input'].startswith('0xcc4b6162')]
 refundgas=sum(int(r['receipt']['gasUsed'],16)*int(r['receipt']['effectiveGasPrice'],16)for r in refunds)
 cases.append({'name':name,'start_block':begin,'end_block':finish,'transactions':len(selected),'wallet_before_wei':str(before),'wallet_after_wei':str(after),'wallet_sent_wei':str(sent),'wallet_receipt_gas_wei':str(gas),'wallet_returned_wei':str(after-before+gas+sent),'wallet_net_change_wei':str(after-before),'separate_refund_claim_transactions':len(refunds),'separate_refund_wallet_gas_wei':str(refundgas)})
result={'rpc':rpc,'chainId':31337,'actor':actor,'vault':vault,'transactions':rows,'cases':cases,'final_state':state,'limitations':['Local unlocked wallet connector; extension/hardware-wallet confirmation UI not exercised.','Wallet priority fee here is about1gwei, not the keeper0.2/0.5gwei economic calibration.','Normal paid checkpoints and single productive build are separate recorded keeper transactions; their economic costs are not omitted from the setup records.','Refund claims are separate explicit wallet transactions outside the durable exit-step cap.']}
(out/'final-all-ui-receipts.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'cases':cases,'final_state':state},indent=2))
