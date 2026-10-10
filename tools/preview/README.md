# 界面预览

`plugin-sdk`、`web-sdk` 与宿主的 `theme.css` 都要求 WebView 页面只消费 `--ats-*` token，页面的排版、浅色／深色、窄屏与弹窗只有真正渲染出来才能核对。这个目录提供一条不依赖设备的预览链路：把 `src/web` 原样复制一份，补上宿主生成的主题 token 与一个内存版传输层替身，让真实的 `index.html` 和真实脚本在桌面浏览器里运行。

```powershell
node tools\preview\build.mjs
node tools\preview\serve.mjs
```

然后打开 <http://127.0.0.1:8791/light.html>。查询参数可以复现需要交互才能到达的状态：

| 地址 | 状态 |
| --- | --- |
| `light.html` / `dark.html` | 浅色与深色首页 |
| `light.html?spin=1` | 点击一次抽取后的结果与历史 |
| `light.html?open=preset` | 转盘预设弹窗 |
| `light.html?open=import` | 批量粘贴弹窗 |
| `light.html?open=save` | 保存为预设弹窗 |
| `light.html?open=help` | 随机说明弹窗 |

需要像素级截图时：

```powershell
node tools\preview\shoot.mjs
```

它会用 DevTools 协议把页面按 412×915（手机）、320×800（窄屏）和 900×1000（宽屏）渲染到真实 CSS 视口，输出到 `output/`，并在任何元素横向溢出时以非零退出码结束。浏览器默认按 Edge、Chrome 的常见安装路径查找，也可以用 `PREVIEW_BROWSER` 指定可执行文件。

生成物全部位于被 Git 忽略的 `site/` 与 `output/`，不进入插件包：`build.mjs` 只从 `src/web` 读取，反过来不会发生。
