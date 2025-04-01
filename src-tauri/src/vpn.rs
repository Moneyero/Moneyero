//! Built-in VPN: a userspace WireGuard client.
//!
//! No TUN driver, no administrator rights, no external WireGuard install. The WireGuard
//! protocol runs in-process (boringtun), IP packets terminate in an in-process TCP/IP stack
//! (smoltcp), and the application reaches the tunnel through a local SOCKS5 server that only
//! Moneyero's own HTTP client points at. When the tunnel is down, that SOCKS server refuses
//! connections, so the application fails closed instead of leaking to the clear network.
//!
//! Scope, stated honestly: this protects traffic Moneyero itself sends (RPC, market data,
//! swap providers, the Monero daemon link, the Claude API). It cannot capture traffic from
//! other programs or from a browser extension; a system tunnel is still needed for that.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use serde::Serialize;
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{dns, tcp};
use smoltcp::time::Instant as SInstant;
use smoltcp::wire::{DnsQueryType, HardwareAddress, IpAddress, IpCidr};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MTU: usize = 1420;
const WG_BUF: usize = 65536;
const TCP_BUF: usize = 65536;
const PENDING_CAP: usize = 1 << 20;

// ================================================================== config

#[derive(Debug, Clone)]
pub struct WgConfig {
    pub name: String,
    pub private_key: [u8; 32],
    pub address: Ipv4Addr,
    pub dns: Vec<IpAddr>,
    pub peer_public: [u8; 32],
    pub preshared: Option<[u8; 32]>,
    pub endpoint: String,
    pub keepalive: Option<u16>,
    #[allow(dead_code)]
    pub allowed_ips: Vec<String>,
}

fn key32(s: &str) -> AppResult<[u8; 32]> {
    let v = B64.decode(s.trim()).map_err(|_| AppError::Msg("key is not valid base64".into()))?;
    v.try_into().map_err(|_| AppError::Msg("key must be 32 bytes".into()))
}

/// Parses a standard WireGuard `.conf` (the format every provider exports).
pub fn parse_conf(name: &str, text: &str) -> AppResult<WgConfig> {
    let mut section = String::new();
    let mut private_key = None;
    let mut address = None;
    let mut dns = vec![];
    let mut peer_public = None;
    let mut preshared = None;
    let mut endpoint = None;
    let mut keepalive = None;
    let mut allowed_ips = vec![];
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            section = line.trim_matches(&['[', ']'][..]).to_ascii_lowercase();
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        match (section.as_str(), k.as_str()) {
            ("interface", "privatekey") => private_key = Some(key32(v)?),
            ("interface", "address") => {
                for a in v.split(',') {
                    let a = a.trim().split('/').next().unwrap_or("");
                    if let Ok(ip) = a.parse::<Ipv4Addr>() {
                        address.get_or_insert(ip);
                    }
                }
            }
            ("interface", "dns") => {
                for d in v.split(',') {
                    if let Ok(ip) = d.trim().parse::<IpAddr>() {
                        dns.push(ip);
                    }
                }
            }
            ("peer", "publickey") => peer_public = Some(key32(v)?),
            ("peer", "presharedkey") => preshared = Some(key32(v)?),
            ("peer", "endpoint") => endpoint = Some(v.to_string()),
            ("peer", "persistentkeepalive") => keepalive = v.parse().ok(),
            ("peer", "allowedips") => allowed_ips.extend(v.split(',').map(|s| s.trim().to_string())),
            _ => {}
        }
    }
    Ok(WgConfig {
        name: name.to_string(),
        private_key: private_key.ok_or_else(|| AppError::Msg("[Interface] PrivateKey missing".into()))?,
        address: address.ok_or_else(|| AppError::Msg("[Interface] Address needs an IPv4 address".into()))?,
        dns: if dns.is_empty() { vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))] } else { dns },
        peer_public: peer_public.ok_or_else(|| AppError::Msg("[Peer] PublicKey missing".into()))?,
        preshared,
        endpoint: endpoint.ok_or_else(|| AppError::Msg("[Peer] Endpoint missing".into()))?,
        keepalive: keepalive.or(Some(25)),
        allowed_ips,
    })
}

// ================================================================== virtual device

