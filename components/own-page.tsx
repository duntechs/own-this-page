'use client';

import {createContext, useContext, useRef, useState, type ReactNode} from 'react';
import {ArrowUpRight, Copy, Check, Grid2X2, ImagePlus, LockKeyhole, MousePointer2, Plus, Wallet, ExternalLink} from 'lucide-react';
import {Toaster, toast} from 'sonner';
import {Sheet, SheetContent, SheetTitle, SheetDescription} from './ui/sheet';
import SolanaTradePanel, {SolanaWalletPicker, SolanaTransactionActivity} from './solana-trade-panel';
import {useSolanaMarket, type SolanaMarketController} from '@/hooks/use-solana-market';
import {officialProject} from '@/lib/official-project';
import {solanaProject} from '@/lib/solana-project';
import {formatSol, quoteLamports} from '@/lib/solana-pricing';
import {validSolanaContentUrl} from '@/lib/solana-client';
import catalog from '@/lib/slots.json';
import {displayCopy} from '@/lib/presentation';

type Placement = typeof catalog[number];
const slots = Object.fromEntries(catalog.map(slot => [slot.key, slot]));
const copy = {...displayCopy,
  announcement: 'Your announcement. Everyone’s attention.',
  wordmark: 'Your name here',
  'nav.0': 'Your website', 'nav.1': 'Your community', 'nav.2': 'Your project', 'nav.3': 'Your link',
  'hero.title': 'This could be\nyour headline.',
  'hero.body': 'A big idea. A new launch. Something worth sharing. Give it a place on the internet.',
  'hero.button': 'Your call to action', 'hero.link': 'Your next destination',
  'hero.note': 'Even this little line can be yours.', 'hero.image': 'A picture worth a thousand clicks.',
  'card.0.icon': '01', 'card.0.title': 'Start something.', 'card.0.body': 'One small space for your next big idea.',
  'card.1.icon': '02', 'card.1.title': 'Find your people.', 'card.1.body': 'Put your community where people can see it.',
  'card.2.icon': '03', 'card.2.title': 'Make some noise.', 'card.2.body': 'A good message deserves a little room.',
  'split.0.eyebrow': 'THE SPOTLIGHT', 'split.0.title': 'A little more room.\nA lot more you.',
  'split.0.body': 'Tell your story in more than a headline. This corner is made for it.',
  'split.0.bullet.0': 'Your idea, in a few words.', 'split.0.bullet.1': 'A link to your world.', 'split.0.bullet.2': 'An image they remember.', 'split.0.button': 'Take a closer look', 'split.0.image': 'Your next big reveal.',
  'split.1.eyebrow': 'THE OTHER SIDE', 'split.1.title': 'For the ones\ndoing their own thing.',
  'split.1.body': 'Your art. Your project. Your very specific obsession. It belongs here.',
  'split.1.bullet.0': 'Something you made.', 'split.1.bullet.1': 'Something you believe in.', 'split.1.bullet.2': 'Something worth a click.', 'split.1.button': 'Meet your next favourite', 'split.1.image': 'A different point of view.',
  'quote.0.text': 'A thought that deserves more than a group chat.',
  'quote.1.text': 'Your next “you have to see this” goes here.',
  'quote.2.text': 'A small corner of the internet. A very big personality.',
  'quote.3.text': 'No algorithm. Just a place on the page.',
  'final.title': 'Leave your mark.', 'final.body': 'One page. A whole lot of possibilities.', 'final.button': 'This button could be yours',
  'footer.0': 'A little space for your words.', 'footer.1': 'Made to be noticed.', 'footer.2': 'Your last word.', 'footer.3': 'Yes, even down here.',
};

const Context = createContext<{market: SolanaMarketController; ownedOnly: boolean; select: (slot:Placement)=>void}|null>(null);
function useCanvas() {const value=useContext(Context); if(!value) throw Error('Missing canvas'); return value;}
function Brand({small=false}:{small?:boolean}) {return <span className={`brand-lockup${small?' brand-small':''}`}><span className="brand-icon"><img src="./brand/own-this-page-logo.png" alt=""/></span><span>own this page<span className="brand-period">.</span></span></span>;}

