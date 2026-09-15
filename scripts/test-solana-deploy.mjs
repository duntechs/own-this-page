import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'vite';
import {ComputeBudgetProgram, Keypair, PublicKey, SystemInstruction, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction} from '@solana/web3.js';

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
const {DeploymentEngine, DeploymentPausedError, DeploymentSimulationError, DeploymentRpcError, DEPLOYMENT_PROGRAM_SHA256, DEPLOYMENT_PROGRAM_LENGTH, DEPLOYMENT_WRITE_BYTES, DEPLOYMENT_LOADER, deploymentProgramDataAddress} = await import(pathToFileURL(path.join(output, 'engine.mjs')).href);
const binary = Uint8Array.from(await readFile(path.join(root, 'solana-market/artifacts/slot_market.so')));
assert.equal(binary.length, DEPLOYMENT_PROGRAM_LENGTH);
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const lighthouse = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
// AccountInfo: assert payer lamports >= 0, Silent logging. This fixture only
// checks compatibility/recovery; it does not replace actual chain simulation.
const guard = () => new TransactionInstruction({programId: lighthouse, keys: [{pubkey:payer.publicKey,isSigner:false,isWritable:false}],data:Buffer.from([5,0,0,0,0,0,0,0,0,0,0,4])});
function guarded(transaction) {
  const message=TransactionMessage.decompile(transaction.message),instructions=message.instructions;
  return new VersionedTransaction(new TransactionMessage({...message,instructions:[...instructions.slice(0,2),guard(),...instructions.slice(2),guard(),guard()]}).compileToV0Message());
}
function signatureText(bytes) {const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),out='';while(n){out=alphabet[Number(n%58n)]+out;n/=58n;}for(const b of bytes){if(b)break;out='1'+out;}return out;}
const info = (data, executable=false) => ({data:Buffer.from(data),executable,owner:DEPLOYMENT_LOADER,lamports:900000000,rentEpoch:0});
function fixture() {
  const accounts=new Map(),receipts=new Map(),saved=new Map(),broadcasts=[],applied=[],signedBatches=[],simulations=[];
  let slot=100,height=110,engine,update=()=>{},statusUnavailable=false,dropBefore=false,dropAfter=false,changeWallet=false,changeMessage=false,addGuards=false;
  const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
  const checkpoint=()=>JSON.parse([...saved.values()][0]);
  const signer={publicKey:payer.publicKey,assertCurrentAccount(){if(changeWallet)throw Error('wallet changed');},async signTransactions(txs){
    signedBatches.push(txs.length);
    return txs.map(tx=>{
      let t=VersionedTransaction.deserialize(tx.serialize());
      if(addGuards)t=guarded(t);
      if(changeMessage)t.message.recentBlockhash=Keypair.generate().publicKey.toBase58();
      t.sign([payer]);return t;
    });
  }};
  const rpc={
    async getGenesisHash(){return genesis;},
    async getAccountInfoAndContext(key,options){assert(options.minContextSlot<=slot,'confirmed account floor must not use processed status tip');const a=accounts.get(key.toBase58());return {context:{slot},value:a?{...a,data:Buffer.from(a.data)}:null};},
    async getMinimumBalanceForRentExemption(size){return size*8+1000;},
    async getLatestBlockhash(){return {blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:height+150};},
    async getLatestBlockhashAndContext(options){assert.equal(options.commitment,'confirmed');assert(options.minContextSlot<=slot);return {context:{slot},value:await rpc.getLatestBlockhash(options)};},
    async getFeeForMessage(){return {context:{slot},value:5000};},
    async getBalance(){return 100000000000;},
    async getBalanceAndContext(_owner,options){assert.equal(options.commitment,'confirmed');assert(options.minContextSlot<=slot,'wallet balance must honor the confirmed simulation floor');return {context:{slot},value:100000000000};},
    async getRecentPrioritizationFees(){return [{prioritizationFee:10000}];},
    async getBlockHeight(){return height;},
    async getEpochInfo(){return {absoluteSlot:slot,blockHeight:height};},
    async simulateTransaction(tx,options){assert.equal(tx.version,0);assert.equal(tx.message.header.numRequiredSignatures,1);assert(tx.serialize().length<=1232);assert.equal(options.replaceRecentBlockhash,false);assert.equal(tx.signatures[0].some(byte=>byte!==0),options.sigVerify);simulations.push({signed:options.sigVerify,size:tx.serialize().length});return {context:{slot},value:{err:null}};},
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
            else if(op===1){const a=accounts.get(ix.keys[0].pubkey.toBase58()),offset=ix.data.readUInt32LE(4),length=Number(ix.data.readBigUInt64LE(8));assert.equal(length,ix.data.length-16);ix.data.copy(a.data,37+offset,16);applied.push({kind:'write',offset,length,signature});}
            else if(op===2){
              assert.equal(Number(ix.data.readBigUInt64LE(4)),binary.length);
              const program=ix.keys[2].pubkey,buffer=accounts.get(ix.keys[3].pubkey.toBase58());
              assert.deepEqual(buffer.data.subarray(37),Buffer.from(binary),'final deployment requires exact uploaded bytes');
              const data=Buffer.alloc(45+binary.length);data.writeUInt32LE(3,0);data[12]=1;payer.publicKey.toBuffer().copy(data,13);Buffer.from(binary).copy(data,45);
              accounts.set(ix.keys[1].pubkey.toBase58(),info(data));
              const p=Buffer.alloc(36);p.writeUInt32LE(2,0);deploymentProgramDataAddress(program).toBuffer().copy(p,4);accounts.set(program.toBase58(),info(p,true));accounts.delete(ix.keys[3].pubkey.toBase58());applied.push({kind:'deploy',signature});
            }else assert.fail('unexpected loader instruction');
          }else if(ix.programId.equals(lighthouse))assert.deepEqual(ix.data,guard().data);
          else assert.fail('unexpected instruction recipient');
        }
        slot++;receipts.set(signature,{slot,err:null,confirmationStatus:'confirmed',confirmations:1});
      }
      if(dropAfter){dropAfter=false;statusUnavailable=true;throw Error('RPC lost reply after accepting transaction');}
      return signature;
    },
  };
  const fresh=()=>engine=new DeploymentEngine({connection:rpc,binary,storage,onUpdate:p=>update(p)});
  return {rpc,signer,storage,saved,accounts,receipts,broadcasts,applied,signedBatches,simulations,checkpoint,fresh,get engine(){return engine;},onUpdate:fn=>update=fn,
    loseAfter(){dropAfter=true;},loseBefore(){dropBefore=true;},restore(){statusUnavailable=false;},expire(){height+=500;slot+=500;},advanceSlots(count){height+=count;slot+=count;},setChangedWallet(v){changeWallet=v;},setChangedMessage(v){changeMessage=v;},setGuards(v){addGuards=v;}};
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

