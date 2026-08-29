//! 按节点并发测速：借助 mihomo listeners 的 `proxy` 绑定，把每个待测节点映射为
//! 一个仅监听 127.0.0.1 的本地 mixed 端口，经该端口下载计量得到节点下行速度。
//! 测速期间通过 `update_runtime_config` 叠加监听器（走与切订阅相同的热重载管线），
//! 结束或取消时恢复原配置；全程不影响用户当前选中的节点与连接。

use std::{
    collections::{HashSet, VecDeque},
    net::{SocketAddr, TcpListener},
    string::String as StdString,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::Context as _;
use clash_verge_logging::{Type, logging};
use parking_lot::Mutex;
use reqwest::{Client, Proxy};
use serde::Serialize;
use serde_yaml_ng::Value;
use tauri::ipc::Channel;
use tokio::{net::TcpStream, sync::watch, task::JoinSet, time::sleep};

use crate::{
    config::{Config, MixedPort},
    core::CoreManager,
    process::AsyncHandler,
    singleton,
    utils::port::find_next_available_port,
};

/// 连接（含代理握手）超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// 从发起请求到收到首个数据字节的超时
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(8);
/// 采样窗口：首个数据字节后持续计时的时长
const SAMPLE_WINDOW: Duration = Duration::from_secs(5);
/// 单节点采样上限：下载满即提前结束，避免高速链路白白消耗流量
const MAX_SAMPLE_BYTES: u64 = 25 * 1024 * 1024;
/// 注入监听器后等待内核就绪的上限
const LISTENER_READY_TIMEOUT: Duration = Duration::from_secs(3);
/// 测速监听端口起始偏移（相对 mixed-port，避开常用低位端口段）
const PORT_BASE_OFFSET: u16 = 2000;
/// 并发上限（前端提供 4/8/16，此处做硬性钳制）
const MAX_CONCURRENCY: u32 = 32;

/// 测速参数。抽出结构体以便单测注入更短的超时。
#[derive(Clone, Copy)]
struct SpeedTestParams {
    connect_timeout: Duration,
    first_byte_timeout: Duration,
    sample_window: Duration,
    max_sample_bytes: u64,
}

impl Default for SpeedTestParams {
    fn default() -> Self {
        Self {
            connect_timeout: CONNECT_TIMEOUT,
            first_byte_timeout: FIRST_BYTE_TIMEOUT,
            sample_window: SAMPLE_WINDOW,
            max_sample_bytes: MAX_SAMPLE_BYTES,
        }
    }
}

/// 经 Channel 回传前端的增量事件
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SpeedTestEvent {
    /// 单节点测速完成（成功或失败）
    Item {
        name: StdString,
        ok: bool,
        speed_bps: u64,
        error: Option<StdString>,
    },
    /// 整轮测速结束（全部完成或被取消）
    Done { total: usize, cancelled: bool },
}

/// 供前端查询的运行状态快照
#[derive(Clone, Default, Serialize)]
pub struct SpeedTestStatus {
    pub running: bool,
    pub group: Option<StdString>,
    pub total: usize,
    pub completed: usize,
    pub concurrency: u32,
}

/// start 的结构化失败，命令层据此映射稳定错误码
#[derive(Debug)]
pub enum StartFailure {
    Busy,
    Invalid(StdString),
    Apply(StdString),
}

impl std::fmt::Display for StartFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("speed test already running"),
            Self::Invalid(msg) => write!(f, "invalid speed test request: {msg}"),
            Self::Apply(msg) => write!(f, "failed to apply speed test listeners: {msg}"),
        }
    }
}

struct ActiveRun {
    group: StdString,
    total: usize,
    completed: Arc<AtomicUsize>,
    concurrency: u32,
    cancel: watch::Sender<bool>,
}

pub struct SpeedTestManager {
    active: Mutex<Option<ActiveRun>>,
}

singleton!(SpeedTestManager, SPEED_TEST_MANAGER);

impl Default for SpeedTestManager {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }
}

impl SpeedTestManager {
    fn new() -> Self {
        Self::default()
    }

