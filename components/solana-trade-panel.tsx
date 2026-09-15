'use client';

import {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, LayoutGrid, LoaderCircle, Wallet} from 'lucide-react';
import {SheetDescription, SheetTitle} from '@/components/ui/sheet';
import type {SolanaMarketController} from '@/hooks/use-solana-market';
import {emptySolanaSlot, prepareSolanaAction, sameSolanaQuote, validSolanaContentUrl, validateSlotContent, type PreparedSolanaAction, type SlotContent, type SolanaAction} from '@/lib/solana-client';
import {baseLamports, formatSol, quoteLamports} from '@/lib/solana-pricing';
import {solanaProject} from '@/lib/solana-project';
import catalog from '@/lib/slots.json';
import {uploadPlacementImage} from '@/lib/solana-image-upload';

type Placement = (typeof catalog)[number];
const shorten = (address: string) => `${address.slice(0, 5)}…${address.slice(-5)}`;
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function SolanaWalletPicker({controller}: {controller: SolanaMarketController}) {
  if (controller.session) return <div className="s-connected-wallet"><span><Wallet size={15} />{shorten(controller.session.account.address)}</span><button type="button" onClick={() => void controller.disconnect()} disabled={controller.busy}>Disconnect</button></div>;
  return <div className="s-wallet-picker"><p>Choose a Solana wallet. Connecting does not make a purchase.</p>{controller.wallets.length ? controller.wallets.map((wallet, index) => <button type="button" key={`${wallet.name}-${index}`} onClick={() => void controller.connect(wallet)} disabled={controller.connecting}><Wallet size={16} />{controller.connecting ? 'Connecting…' : wallet.name}<ArrowUpRight size={14} /></button>) : <p className="s-form-help">No compatible Solana wallet was detected. Open this page in your wallet browser or enable your wallet extension, then return here.</p>}{controller.walletError && <p role="alert" className="s-form-error">{controller.walletError}</p>}</div>;
}

export function SolanaTransactionActivity({controller}: {controller: SolanaMarketController}) {
  const activity = controller.activity;
  if (!activity) return null;
  return <div className={`s-transaction-status s-transaction-${activity.status}`} role="status" aria-live="polite"><strong>{activity.status === 'signing' ? <><LoaderCircle size={15} className="s-spin" />Waiting for confirmation</> : activity.status === 'confirmed' ? 'Transaction confirmed' : activity.status === 'uncertain' ? 'Check your transaction' : 'Transaction not completed'}</strong><p>{activity.message}</p>{activity.signature && <a href={`https://solscan.io/tx/${activity.signature}`} target="_blank" rel="noopener noreferrer">View transaction <ArrowUpRight size={13} /></a>}{activity.status === 'uncertain' && <>{activity.signature && <button type="button" className="s-secondary-button" onClick={() => void controller.checkActivity()}>Check confirmation</button>}<p>Your saved transaction must be confirmed, failed, or verified as expired before another payment.</p></>}{(activity.status === 'confirmed' || activity.status === 'failed') && <button type="button" className="s-secondary-button" onClick={controller.acknowledgeActivity}>Dismiss</button>}</div>;
}

