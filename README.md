# 豆包 DreamSkin Adapter

把 DreamSkin.cc 社区主题壁纸接入 Windows 版豆包。实现基于
[beautiCode](https://github.com/starsstreaming/beautiCode)，只应用壁纸和裁切焦点，
不搬运 Codex 专用的 CSS/配色。

## 功能

- 豆包背景面板新增“主题库”，支持搜索、排序、分页（当前服务端约 990 款）。
- 应用 DreamSkin 壁纸；使用主题的 `focusX/focusY` 设置 `object-position`。
- 支持“导入背景”选本地图片，自动保存为已应用主题。
- 已保存主题重新点选也会保留 focus，不会回到 `50% 50%`。
- 关闭重开恢复上次壁纸、主题、阴影、模糊、透明度。
- 浅色主题默认阴影降到 20%，不会把 DreamSkin 壁纸糊成一层白雾。
- 桌面快捷方式启动时同时拉起 CDP runner；主题库请求失败会重试。

## 环境

- Windows 10/11
- Node.js **22+**
- PowerShell 5.1（系统自带）
- 豆包桌面版（安装路径由适配器自动发现）

## 安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：

1. 把 `runtime` 复制到 `%LOCALAPPDATA%\beauticode\runtime\doubao`。
2. 把 `doubao-launch.ps1` 复制到 `%LOCALAPPDATA%\beauticode`。
3. 创建桌面快捷方式 **Doubao - DreamSkin**。
4. 创建登录启动项 `beauticode-doubao-runner.vbs`，登录后拉起 runner。

如果豆包已开着且没有 CDP，点新快捷方式会检测到并重启一次主窗口，让 CDP 接管；
这是为了让壁纸能注入。

## 使用

1. 点桌面 **Doubao - DreamSkin**。
2. 打开豆包左下角皮肤入口，选“主题库”。
3. 选主题；或“导入背景”选本地图片。
4. 底部可翻页：当前实测 `第 1 / 83 页 · 共 989 款`。

## 排障

> 主题库依赖 `api.dreamskin.cc`。在中国大陆网络下如果打不开，先在系统代理中放行，或设置 `HTTP_PROXY` / `HTTPS_PROXY`；运行时已设置 `NODE_USE_ENV_PROXY=1`。

- **主题库显示 0 款**：检查 `%LOCALAPPDATA%\beauticode\hosts\doubao\runner.log`
  和 `9382` 端口；守护在跑时重新打开面板即可。
- **应用后壁纸被裁切**：主题库和已保存主题都会带 `focusX/focusY`；若旧主题没有
  焦点，重新从主题库应用一次。
- **没有壁纸**：确认 `9342` 在线；从新快捷方式启动，必要时关掉豆包后重开。
- **浅色主题发白**：背景面板的“背景阴影”可调；默认 20%。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

卸载会删除快捷方式、登录启动项、runner 和插件运行时；保留已下载主题和
`%LOCALAPPDATA%\beauticode\hosts\doubao\state.json`。

## 说明

- 不包含 DreamSkin 社区壁纸；主题版权/许可证在主题库 UI 显示，仅本机个人使用。
- 非官方项目，与豆包、DreamSkin.cc 无隶属关系。