    /// 启动一轮测速。立即返回，进度经 `on_event` 增量回传；同一时刻仅允许一轮。
    pub async fn start(
        &self,
        group: StdString,
        names: Vec<StdString>,
        concurrency: u32,
        url: StdString,
        on_event: Channel<SpeedTestEvent>,
    ) -> Result<(), StartFailure> {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err(StartFailure::Invalid("test url is empty".into()));
        }
        let names = dedup_preserving_order(names);
        if names.is_empty() {
            return Err(StartFailure::Invalid("no proxy names".into()));
        }
        let concurrency = concurrency.clamp(1, MAX_CONCURRENCY);

        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut active = self.active.lock();
            if active.is_some() {
                return Err(StartFailure::Busy);
            }
            *active = Some(ActiveRun {
                group,
                total: names.len(),
                completed: Arc::new(AtomicUsize::new(0)),
                concurrency,
                cancel: cancel_tx,
            });
        }

        match self.prepare_and_spawn(names, concurrency, url, on_event, cancel_rx).await {
            Ok(()) => Ok(()),
            Err(err) => {
                *self.active.lock() = None;
                Err(err)
            }
        }
    }

    /// 请求取消当前测速；监听器恢复与槽位释放由 supervisor 完成。
    pub fn stop(&self) -> bool {
        let active = self.active.lock();
        match active.as_ref() {
            Some(run) => run.cancel.send(true).is_ok(),
            None => false,
        }
    }

    pub fn status(&self) -> SpeedTestStatus {
        let active = self.active.lock();
        match active.as_ref() {
            Some(run) => SpeedTestStatus {
                running: true,
                group: Some(run.group.clone()),
                total: run.total,
                completed: run.completed.load(Ordering::Relaxed),
                concurrency: run.concurrency,
            },
            None => SpeedTestStatus::default(),
        }
    }

    /// 校验节点、分配端口、注入监听器并启动测量编排任务。
    /// 返回 Err 时槽位由调用方清理，配置不残留测速监听器。
    async fn prepare_and_spawn(
        &self,
        names: Vec<StdString>,
        concurrency: u32,
        url: StdString,
        on_event: Channel<SpeedTestEvent>,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<(), StartFailure> {
        // 读取当前 runtime：用于还原的原始 listeners、节点名合法性校验、保留端口集
        let (config, original_listeners) = {
            let runtime = Config::runtime().await;
            let arc = runtime.latest_arc();
            let config = arc
                .config
                .clone()
                .ok_or_else(|| StartFailure::Apply("runtime config is not ready".into()))?;
            let original_listeners = config.get("listeners").cloned();
            (config, original_listeners)
        };

        let known = known_outbound_names(&config);
        let mut entries = Vec::with_capacity(names.len());
        let mut missing = 0usize;
        for name in &names {
            if known.contains(name.as_str()) {
                entries.push((name.clone(), 0u16));
            } else {
                // 订阅切换等场景下节点可能已不存在：直接判失败，不注入监听器
                missing += 1;
                let _ = on_event.send(SpeedTestEvent::Item {
                    name: name.clone(),
                    ok: false,
                    speed_bps: 0,
                    error: Some("proxy not found in current config".into()),
                });
            }
        }
        let total = names.len();
        let (group, completed_counter) = {
            let active = self.active.lock();
            match active.as_ref() {
                Some(run) => (run.group.clone(), Arc::clone(&run.completed)),
                None => return Err(StartFailure::Apply("speed test slot lost".into())),
            }
        };
        completed_counter.fetch_add(missing, Ordering::Relaxed);

        if entries.is_empty() {
            let _ = on_event.send(SpeedTestEvent::Done { total, cancelled: false });
            *self.active.lock() = None;
            return Ok(());
        }

        // 端口分配：避开 runtime 已占用端口，逐个绑定探测
        let mut reserved = reserved_runtime_ports(&config);
        let mut cursor = MixedPort::desired().await.saturating_add(PORT_BASE_OFFSET);
        for (_, port) in entries.iter_mut() {
            let found = find_next_available_port(cursor, &reserved, |candidate| {
                TcpListener::bind(("127.0.0.1", candidate)).is_ok()
            })
            .ok_or_else(|| StartFailure::Apply("no free local port for speed test".into()))?;
            reserved.insert(found);
            cursor = found;
            *port = found;
        }

        let listeners = crate::config::runtime::build_speed_test_listeners(
            &entries
                .iter()
                .map(|(name, port)| (name.as_str(), *port))
                .collect::<Vec<_>>(),
        );
        let injected = listeners.clone();

        // 叠加监听器并热重载；失败时事务不提交，无需恢复
        let outcome = CoreManager::global()
            .update_runtime_config(move |draft| {
                draft.set_speed_test_listeners(Some(listeners));
            })
            .await
            .map_err(|err| StartFailure::Apply(format!("{err:#}")))?;
        if !outcome.is_valid() {
            return Err(StartFailure::Apply(outcome.to_string()));
        }

        AsyncHandler::spawn(move || async move {
            supervise(
                group,
                entries,
                concurrency,
                url,
                cancel_rx,
                on_event,
                SuperviseContext {
                    total,
                    completed: completed_counter,
                    injected,
                    original_listeners,
                },
            )
            .await;
        });

        Ok(())
    }
}

