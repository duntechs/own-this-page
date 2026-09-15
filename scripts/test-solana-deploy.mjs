import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'vite';
import {Keypair, PublicKey, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction} from '@solana/web3.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixedOwner = '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9';
const payer = Keypair.generate();
const output = path.join(root, '.sites-runtime/solana-deployment-tests');
assert((await readFile(path.join(root, 'lib/solana-client.ts'), 'utf8')).includes(`SOLANA_TREASURY = '${fixedOwner}'`));
// Only this isolated test bundle substitutes a generated signing identity.
// The production source and pinned immutable ELF are never modified. Every
// signature in the tests is genuine Ed25519, verified by production code.
await build({configFile: false, root, publicDir: false, logLevel: 'silent', plugins: [{name: 'test-only-deployment-owner', transform(code, id) {
  if (id.endsWith('/lib/solana-client.ts')) return code.replaceAll(fixedOwner, payer.publicKey.toBase58());
}}], build: {ssr: true, outDir: output, emptyOutDir: true, rollupOptions: {input: path.join(root, 'lib/solana-deploy.ts'), output: {entryFileNames: 'engine.mjs'}}}});
const {DeploymentEngine, DeploymentPausedError, DEPLOYMENT_PROGRAM_SHA256, DEPLOYMENT_PROGRAM_LENGTH, DEPLOYMENT_LOADER, deploymentProgramDataAddress} = await import(pathToFileURL(path.join(output, 'engine.mjs')).href);
const binary = Uint8Array.from(await readFile(path.join(root, 'solana-market/artifacts/slot_market.so')));
assert.equal(binary.length, DEPLOYMENT_PROGRAM_LENGTH);
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
function signatureText(bytes) {const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),out='';while(n){out=alphabet[Number(n%58n)]+out;n/=58n;}for(const b of bytes){if(b)break;out='1'+out;}return out;}
const info = (data, executable=false) => ({data:Buffer.from(data),executable,owner:DEPLOYMENT_LOADER,lamports:900000000,rentEpoch:0});
function fixture() {
  const accounts=new Map(),receipts=new Map(),saved=new Map(),broadcasts=[],applied=[],signedBatches=[];
  let slot=100,height=110,engine,update=()=>{},statusUnavailable=false,dropBefore=false,dropAfter=false,changeWallet=false,changeMessage=false;
  const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
  const checkpoint=()=>JSON.parse([...saved.values()][0]);
  const signer={publicKey:payer.publicKey,assertCurrentAccount(){if(changeWallet)throw Error('wallet changed');},async signTransactions(txs){
    signedBatches.push(txs.length);
    return txs.map(tx=>{
      const t=VersionedTransaction.deserialize(tx.serialize());
      if(changeMessage)t.message.recentBlockhash=Keypair.generate().publicKey.toBase58();
      t.sign([payer]);return t;
    });
  }};
  const rpc={
    async getGenesisHash(){return genesis;},
    async getAccountInfoAndContext(key,options){assert(options.minContextSlot<=slot,'confirmed account floor must not use processed status tip');const a=accounts.get(key.toBase58());return {context:{slot},value:a?{...a,data:Buffer.from(a.data)}:null};},
    async getMinimumBalanceForRentExemption(size){return size*8+1000;},
    async getLatestBlockhash(){return {blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:height+150};},
    async getFeeForMessage(){return {context:{slot},value:5000};},
    async getBalance(){return 100000000000;},
    async getRecentPrioritizationFees(){return [{prioritizationFee:10000}];},
    async getBlockHeight(){return height;},
    async getEpochInfo(){return {absoluteSlot:slot,blockHeight:height};},
    async simulateTransaction(tx){assert.equal(tx.version,0);assert.equal(tx.message.header.numRequiredSignatures,1);assert(tx.serialize().length<=1232);return {context:{slot},value:{err:null}};},
    async getSignatureStatuses(ids){if(statusUnavailable)throw Error('RPC temporarily unavailable');return {context:{slot:slot+50},value:ids.map(id=>receipts.get(id)??null)};},
    async sendRawTransaction(bytes,options){
      assert.equal(options.skipPreflight,false);assert.equal(options.maxRetries,3);
      const tx=VersionedTransaction.deserialize(bytes),signature=signatureText(tx.signatures[0]);
      broadcasts.push(signature);
      assert(checkpoint().pending.some(p=>p.signature===signature),'public signed receipt must be durable before submission');
      assert(checkpoint().pending.every(p=>p.raw&&p.blockhash&&p.lastValidBlockHeight),'all batch packets are saved first');
      if(dropBefore){dropBefore=false;statusUnavailable=true;throw Error('RPC response lost before acceptance');}
      if(!receipts.has(signature)){
        const instructions=TransactionMessage.decompile(tx.message).instructions;
        assert.equal(instructions.length>=3,true);
        for(const ix of instructions.slice(2)){
          if(ix.programId.equals(SystemProgram.programId)){
            const decoded=SystemInstruction.decodeCreateWithSeed(ix);
            assert(decoded.fromPubkey.equals(payer.publicKey));assert(decoded.basePubkey.equals(payer.publicKey));
            assert((await PublicKey.createWithSeed(decoded.basePubkey,decoded.seed,decoded.programId)).equals(decoded.newAccountPubkey));
            assert(!accounts.has(decoded.newAccountPubkey.toBase58()),'never create an existing seeded account');
            accounts.set(decoded.newAccountPubkey.toBase58(),info(Buffer.alloc(decoded.space)));
            applied.push({kind:decoded.space===36?'program-account':'buffer-account',signature});
          }else if(ix.programId.equals(DEPLOYMENT_LOADER)){
            const op=ix.data.readUInt32LE(0);
            if(op===0){const a=accounts.get(ix.keys[0].pubkey.toBase58());a.data.writeUInt32LE(1,0);a.data[4]=1;payer.publicKey.toBuffer().copy(a.data,5);}
            else if(op===1){const a=accounts.get(ix.keys[0].pubkey.toBase58()),offset=ix.data.readUInt32LE(4),length=Number(ix.data.readBigUInt64LE(8));assert.equal(length,ix.data.length-16);ix.data.copy(a.data,37+offset,16);applied.push({kind:'write',offset,signature});}
            else if(op===2){
              assert.equal(Number(ix.data.readBigUInt64LE(4)),binary.length);
              const program=ix.keys[2].pubkey,buffer=accounts.get(ix.keys[3].pubkey.toBase58());
              assert.deepEqual(buffer.data.subarray(37),Buffer.from(binary),'final deployment requires exact uploaded bytes');
              const data=Buffer.alloc(45+binary.length);data.writeUInt32LE(3,0);data[12]=1;payer.publicKey.toBuffer().copy(data,13);Buffer.from(binary).copy(data,45);
              accounts.set(ix.keys[1].pubkey.toBase58(),info(data));
              const p=Buffer.alloc(36);p.writeUInt32LE(2,0);deploymentProgramDataAddress(program).toBuffer().copy(p,4);accounts.set(program.toBase58(),info(p,true));accounts.delete(ix.keys[3].pubkey.toBase58());applied.push({kind:'deploy',signature});
            }else assert.fail('unexpected loader instruction');
          }else assert.fail('unexpected instruction recipient');
        }
        slot++;receipts.set(signature,{slot,err:null,confirmationStatus:'confirmed',confirmations:1});
      }
      if(dropAfter){dropAfter=false;statusUnavailable=true;throw Error('RPC lost reply after accepting transaction');}
      return signature;
    },
  };
  const fresh=()=>engine=new DeploymentEngine({connection:rpc,binary,storage,onUpdate:p=>update(p)});
  return {rpc,signer,storage,saved,accounts,receipts,broadcasts,applied,signedBatches,checkpoint,fresh,get engine(){return engine;},onUpdate:fn=>update=fn,
    loseAfter(){dropAfter=true;},loseBefore(){dropBefore=true;},restore(){statusUnavailable=false;},expire(){height+=500;slot+=500;},setChangedWallet(v){changeWallet=v;},setChangedMessage(v){changeMessage=v;}};
}
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}

