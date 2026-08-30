# Clash Verge Rev 架构与模块说明

> 本文档描述项目的整体架构、各模块职责、关键函数与核心调用链，
> 供新贡献者快速建立全貌认知。生成日期：2026-08-29。

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 架构总览](#2-架构总览)
- [3. 后端模块（src-tauri/src）](#3-后端模块src-taurisrc)
- [4. Workspace Crates（crates/）](#4-workspace-cratescrates)
- [5. 关键外部依赖](#5-关键外部依赖)
- [6. 前端模块（src/）](#6-前端模块src)
- [7. 核心调用链](#7-核心调用链)

---

## 1. 项目概览

**Clash Verge Rev** 是基于 **Tauri 2** 的跨平台 Clash/Mihomo 图形客户端。

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 + TypeScript + MUI + SWR（自封装 query-client）+ react-router v7 + i18next（13 语言）+ @tanstack/react-virtual + monaco-editor |
| 后端 | Rust（tokio 异步运行时）+ Tauri 2 插件体系 |
| 内核 | mihomo（Meta）作为 sidecar 子进程或系统服务运行，经 external-controller（REST/WebSocket/UDS）控制 |
| 平台 | Windows（NSIS/MSVC）、macOS（app/dmg）、Linux（deb/rpm/AppImage） |

```
仓库根
├── src/                    # 前端（React）
├── src-tauri/              # 后端（Rust，Tauri 主程序）
│   ├── src/
│   │   ├── cmd/            # Tauri 命令层（前端 IPC 入口）
│   │   ├── config/         # 四层配置体系（verge/clash/profiles/runtime）
│   │   ├── core/           # 核心运行时（内核生命周期/服务/系统代理/托盘…）
│   │   ├── enhance/        # 配置合成管线（profiles → 最终 mihomo 配置）
│   │   ├── feat/           # 业务特性层（cmd/托盘/热键收敛于此）
│   │   ├── module/         # 独立功能模块（自动备份/轻量模式/测速）
│   │   ├── process/        # 任务派发原语
│   │   └── utils/          # 工具层（路径/初始化/单例锁/网络…）
│   └── tauri.{macos,windows,linux}.conf.json   # 平台打包配置
├── crates/                 # workspace 成员（draft/i18n/logging/限流/解锁检测/信号/系统信息）
├── scripts/                # 构建/开发脚本（prebuild/dev/i18n/版本管理）
└── docs/                   # 文档
```

---

## 2. 架构总览

### 2.1 分层

```
┌──────────────────────────────────────────────────────────┐
│ 前端 React                                                │
│  pages → components → hooks → services(cmds/delay/speed)  │
│        ↕ invoke(Tauri IPC)   ↕ emit/listen(事件)           │
├──────────────────────────────────────────────────────────┤
│ 命令层 cmd/                                               │
│  ##[tauri::command] 薄封装 → feat/ + core/ + config/       │
├──────────────────────────────────────────────────────────┤
│ 业务层 feat/ + 模块 module/                                │
│  patch 配置 / 内核生命周期 / 系统代理 / 窗口 / 订阅更新      │
├──────────────────────────────────────────────────────────┤
│ 核心层 core/ + 配置层 config/ + 合成管线 enhance/           │
│  CoreManager(RunState) · ServiceManager · Sysopt · Draft   │
├──────────────────────────────────────────────────────────┤
│ mihomo 内核（sidecar 子进程 或 系统服务）                    │
│  ↕ tauri-plugin-mihomo（REST/WS/UDS）                      │
│  ↕ clash-verge-service-ipc（服务模式 IPC）                  │
└──────────────────────────────────────────────────────────┘
```

### 2.2 核心抽象

| 抽象 | 位置 | 说明 |
| --- | --- | --- |
| `Config` 单例 | `config/config.rs` | 持有 4 个 `Draft<T>`：clash（内核层）/ verge（应用层）/ profiles（订阅）/ runtime（合成产物）；`CONFIG_WRITE_LOCK` 串行化跨层事务 |
| `Draft<T>` | `crates/clash-verge-draft` | 写时复制草稿：committed 快照 + draft 编辑区，`DraftTransaction` 跨多层原子提交/回滚 |
| `CoreManager` 单例 | `core/manager/` | 内核进程生命周期（start/stop/restart/change_core/配置应用），锁序 `config_update → lifecycle` |
| `RunStateStore` | `core/runstate/` | 运行状态权威（RunningMode=Sidecar/Service、ServiceHealth、PendingAction），每次变迁推送前端 |
| `ServiceManager` 单例 | `core/service.rs` | 特权服务安装/卸载/IPC/staging（Windows sc.exe、macOS launchctl+osascript、Linux systemd） |
| `Handle` 单例 | `core/handle.rs` | AppHandle 出口 + `mihomo()` 客户端 + 前端事件发送（refresh_* / notice / run-state） |
| `singleton!` 宏 | `utils/singleton.rs` | `XxxManager::global()` 静态实例惯用法 |

---

## 3. 后端模块（src-tauri/src）

### 3.1 入口：`main.rs` + `lib.rs`

- **`main.rs`**：自建 tokio multi-thread runtime（worker ≤ min(CPU,8)），`tauri::async_runtime::set()` 后调 `app_lib::run()`。
- **`lib.rs` `run()` 启动序列**：
  1. macOS release：`macos_launch_guard::enforce_before_initialization()`（拒绝非 /Applications 位置启动）
  2. `dirs::init_portable_flag()`（便携模式）
  3. `server::check_singleton()` 单实例检查（次实例经内嵌 HTTP 通知主实例 `/commands/visible|scheme` 后退出）
  4. Linux：NVIDIA dmabuf / Wayland WebKit 环境补丁
  5. `setup_plugins` + `.setup()`（初始化日志/自启/深链接/窗口状态）+ `invoke_handler(generate_handlers())`
  6. macOS：注册 `on_web_content_process_terminate`（WKWebView 白屏恢复）
  7. `app.run()` 消费 `RunEvent`：`Ready/Resumed`（放开内嵌 server 命令）、`Reopen`（Dock 点击）、`ExitRequested`（拦关闭→`feat::quit`）、窗口事件（关闭即隐藏、焦点切换 CmdQ/CmdW 系统热键）

**插件注册**：sysinfo、notification、updater、clipboard-manager、process、global-shortcut、fs、dialog、shell、opener、deep-link、http、mihomo（LocalSocket 协议）+ setup 期 autostart、window-state。

### 3.2 命令层 `cmd/`（前端 IPC 入口，薄封装）

约定：`CmdResult<T> = Result<T, CommandFailure>`；`CommandFailure{code?, detail}` 序列化为前端错误码契约；`proxy_aware_coded_error` 优先透出 `SysproxyFailure` 分类码。

| 子模块 | 命令（代表性） | 委托目标 |
| --- | --- | --- |
| `verge.rs` | `get_verge_config` / `patch_verge_config` | `feat::patch_verge` |
| `clash.rs` | `patch_clash_config` / `patch_clash_mode` / `change_clash_core` / `start/stop/restart_core` / `upgrade_clash_core` / `save/apply_dns_config` / `get_clash_logs` / `test_delay` | feat / CoreManager |
| `profile.rs` | `get/import/create/update/delete/reorder_profile` / `patch_profiles_config` / `enhance_profiles` / `get_next_update_time` | feat::profile + config::profiles |
| `proxy.rs` | `get_proxy_view` / `record/forget_selected_node` / `sync_tray_proxy_selection` | `ProxyViewBuilder` / profiles / Tray |
| `runtime.rs` | `get_runtime_config/yaml/logs` / `update_proxy_chain_config_in_runtime` | CoreManager::update_runtime_config |
| `service.rs` | `install/uninstall/reinstall/repair_service` / `continue_with_sidecar` | ServiceManager / CoreManager |
| `speed_test.rs` | `start_speed_test` / `stop_speed_test` / `get_speed_test_status` | `SpeedTestManager` |
| `network.rs` | `get_sys_proxy` / `get_auto_proxy` / `get_network_interfaces*` / `get_embedded_server_port` | sysproxy / sysinfo 插件 |
| `backup.rs` / `webdav.rs` | 本地与 WebDAV 备份 CRUD | `feat::backup` |
| `listener.rs` | `probe_listener` / `save_proxy_ports` | `core::listener` / feat |
| `lightweight.rs` | `entry/exit_lightweight_mode` | `module::lightweight` |
| `media_unlock_checker/` | `check_media_unlock(Channel)` 等 3 个 | clash-verge-media-unlock crate |
| `app.rs` / `system.rs` / `uwp.rs` / `validate.rs` / `save_profile.rs` | 目录打开/退出重启/运行状态/UWP 回环/脚本校验/写文件 | 各处 |

### 3.3 配置层 `config/`

| 文件 | 职责与关键函数 |
| --- | --- |
| `config.rs` | `Config` 单例。`init_config_before_window()`（默认 Merge/Script 项+locale）、`init_runtime_config()`（端口仲裁→generate→校验→失败兜底最小配置）、`generate[_with_profiles]()`（调 `enhance::enhance` 写 runtime draft）、`generate_file(Run/Check)`、`apply_all_and_save_file()`（退出三路并行保存）、TUN 会话抑制组 |
| `clash.rs` | `IClashTemp(Mapping)` 内核层配置。`patch_config`、`save_config`、`get_mixed_port`、`get_client_info()→ClashInfo`（拼 ext-controller 地址）、`guard_external_controller_ipc()` |
| `verge.rs` | `IVerge` 应用设置全集（TUN/自启/系统代理/托盘/热键/端口/主题/WebDAV…，敏感字段加密）。`validate_and_fix_config()`（启动修复+迁移）、`patch_config`、`get_valid_clash_core` |
| `profiles.rs` | `IProfiles` 订阅列表+current+每组选中节点。`current_mapping()`（读当前 profile YAML）、`plan_delete_item`、`raise_short_update_intervals`；safe 家族（`PROFILE_WRITE_LOCK` 串行）；选中节点子系统 `record/forget/activate/restore_selected_nodes` |
| `prfitem.rs` | `PrfItem`（remote/local/script/merge/rules/proxies/groups 七类）。`from_url()`（NetworkManager 下载，解析 subscription-userinfo）、链项取值 `current_merge/script/…` |
| `runtime.rs` | `IRuntime`（合成产物+exists_keys+chain_logs）。`patch_config`、`update_proxy_chain_config`、`set_speed_test_listeners` + `build_speed_test_listeners`（测速监听器注入） |
| `port.rs` / `mixed_port.rs` | 启动端口仲裁 `resolve_startup_mixed_port()`（占用→找空闲→会话级 fallback，不落盘）；`MixedPort::{desired,effective}` |
| `encrypt.rs` | 敏感字段加解密（密钥 `dirs::get_encryption_key`） |
| `snapshot.rs` | 配置文件快照/恢复（备份回滚原子性） |

### 3.4 核心层 `core/`

**`manager/`（CoreManager 四文件分工）**

| 文件 | 职责与关键函数 |
| --- | --- |
| `mod.rs` | 结构定义 + `init()`（启动入口，最多 3 次端口降级重试 `start_core`）；状态原语 `core_started/stopped/starting`、`try_start/finish_config_update` |
| `state.rs` | 进程原语：`start_core_by_sidecar()`（spawn 子进程 + Windows Job Object + ext-controller 就绪轮询）、`stop_core_by_sidecar_unprepared`、`start/stop_core_by_service`、`get_clash_logs` |
| `lifecycle.rs` | 决策与状态机：`startup_decision(ServiceStatus)` → Service/Sidecar/Wait；transition runner 保证 RunState 代数一致；`start/stop/restart_core`、`change_core`、`replace_service_core_with_config`；Windows `try_handoff_sidecar_to_service`（sidecar 就绪后 120s 窗口交回服务） |
| `config.rs` | 配置应用策略：`update_config_checked/forced[_with_profiles]`（300ms debounce）、`update_runtime_config(f)`（DraftTransaction）；`validate_and_apply → apply_config`：service 模式走 staging 协商（ReloadFrom/ReplaceCore/Fail），sidecar 模式 `reload_or_restart`（mihomo PUT 失败则重启内核） |

**其余 core 文件**

| 文件 | 职责与关键函数 |
| --- | --- |
| `handle.rs` | `Handle::app_handle()/mihomo()`；事件出口 `refresh_clash/verge/profiles`、`notify_run_state`、`notice_message`；退出标志；macOS 激活策略 |
| `service.rs`（约 2000 行） | `ServiceManager`：`detect_startup_status/refresh/handle_service_status`；`run_privileged_service_action`（osascript/sc.exe/pkexec 提权装卸）；`stage_runtime_by_service`（runtime staging）；`set_system_proxy_by_service`；owner 监控 `start_owner_monitor/recover_after_owner_loss` |
| `sysopt.rs` | `Sysopt` 系统代理写入/守护：`update_sysproxy()`（幂等：先快照比对）、`reset_sysproxy`、`refresh_guard`、失败恢复 |
| `proxy_control.rs` | 系统代理门面：`apply/clear/refresh_guard`（按运行模式路由本地 Sysopt 或经服务）；`SysproxyFailure` 错误分类（稳定码）；失败登记 `notification::record_failure` |
| `proxy_view.rs` | `ProxyViewBuilder::build()`：mihomo proxies/providers/selections/runtime → 前端 `ProxyViewV1`（组/节点/来源/订阅流量） |
| `tray/` | `Tray::init/update_menu/update_icon/update_part/update_speed_task`；菜单事件分发到 feat；`TrayAction` 左键行为；`speed_task.rs`（macOS 托盘速率，消费 `/traffic` WS） |
| `hotkey.rs` | `Hotkey`：`init/register/unregister/reset/update`；`HotkeyFunction` enum 回调直调 feat；macOS `SystemHotkey(CmdQ/CmdW)` |
| `timer.rs` | `Timer`：订阅定时更新 cron 调度；`refresh()`、`get_next_update_time(uid)`；到点 spawn `feat::update_profile` |
| `updater.rs` | `SilentUpdater`：`try_install_on_startup`、`start_background_check`（应用自身静默更新） |
| `backup.rs` | `WebDavClient::global()`（upload/download/list/delete）；`create_backup()`（zip 打包配置目录） |
| `logger.rs` | `Logger::init/update_log_level/update_log_config`；sidecar stdout → AsyncLogger → 日志文件 |
| `notification.rs` | ①前端事件 `FrontendEvent` + `NotificationSystem::send_event`；②失败登记表 `PendingFailure`（系统代理失败→前端待处理提示） |
| `listener.rs` | 端口探测纯逻辑：`probe_listener`（TCP/UDP bind 探测）、`probe_mixed_port`、`validate`（端口保存冲突检测） |
| `autostart.rs` | `update_launch()`（autostart 插件；Windows 委托 `utils/schtasks.rs`） |
| `runstate/` | `RunStateStore`（`RUN_STATE`）：`state/probe/observe/request_action/perform`；`health.rs`（RunState/ServiceHealth/RunStateView）、`owner.rs`（服务所有者漂移采样）、`probe.rs`（服务版本探测分类） |
| `runtime_bundle.rs` | `collect_runtime_bundle()`：service 模式打包配置+内核+geo 资产传输给服务 |
| `validate.rs` | `CoreConfigValidator`：起内核二进制 `-t` 校验；`ValidationOutcome{Valid/Invalid/Skipped/Busy}` |
| `owner_identity.rs` | 应用所有者凭证（uid/gid、Windows pipe SDDL）→ 服务会话证明 `OwnerSessionProof` |
| `win_uwp.rs` | UWP 回环限制解除（仅 Windows） |

### 3.5 合成管线 `enhance/`

入口 `enhance(profiles) -> (Mapping, exists_keys, chain_logs)`，步骤：

```
get_config_values(开关快照)
→ collect_profile_items(当前 profile YAML + 7 个链项并行解析)
→ process_seq_items(rules/proxies/groups 的 prepend/append/delete)
→ merge_default_config(verge/clash 控制面覆盖: tun/端口/ext-controller)
→ apply_builtin_scripts(内置 JS 链, boa 沙箱)
→ use_tun(开: 补 DNS+macOS 设系统 DNS; 关: 移除+恢复)
→ apply_dns_settings(dns_config.yaml 覆盖)
→ AuthoritativeFields::capture(控制面键快照)
→ 全局 Merge + Script → Profile 级 Merge + Script
→ authoritative.enforce(恢复控制面快照, 防脚本越权)
→ ensure_lan_bind_address → cleanup_proxy_groups(剔除悬空引用) → use_sort
```

子文件：`field.rs`（键规范化/排序）、`merge.rs`（递归深合并）、`script.rs`（boa 沙箱执行 JS，5s 超时+输出上限）、`seq.rs`（序列字段增删）、`chain.rs`（ChainItem 与内置链）、`tun.rs`（TUN/DNS 联动）。

### 3.6 业务层 `feat/`

| 文件 | 关键函数 |
| --- | --- |
| `config.rs` | `patch_clash(&Mapping)`（按键分流：ext-controller 变更→重启内核；其余→热更新）；`patch_verge(patch)`（`determine_update_flags` 位标志分发到 autostart/hotkey/tray/logger/proxy_control/CoreManager/i18n/lightweight → 事务提交+保存） |
| `clash.rs` | `restart_clash_core`、`restart_app`、`change_clash_mode`（mihomo PATCH + 托盘 + 可选断开全部连接）、`test_delay` |
| `profile.rs` | `update_profile(uid, opt, manual)`（直连→self_proxy→with_proxy 三档降级下载；成功后热更新配置）；`enhance_profiles`；`switch_proxy_node`（select + 记录选中 + 托盘） |
| `window.rs` | `quit()`（保存→受控停核→失败取消退出）、`clean_async`（macOS 恢复 DNS）、`open_or_close_dashboard`、`hide` |
| `core_upgrade.rs` | `upgrade_core(force)`：下载替换 mihomo → `change_core` |
| `backup.rs` | WebDAV 与本地备份全套（zip + snapshot 恢复后重初始化） |
| `proxy.rs` | `toggle_system_proxy`、`toggle_tun_mode`、`copy_clash_env` |
| `tun.rs` | `reconcile_tun_availability`：TUN 期望态 vs 实际态对账（权限/服务不可用时抑制） |
| `listener.rs` | `save_proxy_ports`（校验+写配置+必要时重启内核） |
| `icon.rs` | 图标下载缓存/拷贝 |

### 3.7 功能模块 `module/`

| 文件 | 职责 |
| --- | --- |
| `auto_backup.rs` | `AutoBackupManager`：定时/变更触发备份（watch channel 通知 runner；zip + WebDAV 上传） |
| `lightweight.rs` | 轻量模式（销毁 webview 省内存，仅留托盘+内核）：`entry/exit_lightweight_mode`、隐藏后自动计时进入 |
| `speed_test.rs` | `SpeedTestManager`：`start()`（节点校验→`build_speed_test_listeners` 注入 127.0.0.1 mixed 监听→热重载→JoinSet 滑动窗口并发下载计量→Channel 增量回传→恢复配置）；`stop()`（watch 取消）；`status()` |

### 3.8 工具层 `utils/`（择要）

| 文件 | 职责 |
| --- | --- |
| `dirs.rs` | 全部路径解析（app_home/resources/profiles/logs/service/IPC path/加密密钥） |
| `init.rs` | `init_config()`（目录+三配置模板+修复迁移）、`init_resources()`（geo 资源）、`init_scheme()`（URL scheme 注册）、`delete_log` |
| `server.rs` | 单实例检查 + 内嵌 HTTP 服务（次实例唤醒主实例；Ready 后放开命令）；PAC 下发 |
| `network.rs` | `NetworkManager::get(url, ProxyType)`（订阅/图标下载，代理三档） |
| `help.rs` | YAML 读写（原子写）、`mask_url`（日志脱敏）、打开文件/日志 |
| `resolve/` | 启动编排：`resolve_setup_async/sync`（服务探测→建窗→runtime 配置→CoreManager::init→Tray/Timer/Hotkey/自动备份/静默更新并行初始化）；`window.rs`（建窗+WKWebView 白屏恢复）；`scheme.rs`（clash:// 导入）；`dns.rs`（macOS TUN DNS 保护） |
| `window_manager.rs` | `WindowManager`：主窗口显示/切换/销毁（轻量模式）、Dock 策略切换 |
| `singleton.rs` | `singleton!` 宏（`global()` 惯用法） |
| `macos_launch_guard.rs` | 安装位置守卫（App Translocation 检测、强制 /Applications） |
| `tray_speed.rs` / `connections_stream.rs`（macOS） | NSStatusItem 富文本速率 / mihomo WS 流消费 |
| `schtasks.rs`（Windows） | 计划任务自启 |
| `tmpl.rs` / `yaml_emitter.rs` | profile 模板 / mihomo 兼容 YAML 输出 |

### 3.9 `constants.rs`

默认端口（mixed 7897 / socks 7898 / http 7899 / redir 7895 / tproxy 7896）、`DEFAULT_EXTERNAL_CONTROLLER 127.0.0.1:9097`、timing（配置更新 debounce 300ms、服务等待 30s、交接窗口 120s…）、文件名（`clash-verge.yaml` 运行时配置等）。

---

## 4. Workspace Crates（crates/）

| crate | 职责 | 关键导出 | 主要使用方 |
| --- | --- | --- | --- |
| `clash-verge-draft` | 写时复制配置草稿层（committed 快照 + draft 编辑区 + 跨层事务） | `Draft<T>`、`SharedDraft<T>`、`DraftTransaction` | config/*、core/manager/config、feat/config |
| `clash-verge-i18n` | 后端国际化（rust-i18n，13 语言 YAML，zh 回退） | `t!` 宏、`set_locale/sync_locale` | 托盘菜单、服务、通知等约 48 处 |
| `clash-verge-logging` | 统一日志门面（分类枚举 + 宏 + sidecar 日志管道） | `logging!`/`logging_error!`、`Type`（19 类）、`AsyncLogger` | 全仓约 70 文件 |
| `clash-verge-limiter` | 最小时间限流器（原子 CAS，Clock 可注入） | `Limiter<C>`、`SystemLimiter` | 托盘刷新、窗口管理 |
| `clash-verge-media-unlock` | 流媒体解锁检测（12 项，JoinSet 并发 4） | `check_media_unlock(client, on_complete)` | cmd/media_unlock_checker |
| `clash-verge-signal` | 优雅关机信号（unix/windows 回调 + ShutdownLatch） | `register(f)`、`ShutdownOutcome` | feat/window、resolve（退出链） |
| `tauri-plugin-clash-verge-sysinfo` | 系统/应用信息插件（OS/版本/运行模式/管理员/网卡） | `init()`、`set_app_core_mode`、`current_gid`、commands | lib.rs、manager、service |

---

## 5. 关键外部依赖

| 依赖 | 用途 |
| --- | --- |
| `tauri-plugin-mihomo`（git） | mihomo API/WebSocket 客户端。经 `Handle::mihomo()` 使用：`get_proxies/get_base_config/patch_base_config/reload_config/select_node_for_group/close_all_connections/ws_traffic/get_version/update_socket_path` |
| `clash_verge_service_ipc`（git v2.6.5） | 特权服务 IPC 协议：服务标识常量、`OwnerIdentity/OwnerSessionProof`（会话凭证）、RPC（`start/stop_clash`、`stage_runtime`、`set_system_proxy(MacosProxyConfig)`、`get_clash_logs`）、`RuntimeBundle` staging 类型 |
| `sysproxy`（git） | 系统代理读写与守护（`Sysproxy/Autoproxy/GuardMonitor`） |
| `parking_lot` / `arc-swap` / `once_cell` | 同步原语（细粒度锁 / 无锁 Arc 替换 / 单例） |
| `reqwest`（rustls） | HTTP 客户端（订阅下载、测速、检测） |
| `serde_yaml_ng` + `smartstring` | YAML 序列化 + 内联小字符串键 |
| `boa_engine` | JS 沙箱（Merge/Script 链执行） |
| `objc2` 系列（macOS） | NSStatusItem 富文本速率渲染 |

---

## 6. 前端模块（src/）

### 6.1 入口与全局（`main.tsx` + `providers/`）

`main.tsx` 启动：`preloadAppData()`（verge 配置→语言→主题预载）→ Provider 树
`ThemeMode → LoadingCache → UpdateState → SWRConfig → Window → AppData → Router`。

**`app-data-provider.tsx`（全局数据中枢）** 挂载的 SWR 查询：

| QueryKey | 来源 | 轮询 |
| --- | --- | --- |
| `getProxyView` | Rust `get_proxy_view` | 15s |
| `getClashConfig` | mihomo `getBaseConfig` | — |
| `getRules` / `getRuleProviders` | mihomo | — |
| `getSystemProxy` | Rust | staleTime 5s |
| `getRuntimeState` | Rust（事件驱动+30s 兜底） | — |
| `appUptime` | sysinfo 插件 | 3s |

派生上下文（`app-data-context.ts`）：`useProxiesData/useRulesData/useClashConfigData/useSystemData/useUptimeData/useCoreDataStatus/useAppRefreshers`（refreshProxy/refreshClashConfig/refreshRules/refreshSysproxy/refreshAll）。

### 6.2 服务层 `services/`

| 文件 | 职责与关键导出 |
| --- | --- |
| `cmds.ts` | 全部 Rust invoke 封装（按 profile/clash/verge/代理/服务/备份/网络分组，约 60 个函数） |
| `delay.ts` | `DelayManager` 单例：`checkListDelay`（批量，并发 min(36,n,10)，整批 settle 才通知排序）、`checkDelay`、`getDelayFix`（回退节点 history）、`formatDelay/Color`；缓存 TTL 30min，`-2`=testing |
| `speed.ts` | `SpeedManager` 单例：`startTest`（invoke + Channel 增量事件）、`stopTest/refreshStatus`、`addGroupListener`（settle→重排）、`getStoredSpeedTestOptions`（并发 4/8/16+URL 持久化）、`bindConfigWatch`（配置变更自动停止测速） |
| `events.ts` | `subscribeVergeEvents(handlers)`：类型化事件表（refresh-*/notice/run-state/pending-failures/profile-*）+ 同步 teardown |
| `notice-service.ts` | 通知 store（`showNotice.*`）；`CODED_ERROR_TRANSLATION_KEYS` 后端错误码→i18n |
| `query-client.ts` | SWR 适配层（react-query 风格 `useQuery` + 同步镜像 `queryCache`） |
| `i18n.ts` | i18next 初始化（分节懒加载 + 启动预载分节） |
| `use-mihomo-ws` 相关 | `traffic-monitor-worker.ts`（Web Worker 流量采样）、`service-request.ts`（提权请求信箱）、`update.ts`（semver 归一化）、`api.ts`（IP 信息聚合） |

### 6.3 Hooks（`hooks/`，择要）

| Hook | 说明 |
| --- | --- |
| `use-verge` / `use-clash` / `use-profiles` | 配置读取+patch（乐观更新→invoke→refetch） |
| `use-proxy-delay-state(member, group)` | 单节点延迟徽章（订阅 delayManager listener） |
| `use-group-delays` / `use-group-speeds` | 组级 settle 快照 → 驱动 `useRenderList` 缓存失效重排 |
| `use-speed-state` | `useSpeedState(name)` 速度徽章 / `useSpeedRunStatus()` 测速进度 |
| `use-proxy-selection` | 节点切换串行队列（select→记录选中→托盘同步→可选清连接） |
| `use-system-state` / `use-system-proxy-state` | 运行状态（事件驱动）/ 系统代理开关（指示器校验+乐观更新回滚） |
| `use-mihomo-ws-subscription` | mihomo WS 共享订阅底座（引用计数/重连/节流写缓存） |
| `use-traffic-data` / `use-memory-data` / `use-log-data` / `use-connection-data` | 四类 WS 数据流 |
| `use-displayed-mixed-port` | 四源解析显示端口（live→runtime→selected→merge→7897） |

### 6.4 页面（`pages/`）

`home`（仪表盘卡片）、`proxies`（代理页，见 7.3）、`profiles`（订阅管理+dnd 排序+批量操作+各编辑器）、`connections`（活动连接表）、`rules`、`logs`、`unlock`（流媒体检测）、`settings`（聚合 SettingClash/System/VergeBasic/VergeAdvanced）。

`_layout.tsx`：自定义标题栏（无装饰窗口）+ 左侧可排序导航（dnd-kit）+ 实时速率 + 通知浮层 + 提权/迁移对话框；`useLayoutEvents` 订阅配置刷新事件 revalidate 8 个查询 key。

### 6.5 组件（`components/`，择要）

- **`base/`**：BaseDialog/BasePage/BaseLoading/VirtualList/StickyVirtualList（分组吸顶虚拟列表）/BaseSearchBox/Switch/MonacoEditor 等。
- **`proxy/`**：代理页组件树（见 7.3）；`use-render-list`（组缓存以"延迟快照身份+测速版本"为失效键）、`use-head-state`（组状态按 profile 持久化 localStorage）、`use-filter-sort`（0 默认/1 延迟/2 名称/3 网速 + `delay=`/`type=` 过滤语法）。
- **`setting/`**：`GuardState`（设置项受控包装：防抖+onGuard 异步保存+失败回滚）+ 各 viewer（端口/TUN/DNS/热键/主题/备份…）。
- **`layout/`**：通知渲染、提权对话框、流量图（Canvas）、更新按钮、窗口控制。
- **`profile/` / `connection/` / `home/` / `test/`**：对应页面组件族。

### 6.6 类型（`types/`）

`proxy-view.ts`：`ProxyViewV1`（records 按 recordId 去重收纳节点）→ `ProxyMemberRef`（轻量引用：group/node/unresolved）→ `resolveMember()` → `ResolvedProxyMember`（引用+实体闭包）→ `InteractableProxyMember`（排除 unresolved，可测/可选）。
`global.d.ts`：`IVergeConfig`（应用配置全集）、`IClashInfo`、连接/流量/日志/订阅类型、Worker 协议。

---

## 7. 核心调用链

### 7.1 应用启动

```
main.rs → lib::run
  → server::check_singleton        # 次实例: HTTP 唤醒主实例后退出
  → Tauri setup: init_work_dir_and_logger (init::init_config + Logger::init)
  → resolve_setup_async (spawn):
      init_service_manager (detect_startup_status)
      → Config::init_config_before_window
      → WindowManager::create_window
      → Config::init_runtime_config (enhance → validate → 失败则 use_default_config 兜底)
      → CoreManager::init
          → lifecycle::start_core
              ├─ Service 模式: start_core_by_service (IPC + RuntimeBundle/staging)
              └─ Sidecar 模式: start_core_by_sidecar (spawn + Win JobObject + 就绪轮询)
          → apply_proxy_after_start → proxy_control::apply (Sysopt 或经服务)
      ∥ Tray::init ∥ Timer::init (cron→feat::update_profile)
      ∥ Hotkey::init ∥ AutoBackupManager::init ∥ SilentUpdater ∥ auto_lightweight_boot
  → resolve_setup_sync: init_scheme + embed_server
```

### 7.2 配置变更（以修改 Verge 设置为例）

```
UI 控件 (GuardState.onGuard)
→ use-verge.patchVerge → invoke patch_verge_config (cmd/verge.rs)
→ feat::patch_verge: lock_config_write → DraftTransaction → determine_update_flags
   → 分发: autostart/hotkey/tray/logger/proxy_control/CoreManager(restart|update_config)/i18n/lightweight
→ commit + save_file → AutoBackupManager::refresh_settings
→ Handle::refresh_verge → NotificationSystem::send_event
→ 前端 events.ts → useLayoutEvents → SWR revalidate
```

订阅更新链：`feat::update_profile` → `PrfItem::from_url`（直连→self_proxy→with_proxy 三档降级）→ `profiles_update_item_safe` → `CoreManager::update_config_with_force` → validate → (service: staging/ReplaceCore | sidecar: reload_or_restart) → `refresh_clash`。

### 7.3 代理页数据流

```
AppDataProvider: getProxyView 15s 轮询/事件失效/手动 refreshProxy
ProxyGroups (状态机 direct/loading/empty/render)
→ useRenderList: proxyView.groups → resolveMember → filterSort(use-filter-sort)
   组缓存失效键: 组延迟快照身份 + 组测速版本
→ StickyVirtualList → ProxyRender (type 0组头/1工具条/2单列/3空/4多列)
→ ProxyItem/ProxyItemMini: useProxyDelayState + useSpeedState (不经过 SWR, 直连 manager)

延迟测试: 组头按钮 → handleCheckAll → delayManager.checkListDelay
  → mihomo /proxies/{name}/delay → setDelay → rAF 合帧 → settle 后组通知重排
节点测速: 组头按钮 → SpeedTestViewer → speedManager.startTest
  → (并发触发 checkListDelay 连测延迟)
  → invoke start_speed_test → SpeedTestManager (listeners 注入→JoinSet 并发下载→Channel 回传)
  → 徽章更新 → settle → 自动切 sortType=3 (按网速排序)
节点切换: onChangeProxy → use-proxy-selection (串行队列)
  → selectNodeForGroup → record_selected_node → sync_tray → 可选清连接 → refreshProxy
```

### 7.4 系统代理

```
feat::proxy::toggle_system_proxy / feat::config 分发
→ core::proxy_control::{apply|clear|refresh_guard}
   ├─ Sidecar 模式: Sysopt (sysproxy crate 直写 + GuardMonitor 守护)
   └─ Service 模式:  set_system_proxy_by_service (MacosProxyConfig: Disabled|Pac|Global)
→ 失败: SysproxyFailure 分类 → notification::record_failure (PendingFailure)
→ 前端: pending-failures-changed 事件 → 提权对话框 (service-request) → 安装服务重试
```

### 7.5 退出

```
窗口关闭 → prevent_close + hide (macOS 切 Accessory)
真正退出 (菜单/热键/exit_app) → feat::quit
  → Config::apply_all_and_save_file (clash/verge/profiles 三路并行)
  → feat::clean_async: 受控停核 + macOS restore_public_dns
  → 失败则取消退出并通知; 成功 → shutdown_embedded_server → app.exit
信号 (Ctrl-C) → clash_verge_signal::register → 同样接 feat::quit
```

### 7.6 Rust → 前端的三条推送通道

1. **Tauri 事件**（`NotificationSystem::send_event`）：refresh-* / notice-message / run-state-changed / pending-failures-changed / profile-* / timer-updated。
2. **mihomo WebSocket**（`useMihomoWsSubscription` 共享订阅）：traffic / memory / logs / connections，写入 `$sub$` 缓存 key。
3. **Tauri Channel**（命令参数内联回传）：测速增量事件（item/done）、流媒体解锁检测。