await check('an accepted send waits for its receipt instead of immediately resubmitting on the first null status',async()=>{
  const f=fixture(),e=f.fresh(),estimate=await e.estimate(),statuses=f.rpc.getSignatureStatuses;
  let reads=0;
  f.rpc.getSignatureStatuses=async ids=>{
    const result=await statuses(ids);
    if(++reads<=2)return {...result,value:ids.map(()=>null)};
    return result;
  };
  f.onUpdate(progress=>{if(progress.stage==='uploading')e.pause();});
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.equal(reads,3);assert.equal(f.broadcasts.length,1);assert.deepEqual(f.signedBatches,[1]);assert.equal(f.checkpoint().pending.length,0);
  assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
});

await check('AlreadyProcessed on an approved retry keeps reconciling and never substitutes a new signature',async()=>{
  const f=fixture(),e=f.fresh(),estimate=await e.estimate(),send=f.rpc.sendRawTransaction,statuses=f.rpc.getSignatureStatuses;
  const now=Date.now,timer=globalThis.setTimeout;let elapsed=0,retried=false,confirmed=false,attempts=0;
  Date.now=()=>now()+elapsed;
  globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===1500?0:ms,...args);
  try {
    f.rpc.sendRawTransaction=async(bytes,options)=>{
      attempts++;
      if(attempts===1)return send(bytes,options);
      retried=true;
      const saved=f.checkpoint();assert.equal(saved.pending.length,1);assert.equal(saved.pending[0].raw,Buffer.from(bytes).toString('base64'));
      assert.equal(confirmed,false);throw new DeploymentRpcError(200,-32002,{err:'AlreadyProcessed'});
    };
    f.rpc.getSignatureStatuses=async ids=>{
      const result=await statuses(ids);
      if(!retried){elapsed=9000;return {...result,value:ids.map(()=>null)};}
      confirmed=true;return result;
    };
    f.onUpdate(progress=>{if(progress.stage==='uploading'){assert.equal(confirmed,true);e.pause();}});
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
    assert.equal(attempts,2);assert.equal(retried,true);assert.equal(confirmed,true);assert.deepEqual(f.signedBatches,[1]);
    assert.equal(f.checkpoint().pending.length,0);assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
  } finally {Date.now=now;globalThis.setTimeout=timer;}
});

await check('confirmed simulation contexts prevent later signed simulation and submission from using an older RPC bank',async()=>{
  const f=fixture(),e=f.fresh(),estimate=await e.estimate(),simulate=f.rpc.simulateTransaction,send=f.rpc.sendRawTransaction;
  let unsignedSlot=0,signedSlot=0;
  f.rpc.simulateTransaction=async(tx,options)=>{
    assert.equal(options.commitment,'confirmed');
    if(options.sigVerify)assert.equal(options.minContextSlot,unsignedSlot,'Signed simulation must use at least the unsigned simulation bank');
    f.advanceSlots(10);
    const result=await simulate(tx,options);
    if(options.sigVerify)signedSlot=result.context.slot;else unsignedSlot=result.context.slot;
    return result;
  };
  f.rpc.sendRawTransaction=async(bytes,options)=>{
    // Model a load-balanced provider with an older bank available. The old
    // code sent floor100 despite passing signed simulation at120 and failed
    // preflight; the corrected floor excludes that older bank entirely.
    if(options.minContextSlot<signedSlot)throw new DeploymentRpcError(200,-32002);
    assert.equal(options.minContextSlot,signedSlot);
    assert.equal(f.checkpoint().minimumContextSlot,signedSlot,'The confirmed send floor must survive reload with its signed packet');
    return send(bytes,options);
  };
  f.onUpdate(progress=>{if(progress.stage==='uploading')e.pause();});
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.equal(unsignedSlot,110);assert.equal(signedSlot,120);assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
  assert.deepEqual(f.signedBatches,[1]);assert.equal(f.checkpoint().pending.length,0);
});

await check('invalid or regressing successful simulation contexts stop before any submission',async()=>{
  for(const phase of ['unsigned','signed'])for(const slot of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'100',null,undefined,99]){
    const f=fixture(),e=f.fresh(),estimate=await e.estimate(),simulate=f.rpc.simulateTransaction;
    f.rpc.simulateTransaction=async(tx,options)=>{
      const result=await simulate(tx,options);
      return options.sigVerify===(phase==='signed')?{...result,context:{slot}}:result;
    };
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/confirmed simulation slot|simulation older/);
    assert.equal(f.broadcasts.length,0);assert.equal(f.applied.length,0);assert.equal(f.checkpoint().pending.length,0);
    assert.deepEqual(f.signedBatches,phase==='signed'?[1]:[]);
  }
});

