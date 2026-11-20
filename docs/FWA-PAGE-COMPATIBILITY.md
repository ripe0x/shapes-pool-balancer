# FWA pool-page compatibility

**Result: server-side ERC-1271 acceptance remains unverified.** Public client code confirms the publication format, but does not establish how the server validates a contract owner's signature. This is an external application compatibility check, not a security audit or launch approval.

Checked **2026-11-17** against repository revision `9b45f915fcaa27bc24d6125cf4a0062117ef576c`. Public retrievals used HTTPS GET only. No profile was published, no authentication or contact with FWA occurred, and no blockchain call or transaction was made.

## Confirmed evidence

| Source | Confirmed fact |
| --- | --- |
| [FWA manage page](https://pools.fwa.fun/manage) and its [publication client bundle](https://pools.fwa.fun/_next/static/chunks/0ti5-s6bqy95y.js?dpl=dpl_XhkM1HhwvsHEs1DeYcDTdPhhJypa) | `usePoolProfilePublish` obtains a wallet message signature and submits `{pool, issuedAt, metadata, signature}` to `/api/fwa/profile` with POST. Its message contains the publication title, site, chain 1, factory addresses, lower-case pool address, ISO timestamp and `keccak256(JSON.stringify(parsedMetadata))`. The bundled signature schema accepts hex strings up to 32,768 characters; that is a client constraint, not proof of server acceptance. |
| [FWA deployment client bundle](https://pools.fwa.fun/_next/static/chunks/0j3lh0l-wcej5.js?dpl=dpl_XhkM1HhwvsHEs1DeYcDTdPhhJypa) | Its PoolFactory value is `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`, matching this repository's FWA factory. |
| [Profile endpoint](https://pools.fwa.fun/api/fwa/profile), GET | HTTP **405**, empty body, `x-matched-path: /api/fwa/profile`. This reveals no signature-validation implementation or policy. |
| [FWA documentation](https://pools.fwa.fun/docs), home and manage pages, their 36 directly referenced JavaScript bundles | No server publication-handler source or ERC-1271 support statement was identified. Generic client-library ERC-1271 verifier code is present, but no evidence connects it to the server's profile handler. Public search for `"pools.fwa.fun" "profile"` on GitHub and ERC-1271 references on the site returned no results; this does not prove no public source exists. |

Publication client bundle SHA-256: `3b7025e6a99f6ef05f0a546318fc01ae5b2a97fa1655332f8eca1d2437dedc8d`. No downloaded bundle supplied a `sourceMappingURL`; GET of the publication bundle's `.js.map` URL returned HTTP 403 with `x-matched-path: /_next/static/not-found.txt`, not source.

Repository flow reviewed: `app/src/App.tsx:1562-1576` hashes the metadata, waits for `approvePoolPage`, then on mainnet submits a 66-zero-byte placeholder signature to FWA. `src/PoolPage.sol` constructs the corresponding message digest. `src/PoolBalancer.sol:522-540` approves that digest and returns ERC-1271 magic for a current approval. These facts and existing fork signature checks establish the contract side only. The FWA client also contains special editor/legacy-pool handling; this check does not claim compatibility for those paths.

## Recheck 2026-11-20 (shapes-only release candidate)

Read-only recheck of the same live deployment (`dpl_XhkM1Hhw…`): the client still builds the same EIP-191 message (title, `Site: pools.fwa.fun`, `Chain: 1`, `Factories: <PoolFactory>, <FWAFactory V1>` lower-case, lower-case pool, ISO `issuedAt`, metadata hash) and POSTs `{pool, issuedAt, metadata, signature}` to `/api/fwa/profile`; GET still returns 405 and no server source is public. `src/PoolPage.sol` reproduces the message byte for byte, so the result is unchanged: **contract-owner (ERC-1271) acceptance is unverified.** The dashboard says so before the creator approves.

One app-side mismatch was found and fixed: FWA hashes its schema-parsed metadata, which trims `name`, `description`, `websiteUrl`, `xUrl` and `discordUrl`, while the dashboard hashed the raw input. Any surrounding whitespace made the approved digest differ from the server's, which would fail even for an ordinary wallet owner. The dashboard now trims those fields before hashing and validates the trimmed name length.

Pool creation and FWA purchases do not depend on the page: a pool without a published page still works on FWA.

## Exact blocker and smallest remaining action

The inspected public artifacts do not disclose whether the deployed POST handler calls ERC-1271 on the pool owner, accepts this placeholder, imposes additional signature constraints, or permits the dashboard's cross-origin request. Server freshness policy also remains unknown. HTTP GET cannot exercise the publication authorization path.

**Smallest next action:** obtain separately authorized, current FWA server implementation or an explicit FWA answer about this exact contract-owner flow. No contact is authorized by this investigation. If that evidence is unavailable, end-to-end confirmation requires an owner-authorized real publication: approve the exact metadata/timestamp on a mainnet Balancer, submit through the dashboard, and read back the saved page. That requires a mainnet transaction and an external write, neither authorized here. A successful publication would establish acceptance for that request and server version only. No further on-chain signature test can settle this server question.

## Things that don't make sense

None identified. A permissive client signature schema does not establish server support; that remains an explicit compatibility gap.