struct SuperviseContext {
    total: usize,
    completed: Arc<AtomicUsize>,
    injected: Value,
    original_listeners: Option<Value>,
}

/// 测量编排：等待监听器就绪 → 滑动窗口并发测量 → 恢复配置 → 汇报 Done。
/// 无论正常结束、取消还是异常路径，都保证恢复监听器并释放管理器槽位。
async fn supervise(
    group: StdString,
    entries: Vec<(StdString, u16)>,
    concurrency: u32,
    url: StdString,
    cancel_rx: watch::Receiver<bool>,
    on_event: Channel<SpeedTestEvent>,
    ctx: SuperviseContext,
) {
    let ports: Vec<u16> = entries.iter().map(|(_, port)| *port).collect();
    if !wait_listeners_ready(&ports, &cancel_rx).await {
        logging!(warn, Type::Core, "speed test listeners not ready for group {group}");
        for (name, _) in &entries {
            let _ = on_event.send(SpeedTestEvent::Item {
                name: name.clone(),
                ok: false,
                speed_bps: 0,
                error: Some("test listener failed to start".into()),
            });
            ctx.completed.fetch_add(1, Ordering::Relaxed);
        }
    } else {
        run_window(entries, concurrency, url, cancel_rx.clone(), &on_event, &ctx).await;
    }

    // 移交所有权：恢复后仅剩 total（Copy）还需使用
    let total = ctx.total;
    if let Err(err) = restore_listeners(ctx.injected, ctx.original_listeners).await {
        logging!(error, Type::Core, "failed to restore listeners after speed test: {err:#}");
    }
    let _ = on_event.send(SpeedTestEvent::Done {
        total,
        cancelled: *cancel_rx.borrow(),
    });
    *SpeedTestManager::global().active.lock() = None;
}

/// 滑动窗口并发：任一节点完成立即补位（上限 concurrency）
async fn run_window(
    entries: Vec<(StdString, u16)>,
    concurrency: u32,
    url: StdString,
    mut cancel_rx: watch::Receiver<bool>,
    on_event: &Channel<SpeedTestEvent>,
    ctx: &SuperviseContext,
) {
    let params = SpeedTestParams::default();
    let mut queue: VecDeque<(StdString, u16)> = entries.into();
    let mut inflight: JoinSet<(StdString, bool, u64, Option<StdString>)> = JoinSet::new();

    loop {
        while inflight.len() < concurrency as usize
            && let Some((name, port)) = queue.pop_front()
        {
            let url = url.clone();
            let mut cancel = cancel_rx.clone();
            inflight.spawn(async move {
                let result = match build_client(port, params.connect_timeout) {
                    Ok(client) => measure_download(&client, &url, &mut cancel, params).await,
                    Err(err) => (false, 0, Some(err)),
                };
                (name, result.0, result.1, result.2)
            });
        }

        if inflight.is_empty() {
            break;
        }

        tokio::select! {
            joined = inflight.join_next() => {
                match joined {
                    Some(Ok((name, ok, speed_bps, error))) => {
                        let _ = on_event.send(SpeedTestEvent::Item {
                            name,
                            ok,
                            speed_bps,
                            error,
                        });
                        ctx.completed.fetch_add(1, Ordering::Relaxed);
                    }
                    Some(Err(err)) => {
                        // 测量任务 panic 等 JoinSet 层错误：计完成但无法定位节点，仅记日志
                        logging!(error, Type::Core, "speed test task failed: {err}");
                        ctx.completed.fetch_add(1, Ordering::Relaxed);
                    }
                    None => break,
                }
            }
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    inflight.abort_all();
                    break;
                }
            }
        }
    }
}