await check('slow unsigned preparation is followed by a fresh contextual blockhash before the only wallet approval',async()=>{
  const f=fixture(),e=f.fresh(),estimate=await e.estimate(),simulate=f.rpc.simulateTransaction,latest=f.rpc.getLatestBlockhashAndContext,sign=f.signer.signTransactions;
  let preparedMessage,freshHash,freshSlot;
  f.rpc.simulateTransaction=async(tx,options)=>{
    if(!options.sigVerify){preparedMessage=TransactionMessage.decompile(tx.message);f.advanceSlots(140);}
    return simulate(tx,options);
  };
  f.rpc.getLatestBlockhashAndContext=async options=>{
    assert(preparedMessage,'The refresh follows unsigned checks');
    const result=await latest(options);assert.equal(options.minContextSlot,result.context.slot);
    freshHash=result.value.blockhash;freshSlot=result.context.slot;return result;
  };
  f.signer.signTransactions=async transactions=>{
    assert.equal(transactions[0].message.recentBlockhash,freshHash);
    assert.notEqual(freshHash,preparedMessage.recentBlockhash);
    const rebuilt=TransactionMessage.decompile(transactions[0].message);
    assert.deepEqual(rebuilt.instructions,preparedMessage.instructions,'Only the unsigned blockhash changes');assert(rebuilt.payerKey.equals(preparedMessage.payerKey));
    return sign(transactions);
  };
  f.onUpdate(p=>{if(p.stage==='uploading')e.pause();});
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.deepEqual(f.signedBatches,[1]);assert.equal(f.broadcasts.length,1);
  const report=e.getDeploymentStatus();assert.equal(report.lastBatch.blockhashContextSlot,freshSlot);assert.equal(report.lastBatch.remainingBlocksAtSubmission,150);
  assert.equal(report.lastBatch.receipts[0].status,'confirmed');assert.equal(report.lastBatch.receipts[0].rpcAcknowledged,true);
});

await check('invalid fresh blockhash contexts and expired or near-expiry signed groups cannot create pending packets or broadcast',async()=>{
  {
    const f=fixture(),e=f.fresh(),estimate=await e.estimate(),latest=f.rpc.getLatestBlockhashAndContext;
    f.rpc.getLatestBlockhashAndContext=async options=>{const result=await latest(options);e.pause();return result;};
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);assert.equal(f.signedBatches.length,0);assert.equal(f.broadcasts.length,0);
  }
  for(const invalid of [-1,1.5,'100',99]){
    const f=fixture(),e=f.fresh(),estimate=await e.estimate(),latest=f.rpc.getLatestBlockhashAndContext;
    f.rpc.getLatestBlockhashAndContext=async options=>({...await latest(options),context:{slot:invalid}});
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/blockhash context|blockhash older/);
    assert.equal(f.signedBatches.length,0);assert.equal(f.broadcasts.length,0);assert.equal(f.checkpoint().pending.length,0);
  }
  for(const count of [1,5])for(const remaining of [-1,0,1,count===1?59:71]){
    const f=fixture(),e=f.fresh(),estimate=await e.estimate(),sign=f.signer.signTransactions;
    if(count===5){
      const saved=f.checkpoint(),buffer=Buffer.alloc(binary.length+37);buffer.writeUInt32LE(1,0);buffer[4]=1;payer.publicKey.toBuffer().copy(buffer,5);
      f.accounts.set(saved.bufferId,info(buffer));saved.walletBatchSafe=true;f.storage.setItem([...f.saved.keys()][0],JSON.stringify(saved));
    }
    f.signer.signTransactions=async transactions=>{const signed=await sign(transactions);f.advanceSlots(150-remaining);return signed;};
    const height=f.rpc.getBlockHeight;
    f.rpc.getBlockHeight=async options=>{assert.equal(options.commitment,'confirmed');assert.equal(options.minContextSlot,freshFloor);return height();};
    let freshFloor=0;const simulate=f.rpc.simulateTransaction;
    f.rpc.simulateTransaction=async(tx,options)=>{const result=await simulate(tx,options);if(options.sigVerify)freshFloor=result.context.slot;return result;};
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),error=>error instanceof DeploymentPausedError&&/None of this group was submitted/.test(error.message));
    assert.deepEqual(f.signedBatches,[count]);assert.equal(f.broadcasts.length,0);assert.equal(f.checkpoint().pending.length,0);assert.equal(f.checkpoint().lastBatch,undefined);
  }
});