function Slot({slotKey,className='',children}:{slotKey:string;className?:string;children?:ReactNode}) {
  const {market,select,ownedOnly}=useCanvas(); const slot=slots[slotKey]; const state=market.states[slot.id];
  let price:bigint|null=null;try{price=quoteLamports(slot,state?.paid);}catch{/* Overflow disables further takeovers. */}
  const text=state?.exists&&slot.kind!=='image'?state.content.text:null;
  const isMine=!!market.session&&state?.owner===market.session.account.address;
  return <button type="button" data-slot-id={slot.id} data-slot-key={slotKey} className={`placement ${className}${ownedOnly&&!isMine?' placement-muted':''}${isMine?' placement-mine':''}`} onClick={()=>select(slot)} aria-label={`${slot.label}. ${price===null?'Price limit reached':`${state?.owner?'Takeover':'Starting'} price ${formatSol(price)} SOL`}. Open slot details.`}>
    <span className="placement-tag" aria-hidden="true"><span>{String(slot.id+1).padStart(2,'0')}</span>{price===null?'Price limit':`${formatSol(price)} SOL`}<ArrowUpRight size={12}/></span>
    {text!==null ? text||<span className="empty-content">Open space</span> : children??copy[slotKey as keyof typeof copy]??slot.text}
  </button>;
}

function ImageSlot({slotKey,variant=''}:{slotKey:string;variant?:string}) {
  const {market}=useCanvas();const state=market.states[slots[slotKey].id];const image=state?.exists&&validSolanaContentUrl(state.content.image)?state.content.image:'';
  return <Slot slotKey={slotKey} className={`image-placement ${variant}`}>
    {image?<img className="advertiser-image" src={image} alt={state?.content.text||slots[slotKey].label} loading="lazy" referrerPolicy="no-referrer"/>:<span className="image-empty"><ImagePlus size={36} strokeWidth={1.15}/><span>Your image here</span></span>}
    <span className="image-caption">{state?.exists?state.content.text:(copy[slotKey as keyof typeof copy]||slots[slotKey].text)}<ArrowUpRight size={19}/></span>
  </Slot>;
}

function OfficialBar() {
 const [copied,setCopied]=useState(false);
 async function copyCa(){try{await navigator.clipboard.writeText(officialProject.coinAddress);setCopied(true);setTimeout(()=>setCopied(false),2000);}catch{toast.error('Copy unavailable. Select the full address to copy it.');}}
 return <div className="official-bar" aria-label="Official project information"><span className="official-label"><LockKeyhole size={13}/>Official</span><div className="ca-inline" data-official="coin-ca"><span className="subtle">CA</span>{officialProject.coinAddress?<><code title={officialProject.coinAddress}>{officialProject.coinAddress}</code><button onClick={()=>void copyCa()} aria-label="Copy official token address">{copied?<Check size={14}/>:<Copy size={14}/>}</button><a href={`${officialProject.explorer}/token/${officialProject.coinAddress}`} target="_blank" rel="noopener noreferrer" aria-label="View official token on Solscan"><ExternalLink size={13}/></a></>:<span>To be announced</span>}</div><a className="official-x" data-official="social" href={officialProject.xUrl} target="_blank" rel="noopener noreferrer"><span aria-hidden="true">𝕏</span>{officialProject.xHandle}<ArrowUpRight size={13}/></a><span className="official-protected">Protected</span></div>;
}