/// 经指定本地 mixed 监听端口下载测速文件并计量下行速度。
/// 计时从收到首个数据字节开始，达到采样窗口或流量上限即停止。
/// 返回 (ok, speed_bps, error)。
async fn measure_download(
    client: &Client,
    url: &str,
    cancel: &mut watch::Receiver<bool>,
    params: SpeedTestParams,
) -> (bool, u64, Option<StdString>) {
    let response = tokio::select! {
        resp = client.get(url).send() => resp,
        _ = cancel.changed() => {
            return (false, 0, Some("cancelled".into()));
        }
    };

    let mut response = match response {
        Ok(resp) if resp.status().is_success() => resp,
        Ok(resp) => {
            return (false, 0, Some(format!("HTTP status {}", resp.status())));
        }
        Err(err) => {
            return (false, 0, Some(format!("request failed: {err}")));
        }
    };

    let mut bytes: u64 = 0;
    let mut started: Option<Instant> = None;
    loop {
        if let Some(start) = started
            && (bytes >= params.max_sample_bytes || start.elapsed() >= params.sample_window)
        {
            break;
        }

        // 首字节用 first_byte_timeout；之后以采样窗口剩余时间为单次读超时
        let wait = match started {
            None => params.first_byte_timeout,
            Some(start) => params
                .sample_window
                .checked_sub(start.elapsed())
                .unwrap_or(Duration::ZERO),
        };
        if wait.is_zero() {
            break;
        }

        let chunk = tokio::select! {
            chunk = tokio::time::timeout(wait, response.chunk()) => chunk,
            _ = cancel.changed() => {
                return (false, 0, Some("cancelled".into()));
            }
        };

        match chunk {
            Ok(Ok(Some(chunk))) => {
                started.get_or_insert_with(Instant::now);
                bytes += chunk.len() as u64;
            }
            Ok(Ok(None)) => break,
            Ok(Err(err)) => {
                // 传输中断：已采到数据则按已有样本计算，否则视为失败
                if bytes == 0 {
                    return (false, 0, Some(format!("transfer failed: {err}")));
                }
                break;
            }
            Err(_) => break, // 超时：采样窗口结束
        }
    }

    match started {
        Some(start) => (true, compute_speed_bps(bytes, start.elapsed()), None),
        None => (false, 0, Some("no data received".into())),
    }
}

/// 速度换算（字节/秒）；耗时过短时按至少 1ms 计，避免除零
fn compute_speed_bps(bytes: u64, elapsed: Duration) -> u64 {
    let millis = elapsed.as_millis().max(1);
    bytes * 1000 / millis as u64
}

fn build_client(port: u16, connect_timeout: Duration) -> Result<Client, StdString> {
    let proxy = Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|err| format!("failed to create proxy: {err}"))?;
    Client::builder()
        .proxy(proxy)
        .connect_timeout(connect_timeout)
        .build()
        .map_err(|err| format!("failed to create client: {err}"))
}

/// 轮询探测所有监听端口可连，最多等待 LISTENER_READY_TIMEOUT
async fn wait_listeners_ready(ports: &[u16], cancel_rx: &watch::Receiver<bool>) -> bool {
    let deadline = Instant::now() + LISTENER_READY_TIMEOUT;
    loop {
        let all_ready = futures_all_ready(ports).await;
        if all_ready {
            return true;
        }
        if Instant::now() >= deadline || *cancel_rx.borrow() {
            return false;
        }
        sleep(Duration::from_millis(100)).await;
    }
}

async fn futures_all_ready(ports: &[u16]) -> bool {
    for port in ports {
        let connected =
            tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(("127.0.0.1", *port)))
                .await
                .map(|result| result.is_ok())
                .unwrap_or(false);
        if !connected {
            return false;
        }
    }
    true
}

