// Mirrors of the Rust command payloads.

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  secret_slots: Record<string, boolean>;
}

export interface ProcStatus {
  name: string;
  running: boolean;
  pid: number | null;
  started: number | null;
  cmdline: string | null;
  exit_code: number | null;
  log_tail: string;
}

export interface ActivityRow {
  id: number;
  ts: number;
  module: string;
  kind: string;
  level: string;
  message: string;
  data: string | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  event: string;
  detail: string | null;
}

export interface Trade {
  id: string;
  ts: number;
  wallet: string;
  in_mint: string;
  in_symbol: string;
  in_amount: number;
  out_mint: string;
  out_symbol: string;
  out_amount: number;
  in_usd: number | null;
  out_usd: number | null;
  signature: string | null;
  status: string;
  slippage_bps: number | null;
  route: string | null;
}

// Monero
export interface XmrStatus {
  process: ProcStatus;
  rpc_ok: boolean;
  rpc_version: number | null;
  wallet: string | null;
  wallet_height: number | null;
  daemon_url: string;
  daemon_height: number | null;
  daemon_target: number | null;
  daemon_synced: boolean | null;
  daemon_nettype: string | null;
  daemon_error: string | null;
  proxy: string | null;
  wallet_dir: string;
  binary: string;
}
export interface XmrSubaddress {
  index: number;
  address: string;
  label: string;
  balance: number;
  unlocked: number;
  used: boolean;
}
export interface XmrBalance {
  balance: number;
  unlocked: number;
  balance_atomic: string;
  unlocked_atomic: string;
  blocks_to_unlock: number;
  subaddresses: XmrSubaddress[];
}
export interface XmrWalletOpened {
  name: string;
  address: string;
  seed: string | null;
  restore_height: number | null;
}
export interface XmrPreparedTx {
  tx_hash: string;
  amount: number;
  fee: number;
  tx_metadata: string;
  destination: string;
}
export interface XmrOutput {
  key_image: string;
  amount: number;
  spent: boolean;
  frozen: boolean;
  unlocked: boolean;
  global_index: number;
  tx_hash: string;
  subaddr_index: number;
  height: number;
  confirmations: number;
}
export interface XmrTransfer {
  kind: string;
  txid: string;
  amount: number;
  fee: number;
  height: number;
  timestamp: number;
  confirmations: number;
  address: string;
  subaddr_index: number;
  note: string;
  locked: boolean;
}

// Zcash
export interface ZecStatus {
  process: ProcStatus;
  reachable: boolean;
  error: string | null;
  chain: string | null;
  blocks: number | null;
  headers: number | null;
  verification_progress: number | null;
  version: unknown;
  backend: string;
  rpc_url: string;
  wallet_version: number | null;
}
export interface ZecBalance {
  transparent: number;
  shielded: number;
  total: number;
  pools: { pool: string; zec: number; shielded: boolean }[];
  min_conf: number;
}
export interface ZecAddress {
  address: string;
  pool: string;
  shielded: boolean;
  account: number | null;
  receiver_types: string[];
  balance: number;
}
export interface ZecTx {
  txid: string;
  kind: string;
  pool: string;
  address: string;
  amount: number;
  memo: string | null;
  confirmations: number;
  time: number;
}

// Exchange
export interface Quote {
  provider: string;
  ok: boolean;
  error: string | null;
  rate: number | null;
  amount_from: number;
  amount_to: number | null;
  min: number | null;
  max: number | null;
  eta_minutes: number | null;
  kyc: string | null;
  fixed: boolean;
  notes: string[];
  latency_ms: number;
  requires_key: boolean;
  quote_ref: string | null;
}
export interface Order {
  id: string;
  ts: number;
  provider: string;
  provider_id: string;
  from_asset: string;
  to_asset: string;
  amount_from: number;
  amount_to: number | null;
  deposit_address: string | null;
  deposit_memo: string | null;
  settle_address: string;
  refund_address: string | null;
  status: string;
  raw: string | null;
  updated: number;
}
export interface ProviderInfo {
  name: string;
  requires_key: boolean;
  has_key: boolean;
  notes: string[];
  url: string;
}

