import { KeyDeriver, LockingScript, OP, P2PKH, Script, Utils, type WalletProtocol } from '@bsv/sdk';
export const TOKEN_PROTOCOL: WalletProtocol = [1, 'bsv21 token'];
export function tokenOwner(identity: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('invalid_token_key_index');
  return new KeyDeriver('anyone')
    .derivePublicKey(TOKEN_PROTOCOL, String(index), identity)
    .toHash('hex') as string;
}
export interface Token {
  id: string;
  amount: string;
  ownerPkh: string;
}
export function transferScript(token: Token): LockingScript {
  if (
    !/^[a-f0-9]{64}_\d+$/.test(token.id) ||
    !/^[1-9]\d*$/.test(token.amount) ||
    BigInt(token.amount) > 2n ** 64n - 1n ||
    !/^[a-f0-9]{40}$/.test(token.ownerPkh)
  )
    throw new Error('invalid_token');
  const payload = JSON.stringify({ p: 'bsv-20', op: 'transfer', id: token.id, amt: token.amount });
  const envelope = new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_IF)
    .writeBin(Utils.toArray('ord', 'utf8'))
    .writeOpCode(OP.OP_1)
    .writeBin(Utils.toArray('application/bsv-20', 'utf8'))
    .writeOpCode(OP.OP_0)
    .writeBin(Utils.toArray(payload, 'utf8'))
    .writeOpCode(OP.OP_ENDIF);
  return LockingScript.fromHex(
    envelope.toHex() + new P2PKH().lock(Utils.toArray(token.ownerPkh, 'hex')).toHex(),
  );
}
export function readToken(script: LockingScript, outpoint: string): Token | null {
  try {
    const c = script.chunks;
    if (
      c.length !== 13 ||
      c[0].op !== OP.OP_FALSE ||
      c[1].op !== OP.OP_IF ||
      Utils.toUTF8(c[2].data ?? []) !== 'ord' ||
      c[3].op !== OP.OP_1 ||
      c[3].data ||
      Utils.toUTF8(c[4].data ?? []) !== 'application/bsv-20' ||
      c[5].op !== OP.OP_0 ||
      c[7].op !== OP.OP_ENDIF ||
      c[8].op !== OP.OP_DUP ||
      c[9].op !== OP.OP_HASH160 ||
      c[10].data?.length !== 20 ||
      c[11].op !== OP.OP_EQUALVERIFY ||
      c[12].op !== OP.OP_CHECKSIG
    )
      return null;
    const data = JSON.parse(Utils.toUTF8(c[6].data ?? []));
    if (
      !data ||
      Array.isArray(data) ||
      typeof data !== 'object' ||
      Object.values(data).some((value) => typeof value !== 'string') ||
      data.p !== 'bsv-20' ||
      !['transfer', 'deploy+mint'].includes(data.op) ||
      !/^[1-9]\d*$/.test(data.amt) ||
      BigInt(data.amt) > 2n ** 64n - 1n
    )
      return null;
    if (
      (data.op === 'deploy+mint' && data.id !== undefined) ||
      (data.dec !== undefined && (!/^(0|[1-9]\d*)$/.test(data.dec) || Number(data.dec) > 18))
    )
      return null;
    const id = data.op === 'deploy+mint' ? outpoint.replace('.', '_') : data.id;
    if (!/^[a-f0-9]{64}_\d+$/.test(id)) return null;
    return { id, amount: data.amt, ownerPkh: Utils.toHex(c[10].data!) };
  } catch {
    return null;
  }
}