await check('partial upload expiry preserves verified progress and all public receipts with acknowledgment versus unknown outcomes across reload',async()=>{
  for(const acknowledgment of [true,false]){
    const f=fixture(),e=f.fresh(),estimate=await e.estimate(),send=f.rpc.sendRawTransaction,statuses=f.rpc.getSignatureStatuses,updates=[];
    let droppedSignature=null,expire=false;
    f.onUpdate(p=>updates.push(p));
    f.rpc.sendRawTransaction=async(bytes,options)=>{
      if(f.signedBatches.at(-1)===5&&!droppedSignature){
        droppedSignature=signatureText(VersionedTransaction.deserialize(bytes).signatures[0]);expire=true;f.broadcasts.push(droppedSignature);
        if(acknowledgment)return droppedSignature;
        throw Error('secret transport detail https://example.invalid/?api-key=private');
      }
      return send(bytes,options);
    };
    f.rpc.getSignatureStatuses=async ids=>{if(expire){f.expire();expire=false;}return statuses(ids);};
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),error=>error instanceof DeploymentPausedError&&/upload transaction expired/.test(error.message));
    assert.deepEqual(f.signedBatches,[1,1,5]);assert.equal(f.checkpoint().pending.length,0);
    const report=e.getDeploymentStatus(),last=updates.at(-1),receipt=report.lastBatch.receipts.find(r=>r.signature===droppedSignature);
    assert.equal(report.writtenBytes,5*DEPLOYMENT_WRITE_BYTES);assert.equal(last.stage,'paused');assert.equal(last.writtenBytes,report.writtenBytes);
    assert.equal(report.lastBatch.receipts.length,5);assert.equal(report.lastBatch.receipts.filter(r=>r.status==='confirmed').length,4);assert.equal(receipt.status,'expired');
    assert.equal(receipt.rpcAcknowledged,acknowledgment);assert.equal(receipt.lastAttempt,acknowledgment?'acknowledged':'unknown');assert.equal(receipt.attemptCount,1);
    assert(receipt.firstAttemptAt>=report.lastBatch.walletReturnedAt);assert.equal(receipt.firstAttemptAt,receipt.lastAttemptAt);
    assert(report.lastBatch.remainingBlocksAtSubmission>=72);assert.equal(report.pendingCount,0);
    const raw=f.checkpoint(),serialized=JSON.stringify(report);for(const secret of [raw.bufferSeed,raw.programSeed,'api-key','private','raw','blockhash\"'])assert(!serialized.includes(secret));
    const returned=e.getDeploymentStatus();returned.lastBatch.receipts[0].status='pending';assert.notEqual(e.getDeploymentStatus().lastBatch.receipts[0].status,'pending','The public report is detached from recovery state');
    const reloaded=f.fresh();await reloaded.inspect();assert.deepEqual(reloaded.getDeploymentStatus(),report);
  }
});

await check('optional receipt archives are bounded and cannot strand or leak an otherwise valid recovery checkpoint',async()=>{
  const f=fixture(),e=f.fresh(),estimate=await e.estimate();f.loseBefore();
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/unavailable/);
  const original=f.checkpoint();assert.equal(original.pending.length,1);
  for(const archive of [undefined,{...original.lastBatch,secret:'private',receipts:original.lastBatch.receipts.map(r=>({...r,secret:'private',lastRpcError:{httpStatus:200,rpcCode:-32002,message:'private',preflight:{err:{InstructionError:[4,{Custom:17}]},unitsConsumed:145,contextSlot:321,logs:['private']}}}))},{...original.lastBatch,receipts:Array(6).fill(original.lastBatch.receipts[0])},{...original.lastBatch,preparedAt:'secret'},'private']){
    f.storage.setItem([...f.saved.keys()][0],JSON.stringify({...original,lastBatch:archive}));
    const reloaded=f.fresh();await reloaded.inspect();const report=reloaded.getDeploymentStatus();
    assert.equal(report.pendingCount,1);assert(!JSON.stringify(report).includes('private'));assert(!JSON.stringify(report).includes('secret'));
    assert.deepEqual(f.checkpoint().pending,original.pending);
    if(archive?.secret==='private'){
      assert.equal(report.lastBatch.receipts.length,1);
      assert.deepEqual(report.lastBatch.receipts[0].lastRpcError,{diagnosticVersion:'otp-rpc-1',method:'sendTransaction',httpStatus:200,rpcCode:-32002,preflight:{err:{InstructionError:[4,{Custom:17}]},unitsConsumed:145,contextSlot:321}});
    }else assert.equal(report.lastBatch,null);
  }
});

await check('an archive persistence failure is surfaced immediately instead of being mistaken for an ambiguous transport timeout',async()=>{
  const f=fixture(),e=f.fresh(),estimate=await e.estimate(),set=f.storage.setItem;
  f.storage.setItem=(key,value)=>{if(JSON.parse(value).lastBatch?.receipts.some(r=>r.attemptCount>0))throw Error('quota');set(key,value);};
  f.rpc.getSignatureStatuses=()=>assert.fail('Storage failure must not enter a retry or confirmation loop');
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/recovery record could not be saved/);
  assert.equal(f.broadcasts.length,0);assert.deepEqual(f.signedBatches,[1]);assert.equal(f.checkpoint().pending.length,1);
});

await check('a relay HTTP 400 surfaces immediately with its receipt intact and resume rebroadcasts the same approved packet',async()=>{
  const f=fixture();let e=f.fresh();const estimate=await e.estimate(),send=f.rpc.sendRawTransaction,packets=[];
  f.rpc.getSignatureStatuses=()=>assert.fail('An explicit submission error should surface before confirmation polling');
  f.rpc.sendRawTransaction=async(bytes)=>{packets.push(Buffer.from(bytes).toString('base64'));throw new DeploymentRpcError(400,-32600);};
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),error=>{
    assert(error instanceof DeploymentRpcError);
    assert.deepEqual(error.report,{diagnosticVersion:'otp-rpc-1',method:'sendTransaction',httpStatus:400,rpcCode:-32600});return true;
  });
  const saved=f.checkpoint();assert.equal(saved.pending.length,1);assert.equal(saved.pending[0].raw,packets[0]);assert.deepEqual(f.signedBatches,[1]);assert.equal(f.applied.length,0);
  const submissionReport=e.getDeploymentStatus().lastBatch.receipts[0];assert.equal(submissionReport.lastAttempt,'rpc-error');assert.equal(submissionReport.rpcAcknowledged,false);
  assert.deepEqual(submissionReport.lastRpcError,{diagnosticVersion:'otp-rpc-1',method:'sendTransaction',httpStatus:400,rpcCode:-32600});
  f.rpc.getSignatureStatuses=async ids=>({context:{slot:100},value:ids.map(id=>f.receipts.get(id)??null)});
  e=f.fresh();
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentRpcError);
  assert.deepEqual(f.checkpoint().pending,saved.pending);assert.deepEqual(packets,[saved.pending[0].raw,saved.pending[0].raw]);assert.deepEqual(f.signedBatches,[1]);
  f.rpc.sendRawTransaction=send;e=f.fresh();f.onUpdate(progress=>{if(progress.stage==='uploading')e.pause();});
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.equal(f.checkpoint().bufferId,saved.bufferId);assert.equal(f.checkpoint().pending.length,0);assert.deepEqual(f.signedBatches,[1]);assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
  assert.equal(f.applied[0].signature,saved.pending[0].signature);
});