/// 仅当当前 listeners 仍等于注入值时才恢复，避免测速期间配置被外部
/// （如切换订阅）重建后误删新配置里的内容。
async fn restore_listeners(injected: Value, original: Option<Value>) -> anyhow::Result<()> {
    let outcome = CoreManager::global()
        .update_runtime_config(move |draft| {
            let current = draft
                .config
                .as_ref()
                .and_then(|config| config.get("listeners"))
                .cloned();
            if current.as_ref() == Some(&injected) {
                draft.set_speed_test_listeners(original);
            } else {
                logging!(
                    warn,
                    Type::Core,
                    "runtime listeners changed during speed test, skip restoring"
                );
            }
        })
        .await
        .context("failed to restore runtime listeners")?;
    if !outcome.is_valid() {
        anyhow::bail!("restore rejected by validator: {outcome}");
    }
    Ok(())
}

/// 去重并保持原有顺序
fn dedup_preserving_order(names: Vec<StdString>) -> Vec<StdString> {
    let mut seen = HashSet::new();
    names
        .into_iter()
        .filter(|name| !name.is_empty() && seen.insert(name.clone()))
        .collect()
}

/// runtime 配置中可被 listeners.proxy 引用的出站名（节点与策略组）
fn known_outbound_names(config: &serde_yaml_ng::Mapping) -> HashSet<&str> {
    let mut names = HashSet::new();
    for key in ["proxies", "proxy-groups"] {
        if let Some(Value::Sequence(items)) = config.get(key) {
            for item in items {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    names.insert(name);
                }
            }
        }
    }
    names
}

/// 汇总 runtime 已占用的监听端口，端口分配时避开
fn reserved_runtime_ports(config: &serde_yaml_ng::Mapping) -> HashSet<u16> {
    let mut ports = HashSet::new();
    for key in ["mixed-port", "port", "socks-port", "redir-port", "tproxy-port"] {
        if let Some(port) = config.get(key).and_then(Value::as_u64)
            && let Ok(port) = u16::try_from(port)
        {
            ports.insert(port);
        }
    }
    if let Some(controller) = config
        .get("external-controller")
        .and_then(Value::as_str)
        .and_then(|addr| addr.parse::<SocketAddr>().ok())
    {
        ports.insert(controller.port());
    }
    ports
}

#[cfg(test)]
mod speed_test_tests {
    use super::{SpeedTestParams, compute_speed_bps, measure_download, reserved_runtime_ports};
    use serde_yaml_ng::{Mapping, Value};
    use std::{
        string::String as StdString,
        time::{Duration, Instant},
    };
    use tokio::{
        io::{AsyncReadExt as _, AsyncWriteExt as _},
        net::{TcpListener, TcpStream},
        sync::watch,
    };

    fn fast_params() -> SpeedTestParams {
        SpeedTestParams {
            connect_timeout: Duration::from_secs(2),
            first_byte_timeout: Duration::from_secs(2),
            sample_window: Duration::from_millis(300),
            max_sample_bytes: 64 * 1024,
        }
    }

    #[test]
    fn speed_calculation_guards_zero_elapsed() {
        assert_eq!(compute_speed_bps(1000, Duration::ZERO), 1_000_000);
        assert_eq!(compute_speed_bps(1000, Duration::from_secs(1)), 1000);
        assert_eq!(compute_speed_bps(1500, Duration::from_millis(500)), 3000);
    }

    #[test]
    fn reserved_ports_covers_numeric_and_controller() {
        let mut config = Mapping::new();
        config.insert("mixed-port".into(), Value::from(7897_u64));
        config.insert("port".into(), Value::from(7890_u64));
        config.insert("external-controller".into(), Value::from("127.0.0.1:9097"));
        config.insert("mode".into(), Value::from("rule"));

        let ports = reserved_runtime_ports(&config);
        assert!(ports.contains(&7897));
        assert!(ports.contains(&7890));
        assert!(ports.contains(&9097));
    }