/// IP packets between the WireGuard tunnel and the TCP/IP stack. No hardware, just queues.
pub struct VirtDev {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

impl VirtDev {
    fn new() -> Self {
        Self { rx: VecDeque::new(), tx: VecDeque::new() }
    }
}

pub struct RxTok(Vec<u8>);
pub struct TxTok<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for RxTok {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}
impl TxToken for TxTok<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut b = vec![0u8; len];
        let r = f(&mut b);
        self.0.push_back(b);
        r
    }
}
impl Device for VirtDev {
    type RxToken<'a> = RxTok;
    type TxToken<'a> = TxTok<'a>;
    fn receive(&mut self, _: SInstant) -> Option<(RxTok, TxTok<'_>)> {
        let p = self.rx.pop_front()?;
        Some((RxTok(p), TxTok(&mut self.tx)))
    }
    fn transmit(&mut self, _: SInstant) -> Option<TxTok<'_>> {
        Some(TxTok(&mut self.tx))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ip;
        c.max_transmission_unit = MTU;
        c
    }
}

// ================================================================== WireGuard + stack core

/// One WireGuard peer session plus an IP stack on top. Shared by the client engine and the
/// in-process test peer, so the exact code path that ships is the one that is tested.
pub struct WgStack {
    tunn: Tunn,
    udp: UdpSocket,
    peer: Option<SocketAddr>,
    dev: VirtDev,
    pub iface: Interface,
    pub sockets: SocketSet<'static>,
    out: Vec<u8>,
    last_timer: Instant,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
}

impl WgStack {
    pub async fn new(private: [u8; 32], peer_public: [u8; 32], psk: Option<[u8; 32]>, keepalive: Option<u16>, addr: Ipv4Addr, peer: Option<SocketAddr>, bind: &str) -> AppResult<Self> {
        let udp = UdpSocket::bind(bind).await?;
        let tunn = Tunn::new(StaticSecret::from(private), PublicKey::from(peer_public), psk, keepalive, rand::random::<u32>() & 0x00ff_ffff, None);
        let mut dev = VirtDev::new();
        let mut cfg = Config::new(HardwareAddress::Ip);
        cfg.random_seed = rand::random();
        let mut iface = Interface::new(cfg, &mut dev, SInstant::now());
        iface.update_ip_addrs(|a| {
            a.push(IpCidr::new(IpAddress::Ipv4(addr), 32)).ok();
        });
        iface.routes_mut().add_default_ipv4_route(Ipv4Addr::new(0, 0, 0, 1)).ok();
        Ok(Self {
            tunn,
            udp,
            peer,
            dev,
            iface,
            sockets: SocketSet::new(vec![]),
            out: vec![0u8; WG_BUF],
            last_timer: Instant::now(),
            tx_bytes: 0,
            rx_bytes: 0,
        })
    }

    fn send_udp(&mut self, b: &[u8]) {
        let r = match self.peer {
            Some(p) => self.udp.try_send_to(b, p),
            None => Err(std::io::Error::new(std::io::ErrorKind::NotConnected, "no peer")),
        };
        if r.is_ok() {
            self.tx_bytes += b.len() as u64;
        }
    }

    pub fn initiate_handshake(&mut self) {
        if let TunnResult::WriteToNetwork(b) = self.tunn.format_handshake_initiation(&mut self.out, false) {
            let v = b.to_vec();
            self.send_udp(&v);
        }
    }

    /// Feed one datagram received from the peer.
    pub fn on_udp(&mut self, pkt: &[u8], from: SocketAddr) {
        if self.peer.is_none() {
            self.peer = Some(from);
        }
        self.rx_bytes += pkt.len() as u64;
        let mut first = true;
        loop {
            let input: &[u8] = if first { pkt } else { &[] };
            first = false;
            let res = self.tunn.decapsulate(None, input, &mut self.out);
            match res {
                TunnResult::WriteToNetwork(b) => {
                    let v = b.to_vec();
                    self.send_udp(&v);
                    continue;
                }
                TunnResult::WriteToTunnelV4(b, _) | TunnResult::WriteToTunnelV6(b, _) => {
                    self.dev.rx.push_back(b.to_vec());
                    continue;
                }
                TunnResult::Done => break,
                TunnResult::Err(_) => break,
            }
        }
    }

    /// Timers (handshake retries, keepalives, rekey). Call at least every 250 ms.
    pub fn tick(&mut self) {
        if self.last_timer.elapsed() < Duration::from_millis(100) {
            return;
        }
        self.last_timer = Instant::now();
        if let TunnResult::WriteToNetwork(b) = self.tunn.update_timers(&mut self.out) {
            let v = b.to_vec();
            self.send_udp(&v);
        }
    }