await check('one rejected upload in a partially accepted batch retains every receipt and recovers without new signatures',async()=>{
  const f=fixture();let e=f.fresh();const estimate=await e.estimate(),send=f.rpc.sendRawTransaction;let rejectedPacket=null;
  f.rpc.sendRawTransaction=async(bytes,options)=>{
    const tx=VersionedTransaction.deserialize(bytes),write=TransactionMessage.decompile(tx.message).instructions.some(ix=>ix.programId.equals(DEPLOYMENT_LOADER)&&ix.data.readUInt32LE(0)===1);
    if(write&&f.signedBatches.at(-1)===5&&!rejectedPacket){rejectedPacket=Buffer.from(bytes).toString('base64');throw new DeploymentRpcError(400,-32600);}
    return send(bytes,options);
  };
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentRpcError);
  const saved=f.checkpoint();assert.equal(saved.pending.length,5);assert(saved.pending.some(receipt=>receipt.raw===rejectedPacket));assert.deepEqual(f.signedBatches,[1,1,5]);
  assert.equal(f.applied.filter(action=>action.kind==='write').length,5);
  const acceptedSignatures=new Set(f.applied.filter(action=>action.kind==='write').map(action=>action.signature));
  assert.equal(saved.pending.filter(receipt=>acceptedSignatures.has(receipt.signature)).length,4);
  f.rpc.sendRawTransaction=send;e=f.fresh();f.onUpdate(progress=>{if(progress.stage==='uploading')e.pause();});
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.equal(f.checkpoint().pending.length,0);assert.equal(f.checkpoint().bufferId,saved.bufferId);assert.deepEqual(f.signedBatches,[1,1,5]);assert.equal(f.applied.filter(action=>action.kind==='write').length,6);
  assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
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
  const uploaded=f.accounts.get(f.checkpoint().bufferId).data;
  uploaded[37+20]=uploaded[37+20]===255?254:255;
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

await check('guarded signed receipts survive reload and complete all packet sizes without another buffer deposit',async()=>{
  const f=fixture();f.setGuards(true);let e=f.fresh();const estimate=await e.estimate();f.loseAfter();
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/unavailable/);
  const saved=f.checkpoint(),packet=VersionedTransaction.deserialize(Buffer.from(saved.pending[0].raw,'base64'));
  assert.equal(packet.message.compiledInstructions.length,7);
  assert.equal(packet.message.staticAccountKeys.length,6);
  assert.equal(saved.walletAssertions,true);
  // Recover the mode from a guarded pending receipt, including older records
  // that did not yet persist the optional assertion flag.
  delete saved.walletAssertions;f.storage.setItem([...f.saved.keys()][0],JSON.stringify(saved));
  f.restore();e=f.fresh();const result=await e.run(f.signer,(await e.estimate()).requiredLamports);
  assert.equal(result.programId,saved.programId);assert.equal(f.applied.filter(x=>x.kind==='buffer-account').length,1);
  assert.equal(f.applied.filter(x=>x.kind==='deploy').length,1);
  assert(f.applied.filter(x=>x.kind==='write').every(x=>x.length<=DEPLOYMENT_WRITE_BYTES));
  assert(f.signedBatches.includes(5),'Invariant guards with sufficient balance headroom can share one group approval');
  assert.equal(f.checkpoint().walletAssertions,true);
  assert(f.simulations.some(x=>x.signed));assert(f.simulations.every(x=>x.size<=1232));
  assert.equal((await f.fresh().inspect()).stage,'verified');
});

await check('legacy 900-byte pending receipts resume into 700-byte writes across a partial new boundary',async()=>{
  const f=fixture();let e=f.fresh();f.onUpdate(p=>{if(p.stage==='uploading')e.pause();});
  await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
  const saved=f.checkpoint(),recent=await f.rpc.getLatestBlockhash(),data=Buffer.alloc(916);
  data.writeUInt32LE(1,0);data.writeUInt32LE(0,4);data.writeBigUInt64LE(900n,8);Buffer.from(binary.subarray(0,900)).copy(data,16);
  const oldWrite=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:recent.blockhash,instructions:[
    ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),
    new TransactionInstruction({programId:DEPLOYMENT_LOADER,data,keys:[{pubkey:new PublicKey(saved.bufferId),isSigner:false,isWritable:true},{pubkey:payer.publicKey,isSigner:true,isWritable:false}]}),
  ]}).compileToV0Message());oldWrite.sign([payer]);
  const signature=signatureText(oldWrite.signatures[0]);
  saved.pending=[{kind:'write',offset:0,rentLamports:0,signature,raw:Buffer.from(oldWrite.serialize()).toString('base64'),blockhash:recent.blockhash,lastValidBlockHeight:recent.lastValidBlockHeight,priority:10000,feeLamports:5000}];
  f.storage.setItem([...f.saved.keys()][0],JSON.stringify(saved));
  // A previous client sent this 900-byte receipt and lost the response.
  await f.rpc.sendRawTransaction(oldWrite.serialize(),{skipPreflight:false,maxRetries:3});
  assert.equal((await f.fresh().inspect()).writtenBytes,700);
  f.onUpdate(()=>{});e=f.fresh();const result=await e.run(f.signer,(await e.estimate()).requiredLamports);
  assert.equal(result.programId,saved.programId);assert.equal(f.applied.filter(x=>x.kind==='buffer-account').length,1);
  assert.equal(f.applied.filter(x=>x.kind==='write'&&x.offset===0).length,1);
  assert(f.applied.some(x=>x.kind==='write'&&x.offset===700&&x.length===700));
  assert.equal(f.applied.filter(x=>x.kind==='deploy').length,1);
});

