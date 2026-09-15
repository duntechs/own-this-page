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
    async getFeeForMessage(){return {context:{slot},value:5000};},
    async getBalance(){return 100000000000;},
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
    loseAfter(){dropAfter=true;},loseBefore(){dropBefore=true;},restore(){statusUnavailable=false;},expire(){height+=500;slot+=500;},setChangedWallet(v){changeWallet=v;},setChangedMessage(v){changeMessage=v;},setGuards(v){addGuards=v;}};
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

await check('a relay HTTP 400 surfaces immediately with its receipt intact and resume rebroadcasts the same approved packet',async()=>{
  const f=fixture();let e=f.fresh();const estimate=await e.estimate(),send=f.rpc.sendRawTransaction,packets=[];
  f.rpc.getSignatureStatuses=()=>assert.fail('An explicit submission error should surface before confirmation polling');
  f.rpc.sendRawTransaction=async(bytes)=>{packets.push(Buffer.from(bytes).toString('base64'));throw new DeploymentRpcError(400,-32600);};
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),error=>{
    assert(error instanceof DeploymentRpcError);
    assert.deepEqual(error.report,{diagnosticVersion:'otp-rpc-1',method:'sendTransaction',httpStatus:400,rpcCode:-32600});return true;
  });
  const saved=f.checkpoint();assert.equal(saved.pending.length,1);assert.equal(saved.pending[0].raw,packets[0]);assert.deepEqual(f.signedBatches,[1]);assert.equal(f.applied.length,0);
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
    if(write&&!rejectedPacket){rejectedPacket=Buffer.from(bytes).toString('base64');throw new DeploymentRpcError(400,-32600);}
    return send(bytes,options);
  };
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentRpcError);
  const saved=f.checkpoint();assert.equal(saved.pending.length,5);assert(saved.pending.some(receipt=>receipt.raw===rejectedPacket));assert.deepEqual(f.signedBatches,[1,5]);
  assert.equal(f.applied.filter(action=>action.kind==='write').length,4);
  const acceptedSignatures=new Set(f.applied.filter(action=>action.kind==='write').map(action=>action.signature));
  assert.equal(saved.pending.filter(receipt=>acceptedSignatures.has(receipt.signature)).length,4);
  f.rpc.sendRawTransaction=send;e=f.fresh();f.onUpdate(progress=>{if(progress.stage==='uploading')e.pause();});
  await assert.rejects(()=>e.run(f.signer,estimate.requiredLamports),DeploymentPausedError);
  assert.equal(f.checkpoint().pending.length,0);assert.equal(f.checkpoint().bufferId,saved.bufferId);assert.deepEqual(f.signedBatches,[1,5]);assert.equal(f.applied.filter(action=>action.kind==='write').length,5);
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
  assert(f.signedBatches.every(length=>length===1),'Guarded transactions need fresh state after each confirmed fee debit');
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

await check('old checkpoints probe one write before selecting guarded single writes or ordinary batches',async()=>{
  for(const guards of [false,true]){
    const f=fixture();let e=f.fresh();f.onUpdate(p=>{if(p.stage==='uploading')e.pause();});
    await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
    const saved=f.checkpoint();delete saved.walletAssertions;f.storage.setItem([...f.saved.keys()][0],JSON.stringify(saved));
    f.setGuards(guards);f.signedBatches.length=0;e=f.fresh();
    f.onUpdate(p=>{if(p.stage==='uploading'&&f.applied.filter(action=>action.kind==='write').length>=(guards?2:6))e.pause();});
    await assert.rejects(async()=>e.run(f.signer,(await e.estimate()).requiredLamports),DeploymentPausedError);
    assert.deepEqual(f.signedBatches,guards?[1,1]:[1,5]);assert.equal(f.checkpoint().walletAssertions,guards);
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