    /// Run the IP stack and push anything it produced into the tunnel.
    pub fn poll(&mut self) {
        self.iface.poll(SInstant::now(), &mut self.dev, &mut self.sockets);
        while let Some(pkt) = self.dev.tx.pop_front() {
            match self.tunn.encapsulate(&pkt, &mut self.out) {
                TunnResult::WriteToNetwork(b) => {
                    let v = b.to_vec();
                    self.send_udp(&v);
                }
                _ => {}
            }
        }
    }

    pub fn poll_delay(&mut self) -> Duration {
        let d = self.iface.poll_delay(SInstant::now(), &self.sockets).map(|d| Duration::from_micros(d.total_micros())).unwrap_or(Duration::from_millis(100));
        d.min(Duration::from_millis(100))
    }

    pub async fn recv_udp(&self, buf: &mut [u8]) -> std::io::Result<(usize, SocketAddr)> {
        self.udp.recv_from(buf).await
    }

    pub fn handshake_age(&self) -> Option<Duration> {
        self.tunn.stats().0
    }

    #[allow(dead_code)]
    pub fn local_port(&self) -> u16 {
        self.udp.local_addr().map(|a| a.port()).unwrap_or(0)
    }
}

// ================================================================== client engine

#[derive(Debug, Clone, Serialize, Default)]
pub struct VpnStatus {
    pub running: bool,
    pub name: Option<String>,
    pub endpoint: Option<String>,
    pub resolved_endpoint: Option<String>,
    pub tunnel_address: Option<String>,
    pub dns: Vec<String>,
    pub handshake_age_secs: Option<u64>,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    pub socks_port: u16,
    pub connections: usize,
    pub last_error: Option<String>,
}

enum Dst {
    Ip(IpAddr),
    Name(String),
}

struct ConnPipes {
    id: u64,
    from_engine: mpsc::Receiver<Vec<u8>>,
}

enum Cmd {
    Connect { dst: Dst, port: u16, reply: oneshot::Sender<Result<ConnPipes, String>> },
}

enum Ev {
    Data { id: u64, bytes: Vec<u8> },
    ClientClosed { id: u64 },
}

struct Conn {
    handle: SocketHandle,
    reply: Option<oneshot::Sender<Result<ConnPipes, String>>>,
    to_client: Option<mpsc::Sender<Vec<u8>>>,
    pending: VecDeque<u8>,
    client_closed: bool,
    started: Instant,
}

struct PendingDns {
    q: dns::QueryHandle,
    port: u16,
    reply: oneshot::Sender<Result<ConnPipes, String>>,
    started: Instant,
}

pub struct VpnHandle {
    cmd_tx: mpsc::Sender<Cmd>,
    stop: Arc<Notify>,
    pub status: Arc<parking_lot::Mutex<VpnStatus>>,
}

async fn resolve_endpoint(ep: &str) -> AppResult<SocketAddr> {
    let mut addrs: Vec<SocketAddr> = tokio::net::lookup_host(ep).await.map_err(|e| AppError::Msg(format!("endpoint {ep}: {e}")))?.collect();
    addrs.sort_by_key(|a| !a.is_ipv4());
    addrs.into_iter().next().ok_or_else(|| AppError::Msg("endpoint did not resolve".into()))
}

pub async fn start(cfg: WgConfig, socks_port: u16) -> AppResult<VpnHandle> {
    let peer = resolve_endpoint(&cfg.endpoint).await?;
    let bind = if peer.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
    let mut stack = WgStack::new(cfg.private_key, cfg.peer_public, cfg.preshared, cfg.keepalive, cfg.address, Some(peer), bind).await?;
    let dns_handle = stack.sockets.add(dns::Socket::new(&cfg.dns.iter().map(|d| IpAddress::from(*d)).collect::<Vec<_>>(), vec![]));
    let listener = TcpListener::bind(("127.0.0.1", socks_port)).await.map_err(|e| AppError::Msg(format!("socks port {socks_port}: {e}")))?;
    let socks_port = listener.local_addr()?.port();

    let status = Arc::new(parking_lot::Mutex::new(VpnStatus {
        running: true,
        name: Some(cfg.name.clone()),
        endpoint: Some(cfg.endpoint.clone()),
        resolved_endpoint: Some(peer.to_string()),
        tunnel_address: Some(cfg.address.to_string()),
        dns: cfg.dns.iter().map(|d| d.to_string()).collect(),
        socks_port,
        ..Default::default()
    }));
    let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(256);
    let (ev_tx, ev_rx) = mpsc::channel::<Ev>(1024);
    let stop = Arc::new(Notify::new());

    tokio::spawn(socks_server(listener, cmd_tx.clone(), ev_tx.clone(), stop.clone()));
    tokio::spawn(engine(stack, dns_handle, cmd_rx, ev_rx, stop.clone(), status.clone()));
    Ok(VpnHandle { cmd_tx, stop, status })
}