function OwnerInfo() {
 return <><span className="eyebrow">OWNER INFORMATION</span><SheetTitle className="s-preview-title">Ready for the next chapter.</SheetTitle><SheetDescription className="s-preview-description">This is your private Own This Page preview. A custom domain and marketplace activation come later.</SheetDescription><div className="owner-summary"><Brand/><dl><div><dt>Website</dt><dd>Private preview</dd></div><div><dt>Domain</dt><dd>Not connected</dd></div><div><dt>Official token CA</dt><dd>Awaiting your new address</dd></div><div><dt>Slot purchases</dt><dd>Not activated</dd></div><div><dt>Network</dt><dd>Solana mainnet</dd></div></dl></div><p className="owner-copy">The marketplace program has not finished deployment. Connecting a wallet here does not deploy it or activate payments.</p><p className="owner-copy">Your approved developer, treasury, and admin wallet:</p><a className="treasury-address" href={`${officialProject.explorer}/account/${solanaProject.treasury}`} target="_blank" rel="noopener noreferrer">{solanaProject.treasury}<ArrowUpRight size={15}/></a><p className="owner-copy">The previous website stays private. The new domain, RPC connection, and verified marketplace program can be configured before launch.</p></>;
}

export default function Canvas(){
 const market=useSolanaMarket();const [selected,setSelected]=useState<Placement|null>(null);const [showPrices,setShowPrices]=useState(false);const [walletOpen,setWalletOpen]=useState(false);const [rulesOpen,setRulesOpen]=useState(false);const [ownerOpen,setOwnerOpen]=useState(false);const [ownedOnly,setOwnedOnly]=useState(false);const trigger=useRef<number|null>(null);const walletTrigger=useRef<HTMLButtonElement>(null);
 const owned=Object.values(market.states).filter(s=>!!market.session&&s.owner===market.session.account.address).length;
 const claimed=Object.values(market.states).filter(s=>s.owner).length;
 function select(slot:Placement){trigger.current=slot.id;setSelected(slot);}
 return <Context.Provider value={{market,ownedOnly:ownedOnly&&!!market.session,select}}><div className={`own-page ${showPrices?'show-prices':''}`}><Toaster theme="light" position="top-center"/><a className="skip-link" href="#canvas">Skip to the page</a>
  <header className="site-header"><div className="container header-inner"><a href="#" className="home-link" aria-label="Own This Page home"><Brand/></a><nav className="nav-links" aria-label="Main navigation"><a href="#canvas" className="nav-active">The page</a><button onClick={()=>setRulesOpen(true)}>How it works</button></nav><button className="wallet-button" ref={walletTrigger} onClick={()=>setWalletOpen(true)}><Wallet size={16}/><span>{market.session?`${market.session.account.address.slice(0,4)}…${market.session.account.address.slice(-4)}`:'Connect wallet'}</span></button></div></header>
  <main className="container"><h1 className="sr-only">Own This Page — 62 buyable spaces</h1><OfficialBar/>
   <section className="canvas-shell" id="canvas" aria-label="62 buyable spaces"><div className="canvas-tools"><div><strong>62 spaces</strong><span className="market-stats">0.1–2 SOL <span>start</span><span className="stats-divider">·</span>2× <span>takeovers</span></span><span className={`availability ${market.live?'is-live':''}`}>{market.live?`${claimed} claimed`:market.status==='error'?'Connection unavailable':'Preview'}</span></div><div className="canvas-tool-actions">{market.session&&<button className={ownedOnly?'control-active':''} aria-pressed={ownedOnly} onClick={()=>setOwnedOnly(!ownedOnly)}>My spaces <span>{owned}</span></button>}<button className={showPrices?'control-active':''} aria-pressed={showPrices} onClick={()=>setShowPrices(!showPrices)}><Grid2X2 size={15}/>{showPrices?'Hide prices':'Show prices'}</button></div></div>
    {!market.live&&<div className="preview-notice" id="market-availability"><span>{market.status==='error'?'The marketplace could not be verified. Purchases are paused.':'Private preview · purchases not open yet.'}</span><button onClick={()=>setRulesOpen(true)}>How it works <ArrowUpRight size={13}/></button></div>}
    {market.status==='error'&&<div className="connection-error" role="status"><p>{market.error}</p>{market.market&&<button onClick={()=>void market.refresh()}>Check again</button>}</div>}
    {market.activity&&!selected&&<SolanaTransactionActivity controller={market}/>}
    <div className="canvas-content">
     <div className="notice-slot"><span className="eyebrow">THE LATEST</span><Slot slotKey="announcement"/><ArrowUpRight size={16}/></div>
     <div className="page-nav"><Slot slotKey="wordmark" className="page-wordmark"/><div>{[0,1,2,3].map(i=><Slot key={i} slotKey={`nav.${i}`}/>)}</div></div>
     <section className="page-hero" aria-label="Headline and image spaces"><div className="page-hero-text"><span className="eyebrow section-id">001 — MAKE AN ENTRANCE</span><h2><Slot slotKey="hero.title"/></h2><p><Slot slotKey="hero.body"/></p><div className="hero-actions"><Slot slotKey="hero.button" className="action-slot"/><Slot slotKey="hero.link" className="link-slot"/></div><Slot slotKey="hero.note" className="hero-footnote"/></div><ImageSlot slotKey="hero.image" variant="hero-image"/></section>
     <section className="logo-row" aria-label="Logo spaces"><div className="section-label"><span>GOOD COMPANY STARTS HERE</span><span>6 logo spaces</span></div><div className="logo-grid">{[0,1,2,3,4,5].map(i=>{const state=market.states[slots[`sponsor.${i}`].id];return <Slot key={i} slotKey={`sponsor.${i}`} className="logo-slot">{state?.exists&&validSolanaContentUrl(state.content.image)?<img src={state.content.image} alt={state.content.text||'Advertiser logo'} loading="lazy" referrerPolicy="no-referrer"/>:<><Plus size={18} strokeWidth={1.2}/><span>{state?.content.text||'Your logo'}</span></>}</Slot>;})}</div></section>
     <section className="idea-grid" aria-label="Short message spaces">{[0,1,2].map(i=><article className="idea-card" key={i}><Slot slotKey={`card.${i}.icon`} className="number-slot"/><h3><Slot slotKey={`card.${i}.title`}/></h3><p><Slot slotKey={`card.${i}.body`}/></p></article>)}</section>
     <section className="spotlights" aria-label="Featured spaces">{[0,1].map(i=><article className={`spotlight spotlight-${i}`} key={i}><div className="spotlight-copy"><Slot slotKey={`split.${i}.eyebrow`} className="eyebrow"/><h3><Slot slotKey={`split.${i}.title`}/></h3><p><Slot slotKey={`split.${i}.body`}/></p><ul>{[0,1,2].map(n=><li key={n}><span aria-hidden="true">/</span><Slot slotKey={`split.${i}.bullet.${n}`}/></li>)}</ul><Slot slotKey={`split.${i}.button`} className="link-slot"/></div><ImageSlot slotKey={`split.${i}.image`} variant={i?'soft-image':'dark-image'}/></article>)}</section>
     <section className="noticeboard" aria-label="Community message spaces"><div className="section-label"><span>A FEW WORDS GO A LONG WAY</span><span>4 message spaces</span></div><div className="message-grid">{[0,1,2,3].map(i=><article className="message-card" key={i}><span className="quote-marker" aria-hidden="true">“</span><Slot slotKey={`quote.${i}.text`} className="message-text"/><div className="message-byline"><Slot slotKey={`quote.${i}.name`}/><Slot slotKey={`quote.${i}.title`}/></div></article>)}</div></section>
     <section className="last-word"><span className="eyebrow">THE LAST IMPRESSION</span><h3><Slot slotKey="final.title"/></h3><p><Slot slotKey="final.body"/></p><Slot slotKey="final.button" className="action-slot"/></section>
     <div className="page-footer">{[0,1,2,3].map(i=><Slot key={i} slotKey={`footer.${i}`}/>)}</div>
    </div>
    <div className="canvas-end"><MousePointer2 size={15}/><span>Every outlined space is a placement. Click one to see the details.</span><button onClick={()=>setShowPrices(!showPrices)}>{showPrices?'Hide outlines':'Find a space'}<ArrowUpRight size={14}/></button></div>
   </section>
  </main>
  <footer className="site-footer container"><Brand small/><button onClick={()=>setRulesOpen(true)}>How it works</button><button onClick={()=>setOwnerOpen(true)}>Owner info<ArrowUpRight size={13}/></button><a href={officialProject.xUrl} target="_blank" rel="noopener noreferrer" aria-label={`Official X ${officialProject.xHandle}`}>𝕏</a></footer>
  <Sheet open={selected!==null} onOpenChange={open=>{if(!open)setSelected(null);}}><SheetContent className="solana-preview-panel" onCloseAutoFocus={event=>{event.preventDefault();document.querySelector<HTMLButtonElement>(`[data-slot-id="${trigger.current}"]`)?.focus();}}>{selected&&<SolanaTradePanel key={selected.id} slot={selected} preview={copy[selected.key as keyof typeof copy]||selected.text} controller={market} close={()=>setSelected(null)}/>}</SheetContent></Sheet>
  <Sheet open={walletOpen} onOpenChange={setWalletOpen}><SheetContent className="solana-preview-panel" onCloseAutoFocus={e=>{e.preventDefault();walletTrigger.current?.focus();}}><span className="eyebrow">YOUR PLACE ON THE PAGE</span><SheetTitle className="s-preview-title">Connect your wallet.</SheetTitle><SheetDescription className="s-preview-description">Use a Solana wallet to manage your spaces. Connecting never sends a payment.</SheetDescription><SolanaWalletPicker controller={market}/>{!market.live&&<div className="s-preview-status"><p>Purchases are not open yet. You can explore every placement and its starting price.</p></div>}<SolanaTransactionActivity controller={market}/></SheetContent></Sheet>
  <Sheet open={rulesOpen} onOpenChange={setRulesOpen}><SheetContent className="solana-preview-panel"><span className="eyebrow">A SHARED SPACE, SIMPLE RULES</span><SheetTitle className="s-preview-title">How this page works.</SheetTitle><SheetDescription className="s-preview-description">62 individual advertising spaces on Solana. The official brand, token address, and X account always stay protected.</SheetDescription><div className="rules-detail">{[
   ['What can I own?','A placement on this page: its text, image, or link. You are buying control of an advertising space, not the website or the project token.'],
   ['How much does it cost?','Starting prices range from 0.1 to 2 SOL according to the fixed size of the placement. Network fees and any first-time storage deposit are shown separately before signing.'],
   ['Can someone take my space?','Yes. A buyer can take over by paying twice the last purchase price. There is no 2 SOL cap on takeovers. All purchase and takeover payments go to the treasury; previous owners receive no payout.'],
   ['Can I edit my content?','The current owner can change their content without paying the placement price again. Network fees still apply. Images and links must use public HTTPS URLs.'],
   ['Who moderates the page?','The admin can clear or change content and lock owner edits. A new buyer can still take over a moderated placement. The admin retains upgrade authority for the marketplace program. It has not had an independent security audit.'],
   ['Can someone change the official details?','No. The brand, official token CA, and official X link are outside the 62 purchasable placements. Advertisers cannot buy or change them.'],
   ['Are purchases open? ',market.live?'The marketplace is verified and open. Select a space to review the current price and transaction.':'Not yet. This private preview lets you explore the page. The marketplace must be deployed and verified before payments are enabled.'],
  ].map(([q,a])=><section key={q}><h3>{q}</h3><p>{a}</p></section>)}<section><h3>Developer / treasury / admin</h3><a className="treasury-address" href={`${officialProject.explorer}/account/${solanaProject.treasury}`} target="_blank" rel="noopener noreferrer">{solanaProject.treasury}<ArrowUpRight size={14}/></a></section></div></SheetContent></Sheet>
  <Sheet open={ownerOpen} onOpenChange={setOwnerOpen}><SheetContent className="solana-preview-panel"><OwnerInfo/></SheetContent></Sheet>
 </div></Context.Provider>;
}
