import { P2PKH, PublicKey, Transaction, type WalletInterface } from '@bsv/sdk';
import { BRC29_PROTOCOL } from './protocol.ts';
import { TOKEN_PROTOCOL, readToken, tokenOwner } from './token.ts';
import { blueprint, keyFor, validatePrepared } from './swap-validation.ts';
import type { SwapReceipt, TokenOverlay, SwapJournal } from './swap-types.ts';

export async function reconcileSwap(
  wallet: WalletInterface,
  receipt: SwapReceipt,
  overlay: TokenOverlay,
  journal: SwapJournal,
): Promise<SwapReceipt> {
  const [{ publicKey: identity }, { network }] = await Promise.all([
    wallet.getPublicKey({ identityKey: true }),
    wallet.getNetwork({}),
  ]);
  if (identity !== receipt.buyerIdentityKey || network !== receipt.offer.network)
    throw new Error('buyer_wallet_mismatch');
  const key = keyFor(identity, receipt.offer);
  const record = await journal.get(key);
  if (
    !record?.prepared ||
    !record.receipt ||
    !['wallet_broadcast', 'overlay_pending', 'overlay_admitted'].includes(record.status) ||
    JSON.stringify(record.receipt) !== JSON.stringify(receipt)
  )
    throw new Error('swap_receipt_not_recorded');
  const tx = Transaction.fromAtomicBEEF(receipt.transaction);
  if (
    tx.id('hex') !== receipt.txid ||
    blueprint(tx) !== blueprint(validatePrepared(record.prepared))
  )
    throw new Error('swap_receipt_mismatch');
  const reconciled = { ...receipt };
  try {
    await overlay.submit(receipt.transaction);
    const admitted = await overlay.lookup(`${receipt.txid}.1`);
    const out = admitted?.transaction.outputs[1];
    const token = out && readToken(out.lockingScript, `${receipt.txid}.1`);
    if (
      !admitted ||
      admitted.spent ||
      admitted.transaction.id('hex') !== receipt.txid ||
      admitted.outputIndex !== 1 ||
      out?.satoshis !== 1 ||
      token?.id !== receipt.offer.tokenId ||
      token.amount !== receipt.offer.tokenAmount ||
      token.ownerPkh !== tokenOwner(identity, receipt.buyerKeyIndex)
    )
      throw new Error('swap_overlay_did_not_admit');
    await wallet.internalizeAction({
      tx: receipt.transaction,
      outputs: [
        {
          outputIndex: 1,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: 'bsv21',
            customInstructions: JSON.stringify({
              protocolID: TOKEN_PROTOCOL,
              keyID: String(receipt.buyerKeyIndex),
              counterparty: 'anyone',
              index: receipt.buyerKeyIndex,
            }),
            tags: ['bsv21', `id:${receipt.offer.tokenId}`, `amt:${receipt.offer.tokenAmount}`],
          },
        },
      ],
      description: 'Receive purchased security credits',
    });
    reconciled.status = 'overlay_admitted';
    delete reconciled.error;
  } catch {
    reconciled.status = 'overlay_pending';
    reconciled.error =
      'Token admission or wallet synchronization needs reconciliation; do not purchase again.';
  }
  await journal.update(key, {
    status: reconciled.status,
    offer: receipt.offer,
    prepared: record.prepared,
    receipt: reconciled,
  });
  return reconciled;
}
export async function receiveSwapProceeds(
  wallet: WalletInterface,
  receipt: SwapReceipt,
): Promise<void> {
  const [{ publicKey: identity }, { network }] = await Promise.all([
    wallet.getPublicKey({ identityKey: true }),
    wallet.getNetwork({}),
  ]);
  if (identity !== receipt.offer.sellerIdentityKey || network !== receipt.offer.network)
    throw new Error('seller_wallet_mismatch');
  const tx = Transaction.fromAtomicBEEF(receipt.transaction);
  if (tx.id('hex') !== receipt.txid) throw new Error('swap_receipt_mismatch');
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${receipt.derivationPrefix} ${receipt.derivationSuffix}`,
    counterparty: receipt.buyerIdentityKey,
    forSelf: true,
  });
  if (
    tx.outputs[0]?.satoshis !== receipt.offer.priceSatoshis ||
    tx.outputs[0].lockingScript.toHex() !==
      new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  )
    throw new Error('swap_proceeds_mismatch');
  await wallet.internalizeAction({
    tx: receipt.transaction,
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: receipt.derivationPrefix,
          derivationSuffix: receipt.derivationSuffix,
          senderIdentityKey: receipt.buyerIdentityKey,
        },
      },
    ],
    description: 'Receive atomic security-credit sale',
  });
}
