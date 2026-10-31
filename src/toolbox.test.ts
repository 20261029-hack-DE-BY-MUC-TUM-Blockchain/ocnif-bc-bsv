import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, OP, Script, Utils, P2PKH, type WalletInterface } from '@bsv/sdk';
import { createMockChain } from './test-helpers/mockchain.ts';
import {
  prepareSwap,
  approveSwap,
  completeSwap,
  receiveSwapProceeds,
  type TokenOverlay,
  type SwapRecord,
  type SwapJournal,
  type SwapOffer,
} from './swap.ts';
import { TOKEN_PROTOCOL, tokenOwner } from './token.ts';

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

test('real Wallet Toolbox wallets execute one atomic token-for-BSV swap on the local mock chain', async () => {
  const chain = await createMockChain();
  try {
    const seller = await chain.makeWallet();
    const buyer = await chain.makeWallet();
    await chain.fund(seller);
    await chain.fund(buyer);
    const sellerId = (await seller.getPublicKey({ identityKey: true })).publicKey;
    const buyerId = (await buyer.getPublicKey({ identityKey: true })).publicKey;
    const body = JSON.stringify({
      p: 'bsv-20',
      op: 'deploy+mint',
      amt: '100',
      sym: 'OCNIF',
      dec: '0',
    });
    const inscription = new Script()
      .writeOpCode(OP.OP_FALSE)
      .writeOpCode(OP.OP_IF)
      .writeBin(Utils.toArray('ord', 'utf8'))
      .writeOpCode(OP.OP_1)
      .writeBin(Utils.toArray('application/bsv-20', 'utf8'))
      .writeOpCode(OP.OP_0)
      .writeBin(Utils.toArray(body, 'utf8'))
      .writeOpCode(OP.OP_ENDIF);
    const lockingScript =
      inscription.toHex() + new P2PKH().lock(Utils.toArray(tokenOwner(sellerId, 0), 'hex')).toHex();
    const deployed = await seller.createAction({
      description: 'Create mock security-credit token',
      outputs: [
        {
          satoshis: 1,
          lockingScript,
          outputDescription: 'Security credits',
          basket: 'bsv21',
          customInstructions: JSON.stringify({
            protocolID: TOKEN_PROTOCOL,
            keyID: '0',
            counterparty: 'anyone',
            index: 0,
          }),
        },
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });
    assert.ok(deployed.tx && deployed.txid);
    const source = Transaction.fromAtomicBEEF(deployed.tx);
    let swap: Transaction | undefined;
    const offer: SwapOffer = {
      id: 'mock-sale',
      outpoint: deployed.txid + '.0',
      tokenId: deployed.txid + '_0',
      tokenAmount: '100',
      priceSatoshis: 100,
      sellerIdentityKey: sellerId,
      sellerKeyIndex: 0,
      network: 'testnet',
    };
    const overlay: TokenOverlay = {
      lookup: async (outpoint) =>
        outpoint === offer.outpoint
          ? { transaction: source, outputIndex: 0, beef: source.toBEEF(), spent: Boolean(swap) }
          : swap && outpoint === swap.id('hex') + '.1'
            ? { transaction: swap, outputIndex: 1, beef: swap.toBEEF(), spent: false }
            : null,
      submit: async (bytes) => {
        const tx = Transaction.fromAtomicBEEF(bytes);
        assert.equal(await tx.verify(chain.chainTracker), true);
        swap = tx;
      },
    };
    const approval = { ...offer, buyerIdentityKey: buyerId };
    const journal = new Journal();
    const p = await prepareSwap(
      buyer as unknown as WalletInterface,
      offer,
      approval,
      0,
      overlay,
      journal,
    );
    const signature = await approveSwap(seller as unknown as WalletInterface, p, approval, overlay);
    const receipt = await completeSwap(
      buyer as unknown as WalletInterface,
      p,
      signature,
      approval,
      overlay,
      journal,
    );
    assert.equal(receipt.status, 'overlay_admitted');
    assert.equal(receipt.confirmed, false);
    await receiveSwapProceeds(seller as unknown as WalletInterface, receipt);
    assert.equal((await buyer.listOutputs({ basket: 'bsv21' })).outputs.length, 1);
    assert.equal(
      await Transaction.fromAtomicBEEF(receipt.transaction).verify(chain.chainTracker),
      true,
    );
  } finally {
    await chain.close();
  }
});
