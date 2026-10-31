import type { Transaction, WalletNetwork } from '@bsv/sdk';

export interface SwapOffer {
  id: string;
  outpoint: string;
  tokenId: string;
  tokenAmount: string;
  priceSatoshis: number;
  sellerIdentityKey: string;
  sellerKeyIndex: number;
  network: WalletNetwork;
}
export interface SwapApproval extends SwapOffer {
  buyerIdentityKey: string;
}
export interface OverlayToken {
  transaction: Transaction;
  outputIndex: number;
  beef: number[];
  spent: boolean;
}
export interface TokenOverlay {
  lookup(outpoint: string): Promise<OverlayToken | null>;
  submit(transaction: number[]): Promise<void>;
}
export interface PreparedSwap {
  offer: SwapOffer;
  buyerIdentityKey: string;
  buyerKeyIndex: number;
  transaction: number[];
  reference: string;
  derivationPrefix: string;
  derivationSuffix: string;
  paymentScript: string;
}
export interface SwapReceipt {
  status: 'wallet_broadcast' | 'overlay_pending' | 'overlay_admitted';
  confirmed: false;
  txid: string;
  transaction: number[];
  offer: SwapOffer;
  buyerIdentityKey: string;
  buyerKeyIndex: number;
  derivationPrefix: string;
  derivationSuffix: string;
  error?: string;
}
export interface SwapRecord {
  status:
    | 'preparing'
    | 'prepared'
    | 'signing'
    | 'review_required'
    | 'wallet_broadcast'
    | 'overlay_pending'
    | 'overlay_admitted';
  offer: SwapOffer;
  prepared?: PreparedSwap;
  receipt?: SwapReceipt;
}
export interface SwapJournal {
  reserve(key: string, record: SwapRecord): Promise<void>;
  update(key: string, record: SwapRecord): Promise<void>;
  get(key: string): Promise<SwapRecord | undefined>;
}
