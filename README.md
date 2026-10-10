# 转盘决策

Android Tool Suite 的转盘决策插件：用加权随机在多个选项之间做决定，并把「怎么算概率」和「抽完之后怎么办」都交给你控制。

插件是 format v3 Web Tool，不携带 `plugin.apk`，不依赖任何其他插件，也不联网。所有转盘预设、历史和设置只保存在本机。

## 功能

- **概率方案可选**：等概率、评分比例、直接百分比、倍数、softmax 温度、排名幂律。评分比例与等概率复刻原脚本的两种模式，其余方案用来表达更具体的意图，例如「A 通常赢，但不要总是赢」用 softmax 温度比手填权重更直接。
- **概率下限**：给每个参与选项保底一份概率，避免某个选项因为评分太低而永远抽不到。下限会被限制在平均概率以内，因为更高的下限在数学上无法满足。
- **抽中之后**：保留、移出本轮、概率衰减、冷却。移出本轮抽完全部选项后自动开始新一轮，不会卡死；选项列表会直接写出「本轮移出」「冷却 3」这类原因，而不是留下一个空白的百分比。
- **预设与临时转盘**：已保存的预设会一直留在本机，可以随时切回来继续用同一个转盘；临时转盘是一次性的，关闭工具后不保留，需要时再另存为预设。
- **批量**：一次抽多个，逐个计算，抽中之后的调整立刻影响下一次；支持粘贴每行一个选项、行尾可带数值的列表。
- **历史**：记录每次结果、当时概率和本轮做了什么调整，可复制、可清空。

## 随机是怎么算的

每次抽取分两步：先把当前选项换算成一份概率，再从系统密码学随机源取一个无偏的随机整数落在其中一份上。动画不参与决定，它只是把已经确定的结果转到指针下面——否则结果会取决于帧率，也没法在设备之外验证。

具体实现：

- **整数权重**。所有方案先算出浮点权重，再用最大余数法换算成总和固定为 2^30 的整数。逐个四舍五入会让总和不再是预算，从而悄悄改变每一项的概率；最大余数法把余数发给小数部分最大的项，每项误差不超过一个单位（约 1e-9）。
- **无偏整数**。`next32() % n` 会让前 `2^32 % n` 个取值多出一份概率，所以采样用拒绝法剔除超出最大整数倍的部分。超过 2^32 的范围改用 53 位随机字，同样拒绝而不是拆成等长分段——最后一段偏短时，分段法会给它内部的每个取值多分概率。
- **采样器**。默认使用累积概率表加二分查找（与 CPython `random.choices`、`std::discrete_distribution` 同形），它没有构建期需要维护的不变式，别人也可以手工复核一次抽取。别名表（Vose）作为可选实现，用于更看重单次 O(1) 的场景；两者的结果在测试里互相校验。
- **别名表用整数运算**。教科书版本把 `p_i = w_i * n / total` 存成浮点并与 1 比较，浮点误差会让数学上等于 1 的项落进错误的工作队列，累积后可能读空队列。整体乘以 `total` 之后，所有比较都变成整数比较，修复步骤也成为整数加法，不需要任何 `== 1` 判断。
- **百分比合计为 100.0**。逐项四舍五入会显示成 33.3 + 33.3 + 33.3 = 99.9；显示值同样用最大余数法分配，并且实际存在但小于显示精度的概率显示为 `<0.1%` 而不是 `0.0%`。

原脚本的做法（`r = uniform(0, total)`，然后逐项 `if r <= w: pick; r -= w`）有两个问题：递减累加器在 `w` 小于 `ulp(r)` 时会让某一项**永远抽不到**，而 `total = 0` 时会固定抽中第一项。本插件保留它表达的两种概率模式，但不再沿用这套累加方式。

## 构建

需要 Node.js 24、JDK 17 和 Gradle 8.9 或更高版本：

```powershell
gradle -p plugins\wheel-decide clean testDebugUnitTest collectArtifacts
```

