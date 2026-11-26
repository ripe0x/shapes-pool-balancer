import {expect,it} from 'vitest';
import {pinnedParams,validateRead} from './local-stress-branch';
it('allows only source reads and refuses transactions, administrative mutations and credential metadata',()=>{
 for(const method of ['eth_getStorageAt','eth_getCode','eth_getBlockByNumber','eth_getLogs'])expect(()=>validateRead(method)).not.toThrow();
 for(const method of ['eth_sendRawTransaction','eth_sendTransaction','anvil_reset','anvil_setBalance','evm_revert','personal_sendTransaction','anvil_nodeInfo','anvil_metadata'])expect(()=>validateRead(method)).toThrow();
});
it('pins live tags without changing specific historic block or slot arguments',()=>{
 expect(pinnedParams('eth_getStorageAt',['0xabc','0x05','latest'],42n)).toEqual(['0xabc','0x05','0x2a']);
 expect(pinnedParams('eth_getBalance',['0xabc','0x20'],42n)).toEqual(['0xabc','0x20']);
 expect(pinnedParams('eth_getLogs',[{fromBlock:'latest',toBlock:'pending',address:'0xabc'}],42n)).toEqual([{fromBlock:'0x2a',toBlock:'0x2a',address:'0xabc'}]);
});

it('refuses future source states and hashes outside the anchor',()=>{
 expect(()=>pinnedParams('eth_getBalance',['0xabc','0x2b'],42n)).toThrow('exceeds');
 expect(()=>pinnedParams('eth_getStorageAt',['0xabc','0x05',{blockHash:'0xbbb'}],42n,'0xaaa')).toThrow('unanchored');
 expect(pinnedParams('eth_getStorageAt',['0xabc','0x05',{blockHash:'0xaaa'}],42n,'0xaaa')).toEqual(['0xabc','0x05',{blockHash:'0xaaa'}]);
 expect(()=>pinnedParams('eth_getLogs',[{fromBlock:'0x10',toBlock:'0x30'}],42n)).toThrow('exceeds');
 expect(pinnedParams('eth_getBlockReceipts',[],42n)).toEqual(['0x2a']);
});
