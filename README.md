# Ocnif BSV wallet payments and atomic security-credit exchange

## Setup / Instalación

This browser library connects Ocnif to a standard BRC-100 wallet through `@bsv/sdk`3.2.1. User keys and signing remain inside BSV Desktop or BSV Browser. BSV Desktop uses the Wallet Toolbox engine; this library does not create a custodial server wallet.

Esta biblioteca conecta Ocnif a una billetera BRC-100 estándar. Las claves y firmas permanecen en BSV Desktop o BSV Browser. No crea una billetera de usuario bajo custodia del servidor.

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm test
npm run typecheck
```

Install this repository by immutable Git commit in the consuming web application. Its package export is TypeScript; configure the browser bundler to transpile `ocnif-bc-bsv`. There are no private environment variables and no deployed server in this package.

## Browser integration / Integración

Call `connectWallet()` from a user action. It returns `{wallet,network,identityKey}` after the wallet approves its connection. Read the actual network; the sponsor's standard setup uses sponsor-funded mainnet satoshis, although the track also accepts testnet.

`payForReport(wallet,quote,approval,journal)` takes a published report's SHA256 digest and a separately approved payment intent:

- `quote`: `{id,recipientIdentityKey,satoshis,network,expiresAt,reportDigest}`. `expiresAt` is Unix milliseconds.
- `approval`: `{id,recipientIdentityKey,maxSatoshis,network,reportDigest}`. Obtain this from the user's review of the intended payment; never manufacture it from untrusted model output.
- `journal`: one `IndexedDBPaymentJournal` for the browser origin. It atomically reserves each wallet/intent pair across browser tabs before requesting an action.

The adapter derives the recipient's BRC-29 output, asks the wallet to sign/broadcast with immediate broadcast mode, and verifies the returned AtomicBEEF transaction ID, intended amount and report-digest commitment. The result includes the exact output index, sender identity and BRC-29 remittance data. The approved amount covers the recipient payment; the wallet displays and controls network fees separately.

Payment outputs and the approved public digest are on-chain data. Supply only an explicitly published report digest. This function makes a payment associated with a report; it does not itself grant access to the separate Cardano paid-report endpoint, create escrow, refund funds or implement a token swap.

La intención vincula destinatario, informe, importe, red y caducidad. El usuario debe revisarla por separado. El pago y la comisión se aprueban en la billetera. La función asocia un pago a un informe público; no desbloquea la ruta Cardano, no crea escrow y no implementa un intercambio de tokens.

## Receipts and recovery / Recibos y recuperación

The return status is `wallet_broadcast` with `confirmed:false`. This is wallet-provided transaction evidence, not independent block inclusion or recipient acceptance. Retain the AtomicBEEF and remittance data for recipient SPV verification/internalization and check the transaction on the correct-network explorer. Never label a test transaction as a real payment.

A repeated intent is blocked. Any error after reservation records `review_required`; cancellation, an interrupted wallet call and an ambiguous broadcast require reviewing the existing wallet action before a new intent is approved. The library never automatically retries a payment. Clearing site storage removes the local journal, so the wallet's action history and an application-side durable receipt remain necessary for long-term reconciliation.

## Atomic exchange / Intercambio atómico

The exchange sells an entire BSV-21 token UTXO for an exact BSV price in one transaction. A token can represent a transferable security-analysis credit, but its issuer must separately publish the actual redemption terms. The library does not promise a redemption service or token value. It accepts an existing genuine token indexed by the sponsor's BSV-21 Token Kit overlay (`tm_tokenkit`, `ls_tokenkit`). A wallet basket entry alone cannot establish token validity.

1. Configure `new HttpTokenOverlay(explicitUrl)` with an operator you trust to validate BSV-21 ancestry. HTTPS is required except localhost development. This discloses the queried outpoint and transaction to that operator. It uses the starter kit's standard `/lookup` and `/submit` routes. Token ancestors must already be indexed in order; this client never guesses an overlay or fabricates a deployment.
2. Obtain an actual token outpoint and the seller's public identity/key index from the overlay. Create an offer with `{id,outpoint,tokenId,tokenAmount,priceSatoshis,sellerIdentityKey,sellerKeyIndex,network}`. Outpoints use `txid.vout`; token IDs use `deployTxid_vout`. Token amounts are positive uint64 integer strings. The exchange transfers the whole amount of this one UTXO.
3. The buyer reviews that exact offer and their public identity, producing `approval = {...offer,buyerIdentityKey}` from the UI. Call `prepareSwap(buyerWallet,offer,approval,buyerKeyIndex,overlay,journal)` using an `IndexedDBSwapJournal`. The wallet reserves its funding; nothing is broadcast. The result is a `PreparedSwap` containing the partial AtomicBEEF, wallet reference and public remittance information. Exchange this artifact through an authenticated channel; it reveals transaction ancestry and identities.
4. The seller independently reviews the offer, buyer identity, price and token amount. Call `approveSwap(sellerWallet,prepared,approval,overlay)`. The wallet signs the token input with `SIGHASH_ALL | FORKID`, committing to every input and output. Seller keys stay in the standard wallet. Changing the price, buyer token output or inputs invalidates the signature.
5. Return the unlocking-script hex to the buyer. Call `completeSwap(buyerWallet,prepared,signature,approval,overlay,journal)`. The buyer wallet adds its funding signatures and broadcasts one transaction: output 0 pays the seller with BRC-29, output 1 transfers all token units to the buyer, and remaining outputs are ordinary wallet change. Network fees are additional and controlled by the buyer wallet.
6. Retain the receipt. `overlay_admitted` means the configured overlay admitted the token output and the buyer wallet internalized it. `confirmed:false` remains explicit; this is not proof of block inclusion. The seller calls `receiveSwapProceeds(sellerWallet,receipt)` to validate the BRC-29 payment and let its wallet SPV-check/internalize the proceeds.

If broadcast succeeds but the overlay or wallet synchronization fails, the receipt is `overlay_pending`. Call `reconcileSwap(buyerWallet,receipt,overlay,journal)` with the recorded receipt to resubmit that same transaction and synchronize the token. This path never creates or signs another payment. A duplicate completion is blocked. An uncertain wallet result becomes `review_required` and needs wallet-history reconciliation. Clearing browser storage removes this local protection; retain receipts separately. Offers have no enforced expiry, escrow, refund or cancellation mechanism; do not describe them as expiring orders.

El intercambio transfiere un UTXO BSV-21 completo a cambio del precio exacto en BSV, dentro de una sola transacción. Comprador y vendedor revisan la misma oferta por separado y firman con sus billeteras estándar. El overlay configurado valida el historial del token; una entrada en la cesta local no basta. Si el pago se emite pero el overlay falla, `reconcileSwap` vuelve a enviar la misma transacción, sin pagar otra vez. No hay garantía de canje, reembolso ni caducidad de la oferta.

## Validation and current limit / Validación y límite actual

Eleven tests cover payment approvals, IndexedDB atomicity, real HTTP/BEEF overlay parsing, exact-output seller signatures, tamper rejection, duplicate completion, ambiguous broadcast and recovery without a second payment. The two-wallet integration test uses actual Wallet Toolbox wallets, SQLite state, a locally mined mock chain, complete transaction SPV verification and seller BRC-29 internalization. Its token admission boundary is a test fixture; the test does not establish a production overlay's token-conservation rules. The fixture derives from the user-supplied BSV TBC26 Token Kit mock-chain harness, with attribution in the source.

No real wallet payment, real token deployment, publicly hosted overlay or explorer-confirmed swap has been recorded. The atomic exchange is implemented and tested locally; sponsor qualification still requires a meaningful deployed product flow and real agent payment evidence on the permitted network. There is no server with user wallet keys in this package.

For isolated verification, the Dockerfile and local-only Compose manifest run the tests as a short-lived task. They are not a long-running production service. The pre-commit hook runs Gitleaks against staged files.
