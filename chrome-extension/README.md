# Binance WOTD Chrome Extension

这是给现有 `binance-wotd-helper` 补的一个页面内助手版。

它不替换原来的 `wotd.py` / `submit.py`，而是把候选词筛选逻辑搬到浏览器里，让你在 Binance WOTD 页面上直接录入线索、看候选词、填词。

## 当前能力

- 在 Binance 页面右上角注入一个浮窗面板
- 支持录入 `猜测词 + 灰/黄/绿` 结果
- 常用词库优先，空结果时自动切到完整词库
- 一键复制候选词
- 一键把候选词填进当前页面输入框

## 不做的事

- 不读取 `configuration.yml`
- 不直接调用你本地 Python 的 Cookie / Submit 流程
- 不默认自动提交到 Binance

这样更稳，也更适合做成浏览器插件。

## 目录

- `manifest.json`：Chrome 扩展入口
- `content.js`：页面内浮窗和交互
- `solver_core.js`：纯候选词筛选逻辑
- `styles.css`：浮窗样式
- `wordlists/`：浏览器端使用的精简词库
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

1. 打开 Binance 的 WOTD 页面
2. 在右上角面板里设置词长
3. 每猜一次，就录入一个单词并点颜色格
4. 面板会自动刷新候选词
5. 先点页面里的输入框，再点候选词旁边的“填入”

## 验证

```bash
node --test chrome-extension/solver_core.test.js
python3 chrome-extension/build_wordlists.py
```