impl VpnHandle {
    pub fn stop(&self) {
        self.stop.notify_waiters();
        self.stop.notify_one();
        self.status.lock().running = false;
    }
    pub fn status(&self) -> VpnStatus {
        self.status.lock().clone()
    }
    /// Keeps the command channel alive for the engine's lifetime.
    pub fn is_alive(&self) -> bool {
        !self.cmd_tx.is_closed()
    }
}

async fn engine(mut stack: WgStack, dns_h: SocketHandle, mut cmd_rx: mpsc::Receiver<Cmd>, mut ev_rx: mpsc::Receiver<Ev>, stop: Arc<Notify>, status: Arc<parking_lot::Mutex<VpnStatus>>) {
    let mut conns: HashMap<u64, Conn> = HashMap::new();
    let mut pending_dns: Vec<PendingDns> = vec![];
    let mut next_id: u64 = 1;
    let mut next_port: u16 = 49152;
    let mut ubuf = vec![0u8; WG_BUF];
    let mut tbuf = vec![0u8; TCP_BUF];
    stack.initiate_handshake();
    let mut last_status = Instant::now();

    loop {
        let delay = stack.poll_delay();
        tokio::select! {
            r = stack.recv_udp(&mut ubuf) => {
                if let Ok((n, from)) = r { stack.on_udp(&ubuf[..n], from); }
            }
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    Cmd::Connect { dst, port, reply } => {
                        match dst {
                            Dst::Ip(ip) => {
                                let id = next_id; next_id += 1;
                                match open_tcp(&mut stack, &mut next_port, ip, port) {
                                    Ok(h) => { conns.insert(id, Conn { handle: h, reply: Some(reply), to_client: None, pending: VecDeque::new(), client_closed: false, started: Instant::now() }); }
                                    Err(e) => { let _ = reply.send(Err(e)); }
                                }
                            }
                            Dst::Name(name) => {
                                let r = stack.sockets.get_mut::<dns::Socket>(dns_h).start_query(stack.iface.context(), &name, DnsQueryType::A);
                                match r {
                                    Ok(q) => pending_dns.push(PendingDns { q, port, reply, started: Instant::now() }),
                                    Err(e) => { let _ = reply.send(Err(format!("dns: {e}"))); }
                                }
                            }
                        }
                    }
                }
            }
            Some(ev) = ev_rx.recv() => {
                match ev {
                    Ev::Data { id, bytes } => if let Some(c) = conns.get_mut(&id) {
                        if c.pending.len() + bytes.len() > PENDING_CAP { c.client_closed = true; } else { c.pending.extend(bytes); }
                    },
                    Ev::ClientClosed { id } => if let Some(c) = conns.get_mut(&id) { c.client_closed = true; },
                }
            }
            _ = tokio::time::sleep(delay) => {}
            _ = stop.notified() => break,
        }

        stack.tick();
        // DNS results -> connects
        let mut i = 0;
        while i < pending_dns.len() {
            let res = stack.sockets.get_mut::<dns::Socket>(dns_h).get_query_result(pending_dns[i].q);
            match res {
                Err(dns::GetQueryResultError::Pending) => {
                    if pending_dns[i].started.elapsed() > Duration::from_secs(8) {
                        let p = pending_dns.remove(i);
                        stack.sockets.get_mut::<dns::Socket>(dns_h).cancel_query(p.q);
                        let _ = p.reply.send(Err("dns timeout through tunnel".into()));
                    } else {
                        i += 1;
                    }
                }
                Err(dns::GetQueryResultError::Failed) => {
                    let p = pending_dns.remove(i);
                    let _ = p.reply.send(Err("dns lookup failed".into()));
                }
                Ok(addrs) => {
                    let p = pending_dns.remove(i);
                    let ip: Option<IpAddr> = addrs.iter().find_map(|a| match a { IpAddress::Ipv4(v) => Some(IpAddr::V4(*v)), _ => None });
                    match ip {
                        Some(ip) => {
                            let id = next_id; next_id += 1;
                            match open_tcp(&mut stack, &mut next_port, ip, p.port) {
                                Ok(h) => { conns.insert(id, Conn { handle: h, reply: Some(p.reply), to_client: None, pending: VecDeque::new(), client_closed: false, started: Instant::now() }); }
                                Err(e) => { let _ = p.reply.send(Err(e)); }
                            }
                        }
                        None => { let _ = p.reply.send(Err("no A record".into())); }
                    }
                }
            }
        }

        // Service sockets: up to a few passes so writes get flushed in the same loop.
        for _ in 0..3 {
            stack.poll();
            let mut changed = false;
            let mut dead = vec![];
            for (id, c) in conns.iter_mut() {
                let (open, may_send, may_recv) = {
                    let s = stack.sockets.get::<tcp::Socket>(c.handle);
                    (s.is_open(), s.may_send(), s.may_recv())
                };
                // connection established -> hand pipes to the SOCKS task
                if c.reply.is_some() && may_send {
                    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
                    c.to_client = Some(tx);
                    if let Some(r) = c.reply.take() {
                        let _ = r.send(Ok(ConnPipes { id: *id, from_engine: rx }));
                    }
                }
                if c.reply.is_some() && (!open || c.started.elapsed() > Duration::from_secs(20)) {
                    if let Some(r) = c.reply.take() {
                        let _ = r.send(Err(if open { "connect timeout through tunnel".into() } else { "connection refused or reset".into() }));
                    }
                    dead.push(*id);
                    continue;
                }
                // client -> tunnel
                if !c.pending.is_empty() && may_send {
                    let s = stack.sockets.get_mut::<tcp::Socket>(c.handle);
                    if s.can_send() {
                        let (a, b) = c.pending.as_slices();
                        let mut n = s.send_slice(a).unwrap_or(0);
                        if n == a.len() && !b.is_empty() {
                            n += s.send_slice(b).unwrap_or(0);
                        }
                        c.pending.drain(..n);
                        if n > 0 { changed = true; }
                    }
                }
                // tunnel -> client
                if let Some(tx) = &c.to_client {
                    loop {
                        let s = stack.sockets.get_mut::<tcp::Socket>(c.handle);
                        if !s.can_recv() { break; }
                        if tx.capacity() == 0 { break; } // backpressure: leave data in the stack
                        let n = s.recv_slice(&mut tbuf).unwrap_or(0);
                        if n == 0 { break; }
                        if tx.try_send(tbuf[..n].to_vec()).is_err() { break; }
                        changed = true;
                    }
                }
                // half/fully closed handling
                let s = stack.sockets.get_mut::<tcp::Socket>(c.handle);
                if c.client_closed && c.pending.is_empty() && s.may_send() {
                    s.close();
                    changed = true;
                }
                if !may_recv && !s.can_recv() {
                    // remote finished sending: drop our sender so the client gets EOF
                    c.to_client = None;
                }
                if !s.is_open() || (!s.is_active() && c.pending.is_empty()) {
                    if c.to_client.is_none() || !s.can_recv() {
                        dead.push(*id);
                    }
                }
            }
            for id in dead {
                if let Some(c) = conns.remove(&id) {
                    let s = stack.sockets.get_mut::<tcp::Socket>(c.handle);
                    s.abort();
                    stack.sockets.remove(c.handle);
                }
            }
            if !changed { break; }
        }

        if last_status.elapsed() > Duration::from_millis(500) {
            last_status = Instant::now();
            let mut st = status.lock();
            st.handshake_age_secs = stack.handshake_age().map(|d| d.as_secs());
            st.tx_bytes = stack.tx_bytes;
            st.rx_bytes = stack.rx_bytes;
            st.connections = conns.len();
        }
    }
    status.lock().running = false;
}

