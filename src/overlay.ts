import { Transaction, Utils } from '@bsv/sdk';
import type { OverlayToken, TokenOverlay } from './swap.ts';
import { readToken } from './token.ts';

const MAX_RESPONSE = 5_000_000;
async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('token_overlay_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_RESPONSE) throw new Error('token_overlay_response_too_large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function byteArray(value: unknown, max: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

/** The configured BSV-21 kit overlay supplies token validity; wallet SPV checks Bitcoin spends. */
export class HttpTokenOverlay implements TokenOverlay {
  readonly url: string;
  constructor(url: string) {
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
    )
      throw new Error('invalid_token_overlay_url');
    this.url = parsed.href.replace(/\/$/, '');
  }
  async lookup(outpoint: string): Promise<OverlayToken | null> {
    const parts = /^([a-f0-9]{64})\.(\d+)$/.exec(outpoint);
    if (!parts || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) > 0xffffffff)
      throw new Error('invalid_token_outpoint');
    const response = await fetch(`${this.url}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: 'ls_tokenkit',
        query: { op: 'outpoint', txid: parts[1], vout: Number(parts[2]) },
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const answer = (await responseJson(response)) as { type?: unknown; outputs?: unknown };
    if (
      !answer ||
      answer.type !== 'output-list' ||
      !Array.isArray(answer.outputs) ||
      answer.outputs.length > 1
    )
      throw new Error('invalid_token_overlay_answer');
    if (answer.outputs.length === 0) return null;
    const output = answer.outputs[0] as {
      beef?: unknown;
      outputIndex?: unknown;
      context?: unknown;
    };
    if (
      !byteArray(output.beef, 1_000_000) ||
      !byteArray(output.context, 8192) ||
      output.outputIndex !== Number(parts[2])
    )
      throw new Error('invalid_token_overlay_output');
    const transaction = Transaction.fromBEEF(output.beef);
    if (transaction.id('hex') !== parts[1]) throw new Error('token_overlay_transaction_mismatch');
    const tokenOutput = transaction.outputs[Number(parts[2])];
    const token = tokenOutput && readToken(tokenOutput.lockingScript, outpoint);
    const context = JSON.parse(Utils.toUTF8(output.context));
    if (
      !token ||
      tokenOutput.satoshis !== 1 ||
      !context ||
      typeof context.spent !== 'boolean' ||
      context.tokenId !== token.id ||
      context.amt !== token.amount ||
      context.ownerPkh !== token.ownerPkh
    )
      throw new Error('token_overlay_context_mismatch');
    return { transaction, outputIndex: Number(parts[2]), beef: output.beef, spent: context.spent };
  }
  async submit(transaction: number[]): Promise<void> {
    const tx = Transaction.fromAtomicBEEF(transaction);
    const response = await fetch(`${this.url}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Topics': JSON.stringify(['tm_tokenkit']),
      },
      body: new Uint8Array(tx.toBEEF()),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    await responseJson(response);
  }
}
