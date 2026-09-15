import {useEffect, useRef, useState} from 'react';
import {Connection} from '@solana/web3.js';
import {ArrowLeft, ArrowUpRight, Check, CheckCircle2, ChevronRight, Copy, LoaderCircle, Pause, RefreshCw, ShieldCheck, Wallet} from 'lucide-react';
import {boundedSolanaFetch, SOLANA_TREASURY} from '../lib/solana-client';
import {createDeploymentRpcFetch} from '../lib/solana-deployment-fetch';
import {DeploymentEngine, DeploymentPausedError, type DeploymentEstimate, type DeploymentInspection, type DeploymentProgress, type DeploymentResult} from '../lib/solana-deploy';
import {connectSolanaWallet, createVersionedSolanaDeploymentSigner, disconnectSolanaWallet, listSolanaWallets, onSolanaAccountChange, onSolanaWalletsChanged, type SolanaWallet, type SolanaWalletSession} from '../lib/solana-wallet';
import {SolanaWalletCompatibilityError} from '../lib/solana-wallet-diagnostics';
import '../marketplace-setup.css';

type Operation = 'checking' | 'connecting' | 'estimating' | 'deploying' | 'verifying' | null;
type Health = 'checking' | 'ready' | 'unavailable';
const ESTIMATE_LIFETIME = 120_000;
const sol = (lamports: number) => `${(lamports / 1_000_000_000).toLocaleString('en-US', {maximumFractionDigits: 9})} SOL`;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;
const explorer = (kind: 'account' | 'tx', value: string) => `https://solscan.io/${kind}/${encodeURIComponent(value)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The connection could not complete this step. Your saved progress has been kept.';

export default function MarketplaceSetup() {
  const [wallets, setWallets] = useState<SolanaWallet[]>([]);
  const [session, setSession] = useState<SolanaWalletSession | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [health, setHealth] = useState<Health>('checking');
  const [healthMessage, setHealthMessage] = useState('Checking the website’s Solana connection.');
  const [inspection, setInspection] = useState<DeploymentInspection | null>(null);
  const [estimate, setEstimate] = useState<DeploymentEstimate | null>(null);
  const [estimatedAt, setEstimatedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [accepted, setAccepted] = useState(false);
  const [progress, setProgress] = useState<DeploymentProgress | null>(null);
  const [latestSignature, setLatestSignature] = useState('');
  const [result, setResult] = useState<DeploymentResult | null>(null);
  const [existingProgram, setExistingProgram] = useState('');
  const [error, setError] = useState('');
  const [errorReport, setErrorReport] = useState<SolanaWalletCompatibilityError['report'] | null>(null);
  const [errorReportOpen, setErrorReportOpen] = useState(false);
  const [errorReportCopyFailed, setErrorReportCopyFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState<'address' | 'report' | 'error' | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const engineRef = useRef<DeploymentEngine | null>(null);
  const pauseRequestedRef = useRef(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const sessionRef = useRef<SolanaWalletSession | null>(null);

  const busy = operation !== null;
  const ownerConnected = session?.account.address === SOLANA_TREASURY;
  const estimateFresh = !!estimate && now - estimatedAt < ESTIMATE_LIFETIME;
  const hasSavedDeployment = !!inspection && inspection.stage !== 'new';
  const written = progress?.writtenBytes ?? inspection?.writtenBytes ?? 0;
  const total = progress?.totalBytes ?? inspection?.totalBytes ?? 1;
  // Upload completion is separate from the final on-chain verification.
  const percent = result ? 100 : Math.min(99, Math.floor(written / Math.max(total, 1) * 100));

  function clearErrorReport() {
    setErrorReport(null); setErrorReportOpen(false); setErrorReportCopyFailed(false);
    setCopied(previous => previous === 'error' ? null : previous);
  }

  async function checkHealth() {
    if (mounted.current) {setHealth('checking'); setHealthMessage('Checking the website’s Solana connection.');}
    try {
      const response = await boundedSolanaFetch('/api/rpc/health', {cache: 'no-store', headers: {Accept: 'application/json'}});
      if (!response.headers.get('content-type')?.includes('application/json')) throw Error('The website’s RPC Worker is not deployed yet. Deploy the latest GitHub version to Cloudflare, then check again.');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw Error('The website’s RPC Worker needs the latest deployment. Deploy the GitHub update to Cloudflare, then check again.');
      const status = body as {network?: string; ok?: boolean; error?: {code?: number; message?: unknown}};
      if (!response.ok || status.ok !== true) {
        const safeMessages = [
          'Add a valid Helius mainnet endpoint as the Cloudflare Worker runtime secret HELIUS_RPC_URL.',
          'The website RPC rate-limit bindings need to be deployed.',
          'Helius rejected the RPC credential. Check the Worker runtime secret and Helius key restrictions.',
          'Helius is rate limiting requests. Wait before checking again.',
          'The Solana mainnet connection could not be verified.',
          'Too many requests. Wait a few seconds and retry.',
        ];
        const message = status.error?.message;
        throw Error(typeof message === 'string' && safeMessages.includes(message) ? message : 'The Solana connection is not responding. Check the Cloudflare Helius secret, deploy the latest website build, and try the connection again.');
      }
      if (status.network !== 'mainnet-beta') throw Error('The website connection did not verify Solana mainnet. Check the Helius endpoint before continuing.');
      if (mounted.current) {setHealth('ready'); setHealthMessage('Solana mainnet connection is ready.');}
    } catch (caught) {
      const message = errorText(caught);
      if (mounted.current) {setHealth('unavailable'); setHealthMessage(message);}
      throw caught;
    }
  }

  async function getEngine() {
    if (engineRef.current) return engineRef.current;
    const response = await boundedSolanaFetch('/deployment/slot_market.so', {cache: 'no-store'});
    if (!response.ok) throw Error('The marketplace program file is not available. Deploy the latest website build and check again.');
    const binary = new Uint8Array(await response.arrayBuffer());
    if (!mounted.current) throw Error('The setup page was closed. No new deployment will be started.');
    const connection = new Connection(new URL('/api/rpc', window.location.origin).toString(), {commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: createDeploymentRpcFetch()});
    const engine = new DeploymentEngine({connection, binary, cluster: 'mainnet-beta', storage: window.localStorage, onUpdate(update) {
      if (!mounted.current) return;
      setProgress(update);
      if (update.signature) setLatestSignature(update.signature);
    }});
    engineRef.current = engine;
    return engine;
  }

  async function exclusive(kind: Exclude<Operation, 'connecting' | null>, action: (engine: DeploymentEngine) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setOperation(kind); setError(''); setNotice(''); clearErrorReport();
    try {
      if (!navigator.locks) throw Error('This browser cannot protect a deployment across tabs. Open the site over HTTPS in a current desktop browser before continuing.');
      await navigator.locks.request('own-this-page-deployment', {ifAvailable: true}, async lock => {
        if (!lock) throw Error('Marketplace setup is already running in another tab. Return to that tab or pause it before continuing here.');
        await checkHealth();
        const engine = await getEngine();
        if (!mounted.current) return;
        await action(engine);
      });
    } catch (caught) {
      if (mounted.current) {
        if (caught instanceof DeploymentPausedError) setNotice(caught.message);
        else {
          setError(errorText(caught));
          if (caught instanceof SolanaWalletCompatibilityError) setErrorReport(caught.report);
        }
      }
    } finally {
      busyRef.current = false;
      pauseRequestedRef.current = false;
      if (mounted.current) {setOperation(null); setPauseRequested(false);}
    }
  }

  async function inspect() {
    setAccepted(false); setEstimate(null);
    await exclusive('checking', async engine => {
      const next = await engine.inspect();
      if (!mounted.current) return;
      setInspection(next);
      if (next.result) {setResult(next.result); if (next.result.signature) setLatestSignature(next.result.signature);}
      else setProgress(null);
    });
  }

  useEffect(() => {
    mounted.current = true;
    const refreshWallets = () => setWallets(listSolanaWallets('mainnet-beta'));
    refreshWallets();
    const unsubscribe = onSolanaWalletsChanged(refreshWallets);
    // Delay one task so React's development effect replay never starts two checks.
    const start = window.setTimeout(() => void inspect(), 0);
    return () => {mounted.current = false; window.clearTimeout(start); unsubscribe(); engineRef.current?.pause();};
  }, []);

  useEffect(() => {
    sessionRef.current = session;
    if (!session) return;
    return onSolanaAccountChange(session, next => {
      if (next?.account.address === session.account.address && next.cluster === session.cluster) return;
      engineRef.current?.pause(); sessionRef.current = null;
      setSession(null); setAccepted(false); setEstimate(null);
      clearErrorReport();
      setError('The connected account changed or disconnected. Deployment has been asked to pause. Reconnect the approved owner wallet to continue.');
    });
  }, [session]);

  useEffect(() => {
    if (!estimate) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [estimate]);

  useEffect(() => {
    if (operation !== 'deploying') return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [operation]);

  async function connect(wallet: SolanaWallet) {
    if (busyRef.current) return;
    busyRef.current = true; setOperation('connecting'); setError(''); setAccepted(false); setEstimate(null); clearErrorReport();
    try {
      const next = await connectSolanaWallet(wallet, 'mainnet-beta');
      if (!mounted.current) return;
      sessionRef.current = next; setSession(next);
      if (next.account.address !== SOLANA_TREASURY) setError('Choose the owner wallet shown above. This connected account cannot deploy the marketplace.');
    } catch (caught) {if (mounted.current) setError(errorText(caught));}
    finally {busyRef.current = false; if (mounted.current) setOperation(null);}
  }

  async function disconnect() {
    if (busyRef.current || !session) return;
    const previous = session;
    clearErrorReport();
    sessionRef.current = null; setSession(null); setAccepted(false); setEstimate(null);
    try {await disconnectSolanaWallet(previous);} catch (caught) {if (mounted.current) setError(errorText(caught));}
  }

  async function reviewCost() {
    if (!ownerConnected) return;
    setAccepted(false); setEstimate(null);
    await exclusive('estimating', async engine => {
      const nextInspection = await engine.inspect();
      if (!mounted.current) return;
      setInspection(nextInspection);
      if (nextInspection.result) {setResult(nextInspection.result); return;}
      const quote = await engine.estimate();
      if (!mounted.current) return;
      setEstimate(quote); setEstimatedAt(Date.now()); setNow(Date.now());
      setInspection({...nextInspection, programId: quote.programId, bufferId: quote.bufferId});
    });
  }

  async function deploy() {
    const current = sessionRef.current;
    if (!accepted || !estimate || !current || current.account.address !== SOLANA_TREASURY || busyRef.current) return;
    if (Date.now() - estimatedAt >= ESTIMATE_LIFETIME) {setAccepted(false); setNow(Date.now()); setError('The estimate expired. Check the current cost and approve the new amount.'); return;}
    const maximum = estimate.requiredLamports;
    setAccepted(false); setPauseRequested(false); pauseRequestedRef.current = false;
    await exclusive('deploying', async engine => {
      if (sessionRef.current !== current) throw Error('The connected wallet changed. Review the deployment again.');
      if (pauseRequestedRef.current) throw new DeploymentPausedError();
      const verified = await engine.run(createVersionedSolanaDeploymentSigner(current), maximum);
      if (!mounted.current) return;
      setResult(verified); if (verified.signature) setLatestSignature(verified.signature);
      setInspection({stage: 'verified', writtenBytes: verified.programLength, totalBytes: verified.programLength, pendingTransactions: 0, programId: verified.programId, result: verified});
    });
    if (mounted.current) {setEstimate(null); setEstimatedAt(0);}
  }

  async function verify() {
    const address = existingProgram.trim();
    if (!address) return;
    setAccepted(false); setEstimate(null);
    await exclusive('verifying', async engine => {
      const verified = await engine.verify(address);
      if (mounted.current) {setResult(verified); if (verified.signature) setLatestSignature(verified.signature);}
    });
  }

  async function copy(kind: 'address' | 'report') {
    if (!result) return;
    const value = kind === 'address' ? result.programId : JSON.stringify({project: 'own-this-page', ...result, treasury: SOLANA_TREASURY, admin: SOLANA_TREASURY, enabled: false}, null, 2);
    try {await navigator.clipboard.writeText(value); setCopied(kind);} catch {setError('Clipboard access was blocked. Select and copy the program address shown below.');}
  }

  async function copyErrorReport() {
    if (!errorReport) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(errorReport, null, 2));
      setCopied('error'); setErrorReportCopyFailed(false);
    } catch {
      setCopied(previous => previous === 'error' ? null : previous);
      setErrorReportCopyFailed(true); setErrorReportOpen(true);
    }
  }

  return <div className="marketplace-setup">
    <header className="mp-header"><a className="mp-brand" href="/"><img src="/brand/own-this-page-logo.png" alt=""/><span>Own This Page</span></a><a className="mp-back" href="/"><ArrowLeft size={15}/><span>Back to the page</span></a></header>
    <main className="mp-layout">
      <div className="mp-intro"><span className="mp-eyebrow">OWNER SETUP · SOLANA MAINNET</span><h1>Make the page<br/><span>yours to launch.</span></h1><p>Deploy the marketplace from your wallet, then verify it before opening purchases. No terminal or file downloads.</p><div className="mp-steps" aria-label="Setup steps"><span className={ownerConnected ? 'is-done' : 'is-current'}>{ownerConnected ? <Check size={12}/> : '1'}<b>Connect</b></span><ChevronRight size={13}/><span className={estimate || result ? 'is-done' : ownerConnected ? 'is-current' : ''}>{estimate || result ? <Check size={12}/> : '2'}<b>Review</b></span><ChevronRight size={13}/><span className={result ? 'is-done' : operation === 'deploying' ? 'is-current' : ''}>{result ? <Check size={12}/> : '3'}<b>Deploy</b></span></div></div>

      <aside className="mp-summary" aria-label="Your marketplace settings"><span className="mp-eyebrow">YOUR MARKETPLACE</span><dl><div><dt>Buyable spaces</dt><dd>62</dd></div><div><dt>Starting prices</dt><dd>0.1–2 SOL</dd></div><div><dt>Every takeover</dt><dd>2× the previous price</dd></div><div><dt>Network</dt><dd>Solana mainnet</dd></div></dl><div className="mp-owner"><span>Developer · treasury · admin</span><a href={explorer('account', SOLANA_TREASURY)} target="_blank" rel="noopener noreferrer">{SOLANA_TREASURY}<ArrowUpRight size={13}/></a></div><p>All purchase and takeover payments go to this wallet. Previous owners receive no payout. This wallet can moderate spaces and retains program upgrade authority.</p><div className="mp-summary-note"><ShieldCheck size={17}/><span>The official account and token address stay outside the buyable spaces.</span></div><p className="mp-coin-note">Launching a token is optional. You can deploy the marketplace without one.</p></aside>

      <div className="mp-workspace">
        <section className={`mp-connection mp-connection-${health}`} aria-label="Solana connection"><div className="mp-connection-top"><span className="mp-status-dot"/><strong>{health === 'ready' ? 'Connection ready' : health === 'checking' ? 'Checking connection' : 'Connection needs setup'}</strong><button type="button" aria-label="Check Solana connection again" onClick={() => void inspect()} disabled={busy}><RefreshCw size={15} className={operation === 'checking' ? 'mp-spin' : ''}/></button></div><p>{healthMessage}</p>{health === 'unavailable' && <details open><summary>Connect Helius through Cloudflare</summary><ol><li>In Helius, copy your <strong>Solana mainnet RPC URL</strong>.</li><li>Open this project in Cloudflare → Settings → <strong>Runtime variables and secrets</strong>.</li><li>Add a <strong>Secret</strong> named <code>HELIUS_RPC_URL</code>. Paste the full Helius RPC URL as its value.</li><li>Save and deploy, then use the connection check above.</li></ol><p>Your API key belongs in the Cloudflare secret. This page does not ask you to paste it.</p></details>}</section>

        {!result && <section className="mp-card" aria-labelledby="mp-deploy-heading"><div className="mp-card-heading"><span className="mp-card-number">01</span><div><h2 id="mp-deploy-heading">Deploy with your wallet</h2><p>Connect the owner wallet to review the current cost.</p></div></div>
          {session ? <div className={`mp-connected ${ownerConnected ? '' : 'mp-wrong-wallet'}`}><Wallet size={18}/><div><strong>{session.wallet.name}</strong><span title={session.account.address}>{short(session.account.address)}{ownerConnected ? ' · Owner wallet' : ' · Choose the owner wallet'}</span></div><button type="button" onClick={() => void disconnect()} disabled={busy}>Disconnect</button></div> : <div className="mp-wallet-picker">{wallets.length ? wallets.map((wallet, index) => <button type="button" className="mp-button mp-button-secondary" key={`${wallet.name}-${index}`} onClick={() => void connect(wallet)} disabled={busy}><Wallet size={16}/>{operation === 'connecting' ? 'Connecting…' : `Connect ${wallet.name}`}<ArrowUpRight size={14}/></button>) : <p>No compatible wallet was detected. Enable Phantom or Solflare in this browser, or open the site in your wallet’s browser.</p>}<span>Connecting does not sign or spend anything.</span></div>}

          <button type="button" className="mp-button mp-button-secondary mp-cost-button" disabled={busy || !ownerConnected || health !== 'ready'} onClick={() => void reviewCost()}>{operation === 'estimating' ? <LoaderCircle size={16} className="mp-spin"/> : <RefreshCw size={15}/ >}{estimate ? 'Refresh deployment estimate' : hasSavedDeployment ? 'Check remaining cost' : 'Check deployment cost'}</button>

          {estimate && <div className="mp-estimate"><div className="mp-estimate-title"><h3>{hasSavedDeployment ? 'Remaining deployment reserve' : 'Deployment reserve'}</h3><span>{estimateFresh ? 'Current estimate' : 'Estimate expired'}</span></div><dl><div><dt>Program storage deposits</dt><dd>{sol(estimate.programRentLamports + estimate.programDataRentLamports)}</dd></div><div><dt>Temporary upload deposit</dt><dd>{sol(estimate.bufferRentLamports)}</dd></div><div><dt>Remaining network fee allowance</dt><dd>{sol(estimate.remainingNetworkFeesLamports)}</dd></div><div className="mp-total"><dt>Maximum approved reserve</dt><dd>{sol(estimate.requiredLamports)}</dd></div></dl><p>This is a reserve for the remaining deployment. The temporary upload balance is reclaimed during a successful final deployment. Program storage deposits remain on-chain. Actual fees can be lower than the allowance.</p><p><strong>{estimate.remainingTransactions} transactions remain.</strong> Your wallet may show upload approvals in groups. The estimate is checked again before signing.</p>{estimate.pendingTransactions > 0 && <p className="mp-pending-note">{estimate.pendingTransactions} saved transaction{estimate.pendingTransactions === 1 ? '' : 's'} must be resolved before any new upload is sent.</p>}
            <label className="mp-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={busy || !estimateFresh || !ownerConnected}/><span>I approve this deployment with a reserve of up to <strong>{sol(estimate.requiredLamports)}</strong>, including network fees.</span></label>
            <button type="button" className="mp-button mp-button-primary" onClick={() => void deploy()} disabled={busy || !ownerConnected || !accepted || !estimateFresh || estimate.requiredLamports <= 0}><Wallet size={16}/>{hasSavedDeployment ? 'Resume deployment in wallet' : 'Deploy marketplace in wallet'}</button>{!estimateFresh && !busy && <p className="mp-expired">Refresh the estimate above before approving.</p>}
          </div>}

          {(progress || hasSavedDeployment) && <div className="mp-progress" role="status" aria-live="polite"><div className="mp-progress-heading"><strong>{operation === 'deploying' ? 'Deployment in progress' : inspection?.stage === 'pending' ? 'Checking your saved deployment' : 'Saved deployment'}</strong><span>{percent}%</span></div><progress value={percent} max={100} aria-label="Marketplace deployment progress"/><p>{progress?.message ?? (inspection?.pendingTransactions ? 'Saved transactions will be checked before any new signatures are requested.' : 'Your saved upload will be checked before resuming.')}</p><div className="mp-progress-actions">{operation === 'deploying' && <button type="button" className="mp-button mp-button-secondary" disabled={pauseRequested} onClick={() => {pauseRequestedRef.current = true; engineRef.current?.pause(); setPauseRequested(true);}}><Pause size={13}/>{pauseRequested ? 'Pausing after current batch…' : 'Pause after current batch'}</button>}{latestSignature && <a href={explorer('tx', latestSignature)} target="_blank" rel="noopener noreferrer">Latest transaction<ArrowUpRight size={13}/></a>}{!busy && <button type="button" className="mp-text-button" onClick={() => void inspect()}>Check saved progress</button>}</div><p className="mp-keep-open">Keep this tab open during upload. If interrupted, return to this same browser and domain, then check the remaining cost to resume. Do not clear this site’s saved data.</p></div>}
        </section>}

        {error && <div className="mp-error" role="alert"><strong>{errorReport ? 'Wallet signing issue.' : 'This step could not finish.'}</strong><p>{error}</p>{errorReport && <div className="mp-error-report"><p>Share this report here so the signing issue can be checked.</p><button type="button" className="mp-button mp-button-secondary" onClick={() => void copyErrorReport()}>{copied === 'error' ? <Check size={15}/> : <Copy size={15}/ >}{copied === 'error' ? 'Error report copied — paste it in chat' : 'Copy error report'}</button>{errorReportCopyFailed && <p role="status" className="mp-error-report-help">Clipboard access was blocked. Select and copy the report below.</p>}<details open={errorReportOpen} onToggle={event => setErrorReportOpen(event.currentTarget.open)}><summary>View error report</summary><label htmlFor="mp-wallet-error-report">Signing diagnostic report</label><textarea id="mp-wallet-error-report" readOnly value={JSON.stringify(errorReport, null, 2)} onFocus={event => event.currentTarget.select()} spellCheck={false}/></details></div>}{latestSignature && <a href={explorer('tx', latestSignature)} target="_blank" rel="noopener noreferrer">Check the latest transaction<ArrowUpRight size={13}/></a>}</div>}
        {notice && <div className="mp-notice" role="status">{notice}</div>}

        {result && <section className="mp-card mp-success" aria-labelledby="mp-result-heading"><div className="mp-success-icon"><CheckCircle2 size={27}/></div><span className="mp-eyebrow">PROGRAM VERIFIED</span><h2 id="mp-result-heading">The marketplace is deployed.</h2><p>The on-chain program code, Solana network, and owner authority match this project.</p><label className="mp-address-label" htmlFor="mp-program-result">Marketplace program address</label><div className="mp-result-address"><input id="mp-program-result" value={result.programId} readOnly onFocus={event => event.currentTarget.select()}/><button type="button" onClick={() => void copy('address')} aria-label="Copy marketplace program address">{copied === 'address' ? <Check size={17}/> : <Copy size={17}/>}</button></div><a className="mp-explorer" href={explorer('account', result.programId)} target="_blank" rel="noopener noreferrer">View program on Solscan<ArrowUpRight size={13}/></a><div className="mp-next-step"><h3>Next: verify a real purchase</h3><p>Public purchases are still off. Copy the public deployment report and paste it in your project chat. The next step is a controlled purchase, edit, and takeover check, including the treasury receipt, before opening the market.</p></div><button type="button" className="mp-button mp-button-primary" onClick={() => void copy('report')}>{copied === 'report' ? <Check size={16}/> : <Copy size={16}/ >}{copied === 'report' ? 'Report copied — paste it in chat' : 'Copy public deployment report'}</button><p className="mp-report-note">The report contains public addresses and program details. It contains no wallet keys or RPC credentials.</p></section>}

        {!result && <section className="mp-card mp-existing"><details><summary><span>Already deployed? Verify your program</span><ChevronRight size={16}/></summary><div><p>Use the address from a completed marketplace deployment. <strong>This is separate from your coin’s CA.</strong> Leave it blank if you are deploying above.</p><p>Verification only reads the program and checks its code and owner authority. It does not sign or spend anything.</p><label htmlFor="mp-existing-program">Marketplace program address</label><input id="mp-existing-program" type="text" value={existingProgram} onChange={event => setExistingProgram(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Address from a completed marketplace deployment" disabled={busy}/><button type="button" className="mp-button mp-button-secondary" onClick={() => void verify()} disabled={busy || !existingProgram.trim() || health !== 'ready'}>{operation === 'verifying' ? <LoaderCircle size={16} className="mp-spin"/> : <ShieldCheck size={16}/>}Verify program</button></div></details></section>}
        <footer className="mp-footer">The program has automated tests and has not had an independent security audit. Your wallet reviews and signs each deployment batch.</footer>
      </div>
    </main>
  </div>;
}
