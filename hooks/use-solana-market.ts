'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {readPendingReceipt, savePendingReceipt, clearPendingReceipt, inspectPendingReceipt} from '@/lib/solana-receipt';
import {solanaDeploymentConfig, solanaProject, type SolanaProjectConfig} from '@/lib/solana-project';
import {createMarketConnection, readSolanaSlots, verifySolanaProgram, type MarketConnection, type PreparedSolanaAction, type SolanaSlotState} from '@/lib/solana-client';
import {connectSolanaWallet, disconnectSolanaWallet, listSolanaWallets, onSolanaAccountChange, onSolanaWalletsChanged, signAndSendSolanaTransaction, SolanaSubmissionError, type SolanaWallet, type SolanaWalletSession} from '@/lib/solana-wallet';

export type SolanaActivity = {
  status: 'signing' | 'confirmed' | 'uncertain' | 'failed';
  slotId: number;
  signature: string | null;
  message: string;
};

export function useSolanaMarket() {
  const [config, setConfig] = useState<SolanaProjectConfig | null>(null);
  const [market, setMarket] = useState<MarketConnection | null>(null);
  const [status, setStatus] = useState<'loading' | 'prelaunch' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [states, setStates] = useState<Record<number, SolanaSlotState>>({});
  const [upgradeAuthority, setUpgradeAuthority] = useState<string | null>(null);
  const [wallets, setWallets] = useState<SolanaWallet[]>([]);
  const [session, setSession] = useState<SolanaWalletSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [accountRevision, setAccountRevision] = useState(0);
  const [activity, setActivity] = useState<SolanaActivity | null>(null);
  const active = useRef(true);
  const marketRef = useRef<MarketConnection | null>(null);
  const sessionRef = useRef<SolanaWalletSession | null>(null);
  const verifiedRef = useRef(false);
  const contextSlot = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const connectingRef = useRef(false);
  const submitting = useRef(false);
  const activityRef = useRef<SolanaActivity | null>(null);
  sessionRef.current = session;

  const recordActivity = useCallback((value: SolanaActivity | null) => {
    activityRef.current = value;
    if (active.current) setActivity(value);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing.current) return refreshing.current;
    const current = marketRef.current;
    if (!current) return;
    const task = (async () => {
      try {
        const verified = await verifySolanaProgram(current);
        const snapshot = await readSolanaSlots(current, undefined, Math.max(contextSlot.current, verified.contextSlot));
        if (!active.current || marketRef.current !== current) return;
        contextSlot.current = snapshot.contextSlot;
        verifiedRef.current = true;
        setStates(Object.fromEntries(snapshot.states.map(slot => [slot.id, slot])));
        setUpgradeAuthority(verified.upgradeAuthority);
        setStatus('ready');
        setError('');
      } catch (caught) {
        if (!active.current || marketRef.current !== current) return;
        verifiedRef.current = false;
        setStatus('error');
        setError(caught instanceof Error ? caught.message : 'The Solana market could not be verified.');
      }
    })();
    refreshing.current = task;
    try {await task;} finally {if (refreshing.current === task) refreshing.current = null;}
  }, []);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        const embeddedPreview = document.getElementById('own-page-preview-config')?.textContent;
        let loaded: SolanaProjectConfig;
        if (embeddedPreview) {
          // A portable preview is never an activation path, even if edited.
          const preview = JSON.parse(embeddedPreview);
          loaded = solanaDeploymentConfig({...preview, enabled: false, programId: '', programSha256: '', programLength: 0});
        } else {
          const response = await fetch('./market-config.json', {cache: 'no-store', signal: controller.signal});
          if (!response.ok) throw Error('The marketplace configuration is unavailable.');
          loaded = solanaDeploymentConfig(await response.json());
        }
        if (controller.signal.aborted) return;
        setConfig(loaded);
        if (!loaded.enabled) {setStatus('prelaunch'); return;}
        const connection = createMarketConnection(loaded);
        const saved = readPendingReceipt(localStorage, connection);
        if (saved) recordActivity({status: 'uncertain', signature: saved.signature, slotId: saved.slotId, message: 'A previous transaction is saved. Check its confirmation before another payment.'});
        marketRef.current = connection;
        setMarket(connection);
        await refresh();
        if (!controller.signal.aborted) timer = setInterval(() => void refresh(), 20_000);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError(caught instanceof Error ? caught.message : 'The marketplace could not be loaded.');
      }
    })();
    return () => {active.current = false; controller.abort(); clearInterval(timer); verifiedRef.current = false; marketRef.current = null;};
  }, [refresh]);

  useEffect(() => {
    const update = () => setWallets(listSolanaWallets(solanaProject.cluster));
    update();
    return onSolanaWalletsChanged(update);
  }, []);

  useEffect(() => {
    if (!session) return;
    return onSolanaAccountChange(session, next => {
      sessionRef.current = next;
      setSession(next);
      setAccountRevision(value => value + 1);
      if (!next) setWalletError('Your wallet account changed or disconnected. Connect again to continue.');
    });
  }, [session]);

  async function connect(wallet: SolanaWallet) {
    if (!active.current || connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setWalletError('');
    try {
      const connected = await connectSolanaWallet(wallet, solanaProject.cluster);
      if (!active.current) return;
      sessionRef.current = connected;
      setSession(connected);
      setAccountRevision(value => value + 1);
    } catch (caught) {if (active.current) setWalletError(caught instanceof Error ? caught.message : 'The wallet connection was declined.');}
    finally {connectingRef.current = false; if (active.current) setConnecting(false);}
  }

  async function disconnect() {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setAccountRevision(value => value + 1);
    try {if (current) await disconnectSolanaWallet(current);} catch {setWalletError('Disconnected from this site. You can also remove the connection in your wallet.');}
  }

  async function submit(prepared: PreparedSolanaAction) {
    const current = sessionRef.current;
    if (!current || !verifiedRef.current || prepared.market !== marketRef.current) throw Error('Refresh the market and connect your wallet before continuing.');
    if (submitting.current || activityRef.current?.status === 'uncertain') throw Error('Check the previous transaction before starting another.');
    submitting.current = true;
    recordActivity({status: 'signing', slotId: prepared.action.id, signature: null, message: 'Review the transaction in your wallet. Waiting for Solana confirmation.'});
    try {
      const signature = await signAndSendSolanaTransaction(current, prepared, 60_000, receipt => {
        savePendingReceipt(localStorage, prepared.market, receipt);
        recordActivity({status: 'signing', slotId: receipt.slotId, signature: receipt.signature, message: 'Submitting your signed transaction. Its ID is saved if the connection is interrupted.'});
      });
      try {clearPendingReceipt(localStorage, prepared.market);} catch {/* Confirmed receipt can be safely checked again after reload. */}
      recordActivity({status: 'confirmed', slotId: prepared.action.id, signature, message: 'Confirmed on Solana. The canvas is refreshing.'});
      await refresh();
    } catch (caught) {
      recordActivity({status: caught instanceof SolanaSubmissionError ? 'uncertain' : 'failed', slotId: prepared.action.id,
        signature: caught instanceof SolanaSubmissionError ? caught.signature : null,
        message: caught instanceof Error ? caught.message : 'The transaction was not completed.'});
    } finally {submitting.current = false;}
  }

  async function checkActivity() {
    const current = activityRef.current;
    const connection = marketRef.current;
    if (!current?.signature || !connection || submitting.current) return;
    try {
      const saved = readPendingReceipt(localStorage, connection);
      if (!saved || saved.signature !== current.signature) throw Error('Saved receipt unavailable.');
      const result = await inspectPendingReceipt(connection, saved);
      if (result === 'pending') {
        recordActivity({...current, status: 'uncertain', message: 'The result is still pending or unverified. Your saved transaction must be resolved before another payment.'});
      } else {
        clearPendingReceipt(localStorage, connection);
        recordActivity({...current, status: result === 'confirmed' ? 'confirmed' : 'failed', message: result === 'confirmed' ? 'Confirmed on Solana.' : result === 'expired' ? 'The transaction expired without confirmation. Refresh the placement and review a new transaction.' : 'The transaction failed on Solana. Network fees may still apply.'});
        await refresh();
      }
    } catch {recordActivity({...current, status: 'uncertain', message: 'The receipt is temporarily unavailable. Check the explorer or wallet history before trying again.'});}
  }

  return {config, market, status, error, states, upgradeAuthority, wallets, session, connecting, walletError, accountRevision, activity,
    live: status === 'ready', busy: activity?.status === 'signing', refresh, connect, disconnect, submit, checkActivity,
    acknowledgeActivity: () => {if (!submitting.current && activityRef.current?.status !== 'uncertain') recordActivity(null);}};
}

export type SolanaMarketController = ReturnType<typeof useSolanaMarket>;