fn open_tcp(stack: &mut WgStack, next_port: &mut u16, ip: IpAddr, port: u16) -> Result<SocketHandle, String> {
    let mut s = tcp::Socket::new(tcp::SocketBuffer::new(vec![0u8; TCP_BUF]), tcp::SocketBuffer::new(vec![0u8; TCP_BUF]));
    s.set_nagle_enabled(false);
    s.set_keep_alive(Some(smoltcp::time::Duration::from_secs(30)));
    s.set_timeout(Some(smoltcp::time::Duration::from_secs(120)));
    let lp = *next_port;
    *next_port = if lp >= 65000 { 49152 } else { lp + 1 };
    let h = stack.sockets.add(s);
    let r = stack.sockets.get_mut::<tcp::Socket>(h).connect(stack.iface.context(), (IpAddress::from(ip), port), lp);
    match r {
        Ok(()) => Ok(h),
        Err(e) => {
            stack.sockets.remove(h);
            Err(format!("connect: {e}"))
        }
    }
}

// ================================================================== SOCKS5 front door

async fn socks_server(listener: TcpListener, cmd_tx: mpsc::Sender<Cmd>, ev_tx: mpsc::Sender<Ev>, stop: Arc<Notify>) {
    loop {
        tokio::select! {
            r = listener.accept() => {
                let Ok((stream, _)) = r else { continue };
                tokio::spawn(socks_conn(stream, cmd_tx.clone(), ev_tx.clone()));
            }
            _ = stop.notified() => break,
        }
    }
}

