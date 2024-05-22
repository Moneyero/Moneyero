# Known limits and blockers

Everything here is surfaced in the UI as a plain message where the feature would be. Nothing is mocked.

| Area | Status | Detail / workaround |
|---|---|---|
| Phantom in the desktop app | platform limit | Browser extensions cannot inject into WebView2 / webkit2gtk. Desktop uses the vault-encrypted local signer (`src-tauri/src/solana.rs`). Phantom works in browser mode (`npm run dev` → `/app.html`). Phantom deep links are mobile-only. |
| Hardware wallets (Ledger/Trezor) | not implemented | No HID/WebUSB transport inside the webview. Plan: Rust HID bridge exposing `sign_message` the same way the local signer does. |
| Zcash light client | roadmap | Backend is the zcashd / zallet JSON-RPC wallet (full node, long initial sync). A `lightwalletd` client (zcash_client_backend) is the planned replacement; the RPC adapter in `zcash.rs` is the integration seam. |
| Zcash restore from mnemonic | node-side | zcashd has no RPC for mnemonic restore (wallet.dat); zallet does it via its CLI (`zallet import-mnemonic`). Moneyero imports individual spending/viewing/WIF keys via RPC. |
| Zcash per-pool balances | partial | Only available for unified accounts (`z_getbalanceforaccount`). Legacy Sapling-only wallets show shielded/transparent totals from `z_gettotalbalance`. |
| WireGuard on Windows | needs admin | `wireguard.exe /installtunnelservice` requires elevation; `wg show` also needs it unless the user is in the Network Configuration Operators group. Moneyero surfaces the raw error. Run elevated, or install the tunnel via the WireGuard app and read status here. |
| Kill switch | inferred | Derived from AllowedIPs + platform defaults and labelled `likely_on` / `off` / `unknown`. Moneyero writes no firewall rules. |
| OpenVPN | not implemented | WireGuard only. |
| Tor | detected, not bundled | Run the Tor daemon (9050) or Tor Browser (9150). Moneyero uses the SOCKS port for all its own traffic (`socks5h`). |
| Swap provider keys | credentials | Trocador and ChangeNOW require API keys from the provider. SideShift and Exolix quote without. SideShift geo-blocks some regions. |
| Provider API drift | external | Response shapes are mapped defensively; a provider changing its API shows up as a failed quote with the raw error, not as a silent wrong number. |
| Jupiter lite endpoint | rate limited | `lite-api.jup.ag` is keyless and rate limited. Set `jupiter.api_key` to use `api.jup.ag`. |
| GeckoTerminal | 30 req/min | Candles refresh every 20–60 s per instrument; rapid instrument switching can hit the limit (shown as a chart error). |
| Realised P&L | log-based | Only swaps executed through Moneyero are in the trade log. Sales of tokens acquired elsewhere are reported as `untracked`, not guessed. |
| Claude agent | opt-in | Requires an Anthropic API key in the vault. Sends the portfolio snapshot shown in the panel. Model can only propose. |
| Signed installers | not yet | Build from source (`npm run desktop:build`). |
| Windows build without admin | workaround | VS Build Tools need elevation. `scripts/msvc-env.ps1` puts a portable MSVC + Windows SDK (downloaded from Microsoft's own manifests) on PATH for the shell. |
