import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PrivateKey,
  ProtoWallet,
  Transaction,
  LockingScript,
  UnlockingScript,
  P2PKH,
  type WalletInterface,
} from '@bsv/sdk';
import {
  prepareSwap,
  approveSwap,
  completeSwap,
  reconcileSwap,
  verifySellerSignature,
  type SwapOffer,
  type SwapApproval,
  type SwapJournal,
  type SwapRecord,
  type TokenOverlay,
} from './swap.ts';
import { tokenOwner, transferScript } from './token.ts';
const sellerKey = PrivateKey.fromString('3'.padStart(64, '0'), 'hex');
const buyerKey = PrivateKey.fromString('4'.padStart(64, '0'), 'hex');
const sellerIdentity = sellerKey.toPublicKey().toString();
const buyerIdentity = buyerKey.toPublicKey().toString();
const source = new Transaction(
  1,
  [],
  [
    {
      satoshis: 1,
      lockingScript: transferScript({
        id: 'aa'.repeat(32) + '_0',
        amount: '100',
        ownerPkh: tokenOwner(sellerIdentity, 0),
      }),
    },
  ],
);
const offer: SwapOffer = {
  id: 'sale-one',
  outpoint: source.id('hex') + '.0',
  tokenId: 'aa'.repeat(32) + '_0',
  tokenAmount: '100',
  priceSatoshis: 100,
  sellerIdentityKey: sellerIdentity,
  sellerKeyIndex: 0,
  network: 'testnet',
};
const approval: SwapApproval = { ...offer, buyerIdentityKey: buyerIdentity };
class Journal implements SwapJournal {
  rows = new Map<string, SwapRecord>();
  async reserve(key: string, value: SwapRecord) {
    if (this.rows.has(key)) throw new Error('already_attempted');
    this.rows.set(key, value);
  }
  async update(key: string, value: SwapRecord) {
    this.rows.set(key, value);
  }
  async get(key: string) {
    return this.rows.get(key);
  }
}
function fixture() {
  let signed = 0;
  let admitted = false;
  let prepared: Transaction;
  const seller = new ProtoWallet(sellerKey) as unknown as WalletInterface;
  seller.getNetwork = async () => ({ network: 'testnet' });
  const buyer = new ProtoWallet(buyerKey) as unknown as WalletInterface;
  buyer.getNetwork = async () => ({ network: 'testnet' });
  const funding = new Transaction(
    1,
    [],
    [{ satoshis: 1000, lockingScript: new P2PKH().lock(buyerKey.toPublicKey().toAddress()) }],
  );
  buyer.createAction = async (args) => {
    prepared = new Transaction(
      1,
      [
        {
          sourceTransaction: source,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript(),
        },
        {
          sourceTransaction: funding,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript(),
        },
      ],
      args
        .outputs!.map((output) => ({
          satoshis: output.satoshis,
          lockingScript: LockingScript.fromHex(output.lockingScript!),
        }))
        .concat([
          { satoshis: 890, lockingScript: new P2PKH().lock(buyerKey.toPublicKey().toAddress()) },
        ]),
    );
    return { signableTransaction: { tx: prepared.toAtomicBEEF(), reference: 'dGVzdA==' } };
  };
  buyer.signAction = async (args) => {
    signed++;
    prepared.inputs[0].unlockingScript = UnlockingScript.fromHex(args.spends[0].unlockingScript);
    return { txid: prepared.id('hex'), tx: prepared.toAtomicBEEF() };
  };
  buyer.internalizeAction = async () => ({ accepted: true });
  const overlay: TokenOverlay = {
    lookup: async (outpoint) =>
      outpoint === offer.outpoint
        ? { transaction: source, outputIndex: 0, beef: source.toBEEF(), spent: false }
        : admitted
          ? { transaction: prepared, outputIndex: 1, beef: prepared.toBEEF(), spent: false }
          : null,
    submit: async () => {
      admitted = true;
    },
  };
  return { seller, buyer, overlay, journal: new Journal(), signed: () => signed };
}
test('atomic token-for-BSV trade requires both wallets and validates seller signature against exact outputs', async () => {
  const f = fixture();
  const prepared = await prepareSwap(f.buyer, offer, approval, 0, f.overlay, f.journal);
  assert.equal(f.signed(), 0);
  const signature = await approveSwap(f.seller, prepared, approval, f.overlay);
  assert.equal(verifySellerSignature(prepared, signature), true);
  const receipt = await completeSwap(f.buyer, prepared, signature, approval, f.overlay, f.journal);
  assert.equal(receipt.status, 'overlay_admitted');
  assert.equal(receipt.confirmed, false);
  assert.equal(f.signed(), 1);
  await assert.rejects(completeSwap(f.buyer, prepared, signature, approval, f.overlay, f.journal));
  assert.equal(f.signed(), 1);
});
test('another token, forged overlay and changed payment cannot obtain a seller signature', async () => {
  const f = fixture();
  await assert.rejects(
    prepareSwap(f.buyer, { ...offer, tokenAmount: '101' }, approval, 0, f.overlay, f.journal),
  );
  const p = await prepareSwap(f.buyer, offer, approval, 0, f.overlay, new Journal());
  const tx = Transaction.fromAtomicBEEF(p.transaction);
  tx.outputs[0].satoshis = 1;
  await assert.rejects(
    approveSwap(f.seller, { ...p, transaction: tx.toAtomicBEEF() }, approval, f.overlay),
  );
  await assert.rejects(
    approveSwap(f.seller, p, approval, { ...f.overlay, lookup: async () => null }),
  );
});
test('seller signature cannot authorize changed outputs or a different buyer', async () => {
  const f = fixture();
  const p = await prepareSwap(f.buyer, offer, approval, 0, f.overlay, f.journal);
  const signature = await approveSwap(f.seller, p, approval, f.overlay);
  const tx = Transaction.fromAtomicBEEF(p.transaction);
  tx.outputs[0].satoshis = 99;
  assert.throws(() => verifySellerSignature({ ...p, transaction: tx.toAtomicBEEF() }, signature));
  await assert.rejects(
    completeSwap(
      f.buyer,
      p,
      signature,
      { ...approval, buyerIdentityKey: sellerIdentity },
      f.overlay,
      f.journal,
    ),
  );
  assert.equal(f.signed(), 0);
});
test('overlay recovery retains the same transaction and never signs or pays again', async () => {
  const f = fixture();
  const p = await prepareSwap(f.buyer, offer, approval, 0, f.overlay, f.journal);
  const signature = await approveSwap(f.seller, p, approval, f.overlay);
  const failedOverlay = {
    ...f.overlay,
    submit: async () => {
      throw new Error('offline');
    },
  };
  const pending = await completeSwap(f.buyer, p, signature, approval, failedOverlay, f.journal);
  assert.equal(pending.status, 'overlay_pending');
  assert.equal(f.signed(), 1);
  await assert.rejects(
    reconcileSwap(f.buyer, { ...pending, txid: 'ff'.repeat(32) }, f.overlay, f.journal),
  );
  const recovered = await reconcileSwap(f.buyer, pending, f.overlay, f.journal);
  assert.equal(recovered.status, 'overlay_admitted');
  assert.equal(recovered.txid, pending.txid);
  assert.equal(f.signed(), 1);
});

test('uncertain wallet broadcast cannot trigger an overlay submission or repeated signing', async () => {
  const f = fixture();
  const p = await prepareSwap(f.buyer, offer, approval, 0, f.overlay, f.journal);
  const signature = await approveSwap(f.seller, p, approval, f.overlay);
  const sign = f.buyer.signAction;
  f.buyer.signAction = async (args) => {
    const result = await sign(args);
    return { ...result, sendWithResults: [{ txid: result.txid!, status: 'sending' }] };
  };
  let submitted = false;
  const overlay = {
    ...f.overlay,
    submit: async () => {
      submitted = true;
    },
  };
  await assert.rejects(
    completeSwap(f.buyer, p, signature, approval, overlay, f.journal),
    /broadcast_uncertain/,
  );
  await assert.rejects(completeSwap(f.buyer, p, signature, approval, overlay, f.journal));
  assert.equal(submitted, false);
  assert.equal(f.signed(), 1);
});
