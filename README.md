# Ocnif BSV wallet payments

## Setup / Instalación

This browser library connects Ocnif to a standard BRC-100 wallet through `@bsv/sdk`3.2.1. User keys and signing remain inside BSV Desktop or BSV Browser. BSV Desktop uses the Wallet Toolbox engine; this library does not create a custodial server wallet.

Esta biblioteca conecta Ocnif a una billetera BRC-100 estándar. Las claves y firmas permanecen en BSV Desktop o BSV Browser. No crea una billetera de usuario bajo custodia del servidor.

```sh
npm ci --ignore-scripts
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

## Validation and current limit / Validación y límite actual

Four tests cover approval tampering, SDK transaction output checks, uncertain result handling and IndexedDB atomicity across connections/reopen. Test wallets use synthetic local transactions and do not call a chain. Type checking and the production dependency audit pass.

A meaningful DeFi product and a real agent payment are still needed for the BSV sponsor track; this wallet payment boundary alone is not a qualifying DeFi implementation. No real wallet transaction or recipient acceptance has been recorded.

For isolated verification, the Dockerfile and local-only Compose manifest run the tests as a short-lived task. They are not a long-running production service. The pre-commit hook runs Gitleaks against staged files.
