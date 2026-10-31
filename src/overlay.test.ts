import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Transaction, Utils } from '@bsv/sdk';
import { HttpTokenOverlay } from './overlay.ts';
import { transferScript } from './token.ts';

test('HTTP overlay validates real BEEF against requested outpoint and metadata before trusting an answer', async () => {
  const token = { id: 'aa'.repeat(32) + '_0', amount: '100', ownerPkh: 'bb'.repeat(20) };
  const tx = new Transaction(1, [], [{ satoshis: 1, lockingScript: transferScript(token) }]);
  let wrong = false;
  let submitted = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/lookup') {
        assert.deepEqual(JSON.parse(body.toString()), {
          service: 'ls_tokenkit',
          query: { op: 'outpoint', txid: tx.id('hex'), vout: 0 },
        });
        res.end(
          JSON.stringify({
            type: 'output-list',
            outputs: [
              {
                beef: tx.toBEEF(),
                outputIndex: 0,
                context: Utils.toArray(
                  JSON.stringify({
                    tokenId: token.id,
                    amt: wrong ? '101' : token.amount,
                    ownerPkh: token.ownerPkh,
                    spent: false,
                  }),
                  'utf8',
                ),
              },
            ],
          }),
        );
      } else if (req.url === '/submit') {
        assert.equal(req.headers['x-topics'], '["tm_tokenkit"]');
        assert.equal(Transaction.fromBEEF(Array.from(body)).id('hex'), tx.id('hex'));
        submitted = true;
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    } catch {
      res.statusCode = 500;
      res.end('{}');
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const overlay = new HttpTokenOverlay(`http://127.0.0.1:${address.port}`);
    assert.equal((await overlay.lookup(tx.id('hex') + '.0'))?.spent, false);
    await overlay.submit(tx.toAtomicBEEF());
    assert.equal(submitted, true);
    wrong = true;
    await assert.rejects(overlay.lookup(tx.id('hex') + '.0'), /context_mismatch/);
    assert.throws(() => new HttpTokenOverlay('http://example.com'));
    assert.throws(() => new HttpTokenOverlay('https://user:secret@example.com'));
  } finally {
    server.close();
    await once(server, 'close');
  }
});