await check('release hash, network, storage persistence and positive rent are checked before any wallet prompt',async()=>{
  const f=fixture();const bad=Uint8Array.from(binary);bad[100]^=1;
  await assert.rejects(()=>new DeploymentEngine({connection:f.rpc,binary:bad,storage:f.storage}).estimate(),/approved/);
  assert.equal(f.saved.size,0);
  f.rpc.getGenesisHash=async()=> 'wrong-network';await assert.rejects(()=>f.fresh().estimate(),/wrong Solana network/);assert.equal(f.saved.size,0);
  f.rpc.getGenesisHash=async()=>genesis;f.rpc.getMinimumBalanceForRentExemption=async()=>0;await assert.rejects(()=>f.fresh().estimate(),/deposit estimate/);
  f.rpc.getMinimumBalanceForRentExemption=async n=>n*8+1000;
  await assert.rejects(()=>new DeploymentEngine({connection:f.rpc,binary,storage:{getItem:()=>null,setItem:()=>{}}}).estimate(),/could not be saved/);
  assert.equal(f.signedBatches.length,0);
});

await check('v0 seeded deployment resumes after a confirmed batch without recreating accounts',async()=>{
  const f=fixture();let e=f.fresh();const estimate=await e.estimate();assert(estimate.remainingTransactions>100);assert(estimate.requiredLamports>0);
  f.onUpdate(p=>{if(p.stage==='uploading'&&f.applied.filter(x=>x.kind==='write').length>=5)e.pause();});
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.equal(f.applied.filter(x=>x.kind==='buffer-account').length,1);assert(f.signedBatches.includes(5));
  const saved=f.checkpoint();assert(saved.bufferSeed&&saved.programSeed);assert.equal(saved.pending.length,0);
  f.onUpdate(()=>{});e=f.fresh();const remaining=await e.estimate();assert.equal(remaining.bufferRentLamports,0);assert(remaining.remainingTransactions<estimate.remainingTransactions);
  const result=await e.run(f.signer,remaining.requiredLamports);
  assert.equal(result.programId,saved.programId);assert.equal(result.programSha256,DEPLOYMENT_PROGRAM_SHA256);assert.equal(result.programLength,binary.length);
  assert.equal(f.applied.filter(x=>x.kind==='buffer-account').length,1);assert.equal(f.applied.filter(x=>x.kind==='deploy').length,1);
  const before=f.broadcasts.length;assert.equal((await f.fresh().inspect()).stage,'verified');assert.equal((await f.engine.run(f.signer,1)).programId,result.programId);assert.equal(f.broadcasts.length,before);
  assert.equal(new Set(f.applied.filter(x=>x.kind==='write').map(x=>x.offset)).size,f.applied.filter(x=>x.kind==='write').length);
});