export default function SolanaTradePanel({slot, preview, controller, close}: {slot: Placement; preview: string; controller: SolanaMarketController; close: () => void}) {
  const state = controller.states[slot.id] ?? emptySolanaSlot(slot.id);
  const actor = controller.session?.account.address ?? '';
  const isOwner = !!actor && state.owner === actor;
  const isAdmin = !!actor && actor === solanaProject.admin;
  const [kind, setKind] = useState<SolanaAction['kind']>('buy');
  const [content, setContent] = useState<SlotContent>({text: '', image: '', link: ''});
  const [locked, setLocked] = useState(false);
  const [prepared, setPrepared] = useState<PreparedSolanaAction | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadsReady, setUploadsReady] = useState(false);
  const draftGeneration = useRef(0);
  useEffect(() => {
    draftGeneration.current++;
    return () => {draftGeneration.current++;};
  }, [slot.id, actor]);
  useEffect(() => {
    if (slot.kind !== 'image') return;
    const abort = new AbortController();
    fetch('/api/images/health', {cache:'no-store', signal:abort.signal}).then(async response => {
      if (response.ok && response.headers.get('Content-Type')?.includes('application/json')) {
        const health = await response.json();
        if (!abort.signal.aborted) setUploadsReady(health.configured === true);
      }
    }).catch(() => {});
    return () => abort.abort();
  }, [slot.kind]);
  let currentPrice: bigint | null = null;
  try {currentPrice = quoteLamports(slot, state.paid);} catch {/* The program also refuses a price beyond u64. */}

  useEffect(() => {
    setContent(state.exists ? {...state.content} : {text: slot.kind === 'image' ? '' : preview, image: '', link: ''});
    setLocked(state.locked);
    setKind(isOwner ? 'edit' : 'buy');
    setError('');
    // Keep a draft while the same placement refreshes. A changed quote still
    // clears consent below; selecting another placement starts a new draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.id, actor]);

  useEffect(() => {setPrepared(null); setAccepted(false);}, [slot.id, actor, controller.accountRevision, controller.live, controller.market, state.owner, state.paid, state.version, state.locked, state.exists, kind, content.text, content.image, content.link, locked]);

  const canAct = controller.live && !!actor && !controller.busy && !uploading && controller.activity?.status !== 'uncertain' &&
    (kind === 'admin' ? isAdmin : kind === 'edit' ? isOwner && !state.locked : currentPrice !== null && !isOwner);
  const preparedMatches = prepared && prepared.action.actor === actor && prepared.market === controller.market &&
    sameSolanaQuote(prepared.action.expected, state) && prepared.action.kind === kind &&
    prepared.action.content.text === content.text && prepared.action.content.image === content.image && prepared.action.content.link === content.link &&
    (kind !== 'admin' || prepared.action.locked === locked);

  async function review() {
    setError(''); setAccepted(false); setPrepared(null);
    if (!canAct || !controller.market) return;
    setPreparing(true);
    try {
      validateSlotContent(content);
      const next = await prepareSolanaAction(controller.market, {kind, actor, id: slot.id, expected: state, content, ...(kind === 'admin' ? {locked} : {})});
      setPrepared(next);
    } catch (caught) {setError(caught instanceof Error ? caught.message : 'The transaction could not be prepared.'); await controller.refresh();}
    finally {setPreparing(false);}
  }

  async function upload(file: File | undefined) {
    if (!file || !controller.session || controller.busy || uploading) return;
    const generation = draftGeneration.current;
    setError(''); setPrepared(null); setAccepted(false); setUploading(true);
    try {
      const image = await uploadPlacementImage(file, controller.session);
      if (generation === draftGeneration.current) setContent(value => ({...value, image}));
    } catch (caught) {
      if (generation === draftGeneration.current) setError(caught instanceof Error ? caught.message : 'The image could not be uploaded.');
    } finally {setUploading(false);}
  }

  async function confirm() {
    if (!canAct || !preparedMatches || !accepted || !prepared) return;
    setAccepted(false); setError('');
    try {await controller.submit(prepared);} catch (caught) {setError(caught instanceof Error ? caught.message : 'The transaction could not be submitted.');}
    finally {setPrepared(null);}
  }

  const shownText = state.exists ? state.content.text : preview;
  const shownImage = state.exists && state.content.image && validSolanaContentUrl(state.content.image) ? state.content.image : '';
  const advertiserLink = state.exists && state.content.link && validSolanaContentUrl(state.content.link) ? state.content.link : '';

  return <><span className="s-eyebrow">Placement {String(slot.id + 1).padStart(2, '0')} / {catalog.length}</span><SheetTitle className="s-preview-title">{slot.label}</SheetTitle><SheetDescription className="s-preview-description">{controller.live ? 'A space on the shared canvas. Review its current owner and price before making a change.' : 'A preview of this space on the shared canvas.'}</SheetDescription>
    <div className="s-preview-art">{slot.kind === 'image' ? shownImage ? <img src={shownImage} alt={shownText || slot.label} referrerPolicy="no-referrer" /> : <><LayoutGrid size={38} strokeWidth={1} /><span>{shownText || 'Image placement'}</span></> : shownText || <span className="s-empty-content">This placement has no text.</span>}</div>
    {advertiserLink && <a className="s-advertiser-link" href={advertiserLink} target="_blank" rel="noopener noreferrer sponsored">Visit advertiser <ArrowUpRight size={14} /></a>}
    <dl className="s-preview-details"><div><dt>Network</dt><dd>Solana mainnet</dd></div><div><dt>Placement type</dt><dd>{slot.kind === 'image' ? 'Image' : 'Text'}</dd></div><div><dt>Design area</dt><dd>{slot.width} × {slot.height}</dd></div><div><dt>{controller.live && state.paid > BigInt(0) ? 'Takeover price' : 'Starting price'}</dt><dd>{currentPrice === null ? 'Price limit reached' : `${formatSol(currentPrice)} SOL`}</dd></div>{controller.live ? <><div><dt>Current owner</dt><dd>{state.owner ? <a href={`https://solscan.io/account/${state.owner}`} target="_blank" rel="noopener noreferrer" title={state.owner}>{isOwner ? 'You · ' : ''}{shorten(state.owner)}</a> : 'Unclaimed'}</dd></div><div><dt>Content</dt><dd>{state.locked ? 'Locked by admin' : 'Editable by owner'}</dd></div></> : <div><dt>Following takeover</dt><dd>{formatSol(baseLamports(slot) * BigInt(2))} SOL</dd></div>}</dl>
    <SolanaWalletPicker controller={controller} />
    {!controller.live ? <div className="s-preview-status"><span className="s-status-note"><span />{controller.status === 'loading' ? 'Checking marketplace' : controller.status === 'error' ? 'Marketplace temporarily unavailable' : 'Purchases not open'}</span><p id="placement-purchase-availability">{controller.status === 'error' ? 'Transactions are paused because the market could not be verified. The canvas may show the last confirmed content.' : 'Purchases are not open yet. This preview does not reserve a slot or request a wallet transaction.'}</p><button type="button" className="s-primary-button s-pending-buy" disabled aria-describedby="placement-purchase-availability">Buy placement</button>{controller.status === 'error' && controller.market && <button type="button" className="s-secondary-button" onClick={() => void controller.refresh()}>Try again</button>}</div> : <>
      {actor && <div className="s-slot-editor"><div className="s-editor-tabs" aria-label="Placement actions">{!isOwner && <button type="button" aria-pressed={kind === 'buy'} onClick={() => {setKind('buy'); setError('');}}>{state.owner ? 'Take over' : 'Buy placement'}</button>}{isOwner && <button type="button" aria-pressed={kind === 'edit'} onClick={() => {setKind('edit'); setContent({...state.content}); setError('');}}>Edit my content</button>}{isAdmin && <button type="button" aria-pressed={kind === 'admin'} onClick={() => {setKind('admin'); setContent({...state.content}); setLocked(state.locked); setError('');}}>Moderate</button>}</div>
        {kind === 'edit' && state.locked ? <p className="s-form-help">The admin has locked this placement. Owner edits are disabled.</p> : <><label className="s-field">{slot.kind === 'image' ? 'Image description' : 'Placement text'}<textarea rows={3} value={content.text} onChange={event => setContent(value => ({...value, text: event.target.value}))} disabled={controller.busy} /><span>{bytes(content.text)} / 280 UTF-8 bytes</span></label>{slot.kind === 'image' && <div className="s-image-uploader"><label className="s-field">Upload an image<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!uploadsReady || controller.busy || uploading || preparing} onChange={event => {const file=event.target.files?.[0]; event.target.value=''; void upload(file);}}/><span>{uploading?'Approve the upload in your wallet, then wait for the image.':uploadsReady?'PNG, JPG or WebP · up to 3 MB. Uploads are public. Your wallet authorizes the upload; no SOL is sent.':'Direct uploads will open when image storage is connected.'}</span></label>{content.image && validSolanaContentUrl(content.image) && <img className="s-uploaded-preview" src={content.image} alt="Your placement image preview" referrerPolicy="no-referrer"/>}<details><summary>Or use an image link</summary><label className="s-field">Image link<input type="url" inputMode="url" placeholder="https://…" value={content.image} onChange={event => setContent(value => ({...value, image:event.target.value}))} disabled={controller.busy || uploading}/><span>HTTPS · {bytes(content.image)} / 256 bytes</span></label></details></div>}<label className="s-field">Advertiser link (optional)<input type="url" inputMode="url" placeholder="https://…" value={content.link} onChange={event => setContent(value => ({...value, link: event.target.value}))} disabled={controller.busy} /><span>HTTPS only · {bytes(content.link)} / 256 bytes</span></label>
        {kind === 'admin' && <><label className="s-consent"><input type="checkbox" checked={locked} onChange={event => setLocked(event.target.checked)} disabled={controller.busy} /><span>Lock content editing by the current owner.</span></label><button type="button" className="s-secondary-button" disabled={controller.busy} onClick={() => setContent({text: '', image: '', link: ''})}>Clear placement content</button><p className="s-form-help">Moderation preserves the owner and purchase price. A new buyer can take over and replace the content.</p></>}
        {kind === 'edit' && <p className="s-form-help">Owner edits have no purchase payment. Solana network fees still apply.</p>}
        <button type="button" className="s-primary-button" onClick={() => void review()} disabled={!canAct || preparing}>{preparing ? <><LoaderCircle size={15} className="s-spin" />Preparing review…</> : 'Review transaction'}</button></>}
      </div>}
      {preparedMatches && prepared && <div className="s-payment-review"><h3>Review before signing</h3><dl className="s-preview-details"><div><dt>{kind === 'buy' ? 'Placement payment' : 'Purchase payment'}</dt><dd>{formatSol(prepared.paymentLamports)} SOL</dd></div><div><dt>Account deposit (up to)</dt><dd>{formatSol(prepared.rentLamports)} SOL</dd></div><div><dt>Network fee (incl. priority)</dt><dd>{formatSol(prepared.feeLamports)} SOL</dd></div><div><dt>Total (up to)</dt><dd>{formatSol(prepared.paymentLamports + prepared.rentLamports + prepared.feeLamports)} SOL</dd></div></dl>{prepared.rentLamports > BigInt(0) && <p>A first action creates the placement’s on-chain account. Its storage deposit is additional to the price and is not refunded by this marketplace.</p>}<p>{kind === 'buy' ? '100% of the placement payment goes to the project treasury. The previous owner receives no payout. A future buyer can take over at twice this purchase price.' : 'This action changes the content on the existing placement.'}</p><p>The admin can moderate and lock content{controller.upgradeAuthority ? ', and upgrade the marketplace program' : ''}. The program has not had an independent security audit.</p><label className="s-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={controller.busy} /><span>I reviewed this placement, my content, the payment, account deposit, network fee, and admin permissions.</span></label><button type="button" className="s-primary-button" disabled={!canAct || !accepted} onClick={() => void confirm()}>{controller.busy ? 'Waiting for wallet…' : kind === 'buy' ? 'Confirm in wallet' : 'Confirm content change'}</button></div>}
      {error && <p role="alert" className="s-form-error">{error}</p>}
    </>}
    <SolanaTransactionActivity controller={controller} />
    <button type="button" className="s-preview-back" onClick={close}>Back to the canvas <ArrowUpRight size={16} /></button>
  </>;
}