async fn socks_conn(mut s: TcpStream, cmd_tx: mpsc::Sender<Cmd>, ev_tx: mpsc::Sender<Ev>) {
    let _ = s.set_nodelay(true);
    let mut hdr = [0u8; 2];
    if s.read_exact(&mut hdr).await.is_err() || hdr[0] != 5 {
        return;
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    if s.read_exact(&mut methods).await.is_err() {
        return;
    }
    if s.write_all(&[5, 0]).await.is_err() {
        return;
    }
    let mut req = [0u8; 4];
    if s.read_exact(&mut req).await.is_err() || req[0] != 5 {
        return;
    }
    if req[1] != 1 {
        let _ = s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await; // command not supported
        return;
    }
    let dst = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            if s.read_exact(&mut a).await.is_err() { return; }
            Dst::Ip(IpAddr::V4(Ipv4Addr::from(a)))
        }
        3 => {
            let mut l = [0u8; 1];
            if s.read_exact(&mut l).await.is_err() { return; }
            let mut n = vec![0u8; l[0] as usize];
            if s.read_exact(&mut n).await.is_err() { return; }
            let name = String::from_utf8_lossy(&n).to_string();
            match name.parse::<IpAddr>() {
                Ok(ip) => Dst::Ip(ip),
                Err(_) => Dst::Name(name),
            }
        }
        4 => {
            let mut a = [0u8; 16];
            if s.read_exact(&mut a).await.is_err() { return; }
            let _ = s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await; // IPv6 not routed through v4 tunnel
            return;
        }
        _ => return,
    };
    let mut p = [0u8; 2];
    if s.read_exact(&mut p).await.is_err() { return; }
    let port = u16::from_be_bytes(p);

    let (reply_tx, reply_rx) = oneshot::channel();
    if cmd_tx.send(Cmd::Connect { dst, port, reply: reply_tx }).await.is_err() {
        let _ = s.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return;
    }
    let pipes = match tokio::time::timeout(Duration::from_secs(25), reply_rx).await {
        Ok(Ok(Ok(p))) => p,
        _ => {
            let _ = s.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await; // connection refused
            return;
        }
    };
    if s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.is_err() {
        return;
    }
    let ConnPipes { id, mut from_engine } = pipes;
    let (mut rd, mut wr) = s.into_split();
    let ev_up = ev_tx.clone();
    let up = tokio::spawn(async move {
        let mut buf = vec![0u8; 16384];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ev_up.send(Ev::Data { id, bytes: buf[..n].to_vec() }).await.is_err() { break; }
                }
            }
        }
        let _ = ev_up.send(Ev::ClientClosed { id }).await;
    });
    while let Some(chunk) = from_engine.recv().await {
        if wr.write_all(&chunk).await.is_err() { break; }
    }
    let _ = wr.shutdown().await;
    up.abort();
    let _ = ev_tx.send(Ev::ClientClosed { id }).await;
}

// ================================================================== commands

fn conf_dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("wg")
}

#[tauri::command]
pub fn vpn_status(state: tauri::State<'_, AppState>) -> VpnStatus {
    let g = state.vpn.lock();
    match g.as_ref() {
        Some(h) => {
            let mut st = h.status();
            if !h.is_alive() {
                st.running = false;
                st.last_error = Some("tunnel engine stopped".into());
            }
            st
        }
        None => VpnStatus { socks_port: state.setting_u64("net.vpn_socks_port", 19050) as u16, ..Default::default() },
    }
}