await check('lost submission response persists receipts and recovers on reload without another buffer deposit',async()=>{
  const f=fixture();let e=f.fresh();const estimate=await e.estimate();f.loseAfter();
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/unavailable/);
  const saved=f.checkpoint();assert.equal(saved.pending.length,1);assert.equal(f.applied.filter(x=>x.kind==='buffer-account').length,1);
  const raw=saved.pending[0].raw;f.restore();e=f.fresh();
  f.onUpdate(p=>{if(p.stage==='uploading')e.pause();});
  await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
  assert.equal(f.checkpoint().bufferId,saved.bufferId);assert.equal(f.checkpoint().programId,saved.programId);assert.equal(f.checkpoint().pending.length,0);assert.equal(f.applied.filter(x=>x.kind==='buffer-account').length,1);assert(raw.length>0);
});

await check('a finalized expired unaccepted packet releases its reserve and reuses the saved seeded address',async()=>{
  const f=fixture();let e=f.fresh();const original=await e.estimate();f.loseBefore();
  await assert.rejects(()=>e.run(f.signer,original.requiredLamports),/unavailable/);const saved=f.checkpoint();assert.equal(f.applied.length,0);
  f.restore();f.expire();e=f.fresh();f.onUpdate(p=>{if(p.stage==='uploading')e.pause();});
  const estimate=await e.estimate();await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.equal(f.checkpoint().bufferId,saved.bufferId);assert.equal(f.applied.filter(x=>x.kind==='buffer-account').length,1);assert.equal(f.checkpoint().pending.length,0);
  assert.notEqual(f.applied[0].signature,saved.pending[0].signature,'only finalized expiry permits a new signed packet');
});

await check('corrupt partial upload cannot be skipped or silently overwritten',async()=>{
  const f=fixture();let e=f.fresh();f.onUpdate(p=>{if(p.stage==='uploading'&&f.applied.some(x=>x.kind==='write'))e.pause();});
  await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
  f.accounts.get(f.checkpoint().bufferId).data[37+20]^=1;
  const prompts=f.signedBatches.length;await assert.rejects(()=>f.fresh().estimate(),/unexpected bytes/);assert.equal(f.signedBatches.length,prompts);
});

await check('wallet changes, changed messages and simulation failures never reach submission',async()=>{
  for(const mode of ['wallet','message','simulation']){
    const f=fixture(),e=f.fresh(),estimate=await e.estimate();
    if(mode==='wallet')f.setChangedWallet(true);if(mode==='message')f.setChangedMessage(true);
    if(mode==='simulation')f.rpc.simulateTransaction=async()=>({context:{slot:100},value:{err:{InstructionError:[2,'InvalidInstructionData']}}});
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),mode==='simulation'?/simulation/:/wallet|transaction/);
    assert.equal(f.broadcasts.length,0);assert.equal(f.checkpoint().pending.length,0);
  }
});

await check('an insufficient approval cannot be bypassed by resuming or changing fee quotes',async()=>{
  const f=fixture(),e=f.fresh();const estimate=await e.estimate();
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports-1),/approved limit/);assert.equal(f.signedBatches.length,0);
  f.rpc.getFeeForMessage=async()=>({context:{slot:100},value:10000000});await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/approved limit/);assert.equal(f.broadcasts.length,0);
});

await check('final deployment is reconciled from its saved receipt after a lost reply',async()=>{
  const f=fixture(),e=f.fresh();f.onUpdate(p=>{if(p.stage==='signing'&&p.message.includes('final marketplace'))f.loseAfter();});
  const estimate=await e.estimate();await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/unavailable/);
  const saved=f.checkpoint();assert.equal(saved.pending[0].kind,'deploy');assert(f.accounts.get(saved.programId).executable);
  f.restore();f.onUpdate(()=>{});const recovered=f.fresh();const before=f.broadcasts.length,result=await recovered.run(f.signer,100000);
  assert.equal(result.signature,saved.pending[0].signature);assert.equal(result.programId,saved.programId);assert.equal(f.broadcasts.length,before);assert.equal(f.applied.filter(x=>x.kind==='deploy').length,1);
});

console.log(`${passed} deployment engine checks passed. RPC state was simulated and test-wallet signatures verified; no network request or transaction was made.`);
