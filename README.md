# Ocnif BSV report payments and transferable access passes

This repository contains a browser wallet library and a standalone BSV-21 overlay/report service. A user can buy an explicitly published security report with BSV, or obtain it while holding an issuer-registered BSV-21 access pass. A pass can be sold for an exact BSV price in one atomic transaction, signed independently by the seller and buyer. User keys stay in their standard BRC-100 wallets.

La biblioteca y el servicio permiten pagar un informe publicado con BSV o acceder con un pase BSV-21 transferible. Comprador y vendedor autorizan por separado el intercambio atómico. Las claves de los usuarios permanecen en sus billeteras BRC-100.

## Standalone setup

Pinned dependencies: SDK 3.2.1, Wallet Toolbox 2.14.9, Overlay 2.6.4, OverlayExpress 2.7.4 and official BRC-121 package `@bsv/402-pay` 0.3.3. The token topic, lookup service and mock-chain harness adapt the user-supplied BSV TBC26 Developer Pack; source attribution is retained.

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run typecheck
npm test
npm run test:server
npm run build
# Populate an ignored, mode-0600 .env from .env.example first.
node --env-file=.env dist/server/main.js
```

The service listens on `OVERLAY_PORT` (8097 by default). All service configuration is in `server/config.ts` and documented in `.env.example`. Give it a writable data directory. The three SQLite databases use DELETE journaling and a busy timeout; run a single service replica against these files. PostgreSQL/shared multi-replica storage is not implemented.

`OVERLAY_PRIVATE_KEY` is a distinct operational overlay identity. `INTERNAL_TOKEN` authorizes reads of the backend's `/internal/reports/:id` endpoint and overlay administrative operations. A separate `BSV_ARC_CALLBACK_TOKEN` authenticates transaction-status callbacks and may be shared only with the configured broadcaster; it must differ from `INTERNAL_TOKEN`. Provider model keys are never needed here. Only reports returned with `source:'user-approved'` and a publication timestamp can be quoted, minted or delivered. Viewing a private conversation is not publication.

`BSV_ISSUER_IDENTITY_KEY` is the public identity of the user's standard wallet. Pass setup requires no user private key. Optional `BSV_MERCHANT_PRIVATE_KEY` controls a separate service earnings wallet for direct BRC-121 sales; never copy a user's wallet key into it. When absent, direct sales return HTTP 503 `setup_required`. When the issuer is absent, pass registration also reports `setup_required`. Back up operator-controlled earnings keys and persistent wallet state before accepting real payments.

The configured Arcade and Chaintracks endpoints must match the selected `BSV_NETWORK`. The documented public endpoints are sponsor mainnet infrastructure; testnet requires explicit matching endpoints. The service validates transaction SPV and token ancestry. It does not run its own Bitcoin node or independently guarantee miner inclusion.

## Browser payment contract

Install the library from an immutable Git commit. Its TypeScript export must be transpiled by the browser bundler. Server modules are not exported. Connect with `connectWallet()` from a user action; inspect the actual returned network and identity.

| Request | Result |
|---|---|
| `GET /v1/config` | Actual configured network, public overlay/merchant/issuer identities, payment/pass readiness |
| `GET /v1/reports/:id/quote` | `ReportQuote`: id, reportId, title, recipientIdentityKey, satoshis, network, expiresAt, reportDigest |
| `GET /v1/quotes/:id/pay` | Standard BRC-121 402 challenge, or delivery with the five payment headers |
| `POST /v1/quotes/:id/pay` | Same verification with JSON `{payment:{x-bsv-beef,x-bsv-sender,x-bsv-nonce,x-bsv-time,x-bsv-vout}}` |

The JSON transport avoids large BEEF proofs exceeding reverse-proxy header limits. The payment protocol and wallet verification remain BRC-121. CORS is restricted to configured browser origins; server clients without an Origin header may use the public paid API.

Show the quote and separately obtain `{id,recipientIdentityKey,maxSatoshis,network,reportDigest}` as `PaymentApproval`. Call `purchasePublishedReport(wallet,baseUrl,quote,approval,new IndexedDBPurchaseJournal())`. It reserves the intent across tabs, constructs one BRC-121 payment, adds an on-chain report-digest commitment, verifies the actual wallet outputs, saves the proof, and submits it once. The server requires the matching published digest, internalizes the BRC-29 output into its merchant wallet, and atomically claims the transaction ID in SQLite before returning the report.

The result includes `{report,payment:{accepted:true,txid,satoshisPaid,senderIdentityKey},confirmed:false}`. Acceptance is actual merchant-wallet SPV/internalization evidence; it is not block confirmation. Network fees are additional and reviewed in the standard wallet. Errors retain `review_required`; inspect the existing wallet action and recorded proof before approving a different intent. The client never automatically pays again. Replaying a transaction is rejected. The older `payForReport` primitive only broadcasts a report-associated payment; use `purchasePublishedReport` for delivery through this service.

## Mint, list and trade a report pass

1. Fetch `GET /v1/reports/:id/pass-intent`. It returns `{id,reportId,reportDigest,issuerIdentityKey,network,keyIndex}`. The user separately approves that exact intent. Call `mintReportPass(wallet,intent,approval,overlay,new IndexedDBMintJournal())`. The wallet creates a fixed supply of one token with a published-report commitment. Minting spends fees and one token satoshi; it is never automatic.
2. After `overlay_admitted`, call `signPassRegistration(wallet,receipt)` and POST its `{registration,signature}` to `/v1/passes`. The server verifies the configured issuer's signature, real token admission, one-token amount, ownership and report commitment. A self-minted unregistered token grants no access.
3. Form a `SwapOffer`: `{id,outpoint,tokenId,tokenAmount:'1',priceSatoshis,sellerIdentityKey,sellerKeyIndex,network}`. Outpoints use `txid.vout`; token IDs use `deployTxid_vout`. Call `signReportOffer(wallet,{reportId,reportDigest,offer})` and POST its `{listing,signature}` to `/v1/offers`. Listing requires the current holder's signature. `GET /v1/reports/:id/offers` returns at most ten listings whose token ownership the overlay still validates.
4. The buyer reviews the offer and creates `approval={...offer,buyerIdentityKey}`. `prepareSwap(buyerWallet,offer,approval,buyerKeyIndex,overlay,new IndexedDBSwapJournal())` reserves funding without broadcasting. Pass its `PreparedSwap` artifact to the seller through a trusted channel; it contains public identities, transaction ancestry and remittance data.
5. The seller independently reviews the price, buyer and token. `approveSwap(sellerWallet,prepared,approval,overlay)` returns the token-input signature using `SIGHASH_ALL|FORKID`, committing to every input and output. Return that signature to the buyer.
6. `completeSwap(buyerWallet,prepared,signature,approval,overlay,journal)` signs the funding and broadcasts one transaction. Output 0 pays the seller, output 1 transfers the token, and remaining outputs are wallet change. `receiveSwapProceeds(sellerWallet,receipt)` lets the seller SPV-verify/internalize its BRC-29 payment.

`new HttpTokenOverlay(explicitUrl)` uses standard `/submit` with `X-Topics:["tm_tokenkit"]` and `/lookup` with service `ls_tokenkit`. It checks both transaction/metadata consistency and actual topic admission; HTTP 200 alone is insufficient. Missing ancestors must be submitted in order. If synchronization fails after broadcast, `reconcileMint` or `reconcileSwap` resubmits the recorded transaction without signing or paying again.

Offers have no enforced expiry, escrow, refund or server cancellation. Both wallet approvals remain necessary after listing. There is no automated counterparty or agent-controlled spending authority.

## Use the transferred pass

POST `/v1/reports/:id/token-challenge` with `{outpoint,holderIdentityKey,keyIndex}`. The service requires an unspent admitted output of a registered token and returns `{id,reportId,reportDigest,outpoint,holderIdentityKey,keyIndex,expiresAt}`. Call `signReportAccess(wallet,challenge)` and POST its `{challengeId,signature}` to `/v1/reports/:id/token-access`.

The service verifies the current holder's BRC-100 signature, checks overlay ownership again, atomically consumes the challenge and delivers the published report. A transferred/spent output and replayed challenge are rejected. Access lasts while the holder controls the admitted pass; it is transferable access to this report, not a promise of token value or unrestricted future agent services. Ownership is the configured overlay's current view; unmined transactions remain explicitly unconfirmed.

## Validation and evidence limits

Eleven focused library tests cover approval binding, durable browser intent reservation, real BEEF parsing, exact-output signatures, tampering, ambiguous broadcast and recovery without a second payment. Two additional HTTP integration tests check unfunded production startup and the full payment/pass journey. The journey uses actual OverlayExpress, SQLite, three real Wallet Toolbox wallets and a locally mined mock chain. It checks real BRC-121 delivery, unpublished-report denial, origin/unknown-field rejection, replay denial, issuer signature verification, mint ancestry, supply forgery rejection, signed offer listing, two-wallet atomic exchange, seller internalization and pass access before/after transfer.

All validation transactions use the local mock chain. No mainnet payment, mainnet mint, public-chain-confirmed swap, user microphone action or sponsor acceptance is claimed. Production wallet configuration, a hosted overlay and independently approved real counterparties are still needed for that evidence.

El pase se canjea por acceso al informe mientras el usuario conserve el UTXO admitido. Tras el intercambio, el antiguo titular pierde acceso y el nuevo titular firma su propio desafío. Las pruebas usan una cadena local; no demuestran pagos ni confirmaciones en mainnet. La billetera muestra y autoriza cada gasto real.

## Local container verification

The standalone Dockerfile runs type checks, all library/HTTP integration tests and the dependency high/critical audit during its build. Its final Node 26 Alpine stage contains compiled service code, production dependencies and native SQLite, runs as UID 1000, and excludes test fixtures, package managers and build-only TypeScript peers. Local Compose is for development only; production uses Azure Container Apps IaC.

```sh
# .env must already exist with operator-owned configuration.
docker compose build
docker compose up -d
docker compose ps
```

On this macOS host, Apple Container can build the same standalone Dockerfile: `container build --platform linux/amd64 --cpus 4 --memory 6G -t ocnif-bc-bsv:local .`. Run Gitleaks on staged changes and in an isolated source-scan container, then scan the actual final image before deployment. Do not confuse a clean production-image scan with dependency-source vulnerability counts.