#[tauri::command]
pub async fn vpn_connect(state: tauri::State<'_, AppState>, name: String) -> AppResult<VpnStatus> {
    let safe = name.trim().trim_end_matches(".conf");
    if safe.is_empty() || !safe.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Msg("bad config name".into()));
    }
    let text = std::fs::read_to_string(conf_dir(&state).join(format!("{safe}.conf"))).map_err(|_| AppError::Msg("config not found; import it in NETWORK first".into()))?;
    let cfg = parse_conf(safe, &text)?;
    if let Some(old) = state.vpn.lock().take() {
        old.stop();
    }
    let port = state.setting_u64("net.vpn_socks_port", 19050) as u16;
    let handle = start(cfg.clone(), port).await?;
    // Wait briefly for the first handshake so the caller learns immediately whether the peer answers.
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if handle.status().handshake_age_secs.is_some() {
            break;
        }
    }
    let st = handle.status();
    let ok = st.handshake_age_secs.is_some();
    *state.vpn.lock() = Some(handle);
    state.net_log(if ok { "vpn_up" } else { "vpn_no_handshake" }, Some(&format!("{} -> {} (socks 127.0.0.1:{})", cfg.name, cfg.endpoint, st.socks_port)));
    state.log("network", "vpn", if ok { "info" } else { "warn" }, &format!("built-in VPN {} {}", cfg.name, if ok { "handshake ok" } else { "no handshake yet" }), None);
    if !ok {
        return Err(AppError::Msg("tunnel started but the peer has not completed a handshake in 4 s. Check endpoint, keys and that the config is still valid with your provider. The tunnel keeps retrying; status will update.".into()));
    }
    Ok(st)
}

#[tauri::command]
pub fn vpn_disconnect(state: tauri::State<'_, AppState>) -> AppResult<VpnStatus> {
    if let Some(h) = state.vpn.lock().take() {
        h.stop();
    }
    state.net_log("vpn_down", None);
    Ok(VpnStatus { socks_port: state.setting_u64("net.vpn_socks_port", 19050) as u16, ..Default::default() })
}

/// Checks the exit IP *through the tunnel's SOCKS port*, independent of the global proxy setting.
#[tauri::command]
pub async fn vpn_exit_check(state: tauri::State<'_, AppState>) -> AppResult<serde_json::Value> {
    let port = {
        let g = state.vpn.lock();
        g.as_ref().map(|h| h.status().socks_port).ok_or_else(|| AppError::Msg("VPN not running".into()))?
    };
    let client = crate::http::build_client(Some(&format!("socks5h://127.0.0.1:{port}")), 25)?;
    let v = crate::http::get_json(&client, &state.setting("net.ip_check_url"), &[]).await?;
    Ok(serde_json::json!({"ip": v["IP"].as_str().or(v["ip"].as_str()), "is_tor": v["IsTor"], "via": format!("socks5h://127.0.0.1:{port}")}))
}

