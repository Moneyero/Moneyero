//! Moneyero backend. Everything privileged - keys, processes, network - lives here.

mod agent;
mod commands;
mod crypto;
mod db;
mod error;
mod exchange;
mod http;
mod llm;
mod monero;
mod network;
mod procs;
mod settings;
mod solana;
mod state;
mod vault;
mod vpn;
mod zcash;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let state = AppState::new(dir)?;
            state.log("app", "start", "info", &format!("Moneyero {} started", env!("CARGO_PKG_VERSION")), None);
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                procs::stop_all(&state);
            }
        })
        .invoke_handler(tauri::generate_handler![
            // app / settings / vault
            commands::app_info,
            commands::settings_all,
            commands::settings_set,
            commands::secret_set,
            commands::secret_delete,
            commands::activity_list,
            commands::activity_log,
            commands::audit_list,
            commands::trades_add,
            commands::trades_list,
            commands::trades_delete,
            vault::vault_status,
            vault::vault_init,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_change_password,
            http::http_request,
            procs::proc_status,
            procs::proc_stop,
            procs::proc_log,
            // solana local signer
            solana::sol_local_status,
            solana::sol_local_create,
            solana::sol_local_import,
            solana::sol_local_sign,
            solana::sol_local_export,
            solana::sol_local_delete,
            // monero
            monero::xmr_status,
            monero::xmr_start,
            monero::xmr_stop,
            monero::xmr_wallet_list,
            monero::xmr_create,
            monero::xmr_open,
            monero::xmr_restore,
            monero::xmr_close,
            monero::xmr_balance,
            monero::xmr_new_subaddress,
            monero::xmr_prepare_transfer,
            monero::xmr_relay,
            monero::xmr_transfers,
            monero::xmr_seed,
            monero::xmr_refresh,
            monero::xmr_rescan,
            monero::xmr_validate,
            monero::xmr_set_daemon,
            monero::xmr_outputs,
            monero::xmr_freeze,
            monero::xmr_prepare_transfer_from,
            monero::xmr_prepare_churn,
            // zcash
            zcash::zec_status,
            zcash::zec_balance,
            zcash::zec_addresses,
            zcash::zec_new_address,
            zcash::zec_send,
            zcash::zec_shield_transparent,
            zcash::zec_operations,
            zcash::zec_transactions,
            zcash::zec_import_key,
            zcash::zec_export_viewing_key,
            zcash::zec_validate,
            zcash::zec_node_start,
            zcash::zec_node_stop,
            // exchange
            exchange::exchange_providers,
            exchange::exchange_quotes,
            exchange::exchange_create,
            exchange::exchange_refresh,
            exchange::exchange_orders,
            // agent
            agent::agent_rules,
            agent::agent_rule_upsert,
            agent::agent_rule_delete,
            agent::agent_tick,
            agent::agent_proposals,
            agent::agent_decide,
            agent::agent_result,
            agent::agent_create_proposal,
            agent::agent_messages,
            agent::agent_clear_chat,
            agent::agent_chat,
            // network
            network::net_status,
            network::net_config_import,
            network::net_config_delete,
            network::net_up,
            network::net_down,
            network::net_ip_check,
            network::net_dns_leak,
            network::net_log_list,
            // built-in VPN (userspace WireGuard)
            vpn::vpn_status,
            vpn::vpn_connect,
            vpn::vpn_disconnect,
            vpn::vpn_exit_check,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Moneyero")
        .run(|_app, event| {
            if std::env::var_os("Moneyero_TRACE").is_some() {
                eprintln!("[tauri] {event:?}");
            }
        });
}