await check('old checkpoints probe one write before selecting a checked group for guarded or ordinary uploads',async()=>{
  for(const guards of [false,true]){
    const f=fixture();let e=f.fresh();f.onUpdate(p=>{if(p.stage==='uploading')e.pause();});
    await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
    const saved=f.checkpoint();delete saved.walletAssertions;f.storage.setItem([...f.saved.keys()][0],JSON.stringify(saved));
    f.setGuards(guards);f.signedBatches.length=0;e=f.fresh();
    f.onUpdate(p=>{if(p.stage==='uploading'&&f.applied.filter(action=>action.kind==='write').length>=6)e.pause();});
    await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
    assert.deepEqual(f.signedBatches,[1,5]);assert.equal(f.checkpoint().walletAssertions,guards);assert.equal(f.checkpoint().walletBatchSafe,true);
    assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
  }
});

await check('changed guards or insufficient group balance headroom pause before broadcasting and preserve individual resume',async()=>{
  for(const mode of ['clock','balance-margin']){
    const f=fixture();f.setGuards(true);let e=f.fresh();const estimate=await e.estimate(),sign=f.signer.signTransactions;
    f.signer.signTransactions=async txs=>{
      const signed=await sign(txs);
      if(txs.length===1)return signed;
      return signed.map(tx=>{
        const decoded=TransactionMessage.decompile(tx.message),index=decoded.instructions.findIndex(ix=>ix.programId.equals(lighthouse));
        if(mode==='clock')decoded.instructions[index]=new TransactionInstruction({programId:lighthouse,keys:[],data:Buffer.from([15,0,0,...new Uint8Array(8),4])});
        else {
          const data=Buffer.from(guard().data);data.writeBigUInt64LE(100000000000n-5000n,3);
          decoded.instructions[index]=new TransactionInstruction({...guard(),data});
        }
        const changed=new VersionedTransaction(decoded.compileToV0Message());changed.sign([payer]);return changed;
      });
    };
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),error=>error instanceof DeploymentPausedError&&/None of this group was submitted/.test(error.message));
    const saved=f.checkpoint();
    assert.deepEqual(f.signedBatches,[1,1,5]);assert.equal(saved.walletBatchSafe,false);assert.equal(saved.pending.length,0);
    assert.equal(f.broadcasts.length,2);assert.equal(f.applied.filter(action=>action.kind==='write').length,1);
    f.signer.signTransactions=sign;e=f.fresh();
    f.onUpdate(progress=>{if(progress.stage==='uploading'&&f.applied.filter(action=>action.kind==='write').length>=3)e.pause();});
    await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
    assert.deepEqual(f.signedBatches,[1,1,5,1,1]);assert.equal(f.checkpoint().walletBatchSafe,false);
    assert.equal(f.checkpoint().bufferId,saved.bufferId);assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
  }
});

await check('the group balance read must use a valid bank at or after the signed simulation',async()=>{
  for(const slot of [99,-1,0.5,undefined]){
    const f=fixture(),e=f.fresh(),estimate=await e.estimate();
    f.rpc.getBalanceAndContext=async(_owner,options)=>{
      assert.equal(options.commitment,'confirmed');assert(options.minContextSlot>=101);
      return {context:{slot},value:100000000000};
    };
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/wallet balance older|confirmed wallet balance slot/);
    assert.equal(f.applied.filter(action=>action.kind==='write').length,0);assert.equal(f.checkpoint().pending.length,0);
    assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
  }
});

await check('post-wallet simulation, fee increase, account change and expiry stop before persistence or broadcast',async()=>{
  for(const mode of ['signed-simulation','signed-fee','wallet-after-simulation','expiry-after-simulation']){
    const f=fixture();f.setGuards(true);const e=f.fresh(),estimate=await e.estimate(),simulate=f.rpc.simulateTransaction;
    if(mode==='signed-fee')f.rpc.getFeeForMessage=async message=>({context:{slot:100},value:message.staticAccountKeys.some(key=>key.equals(lighthouse))?estimate.requiredLamports+1:5000});
    f.rpc.simulateTransaction=async(tx,options)=>{
      const result=await simulate(tx,options);
      if(options.sigVerify){
        if(mode==='signed-simulation')result.value.err={InstructionError:[2,'Custom']};
        if(mode==='wallet-after-simulation')f.setChangedWallet(true);
        if(mode==='expiry-after-simulation')f.expire();
      }
      return result;
    };
    await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/simulation|approved limit|wallet changed|expired/);
    assert.equal(f.signedBatches.length,1);assert.equal(f.broadcasts.length,0);assert.equal(f.checkpoint().pending.length,0);
  }
});

await check('the saved signed receipt reserves its actual returned-message fee',async()=>{
  const f=fixture();f.setGuards(true);const e=f.fresh(),estimate=await e.estimate();
  f.rpc.getFeeForMessage=async message=>({context:{slot:100},value:message.staticAccountKeys.some(key=>key.equals(lighthouse))?7000:5000});
  f.loseBefore();await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),/unavailable/);
  assert.equal(f.checkpoint().pending[0].feeLamports,7000);assert.equal(f.applied.length,0);
});