// ================================================================== tests: a real WireGuard peer in-process

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal WireGuard "server": decrypts the client's packets, runs a TCP echo on 10.9.0.1:7
    /// and answers DNS for "echo.test" with 10.9.0.1. Uses the same WgStack code as the client.
    async fn test_peer(server_priv: [u8; 32], client_pub: [u8; 32], ready: oneshot::Sender<u16>, stop: Arc<Notify>) {
        let mut stack = WgStack::new(server_priv, client_pub, None, None, Ipv4Addr::new(10, 9, 0, 1), None, "127.0.0.1:0").await.unwrap();
        let port = stack.local_port();
        let echo_h = stack.sockets.add(tcp::Socket::new(tcp::SocketBuffer::new(vec![0u8; 65536]), tcp::SocketBuffer::new(vec![0u8; 65536])));
        stack.sockets.get_mut::<tcp::Socket>(echo_h).listen(7).unwrap();
        let udp_dns = stack.sockets.add(smoltcp::socket::udp::Socket::new(
            smoltcp::socket::udp::PacketBuffer::new(vec![smoltcp::socket::udp::PacketMetadata::EMPTY; 8], vec![0u8; 4096]),
            smoltcp::socket::udp::PacketBuffer::new(vec![smoltcp::socket::udp::PacketMetadata::EMPTY; 8], vec![0u8; 4096]),
        ));
        stack.sockets.get_mut::<smoltcp::socket::udp::Socket>(udp_dns).bind(53).unwrap();
        let _ = ready.send(port);
        let mut buf = vec![0u8; WG_BUF];
        let mut echo = vec![0u8; 4096];
        loop {
            let delay = stack.poll_delay();
            tokio::select! {
                r = stack.recv_udp(&mut buf) => { if let Ok((n, from)) = r { stack.on_udp(&buf[..n], from); } }
                _ = tokio::time::sleep(delay) => {}
                _ = stop.notified() => break,
            }
            stack.tick();
            for _ in 0..3 {
                stack.poll();
                let mut changed = false;
                // echo
                let s = stack.sockets.get_mut::<tcp::Socket>(echo_h);
                if s.can_recv() && s.can_send() {
                    let n = s.recv_slice(&mut echo).unwrap();
                    s.send_slice(&echo[..n]).unwrap();
                    changed = true;
                }
                if !s.is_open() {
                    s.listen(7).unwrap();
                }
                // tiny DNS responder: any A query -> 10.9.0.1
                let u = stack.sockets.get_mut::<smoltcp::socket::udp::Socket>(udp_dns);
                if let Ok((q, meta)) = u.recv() {
                    let q = q.to_vec();
                    if q.len() > 12 {
                        let mut resp = q.clone();
                        resp[2] = 0x81; resp[3] = 0x80; // response, recursion available
                        resp[7] = 1; // ancount = 1
                        resp.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 9, 0, 1]);
                        let _ = u.send_slice(&resp, meta);
                        changed = true;
                    }
                }
                if !changed { break; }
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn socks_over_wireguard_roundtrip() {
        let server_sk = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let client_sk = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let server_pk = PublicKey::from(&server_sk);
        let client_pk = PublicKey::from(&client_sk);
        let stop = Arc::new(Notify::new());
        let (ready_tx, ready_rx) = oneshot::channel();
        tokio::spawn(test_peer(server_sk.to_bytes(), client_pk.to_bytes(), ready_tx, stop.clone()));
        let server_port = ready_rx.await.unwrap();

        let cfg = WgConfig {
            name: "test".into(),
            private_key: client_sk.to_bytes(),
            address: Ipv4Addr::new(10, 9, 0, 2),
            dns: vec![IpAddr::V4(Ipv4Addr::new(10, 9, 0, 1))],
            peer_public: server_pk.to_bytes(),
            preshared: None,
            endpoint: format!("127.0.0.1:{server_port}"),
            keepalive: Some(5),
            allowed_ips: vec!["0.0.0.0/0".into()],
        };
        let h = start(cfg, 0).await.unwrap();
        let socks_port = h.status().socks_port;

        // handshake completes
        let mut hs = false;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if h.status().handshake_age_secs.is_some() { hs = true; break; }
        }
        assert!(hs, "no WireGuard handshake with in-process peer");

        // SOCKS5 CONNECT by hostname (resolved through the tunnel) and echo 100 KB
        let mut s = TcpStream::connect(("127.0.0.1", socks_port)).await.unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap();
        let mut r = [0u8; 2];
        s.read_exact(&mut r).await.unwrap();
        assert_eq!(r, [5, 0]);
        let host = b"echo.test";
        let mut req = vec![5, 1, 0, 3, host.len() as u8];
        req.extend_from_slice(host);
        req.extend_from_slice(&7u16.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await.unwrap();
        assert_eq!(rep[1], 0, "socks connect failed: {:?}", rep);

        let payload: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let (mut rd, mut wr) = s.into_split();
        let p2 = payload.clone();
        let writer = tokio::spawn(async move { wr.write_all(&p2).await.unwrap(); wr });
        let mut got = vec![0u8; payload.len()];
        tokio::time::timeout(Duration::from_secs(20), rd.read_exact(&mut got)).await.expect("echo timed out").unwrap();
        assert_eq!(got, payload);
        let _wr = writer.await.unwrap();
        tokio::time::sleep(Duration::from_millis(700)).await; // status snapshot refreshes every 500 ms
        let st = h.status();
        assert!(st.tx_bytes > 100_000 && st.rx_bytes > 100_000, "counters: tx={} rx={}", st.tx_bytes, st.rx_bytes);
        h.stop();
        stop.notify_waiters();
    }

    #[test]
    fn parse_provider_conf() {
        let c = parse_conf("mullvad-se1", "[Interface]\nPrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress = 10.64.1.2/32, fc00::2/128\nDNS = 10.64.0.1\n\n[Peer]\nPublicKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = se1-wg.example.net:51820\nPersistentKeepalive = 25\n").unwrap();
        assert_eq!(c.address, Ipv4Addr::new(10, 64, 1, 2));
        assert_eq!(c.dns.len(), 1);
        assert_eq!(c.endpoint, "se1-wg.example.net:51820");
        assert_eq!(c.keepalive, Some(25));
    }
}
