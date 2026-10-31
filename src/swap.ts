import {
  Hash,
  P2PKH,
  PublicKey,
  Random,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
} from '@bsv/sdk';
import { BRC29_PROTOCOL } from './protocol.ts';
import { TOKEN_PROTOCOL, tokenOwner, transferScript } from './token.ts';
import { IndexedDBOperationJournal } from './journal.ts';
import {
  SCOPE,
  keyFor,
  validateApproval,
  approvedSource,
  validatePrepared,
  spendContext,
  verifySellerSignature,
  blueprint,
} from './swap-validation.ts';
import { reconcileSwap } from './swap-receipt.ts';
import type {
  SwapOffer,
  SwapApproval,
  PreparedSwap,
  SwapReceipt,
  SwapRecord,
  SwapJournal,
  TokenOverlay,
} from './swap-types.ts';
export type {
  SwapOffer,
  SwapApproval,
  OverlayToken,
  TokenOverlay,
  PreparedSwap,
  SwapReceipt,
  SwapRecord,
  SwapJournal,
} from './swap-types.ts';
export { reconcileSwap, receiveSwapProceeds } from './swap-receipt.ts';
export { verifySellerSignature } from './swap-validation.ts';

export class IndexedDBSwapJournal
  extends IndexedDBOperationJournal<SwapRecord>
  implements SwapJournal
{
  constructor(name = 'ocnif-swaps') {
    super(name);
  }
}
export async function prepareSwap(
  wallet: WalletInterface,
  offer: SwapOffer,
  approval: SwapApproval,
  buyerKeyIndex: number,
  overlay: TokenOverlay,
  journal: SwapJournal,
): Promise<PreparedSwap> {
  const [{ publicKey: buyerIdentityKey }, { network }] = await Promise.all([
    wallet.getPublicKey({ identityKey: true }),
    wallet.getNetwork({}),
  ]);
  validateApproval(offer, buyerIdentityKey, approval);
  if (network !== offer.network) throw new Error('wallet_network_mismatch');
  const source = await approvedSource(offer, overlay);
  const key = keyFor(buyerIdentityKey, offer);
  await journal.reserve(key, { status: 'preparing', offer });
  try {
    const derivationPrefix = Utils.toBase64(Random(16));
    const derivationSuffix = Utils.toBase64(Random(16));
    const { publicKey } = await wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: offer.sellerIdentityKey,
      forSelf: false,
    });
    const paymentScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex();
    const result = await wallet.createAction({
      description: 'Prepare atomic security-credit swap',
      inputBEEF: source.beef,
      inputs: [
        {
          outpoint: offer.outpoint,
          unlockingScriptLength: 108,
          inputDescription: 'Seller security-credit token',
        },
      ],
      outputs: [
        {
          lockingScript: paymentScript,
          satoshis: offer.priceSatoshis,
          outputDescription: 'BSV price paid to seller',
        },
        {
          lockingScript: transferScript({
            id: offer.tokenId,
            amount: offer.tokenAmount,
            ownerPkh: tokenOwner(buyerIdentityKey, buyerKeyIndex),
          }).toHex(),
          satoshis: 1,
          outputDescription: 'Security-credit tokens to buyer',
          basket: 'bsv21',
          customInstructions: JSON.stringify({
            protocolID: TOKEN_PROTOCOL,
            keyID: String(buyerKeyIndex),
            counterparty: 'anyone',
            index: buyerKeyIndex,
          }),
        },
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, noSend: true },
    });
    if (!result.signableTransaction) throw new Error('swap_wallet_did_not_prepare');
    const p: PreparedSwap = {
      offer,
      buyerIdentityKey,
      buyerKeyIndex,
      transaction: Array.from(result.signableTransaction.tx),
      reference: result.signableTransaction.reference,
      derivationPrefix,
      derivationSuffix,
      paymentScript,
    };
    validatePrepared(p);
    await journal.update(key, { status: 'prepared', offer, prepared: p });
    return p;
  } catch (error) {
    await journal.update(key, { status: 'review_required', offer });
    throw error;
  }
}
export async function approveSwap(
  wallet: WalletInterface,
  p: PreparedSwap,
  approval: SwapApproval,
  overlay: TokenOverlay,
): Promise<string> {
  validateApproval(p.offer, p.buyerIdentityKey, approval);
  const [{ publicKey: identity }, { network }] = await Promise.all([
    wallet.getPublicKey({ identityKey: true }),
    wallet.getNetwork({}),
  ]);
  if (identity !== p.offer.sellerIdentityKey || network !== p.offer.network)
    throw new Error('seller_wallet_mismatch');
  await approvedSource(p.offer, overlay);
  const { publicKey: payKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
    counterparty: p.buyerIdentityKey,
    forSelf: true,
  });
  if (new P2PKH().lock(PublicKey.fromString(payKey).toAddress()).toHex() !== p.paymentScript)
    throw new Error('seller_payment_key_mismatch');
  const tx = validatePrepared(p);
  const context = spendContext(tx);
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Hash.hash256(TransactionSignature.format(context)),
    protocolID: TOKEN_PROTOCOL,
    keyID: String(p.offer.sellerKeyIndex),
    counterparty: 'anyone',
  });
  const { publicKey } = await wallet.getPublicKey({
    protocolID: TOKEN_PROTOCOL,
    keyID: String(p.offer.sellerKeyIndex),
    counterparty: 'anyone',
    forSelf: true,
  });
  const parsed = Signature.fromDER(Array.from(signature));
  const sig = new TransactionSignature(parsed.r, parsed.s, SCOPE).toChecksigFormat();
  const pub = Utils.toArray(publicKey, 'hex');
  const unlocking = new UnlockingScript([
    { op: sig.length, data: sig },
    { op: pub.length, data: pub },
  ]).toHex();
  verifySellerSignature(p, unlocking);
  return unlocking;
}
export async function completeSwap(
  wallet: WalletInterface,
  p: PreparedSwap,
  signature: string,
  approval: SwapApproval,
  overlay: TokenOverlay,
  journal: SwapJournal,
): Promise<SwapReceipt> {
  validateApproval(p.offer, p.buyerIdentityKey, approval);
  const [{ publicKey: identity }, { network }] = await Promise.all([
    wallet.getPublicKey({ identityKey: true }),
    wallet.getNetwork({}),
  ]);
  if (identity !== p.buyerIdentityKey || network !== p.offer.network)
    throw new Error('buyer_wallet_mismatch');
  const key = keyFor(identity, p.offer);
  const record = await journal.get(key);
  if (record?.status !== 'prepared' || JSON.stringify(record.prepared) !== JSON.stringify(p))
    throw new Error('swap_preparation_not_recorded');
  await approvedSource(p.offer, overlay);
  verifySellerSignature(p, signature);
  await journal.reserve(`${key}:completion`, { status: 'signing', offer: p.offer, prepared: p });
  let receipt: SwapReceipt;
  try {
    const result = await wallet.signAction({
      reference: p.reference,
      spends: { 0: { unlockingScript: signature } },
      options: { acceptDelayedBroadcast: false, noSend: false },
    });
    if (!result.txid || !result.tx) throw new Error('swap_wallet_incomplete');
    if (
      result.sendWithResults?.some(
        (result) => result.status === 'failed' || result.status === 'sending',
      )
    )
      throw new Error('swap_broadcast_uncertain');
    const tx = Transaction.fromAtomicBEEF(result.tx);
    if (tx.id('hex') !== result.txid || blueprint(tx) !== blueprint(validatePrepared(p)))
      throw new Error('swap_final_transaction_mismatch');
    receipt = {
      status: 'wallet_broadcast',
      confirmed: false,
      txid: result.txid,
      transaction: Array.from(result.tx),
      offer: p.offer,
      buyerIdentityKey: p.buyerIdentityKey,
      buyerKeyIndex: p.buyerKeyIndex,
      derivationPrefix: p.derivationPrefix,
      derivationSuffix: p.derivationSuffix,
    };
    await journal.update(key, { status: 'wallet_broadcast', offer: p.offer, prepared: p, receipt });
  } catch (error) {
    await journal.update(key, { status: 'review_required', offer: p.offer, prepared: p });
    throw error;
  }
  return reconcileSwap(wallet, receipt, overlay, journal);
}
