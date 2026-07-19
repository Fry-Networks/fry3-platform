# Fry 3.0 Migration — Source-to-Target Map (MongoDB/MariaDB → PostgreSQL)

Source: ARES00 MongoDB (10 Fry DBs) + HEPH00 MariaDB (timeclock).
Target: canonical PostgreSQL (Prisma schema, 21 models).
All migrations idempotent via `MigrationProvenance` (unique sourceDb+sourceCollection+sourceId).

## Identity / Users / Wallets
| Source (Mongo) | Target (PG) | Notes |
|---|---|---|
| main.registration-users (3816) | User | primaryEmail ← email; status ACTIVE |
| main.webusers (9) | User | merge by email; dedupe rule R1 |
| main.devices[].ownerUserId | User.devices | FK via fem_key_map |
| main.dao_accounts (20) | Wallet | address unique; verified=true |
| migration.fem_key_map (19978) | Device.canonicalId + Wallet link | canonical device identity source |

## Devices / FEM
| Source | Target | Notes |
|---|---|---|
| main.devices (19980) | Device | canonicalId ← fem_key_map; status derived from monitoringsessions |
| main.monitoringsessions (5527) | Heartbeat (lastSeenAt, lastHeartbeatAt) | most recent per device |
| main.devices[].address | Wallet.address (link) | 2-step join per memory |
| main.blacklist-devices (11) | Device.banned=true | |
| main.devices_orphan_userid_archive_* | EXCLUDED (archives) | provenance only |
| main.devices_connectivity_wallet_archive_* | EXCLUDED (archives) | |

## Integrations
| Source | Target | Notes |
|---|---|---|
| PoC.hardware (8833) | IntegrationHealth (evidence) | per-device integration telemetry |
| PoC.installations (468) | IntegrationHealth (active installs) | |
| creds.{weather,air,water,radiation,energy,camera} | IntegrationHealth (per-kind) | evidenceType=telemetry |

## Rewards / Ledger
| Source | Target | Notes |
|---|---|---|
| main.poc_reward_dailies (773320) | RewardAccrual (historical) | amountBase ← amount (integer); provenance batch |
| main.reward_epoch_history (7093) | RewardAccrual (epoch meta) | |
| main.reward_pending_claims (15) | Claim (PENDING) | idempotencyKey ← _id |
| main.device_transactions (3437) | RewardLedgerEntry (historical) | |
| main.refund-history (212) | RewardLedgerEntry (ADJUST) | |
| frystaking.stakingtokens (154) | (staking — out of reward scope; archive) | |
| frystaking.dailyclaims (1440) | RewardAccrual (staking claims historical) | |

## BYOD
| Source | Target | Notes |
|---|---|---|
| main.byods (3282) | ByodLicense | licenseKey unique; deviceId link; status |

## Voting / DAO
| Source | Target | Notes |
|---|---|---|
| main.dao (62) | Proposal | externalId ← on-chain ref (read-only) |
| main.dao-stakes (192) | Vote.weightBase | |

## Timeclock (MariaDB)
| Source | Target | Notes |
|---|---|---|
| _746cd6c3be9aa3c9.* | TimeclockEntry | workerId, clockInAt, clockOutAt |
| _8efcfed43a78d1aa.* | TimeclockEntry (merge, dedupe R2) | |

## Explorer
| Source | Target | Notes |
|---|---|---|
| public_explorer.sensor_summaries (97889) | (explorer read model — rebuilt, not migrated 1:1) | rebuilt from IntegrationHealth |
| public_explorer.sensor_families (6) | (static ref) | |

## Repair rules (deterministic, all logged)
- R1: duplicate User by email → keep lowest createdAt, merge wallets/devices.
- R2: duplicate TimeclockEntry (workerId+clockInAt) → keep first.
- R3: device with no fem_key_map entry → canonicalId = sha256(minerKey), flag for review.
- R4: orphan device (ownerUserId not in users) → assign to migration-holding user, flag.
- Every repaired record logged with reason to migration-repairs.log.

## Reconciliation (must be EXACT for: users, wallets, devices, pending claims, BYOD, vote history)
- poc_reward_dailies total SUM(amount) source vs target (exact).
- reward_pending_claims count + SUM (exact).
- devices count (exact); banned count (exact).
- byods count (exact); active count (exact).