    /// 读走一个 HTTP 请求头（测速请求无 body）
    async fn drain_request(stream: &mut TcpStream) -> anyhow::Result<()> {
        let mut buf = [0u8; 1024];
        let mut got = Vec::new();
        loop {
            let n = stream.read(&mut buf).await?;
            if n == 0 {
                return Ok(());
            }
            got.extend_from_slice(&buf[..n]);
            if got.windows(4).any(|window| window == b"\r\n\r\n") {
                return Ok(());
            }
        }
    }

    fn chunked_headers() -> StdString {
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".into()
    }

    /// 持续快发数据的测速服务器
    async fn spawn_streaming_server() -> anyhow::Result<(u16, tokio::task::JoinHandle<()>)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = drain_request(&mut stream).await;
                let _ = stream.write_all(chunked_headers().as_bytes()).await;
                let block = vec![b'x'; 8 * 1024];
                for _ in 0..64 {
                    let chunk_header = format!("{:x}\r\n", block.len());
                    let _ = stream.write_all(chunk_header.as_bytes()).await;
                    let _ = stream.write_all(&block).await;
                    let _ = stream.write_all(b"\r\n").await;
                }
                let _ = stream.write_all(b"0\r\n\r\n").await;
            }
        });
        Ok((port, handle))
    }

    /// 回响应头后挂住不发的服务器
    async fn spawn_stalling_server() -> anyhow::Result<(u16, tokio::task::JoinHandle<()>)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = drain_request(&mut stream).await;
                let _ = stream.write_all(chunked_headers().as_bytes()).await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        Ok((port, handle))
    }

    /// 慢速持续发送的服务器（每 50ms 一个小块），保证测试期间下载一直进行中
    async fn spawn_slow_server() -> anyhow::Result<(u16, tokio::task::JoinHandle<()>)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = drain_request(&mut stream).await;
                let _ = stream.write_all(chunked_headers().as_bytes()).await;
                let block = vec![b'x'; 4 * 1024];
                for _ in 0..1024 {
                    let chunk_header = format!("{:x}\r\n", block.len());
                    let _ = stream.write_all(chunk_header.as_bytes()).await;
                    let _ = stream.write_all(&block).await;
                    let _ = stream.write_all(b"\r\n").await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        });
        Ok((port, handle))
    }

    #[tokio::test]
    async fn measures_download_speed_from_stream() -> anyhow::Result<()> {
        let (port, server) = spawn_streaming_server().await?;

        let client = reqwest::Client::builder().build()?;
        let (_tx, mut rx) = watch::channel(false);
        let url = format!("http://127.0.0.1:{port}/speedtest");

        let started = Instant::now();
        let (ok, speed, error) = measure_download(&client, &url, &mut rx, fast_params()).await;
        let elapsed = started.elapsed();

        assert!(ok, "expected success, error: {error:?}");
        assert!(speed > 0);
        // 采样窗口 300ms，测量应在窗口后立即结束（留足服务器发送余量）
        assert!(elapsed < Duration::from_secs(2), "took too long: {elapsed:?}");

        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn first_byte_timeout_reports_failure() -> anyhow::Result<()> {
        let (port, server) = spawn_stalling_server().await?;

        let client = reqwest::Client::builder().build()?;
        let (_tx, mut rx) = watch::channel(false);
        let url = format!("http://127.0.0.1:{port}/stall");

        let started = Instant::now();
        let (ok, _, error) = measure_download(&client, &url, &mut rx, fast_params()).await;

        assert!(!ok);
        assert!(error.is_some());
        // 首字节超时 2s 兜底，不应挂满服务器的 5s
        assert!(started.elapsed() < Duration::from_secs(4));

        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn cancel_during_download_stops_early() -> anyhow::Result<()> {
        let (port, server) = spawn_slow_server().await?;

        let client = reqwest::Client::builder().build()?;
        let (tx, mut rx) = watch::channel(false);
        let url = format!("http://127.0.0.1:{port}/cancel");

        // 100ms 后触发取消
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = tx.send(true);
        });

        let started = Instant::now();
        let (ok, _, error) = measure_download(&client, &url, &mut rx, fast_params()).await;

        assert!(!ok);
        assert_eq!(error.as_deref(), Some("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(2));

        server.abort();
        Ok(())
    }
}
