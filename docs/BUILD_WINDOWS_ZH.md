# Windows 本地打包指南（自编译版）

> 本指南面向从个人 fork 构建**可安装的 Windows 版本**的场景，覆盖官方
> [CONTRIBUTING.md](../CONTRIBUTING.md) 未提及的本地打包要点：禁用 updater
> 签名产物、内核下载网络问题处理、版本号策略。
> 基础环境安装亦可参考官方文档的 Development Setup 一节。

## 1. 前置环境

| 依赖 | 安装方式 | 说明 |
| --- | --- | --- |
| Node.js LTS | [nodejs.org](https://nodejs.org) | 20 或更高 |
| Git | [git-scm.com](https://git-scm.com) | 自带凭据管理器，推送免配置 |
| Rust | [rustup.rs](https://rustup.rs) | 默认选项安装；进入项目后会按 `rust-toolchain.toml` 自动补齐 1.95.0 工具链与组件 |
| VS Build Tools 2022 | rustup 安装时按提示装 | 需要 MSVC C++ 工具链 + Windows SDK |
| GNU `patch` 工具 | [gnuwin32](https://gnuwin32.sourceforge.net/packages/patch.htm) 或 scoop/choco | Windows 平台构建脚本依赖 |

注意事项：

- 使用 MSVC 工具链（默认即是），ARM 设备另需安装 LLVM/clang 并配置环境变量。
- 确保 `rustc`、`cargo`、`node`、`pnpm` 均在 `PATH` 中。

## 2. 克隆与安装依赖

```powershell
npm i -g pnpm@12.0.0    # 项目锁定 pnpm 12，勿用其他大版本
git clone -b dev https://github.com/myHooby/clash-verge-rev.git
cd clash-verge-rev
pnpm install
```

## 3. 下载内核与资源（prebuild）

```powershell
pnpm prebuild
```

该步骤从 GitHub 下载 Windows 版 mihomo 内核（稳定版 + Alpha）、geo 数据库等，耗时较长。产物在 `src-tauri/sidecar/` 与 `src-tauri/resources/`（已被 gitignore，不会误提交）。

**网络不通时的处理**（node 的 fetch 默认不走系统代理）：

```powershell
$env:NODE_USE_ENV_PROXY = "1"            # Node 24+ 原生支持环境变量代理
$env:HTTPS_PROXY = "http://127.0.0.1:7890"   # 换成自己的代理端口
pnpm prebuild
```

强制重新下载：`pnpm prebuild --force`。

## 4. 本地打包

### 4.1 为什么必须带覆盖配置

仓库默认 `createUpdaterArtifacts: true`，打包时会用 **updater 签名私钥**（存在官方
仓库的 GitHub Secrets 里）给更新产物签名。本地没有该私钥，不关掉它打包必然在
最后一步失败。以下覆盖配置就是关掉它：

```powershell
'{"bundle":{"createUpdaterArtifacts":false}}' | Out-File -Encoding utf8 $HOME\clash-verge-local-build.json
```

### 4.2 打包命令

```powershell
pnpm tauri build --config $HOME\clash-verge-local-build.json
```

注意 `--config` 必须放在 `--` 之前（如有其他转发给 cargo 的参数）。

首次编译约 10-20 分钟，产物为 NSIS 安装包：

```
target\release\bundle\nsis\Clash Verge_2.5.4_x64-setup.exe
```

安装模式为 perMachine，安装时需要管理员权限；自编译包未做代码签名，SmartScreen
可能告警，选"仍要运行"即可。

### 4.3 可选：提升版本号

不提升也能正常覆盖安装，但应用内"检查更新"仍指向官方通道，官方发布
更高版本后会提示升级，**一旦升级会覆盖掉自编译的功能**。打包前可提升：

```powershell
pnpm release-version 2.5.5   # 同步修改 package.json / tauri.conf.json / Cargo.toml
```

## 5. 验证测速功能

1. 安装后打开应用，导入订阅，进入"代理"页展开任一分组；
2. 分组工具栏延迟测试按钮旁的**下载图标**即测速入口：选并发（4/8/16）、开始；
3. 预期：速度徽章逐个出值（同时联动测延迟），完成后组内自动按网速排序；
4. 点单个节点的速度徽章可单独重测（顺带重测该节点延迟）。

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| `prebuild` 卡在下载 | 见第 3 节的代理环境变量；或更换网络后 `pnpm prebuild --force` |
| 打包最后报 updater/signing 相关错误 | 忘带 `--config` 覆盖配置，见 4.1 |
| `pnpm tauri build` 参数不生效 | `--config` 要放在 `--` 之前 |
| 改了代码重新打包很慢 | 正常增量编译，只重编改动的部分；全新 clone 首次最慢 |
| 装完启动被杀毒软件拦截 | 自编译未签名所致，加白名单即可 |

> 注：因禁用了 updater 产物，自编译包无法走应用内更新通道，后续更新需
> 重新拉代码打包覆盖安装。