await check('an unlanded buffer transaction expiring during confirmation never advances to write or a second approval',async()=>{
  const f=fixture();f.setGuards(true);let e=f.fresh();const estimate=await e.estimate(),original=f.checkpoint();
  const statuses=f.rpc.getSignatureStatuses,simulate=f.rpc.simulateTransaction;
  let writesSimulated=0;
  f.rpc.simulateTransaction=async(tx,options)=>{
    const result=await simulate(tx,options);
    if(TransactionMessage.decompile(tx.message).instructions.some(ix=>ix.programId.equals(DEPLOYMENT_LOADER)&&ix.data.readUInt32LE(0)===1)){
      writesSimulated++;result.value.err='AccountNotFound';
    }
    return result;
  };
  f.loseBefore();
  f.rpc.getSignatureStatuses=async ids=>{f.restore();f.expire();return statuses(ids);};
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),error=>error instanceof DeploymentPausedError&&/upload-account transaction expired/.test(error.message));
  assert.equal(writesSimulated,0);assert.deepEqual(f.signedBatches,[1]);assert.equal(f.applied.length,0);
  assert.equal(f.checkpoint().pending.length,0);assert.equal(f.checkpoint().bufferId,original.bufferId);assert.equal(f.checkpoint().bufferSeed,original.bufferSeed);assert.equal(f.checkpoint().programId,original.programId);
  f.rpc.getSignatureStatuses=statuses;f.rpc.simulateTransaction=simulate;e=f.fresh();
  f.onUpdate(progress=>{if(progress.stage==='uploading')e.pause();});
  const remaining=await e.estimate();assert.equal(remaining.requiredLamports,estimate.requiredLamports,'An unlanded buffer must not consume a deposit in the remaining quote');
  await assert.rejects(()=>e.run(f.signer,remaining.requiredLamports),DeploymentPausedError);
  assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);assert.equal(f.checkpoint().bufferId,original.bufferId);
  assert.equal(f.applied.filter(action=>action.kind==='write').length,0);
});

await check('an expiring write pauses without re-signing and resume retains the confirmed buffer deposit',async()=>{
  const f=fixture();f.setGuards(true);let e=f.fresh();const estimate=await e.estimate(),send=f.rpc.sendRawTransaction;
  let expiredWrite=false;
  f.rpc.sendRawTransaction=async(bytes,options)=>{
    const transaction=VersionedTransaction.deserialize(bytes),instructions=TransactionMessage.decompile(transaction.message).instructions;
    if(!expiredWrite&&instructions.some(ix=>ix.programId.equals(DEPLOYMENT_LOADER)&&ix.data.readUInt32LE(0)===1)){
      expiredWrite=true;f.expire();const signature=signatureText(transaction.signatures[0]);f.broadcasts.push(signature);return signature;
    }
    return send(bytes,options);
  };
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),error=>error instanceof DeploymentPausedError&&/upload transaction expired/.test(error.message));
  assert.equal(expiredWrite,true);assert.deepEqual(f.signedBatches,[1,1]);assert.equal(f.applied.filter(action=>action.kind==='write').length,0);
  const saved=f.checkpoint();assert.equal(saved.pending.length,0);assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
  e=f.fresh();const remaining=await e.estimate();assert.equal(remaining.bufferRentLamports,0);assert(remaining.requiredLamports<estimate.requiredLamports);
  const result=await e.run(f.signer,remaining.requiredLamports);assert.equal(result.programId,saved.programId);assert.equal(f.applied.filter(action=>action.kind==='buffer-account').length,1);
});

await check('the next-step simulation never creates storage, signs, sends or reconciles pending receipts',async()=>{
  const f=fixture();f.storage.setItem=()=>assert.fail('Read-only checking must not write recovery storage');
  await assert.rejects(()=>f.fresh().checkNextSimulation(),/No saved deployment/);assert.equal(f.saved.size,0);assert.equal(f.simulations.length,0);
  const pending=fixture(),engine=pending.fresh();const estimate=await engine.estimate();pending.loseBefore();
  await assert.rejects(()=>engine.run(pending.signer,estimate.requiredLamports),/unavailable/);
  const before=[...pending.saved];pending.storage.setItem=()=>assert.fail('Pending check cannot save');
  pending.rpc.getSignatureStatuses=()=>assert.fail('Pending check cannot reconcile');pending.rpc.sendRawTransaction=()=>assert.fail('Pending check cannot broadcast');pending.rpc.simulateTransaction=()=>assert.fail('Pending check cannot simulate a replacement');
  const prompts=pending.signedBatches.length;
  await assert.rejects(()=>pending.fresh().checkNextSimulation(),/saved transaction is unresolved/);
  assert.deepEqual([...pending.saved],before);assert.equal(pending.signedBatches.length,prompts);
});

