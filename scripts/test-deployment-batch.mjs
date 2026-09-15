import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'vite';
import {ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction} from '@solana/web3.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.sites-runtime/deployment-batch-tests');
await build({configFile:false,root,publicDir:false,logLevel:'silent',build:{ssr:true,outDir:out,emptyOutDir:true,rollupOptions:{input:path.join(root,'lib/solana-deployment-batch.ts'),output:{entryFileNames:'batch.mjs'}}}});
const {deploymentUploadBatchIsSafe} = await import(pathToFileURL(path.join(out,'batch.mjs')).href);
const owner = new PublicKey('8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9');
const buffer = new PublicKey('HPAjaAv56oUXGy2nXML9qkLc7fL5TfY4RHrjF3t1z9M4');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const lighthouse = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
// Public instruction bytes from the user's successful Write at slot447310760.
// These are assertions, not a signed transaction, secret or live submission.
const before = Buffer.from('0604010202a8f6914e88a1b0e210153ef763ae2b00c2b93d16c124d2c0537a100480000000','hex');
const payerGuard = Buffer.from('06040300605d4039000000000403000001000000000000000000','hex');
const authority = Buffer.from('0d040100016e66c1801df34c2ff5ed6146b75fd0d4ba19f908927a8699987c805976214cae00','hex');
const guard = (data,target) => new TransactionInstruction({programId:lighthouse,keys:target?[{pubkey:target,isSigner:false,isWritable:false}]:[],data});
function transaction({payer=payerGuard,pre=before,post=authority,extra=[],unguarded=false}={}) {
  const data = Buffer.alloc(716);data.writeUInt32LE(1);data.writeUInt32LE(14_700,4);data.writeBigUInt64LE(700n,8);
  const write = new TransactionInstruction({programId:loader,keys:[{pubkey:buffer,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:false}],data});
  return new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:owner.toBase58(),instructions:[
    ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),
    ...(unguarded?[]:[guard(pre,buffer)]),write,...(unguarded?[]:[guard(payer,owner),guard(post,buffer)]),...extra,
  ]}).compileToV0Message());
}
const options = {owner:owner.toBase58(),buffer:buffer.toBase58(),balanceLamports:965526520,totalFeeLamports:35000};
let passed=0;function test(name,run){run();passed++;console.log(`PASS ${passed} ${name}`);}

test('observed Phantom assertions allow five writes without changing their serialized packets',()=>{
  const txs=Array.from({length:5},()=>transaction()),packets=txs.map(tx=>Buffer.from(tx.serialize()));
  assert(deploymentUploadBatchIsSafe(txs,options));
  txs.forEach((tx,i)=>assert.deepEqual(Buffer.from(tx.serialize()),packets[i]));
  assert(deploymentUploadBatchIsSafe(Array.from({length:5},()=>transaction({unguarded:true})),options));
});
test('every payer floor is checked after the entire group fee, including exact boundary',()=>{
  const floor=960519520;
  assert(deploymentUploadBatchIsSafe([transaction()],{...options,balanceLamports:floor+options.totalFeeLamports}));
  assert(!deploymentUploadBatchIsSafe([transaction()],{...options,balanceLamports:floor+options.totalFeeLamports-1}));
  const high=Buffer.from(payerGuard);high.writeBigUInt64LE(BigInt(options.balanceLamports),4);
  assert(!deploymentUploadBatchIsSafe([transaction(),transaction({payer:high})],options));
});
test('balance equality, clock, hashes, unknown operators and changed authorities cannot be grouped',()=>{
  const equality=Buffer.from(payerGuard);equality[12]=0;
  const unknown=Buffer.from(payerGuard);unknown[12]=8;
  const changedAuthority=Buffer.from(authority);changedAuthority[7]^=1;
  const wrongOwner=Buffer.from(before);wrongOwner[8]^=1;
  const hash=Buffer.from([5,0,8,...new Uint8Array(32),0,1]);
  const clock=guard(Buffer.from([15,0,0,...new Uint8Array(8),4]),null);
  for(const tx of [transaction({payer:equality}),transaction({payer:unknown}),transaction({post:changedAuthority}),transaction({pre:wrongOwner}),transaction({pre:hash}),transaction({extra:[clock]})]) assert(!deploymentUploadBatchIsSafe([tx],options));
});
test('truncated, trailing, noncanonical or unsupported assertions fail closed',()=>{
  for(const payer of [payerGuard.subarray(0,-1),Buffer.concat([payerGuard,Buffer.from([0])]),Buffer.from([6,0,129,0]),Buffer.from([6,0,9]),Buffer.from([5,3,0,...new Uint8Array(8),4])]) assert(!deploymentUploadBatchIsSafe([transaction({payer})],options));
  const empty=Buffer.from([6,0,0]);assert(!deploymentUploadBatchIsSafe([transaction({payer:empty})],options));
});
test('unrelated transfers, excessive groups and invalid funding inputs cannot qualify',()=>{
  const transfer=SystemProgram.transfer({fromPubkey:owner,toPubkey:buffer,lamports:1});
  assert(!deploymentUploadBatchIsSafe([transaction({extra:[transfer]})],options));
  assert(!deploymentUploadBatchIsSafe([],options));assert(!deploymentUploadBatchIsSafe(Array.from({length:6},()=>transaction()),options));
  for(const patch of [{balanceLamports:NaN},{balanceLamports:1},{totalFeeLamports:0},{totalFeeLamports:-1},{totalFeeLamports:1.5},{owner:buffer.toBase58()},{buffer:owner.toBase58()}]) assert(!deploymentUploadBatchIsSafe([transaction()],{...options,...patch}));
});
console.log(`Deployment batch eligibility: ${passed} groups passed; no signatures or network requests.`);
