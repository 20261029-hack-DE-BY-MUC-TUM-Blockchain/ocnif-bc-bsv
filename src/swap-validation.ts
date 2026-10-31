import { Spend, Transaction, TransactionSignature, UnlockingScript } from '@bsv/sdk';
import { readToken, tokenOwner, transferScript } from './token.ts';
import type { SwapOffer, SwapApproval, PreparedSwap, TokenOverlay } from './swap-types.ts';

export const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;
export const keyFor = (buyer: string, offer: SwapOffer) => `swap:${buyer}:${offer.outpoint}`;
export function validateApproval(offer: SwapOffer, buyer: string, approval: SwapApproval) {
  for (const field of [
    'id',
    'outpoint',
    'tokenId',
    'tokenAmount',
    'priceSatoshis',
    'sellerIdentityKey',
    'sellerKeyIndex',
    'network',
  ] as const)
    if (offer[field] !== approval[field]) throw new Error('swap_approval_mismatch');
  if (buyer !== approval.buyerIdentityKey || buyer === offer.sellerIdentityKey)
    throw new Error('swap_counterparty_mismatch');
  if (
    !/^[a-f0-9]{64}\.\d+$/.test(offer.outpoint) ||
    !Number.isSafeInteger(offer.priceSatoshis) ||
    offer.priceSatoshis < 1 ||
    !['testnet', 'mainnet'].includes(offer.network)
  )
    throw new Error('invalid_swap_offer');
  tokenOwner(offer.sellerIdentityKey, offer.sellerKeyIndex);
}
export async function approvedSource(offer: SwapOffer, overlay: TokenOverlay) {
  const source = await overlay.lookup(offer.outpoint);
  if (!source || source.spent) throw new Error('token_not_overlay_validated');
  if (`${source.transaction.id('hex')}.${source.outputIndex}` !== offer.outpoint)
    throw new Error('overlay_outpoint_mismatch');
  const output = source.transaction.outputs[source.outputIndex];
  const token = output && readToken(output.lockingScript, offer.outpoint);
  if (
    !token ||
    output.satoshis !== 1 ||
    token.id !== offer.tokenId ||
    token.amount !== offer.tokenAmount ||
    token.ownerPkh !== tokenOwner(offer.sellerIdentityKey, offer.sellerKeyIndex)
  )
    throw new Error('overlay_token_mismatch');
  return source;
}
export function validatePrepared(p: PreparedSwap): Transaction {
  const tx = Transaction.fromAtomicBEEF(p.transaction);
  const first = tx.inputs[0];
  if (
    !first ||
    `${first.sourceTXID ?? first.sourceTransaction?.id('hex')}.${first.sourceOutputIndex}` !==
      p.offer.outpoint
  )
    throw new Error('swap_input_mismatch');
  if (
    tx.inputs.length < 2 ||
    new Set(
      tx.inputs.map(
        (i) => `${i.sourceTXID ?? i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`,
      ),
    ).size !== tx.inputs.length
  )
    throw new Error('swap_funding_invalid');
  const tokenScript = transferScript({
    id: p.offer.tokenId,
    amount: p.offer.tokenAmount,
    ownerPkh: tokenOwner(p.buyerIdentityKey, p.buyerKeyIndex),
  }).toHex();
  if (
    tx.outputs[0]?.satoshis !== p.offer.priceSatoshis ||
    tx.outputs[0].lockingScript.toHex() !== p.paymentScript ||
    tx.outputs[1]?.satoshis !== 1 ||
    tx.outputs[1].lockingScript.toHex() !== tokenScript
  )
    throw new Error('swap_output_mismatch');
  if (
    tx.outputs
      .slice(2)
      .some((out, index) => readToken(out.lockingScript, `${tx.id('hex')}.${index + 2}`))
  )
    throw new Error('unexpected_token_output');
  if (
    tx.inputs.slice(1).some((input) => {
      const output = input.sourceTransaction?.outputs[input.sourceOutputIndex];
      return (
        !output ||
        readToken(
          output.lockingScript,
          `${input.sourceTransaction!.id('hex')}.${input.sourceOutputIndex}`,
        ) !== null
      );
    })
  )
    throw new Error('unexpected_token_input');
  return tx;
}
export function spendContext(tx: Transaction) {
  const input = tx.inputs[0];
  const source = input.sourceTransaction?.outputs[input.sourceOutputIndex];
  if (!source || source.satoshis !== 1) throw new Error('missing_token_source');
  return {
    sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.slice(1),
    inputIndex: 0,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope: SCOPE,
  };
}
export function verifySellerSignature(p: PreparedSwap, signature: string): true {
  const tx = validatePrepared(p);
  const context = spendContext(tx);
  const unlockingScript = UnlockingScript.fromHex(signature);
  const sig = unlockingScript.chunks[0]?.data;
  if (!sig || sig.at(-1) !== SCOPE || unlockingScript.chunks.length !== 2)
    throw new Error('swap_signature_scope_invalid');
  const spend = new Spend({ ...context, lockingScript: context.subscript, unlockingScript });
  if (!spend.validate()) throw new Error('swap_signature_invalid');
  return true;
}
export function blueprint(tx: Transaction) {
  return JSON.stringify([
    tx.version,
    tx.lockTime,
    tx.inputs.map((i) => [
      i.sourceTXID ?? i.sourceTransaction?.id('hex'),
      i.sourceOutputIndex,
      i.sequence ?? 0xffffffff,
    ]),
    tx.outputs.map((o) => [o.satoshis, o.lockingScript.toHex()]),
  ]);
}
