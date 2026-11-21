# WorkBuddy / 豆包 DreamSkin 美化适配

把 [DreamSkin.cc](https://dreamskin.cc/) 社区主题壁纸接到 Windows 版 **WorkBuddy** 和 **豆包** 桌面端。项目只负责壁纸、主题名、作者/协议和 `focusX/focusY` 裁切，不移植 Codex 专用的 CSS/配色，因此不会把 WorkBuddy 或豆包的布局搞乱。

> 非官方项目，与 WorkBuddy、豆包、DreamSkin.cc 均无隶属或合作关系。

## 两个分支

| 分支 | 适用客户端 | 内容 |
| --- | --- | --- |
| [`workbuddy`](https://github.com/cxkdz/WorkBuddy-DouBao-Theme-Decoration/tree/workbuddy) | WorkBuddy 桌面端 | CDP 注入、主题库分页/自动重试、全屏壁纸、focus 恢复、桌面图标/看门狗 |
| [`doubao`](https://github.com/cxkdz/WorkBuddy-DouBao-Theme-Decoration/tree/doubao) | 豆包桌面端 | CDP 注入、DreamSkin 主题库、导入背景、focus 保存/恢复、桌面图标/登录自启 |

## 共同特性

- 浏览 DreamSkin.cc 主题库，支持搜索、排序、分页（当前服务端约 990 款）。
- 一键应用社区壁纸，按主题自带 `focusX/focusY` 做 `object-position` 裁切。
- 关闭再打开后恢复上次主题、壁纸、阴影等状态。
- 主题库请求失败会自动重试，守护进程晚到也能恢复。
- 只读取 DreamSkin 公开 API，不需要账号，不需要上传任何本地数据。
- 不包含任何 DreamSkin 社区壁纸文件；主题版权/许可证在 UI 中显示，仅供本机个人使用。

## 安装

1. 安装 **Node.js 22+**（安装时勾选加入 PATH）。
2. 进入对应分支，下载 ZIP 或 `git clone -b workbuddy` / `git clone -b doubao`。
3. 在 PowerShell 中运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

4. 安装完成后使用新建的 **WorkBuddy - DreamSkin** 或 **Doubao - DreamSkin** 桌面快捷方式启动。第一次启动需要等 CDP 和守护进程起来，通常几秒。

详细说明、卸载方法和排障见各分支的 `README.md`。

## 目录约定

运行时安装到 `%LOCALAPPDATA%\beauticode\runtime\<host>`，状态和主题缓存保存在 `%APPDATA%\beauticode` 或 `%LOCALAPPDATA%\beauticode\hosts`。安装脚本只复制程序文件，不覆盖你的聊天记录、主题缓存或客户端安装目录。

## License

代码采用 MIT。`workbuddy` 分支内置的 `Internal Beyond` 氛围素材来自 [Sui-IB/InternalBeyond](https://github.com/Sui-IB/InternalBeyond)，按 **CC BY-NC-SA 4.0** 使用，详见 `NOTICE.md`。DreamSkin.cc 社区主题不随本仓库分发。