// Agent
export type Trigger =
  | { kind: "realized_pnl_above"; usd: number }
  | { kind: "sol_balance_above"; sol: number }
  | { kind: "allocation_above"; asset: string; pct: number }
  | { kind: "allocation_below"; asset: string; pct: number }
  | { kind: "price_above"; symbol: string; usd: number }
  | { kind: "price_below"; symbol: string; usd: number }
  | { kind: "unshielded_zec_above"; zec: number }
  | { kind: "treasury_value_above"; usd: number };

export type Action =
  | { kind: "propose_move"; from: string; to: string; pct?: number | null; amount?: number | null; note?: string | null }
  | { kind: "propose_swap"; from_symbol: string; to_symbol: string; amount?: number | null; pct?: number | null; note?: string | null }
  | { kind: "propose_shield"; note?: string | null }
  | { kind: "notify"; message: string };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  cooldown_secs: number;
  last_fired: number | null;
  created: number;
}
export interface Proposal {
  id: string;
  ts: number;
  rule_id: string | null;
  source: string;
  title: string;
  rationale: string;
  action: Action;
  status: string;
  decided_ts: number | null;
  result: string | null;
}
export interface Snapshot {
  prices: Record<string, number>;
  balances: { sol: number; usdc: number; xmr: number; zec: number; zec_transparent: number; sol_tokens_usd: number };
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  wallet: string | null;
  sources: string[];
}
export interface ChatReply {
  reply: string;
  rules: { name: string; trigger: Trigger; action: Action; cooldown_secs: number }[];
  proposals: Proposal[];
  invalid: string[];
  model: string;
  tokens: [number, number];
}
export interface ChatMessage {
  id: number;
  ts: number;
  role: string;
  content: string;
}

// Network
export interface ConfSummary {
  name: string;
  endpoint: string | null;
  allowed_ips: string[];
  dns: string[];
  full_tunnel: boolean;
  address: string | null;
}
export interface Peer {
  public_key: string;
  endpoint: string | null;
  allowed_ips: string[];
  latest_handshake: number | null;
  rx_bytes: number;
  tx_bytes: number;
}
export interface Tunnel {
  interface: string;
  listen_port: number | null;
  peers: Peer[];
  handshake_fresh: boolean;
}
export interface NetStatus {
  platform: string;
  wireguard_bin: string;
  wireguard_found: boolean;
  wg_bin: string;
  wg_found: boolean;
  wg_error: string | null;
  tunnels: Tunnel[];
  configs: ConfSummary[];
  proxy_enabled: boolean;
  proxy_url: string;
  tor_socks_reachable: boolean;
  kill_switch: { state: string; reason: string };
}
export interface VpnStatus {
  running: boolean;
  name: string | null;
  endpoint: string | null;
  resolved_endpoint: string | null;
  tunnel_address: string | null;
  dns: string[];
  handshake_age_secs: number | null;
  tx_bytes: number;
  rx_bytes: number;
  socks_port: number;
  connections: number;
  last_error: string | null;
}
export interface IpCheck {
  ip: string | null;
  is_tor: boolean | null;
  via_proxy: boolean;
  source: string;
  geo: { country?: string; org?: string; asn?: string; city?: string } | null;
  error: string | null;
}
export interface DnsLeakResult {
  test_id: string;
  your_ip: { ip: string; country: string; asn: string }[];
  dns_servers: { ip: string; country: string; asn: string }[];
  conclusion: string | null;
  resolver_queries_sent: number;
}
export interface NetLogRow {
  id: number;
  ts: number;
  event: string;
  detail: string | null;
}
export interface SolLocalStatus {
  exists: boolean;
  pubkey: string | null;
  vault_unlocked: boolean;
}
