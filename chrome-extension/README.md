# BN助手 Chrome Extension

这是一个合并版 Binance 页面助手。

它把两个能力放进了同一个 Chrome 扩展里：

- Alpha 页面：价差监控
- WOTD 页面：猜词助手

WOTD 这部分不替换原来的 `wotd.py` / `submit.py`，只是把候选词筛选逻辑搬到浏览器里。

## 当前能力

- 在 Binance Alpha 页面运行价差监控
- 在 Binance WOTD 页面右上角注入一个浮窗面板
- 默认自动读取当前页面棋盘结果
- 识别失败时也支持手动录入 `猜测词 + 灰/黄/绿` 结果
- 默认直接使用完整词库
- 浮窗支持拖动
- 已同步线索和候选词列表支持折叠，默认更偏精简视图
- 一键复制候选词
- 一键把候选词输入到当前 WOTD 棋盘

## 不做的事

- 不读取 `configuration.yml`
- 不直接调用你本地 Python 的 Cookie / Submit 流程
- 不默认自动提交到 Binance
- 不新增你自己的后端接口

这样更稳，也更适合做成浏览器插件。

## 目录

- `manifest.json`：Chrome 扩展入口
- `background.js`：Alpha 通知相关后台脚本
- `alpha_content.js`：Alpha 页面内容脚本
- `alpha_styles.css`：Alpha 页面样式
- `content.js`：WOTD 页面浮窗和交互
- `solver_core.js`：WOTD 纯候选词筛选逻辑
- `styles.css`：WOTD 浮窗样式
- `wordlists/`：浏览器端使用的词库
- `build_wordlists.py`：从父目录原始词库生成浏览器词库

## 安装方式

1. 先生成词库

```bash
python3 chrome-extension/build_wordlists.py
```

2. 打开 Chrome 扩展页
3. 开启开发者模式
4. 选择“加载已解压的扩展程序”
5. 选择目录：

```text
tools/binance-wotd-helper/chrome-extension
```

## 使用方式

1. 把这个目录作为一个扩展加载到 Chrome
2. 打开 Binance Alpha 页面时，会自动启用价差监控
3. 打开 Binance WOTD 页面时，会自动启用猜词助手
4. WOTD 面板会自动同步棋盘并直接显示推荐下一词

## 验证

```bash
node --test chrome-extension/solver_core.test.js
python3 chrome-extension/build_wordlists.py
```
