# WorkBuddy DreamSkin Adapter

把 DreamSkin.cc 社区主题壁纸接入 Windows 版 WorkBuddy。实现基于
[beautiCode](https://github.com/starsstreaming/beautiCode)，只应用壁纸和裁切焦点，
不搬运 Codex 专用的 CSS/配色。

## 功能

- WorkBuddy 主题库：搜索、排序、分页，当前服务端约 990 款。
- 应用社区壁纸；使用主题的 `focusX/focusY` 设置 `object-position`。
- 壁纸铺满 WorkBuddy 窗口，主内容壳透明，侧栏保留宿主表面。
- 关闭再打开恢复主题、壁纸、阴影、模糊、透明度。
- 主题库失败后每 3 秒自动重试；守护晚到也能从“0 款”恢复。
- 桌面快捷方式启动时同时拉起 CDP runner 和 `wb-watch.ps1` 看门狗。
- 看门狗每 3 秒检查，WorkBuddy 开着但 runner 不在时自动补。

## 环境

- Windows 10/11
- Node.js **22+**
- PowerShell 5.1（系统自带）
- WorkBuddy 桌面版（安装路径由适配器自动发现）

## 安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：

1. 把 `runtime` 复制到 `%LOCALAPPDATA%\beauticode\runtime\workbuddy`。
2. 把 `wb-launch.ps1`、`wb-watch.ps1` 复制到 `%LOCALAPPDATA%\beauticode`。
3. 创建桌面快捷方式 **WorkBuddy - DreamSkin**。
4. 创建登录启动项 `beauticode-workbuddy-watch.vbs`，登录后拉起看门狗。
5. 立即启动看门狗（不会自动打开 WorkBuddy）。

如果 WorkBuddy 已开着，先关掉再点新快捷方式，让带 CDP 的实例接管。

## 使用

1. 点桌面 **WorkBuddy - DreamSkin**。冷启动会多几秒，是在等 CDP 和守护进程。
2. 打开 WorkBuddy 背景面板（左下角皮肤入口）。
3. 点“主题库 → 打开”，选择 DreamSkin 主题；也可“导入背景”选本地图片。
4. 主题库分页在底部：上一页 / 第 X / Y 页 · 共 N 款 / 下一页。

当前截图验证：`第 1 / 83 页 · 共 989 款`，12 张卡片；主题「休闲室内居家」的
`objectPosition` 为 `50% 50%`。

## 排障

> 主题库依赖 `api.dreamskin.cc`。在中国大陆网络下如果打不开，先在系统代理中放行，或设置 `HTTP_PROXY` / `HTTPS_PROXY`；运行时已设置 `NODE_USE_ENV_PROXY=1`。

- **主题库显示“服务未响应 / 共 0 款”**：`9337` 画廊端口没起。查看
  `%LOCALAPPDATA%\beauticode\logs\wb-watch.log` 是否有 `watcher-started`；
  正常情况看门狗会自动补 runner，面板 3 秒后恢复。
- **应用后壁纸被裁切**：主题库会带 `focusX/focusY`；已保存主题重新点选也会保留焦点。
- **没有壁纸**：确认 `9336` 在线、`wb-cdp-runner` 在跑；从新建的快捷方式启动。
- **布局错位**：本适配不注入 Codex CSS，只改壁纸层；若仍有问题，清掉浏览器缓存式
  的旧注入，重启 WorkBuddy。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

卸载会删除快捷方式、登录启动项、runner/看门狗和插件运行时；保留已下载主题和
`%APPDATA%\beauticode\state.json`。

## 说明

- 不包含 DreamSkin 社区壁纸；主题版权/许可证在主题库 UI 显示，仅本机个人使用。
- `runtime/assets/themes/internal-beyond` 的素材来自 InternalBeyond，按
  CC BY-NC-SA 4.0 使用，详见仓库根目录 `NOTICE.md`。
- 非官方项目，与 WorkBuddy、DreamSkin.cc 无隶属关系。