await check('read-only next-step checks select the existing buffer, write or final deployment without modifying the saved record',async()=>{
  const f=fixture();await f.fresh().estimate();const checkpoint=f.checkpoint(),before=[...f.saved],actions=[];
  f.storage.setItem=()=>assert.fail('Read-only simulation cannot save');f.rpc.sendRawTransaction=()=>assert.fail('Read-only simulation cannot send');f.rpc.getSignatureStatuses=()=>assert.fail('Read-only simulation cannot reconcile');f.signer.signTransactions=()=>assert.fail('Read-only simulation cannot sign');
  const simulate=f.rpc.simulateTransaction;
  f.rpc.simulateTransaction=async(transaction,options)=>{
    assert.equal(options.sigVerify,false);assert(transaction.signatures[0].every(byte=>byte===0));
    actions.push(TransactionMessage.decompile(transaction.message).instructions.filter(ix=>ix.programId.equals(DEPLOYMENT_LOADER)).map(ix=>ix.data.readUInt32LE(0)));
    return simulate(transaction,options);
  };
  await f.fresh().checkNextSimulation();
  const successfulSimulation=f.rpc.simulateTransaction;
  f.rpc.simulateTransaction=async()=>({context:{slot:100},value:{err:'BlockhashNotFound',unitsConsumed:0}});
  await assert.rejects(()=>f.fresh().checkNextSimulation(),error=>error instanceof DeploymentSimulationError&&error.report.action==='buffer'&&error.report.phase==='before-wallet'&&error.report.error.kind==='BlockhashNotFound');
  f.rpc.simulateTransaction=successfulSimulation;
  const buffer=Buffer.alloc(binary.length+37);buffer.writeUInt32LE(1,0);buffer[4]=1;payer.publicKey.toBuffer().copy(buffer,5);f.accounts.set(checkpoint.bufferId,info(buffer));
  await f.fresh().checkNextSimulation();
  Buffer.from(binary).copy(f.accounts.get(checkpoint.bufferId).data,37);
  await f.fresh().checkNextSimulation();
  assert.deepEqual(actions,[[0],[1],[2]]);assert.deepEqual([...f.saved],before);assert.equal(f.signedBatches.length,0);assert.equal(f.broadcasts.length,0);
});

await check('simulation failures expose bounded protocol diagnostics before and after wallet approval without log or secret disclosure',async()=>{
  for(const phase of ['before-wallet','after-wallet']){
    const f=fixture();f.setGuards(true);const engine=f.fresh(),estimate=await engine.estimate(),simulate=f.rpc.simulateTransaction,checkpoint=f.checkpoint();
    f.rpc.simulateTransaction=async(transaction,options)=>{
      const result=await simulate(transaction,options);
      if(options.sigVerify===(phase==='after-wallet'))return {context:{slot:123},value:{err:{InstructionError:[2,{Custom:41}]},unitsConsumed:199999,logs:['api-key=not-shareable',checkpoint.bufferSeed],returnData:{data:['private-packet','base64']}}};
      return result;
    };
    await assert.rejects(()=>engine.run(f.signer,estimate.requiredLamports),error=>{
      assert(error instanceof DeploymentSimulationError);const report=error.report;
      assert.equal(report.diagnosticVersion,'otp-simulation-1');assert.equal(report.phase,phase);assert.equal(report.action,'buffer');assert.equal(report.bufferId,checkpoint.bufferId);assert.equal(report.programId,checkpoint.programId);
      assert.equal(report.offset,null);assert.equal(report.writeLength,null);assert.equal(report.minimumContextSlot,100);assert.equal(report.simulationContextSlot,123);assert.equal(report.unitsConsumed,199999);
      assert.deepEqual(report.requestedCompute,{limit:200000,priceMicroLamports:12000});assert.deepEqual(report.error,{kind:'InstructionError',instructionIndex:2,instructionError:'Custom',customCode:41});
      assert.equal(report.failedProgram,phase==='after-wallet'?lighthouse.toBase58():SystemProgram.programId.toBase58());
      const text=JSON.stringify(report);assert(text.length<1500);for(const forbidden of ['api-key',checkpoint.bufferSeed,checkpoint.programSeed,'private-packet','logs','returnData'])assert(!text.includes(forbidden));
      return true;
    });
    assert.equal(f.signedBatches.length,phase==='before-wallet'?0:1);assert.equal(f.broadcasts.length,0);assert.equal(f.checkpoint().pending.length,0);
  }
});

await check('the read-only write diagnostic preserves offset and redacts unrecognized errors and invalid numeric fields',async()=>{
  const f=fixture();await f.fresh().estimate();const saved=f.checkpoint();
  const buffer=Buffer.alloc(binary.length+37);buffer.writeUInt32LE(1,0);buffer[4]=1;payer.publicKey.toBuffer().copy(buffer,5);f.accounts.set(saved.bufferId,info(buffer));
  const before=[...f.saved];f.storage.setItem=()=>assert.fail('Diagnostic check cannot save');
  for(const rawError of ['AccountNotFound','privateApiKeyWithOnlyLetters',{InstructionError:[2,'InvalidInstructionData']},{InstructionError:[2,{Custom:7}]},{InstructionError:[2,{BorshIoError:'api-key=secret'}]}]){
    f.rpc.simulateTransaction=async()=>({context:{slot:-1},value:{err:rawError,unitsConsumed:Infinity,logs:['secret']}});
    await assert.rejects(()=>f.fresh().checkNextSimulation(),error=>{
      assert(error instanceof DeploymentSimulationError);const report=error.report;
      assert.equal(report.action,'write');assert.equal(report.offset,0);assert.equal(report.writeLength,700);assert.equal(report.simulationContextSlot,null);assert.equal(report.unitsConsumed,null);
      assert(!JSON.stringify(report).includes('secret'));assert(!JSON.stringify(report).includes('privateApiKey'));
      if(rawError==='AccountNotFound')assert.equal(report.error.kind,'AccountNotFound');
      else if(rawError==='privateApiKeyWithOnlyLetters'||rawError.InstructionError?.[1]?.BorshIoError)assert.equal(report.error.kind,'UnrecognizedSimulationError');
      else assert.equal(report.failedProgram,DEPLOYMENT_LOADER.toBase58());
      return true;
    });
  }
  assert.deepEqual([...f.saved],before);assert.equal(f.signedBatches.length,0);assert.equal(f.broadcasts.length,0);
});

console.log(`${passed} deployment engine checks passed. RPC state was simulated and test-wallet signatures verified; no network request or transaction was made.`);
