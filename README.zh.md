# GeoResearch for DeepSeek Harness

[English](README.md) | 中文

GeoResearch 是面向
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的证据驱动型科学研究
Agent 插件。它将研究问题、论文、源代码仓库和科学数据组织成可持久化、可审计的完整工作流，覆盖
文献综述、论文复现、地理空间实验、独立验证和论文写作准备。

> **当前版本：** `0.1.0` 已通过 npm 和公开的
> [GitHub 仓库](https://github.com/LYP-PYL/georesearch-dsh)发布。正式版本对应 annotated
> [`v0.1.0`](https://github.com/LYP-PYL/georesearch-dsh/releases/tag/v0.1.0) 标签，全部 26 个
> npm 包都包含 registry provenance。

GeoResearch 当前面向 DeepSeek Harness `0.1.0-rc.5`，并实现了 DSH Standard Community
v0.15 Host 组件边界。准确的支持范围请参阅
[兼容性矩阵](docs/compatibility-matrix.md)。

## GeoResearch 是什么

GeoResearch 面向那些在对话结束后仍需检查研究过程和依据的工作。它不会只依赖聊天记录，而是将项目中的
关键内容保存为有类型、有版本且可验证的研究记录。

```text
研究简报
  -> 文献、论文、文件和代码仓库
  -> 复现计划和实验
  -> 独立验证
  -> 用户批准的科学主张
  -> 写作资料包和论文草稿
```

Coordinator 可以将有边界的任务委派给文献、实验、审查和写作 Specialist，但项目状态、正式运行、
证据、验证、科学主张和最终交付物始终由 Host 服务负责权威提交。

## 核心功能

| 领域 | 可以完成的工作 |
| --- | --- |
| 研究项目 | 将研究问题固化为持久化 ResearchBrief，跟踪项目状态、保存 Artifact，并跨会话继续研究。 |
| 文献与证据 | 检索 Crossref、阅读论文、登记 SourceRecord、保存证据级 PDF 回执并检查引用。 |
| 文件与附件 | 检查混合上传的 PDF、Office/OpenDocument、EPUB、Notebook、压缩包、源代码、图像、SQLite、HDF5、NetCDF 和 Parquet。 |
| 代码与论文复现 | 通过有界只读 Provider 审计 Git 仓库，对照论文方法和实现，建立复现计划、测试和可追溯报告。 |
| 地理空间实验 | 检查科学数据和栅格数据，验证空间身份与 CRS，冻结实验规格，执行获准的 Python 工作并登记结果。 |
| 验证与写作 | 在科学主张获批前执行独立审查，从可追溯 WritingPacket 生成仅基于已验证记录的论文草稿。 |
| Specialist Skills | 使用内置的文献综述、地理空间数据、遥感实验、空间统计、论文复现、科学验证和论文写作协议。 |

当系统中存在受管理的 `DEEPSEEK_API_KEY` 时，GeoResearch 会使用
`deepseek-v4-flash-vision-exp` 自动理解图像和文档中的图像；原生模型视觉和本地 OCR
作为显式后备路径。上传图像中的任何指令始终被视为不可信数据。

## 安全性与可追溯性

- 候选结果与权威记录相互分离。Specialist 不能将自己的输出静默升级为已接受证据、正式结果或科学主张。
- Project、Artifact、Run、Evidence、Review、Claim 和 WritingPacket 都会绑定内容并在下游使用前重新验证。
- 仓库访问为只读；实验执行通过有界服务完成，不向 Agent 暴露通用 Shell 入口。
- 安装、升级、恢复、验证和卸载都是显式操作。安装器不使用 `postinstall`，也不会修改 DeepSeek Harness 源代码树。
- 受管理的 GeoResearch 运行环境会关闭 Session Telemetry。

准确的权限声明和标准组件身份记录在
[DSH Standard 一致性说明](docs/dsh-standard-conformance.md)中。

## 环境要求

| 组件 | 支持版本 |
| --- | --- |
| 操作系统 | Windows 10 或 Windows 11 x64 |
| DeepSeek Harness | `0.1.0-rc.5` 及已验证的 GeoResearch 兼容补丁 |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| pnpm | 从源码构建时使用 `11.7.0` |
| Python | 地理空间工作流需要 3.10 或更高版本 |
| Python 包 | 栅格检查和 CRS 归一化需要 `rasterio` 与 `pyproj` |
| Git | RepositoryAudit 和复现工作流要求 Git 位于 `PATH` 中 |

执行安装、升级、恢复或卸载前，请关闭正在运行的 DeepSeek Harness 进程。Harness Home 默认位于
`%USERPROFILE%\.dsh`；可以设置 `DSH_HOME` 或传入 `--dsh-home` 使用其他目录。

## 获取 GeoResearch

### 通过 npm 安装

请使用精确版本安装，以确保受管理的分发包保持固定：

```powershell
$dshHome = Join-Path $env:USERPROFILE '.dsh'
npx --yes @georesearch/dsh-installer@0.1.0 install --dsh-home $dshHome
npx --yes @georesearch/dsh-installer@0.1.0 verify --dsh-home $dshHome
```

自包含安装器携带完整的 GeoResearch 分发包，不需要本仓库源码、单独安装其他包或传入
`--distribution-dir`。发布资产和校验和可从
[`v0.1.0` Release 页面](https://github.com/LYP-PYL/georesearch-dsh/releases/tag/v0.1.0)下载。

### 从源码构建

如果需要开发 GeoResearch，或者审计完整源码和发布门禁，可以克隆公开仓库：

使用 GitHub CLI 克隆仓库：

```powershell
gh repo clone LYP-PYL/georesearch-dsh
cd georesearch-dsh
```

也可以在配置好 GitHub 身份验证后直接使用 Git：

```powershell
git clone https://github.com/LYP-PYL/georesearch-dsh.git
cd georesearch-dsh
```

准备工作区并构建受管理的分发包：

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm run distribution
```

安装并验证本地构建的分发包：

```powershell
$dshHome = Join-Path $env:USERPROFILE '.dsh'

node packages/installer/lib/cli.js install `
  --dsh-home $dshHome `
  --distribution-dir dist\distribution `
  --harness-root C:\path\to\deepseek-harness

node packages/installer/lib/cli.js verify --dsh-home $dshHome
```

请将 `C:\path\to\deepseek-harness` 替换为受支持的 Harness 源码目录。安装器会把
GeoResearch 集成到所有包含 `@deepseek-ai/dsh-web-app` 的现有 Web Profile，并创建受管理的
`georesearch` 诊断 Profile。

## 首次使用

启动已经完成集成的 Web Profile：

```powershell
dsh --profile web
```

也可以启动受管理的诊断 Profile：

```powershell
dsh --profile georesearch
```

进入 Web UI 后：

1. 打开 **Settings -> Models**，配置 DeepSeek 模型并保存 API 凭据。
2. 选择用于保存研究项目和交付物的 Workspace。
3. 使用 **GeoResearch** Preset 新建 Session。
4. 描述研究问题，并上传需要作为初始证据的论文、数据集、图像或代码仓库。

示例请求：

```text
为“利用多时相卫星影像评估城市热岛变化”建立研究简报，并指出目前仍缺少哪些证据和数据。
```

```text
检索空间自相关遥感模型验证方法的相关文献，并将最可靠的来源登记到当前项目中。
```

```text
检查已上传 GeoTIFF 的 CRS 和分辨率，提出一个可复现的实验方案；在我批准前不要运行实验。
```

```text
审计这篇论文及其代码仓库，建立复现计划，并严格区分已经验证的发现与仍需审查的主张。
```

## 运维

安装器提供 `install`、`upgrade`、`verify`、`recover` 和 `uninstall`。安装完成、Harness
修复后以及升级前应运行 `verify`；修改操作被中断后应使用 `recover`，不要手动删除事务文件。

完整流程与恢复规则请参阅
[安装与运维文档](docs/installation-and-operations.md)。

## 文档

- [安装与运维](docs/installation-and-operations.md)
- [兼容性矩阵](docs/compatibility-matrix.md)
- [附件与视觉模型边界](docs/deepseek-vision.md)
- [DSH Standard 一致性说明](docs/dsh-standard-conformance.md)
- [Provider 扩展指南](docs/provider-extension.md)
- [发布门禁与验证证据](docs/phase7-gate.md)
- [`v0.1.0` 发布说明](docs/releases/v0.1.0.md)

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run dsh-std:check
```

维护者可以在干净的 Git 工作区中运行完整发布候选门禁：

```powershell
pnpm run release:gate
```

该门禁会执行确定性测试、Windows 功能探针、科学 golden 测试、DSH Standard 验证、在线发布证据、
包 lint，以及所有发布包的 `npm publish --dry-run`。它会生成 release manifest 和校验和，但不会
发布或上传任何包。

## 许可证

[MIT](LICENSE)