产物位于 `artifacts/wheel-decide.atsplugin`。

测试覆盖随机源的无偏性、两种采样器对目标分布的精确复现（枚举整个随机空间计数，不留统计误差）、卡方拟合与总变差距离、六种概率方案的边界、四种抽后策略、预设与历史的容错归一化，以及页面元素 id、Capability 调用、设计 token 与清单的一致性。

界面改动可以在桌面浏览器里核对，不必先装到设备上：`node tools/preview/build.mjs` 会把 `src/web` 复制一份、补上宿主主题 token 与内存版传输层替身，`node tools/preview/serve.mjs` 起服务后用 `node tools/preview/shoot.mjs` 按手机、窄屏和宽屏截图，并在出现横向溢出时以非零退出码结束。用法见 `tools/preview/README.md`。

## 发布通道

- 日常 CI 只测试、构建并上传产物。Debug 通过本地构建和 ADB 导入进行调试，不发布远程版本或调试索引。
- 推送 `v<versionName>` 标签后，工作流测试、构建并发布正式 Release，并以事件通知插件索引重建。
- `data-compatibility.json` 声明当前构建可能写入的数据格式及可读取范围；修改存储结构时必须同步递增并评估兼容范围。

## 数据与安全

- 两类 Dataset 位于应用私有目录：`wheel-presets`（预设、当前转盘和界面偏好）与 `wheel-history`（抽取历史）。两者都可以随数据备份导出和恢复，合并时预设按更新时间取较新的一份，历史按记录去重求并集。
- 插件不申请网络能力，不收集、不上传任何内容。
- 剪贴板权限只用于「复制列表 / 复制结果 / 复制历史」，未授权时这几项会提示去授权，不影响抽取与保存。

## 开源方案调研

设计前参考了以下实现和资料，插件没有复制其中任何界面资源或业务源码，界面按 Android Tool Suite 共享设计系统重新实现：

- [Wheel of Names](https://wheelofnames.com/faq)：对外的 1000 项显示上限与「超出部分在转动时随机取子集」的做法、明确使用 `crypto.getRandomValues`、以及「自己跑一万次验证」的自证式说明。
- [Picker Wheel](https://pickerwheel.com/)：文本模式下 `权重,选项` 的逐行写法、`~隐藏~` 语法、消除/累积等抽后动作，以及结果面板与计数。
- [Wheel Decide](https://wheeldecide.com/)：最简可用形态——文本框、独立的权重输入、一个画布。
- [random.org 列表随机化](https://www.random.org/lists/) 与 GNU `shuf`：都只做等概率排列，没有逐项权重；这正好是本插件补上的部分。
- [Alias method](https://en.wikipedia.org/wiki/Alias_method)、[Keith Schwarz, Darts, Dice, and Coins](https://www.keithschwarz.com/darts-dice-coins/)：Vose 别名法的工作队列构造、浮点不稳定点，以及「不要与 1 做相等比较」这一经典陷阱。
- [PCG, Fast, Branchless Random Integers](https://www.pcg-random.org/posts/bounded-rands.html) 与 [Lemire 的有界随机数](https://arxiv.org/abs/1805.10941)：取模偏差的量级与拒绝法。
- [NIST/SEMATECH 卡方拟合优度检验](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35f.htm)：统计量与自由度、以及每格期望次数不小于 5 的适用条件。
- [Softmax 函数](https://en.wikipedia.org/wiki/Softmax_function)：温度形式、减最大值的数值稳定写法，以及它作为 IIA 一致的随机选择模型的性质。
- [最大余数法](https://en.wikipedia.org/wiki/Largest_remainder_method) 与 [加法平滑](https://en.wikipedia.org/wiki/Additive_smoothing)：百分比取整分配与概率下限的解析解。
- [Fisher–Yates 洗牌](https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle)：无偏排列的正确写法，以及用 `sort(() => Math.random() - 0.5)` 会被证明不均匀的原因。
