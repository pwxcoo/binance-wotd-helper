/**
 * Binance Alpha 价差监控 - Content Script
 * 监控成交记录，计算并显示价差
 */

(function () {
  'use strict';

  // 配置
  const CONFIG = {
    MONITOR_INTERVAL: 1000, // 监控间隔 (ms)
    MAX_TRADES: 20, // 分析的最大交易数
    DEBOUNCE_DELAY: 300, // 防抖延迟 (ms)
    AUTO_TRADE_HISTORY_SCAN_INTERVAL: 1000, // 自动交易开启时，历史成交刷新间隔
    MAX_PENDING_SUBMITS: 1, // 历史未同步前最多允许的在途单数，防超刷
    ALPHA_SELL_FEE_RATE: 0.0001, // Alpha 卖出手续费率 0.01%
    WEAR_DETAIL_ALERT_THRESHOLD: 0.18, // 磨损明细异化阈值（按亏损绝对值）
    LIQUIDITY_WINDOW_MS: 10000, // 流动性判断窗口 10 秒
    LIQUIDITY_MIN_TRADES: 7, // 10 秒内最少成交笔数
    AUTO_TRADE_BLOCK_LOG_INTERVAL_MS: 15000, // 自动交易拦截日志最小间隔
    DEFAULT_TRADE_VOLUME_MULTIPLIER: 4, // 默认交易量倍率
    SPECIAL_VOLUME_SYMBOLS_X1: ['CRCLon'], // 特殊币种：交易量按 1 倍计算
  };
  const STORAGE_KEY = 'binance_spread_monitor_settings_v1';
  const RUNTIME_STORAGE_KEY = 'binance_spread_monitor_runtime_v1';

  // 状态
  let state = {
    trades: [],
    highPrice: 0,
    lowPrice: Infinity,
    spread: 0,
    spreadPercent: 0,
    wearCost: 0, // 每500U来回交易的磨损
    recentTradeCountInWindow: 0, // 最近 10 秒成交笔数
    isLowLiquidity: false, // 是否流动性较差
    lastUpdate: null,
    isMinimized: false,
    maxTrades: 10, // 可配置的最大监控交易数（默认10）
    autoFillReverse: true, // 自动填充反向订单开关（默认开启）
    autoTrade: false, // 自动交易开关（默认关闭）
    fullAutoConfirm: false, // 全自动确认（二次弹窗自动点击，默认关闭）
    autoTradeTargetMode: 'count', // 目标模式：count=按笔数，volume=按交易量
    autoTradeTargetCount: 16, // 今日目标笔数（默认16）
    autoTradeTargetVolume: 32768, // 本周期目标交易量（按当前交易量倍率口径）
    autoTradeWearThreshold: 0.2, // 自动交易磨损阈值（默认0.2U）
    lastTradeTime: null, // 上次交易时间，防止频繁交易
    tradeAmount: 514, // 成交额（默认514）
    priceMarkup: 0.1, // 上浮百分比（默认0.1%）
    cooldown: 10, // 冷却时间（默认10秒）
    detailsExpanded: false, // 详细信息是否展开（默认收起）
    dailyVolume: 0, // 本周期买入成交额（USDT）
    dailyTradeCount: 0, // 本周期买入成交笔数
    cycleSellAmount: 0, // 本周期卖出成交额（USDT）
    cycleSellFeeAmount: 0, // 本周期卖出手续费（USDT）
    cycleWearAmount: 0, // 本周期已配对净卖出减买入后的磨损（USDT）
    cycleWearDetails: [], // 本周期逐笔磨损明细
    cycleSymbols: [], // 本周期去重币种
    cycleUnmatchedBuyCount: 0, // 本周期未配对买入笔数
    cycleUnmatchedSellCount: 0, // 本周期未配对卖出笔数
    lastVolumeCheck: null, // 上次检查成交量时间
    autoSubmittedCount: 0, // 本周期自动发起（已点买入）笔数
    autoSubmittedBuyAmount: 0, // 本周期自动发起（已点买入）金额
    autoSubmittedCycleKey: '', // 本周期 key（UTC 00:00 切日）
    completionNotifiedCycleKey: '', // 已通知完成的周期 key
    completionNotifiedTargetSignature: '', // 已通知完成的目标签名
    completionNotificationPending: false, // 完成通知发送中
    wearDetailsExpanded: false, // 磨损明细是否展开
    wearDetailScrollTop: 0, // 磨损明细滚动位置
    lastAutoTradeBlockReason: '', // 最近一次自动交易拦截原因
    lastAutoTradeBlockLogAt: 0, // 最近一次自动交易拦截日志时间
  };

  function saveSettings() {
    try {
      const payload = {
        autoFillReverse: !!state.autoFillReverse,
        autoTradeTargetMode: String(state.autoTradeTargetMode || 'count'),
        autoTradeTargetCount: Number(state.autoTradeTargetCount || 16),
        autoTradeTargetVolume: Number(state.autoTradeTargetVolume || 32768),
        autoTradeWearThreshold: Number(state.autoTradeWearThreshold || 0.2),
        tradeAmount: Number(state.tradeAmount || 514),
        priceMarkup: Number(state.priceMarkup || 0.1),
        cooldown: Number(state.cooldown || 10),
        maxTrades: Number(state.maxTrades || 10),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.log('[价差监控] 保存配置失败', e);
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const cfg = JSON.parse(raw);
      if (typeof cfg !== 'object' || !cfg) return;

      if (typeof cfg.autoFillReverse === 'boolean') state.autoFillReverse = cfg.autoFillReverse;
      // 自动交易 / 全自动确认：每次刷新默认关闭，不持久化
      state.autoTrade = false;
      state.fullAutoConfirm = false;
      if (cfg.autoTradeTargetMode === 'count' || cfg.autoTradeTargetMode === 'volume') {
        state.autoTradeTargetMode = cfg.autoTradeTargetMode;
      }
      if (Number.isFinite(Number(cfg.autoTradeTargetCount)) && Number(cfg.autoTradeTargetCount) >= 1 && Number(cfg.autoTradeTargetCount) <= 500) {
        state.autoTradeTargetCount = Math.floor(Number(cfg.autoTradeTargetCount));
      }
      if (Number.isFinite(Number(cfg.autoTradeTargetVolume)) && Number(cfg.autoTradeTargetVolume) > 0) {
        state.autoTradeTargetVolume = Number(cfg.autoTradeTargetVolume);
      }
      if (Number.isFinite(Number(cfg.autoTradeWearThreshold)) && Number(cfg.autoTradeWearThreshold) >= 0) {
        state.autoTradeWearThreshold = Number(cfg.autoTradeWearThreshold);
      }
      if (Number.isFinite(Number(cfg.tradeAmount)) && Number(cfg.tradeAmount) > 0) {
        state.tradeAmount = Number(cfg.tradeAmount);
      }
      if (Number.isFinite(Number(cfg.priceMarkup)) && Number(cfg.priceMarkup) >= 0) {
        state.priceMarkup = Number(cfg.priceMarkup);
      }
      if (Number.isFinite(Number(cfg.cooldown)) && Number(cfg.cooldown) >= 0) {
        state.cooldown = Math.floor(Number(cfg.cooldown));
      }
      if (Number.isFinite(Number(cfg.maxTrades)) && Number(cfg.maxTrades) >= 5 && Number(cfg.maxTrades) <= 100) {
        state.maxTrades = Math.floor(Number(cfg.maxTrades));
      }
    } catch (e) {
      console.log('[价差监控] 加载配置失败', e);
    }
  }

  function saveRuntimeState() {
    try {
      const payload = {
        completionNotifiedCycleKey: String(state.completionNotifiedCycleKey || ''),
        completionNotifiedTargetSignature: String(state.completionNotifiedTargetSignature || ''),
      };
      localStorage.setItem(RUNTIME_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.log('[价差监控] 保存运行状态失败', e);
    }
  }

  function loadRuntimeState() {
    try {
      const raw = localStorage.getItem(RUNTIME_STORAGE_KEY);
      if (!raw) return;
      const runtime = JSON.parse(raw);
      if (typeof runtime !== 'object' || !runtime) return;

      if (typeof runtime.completionNotifiedCycleKey === 'string') {
        state.completionNotifiedCycleKey = runtime.completionNotifiedCycleKey;
      }
      if (typeof runtime.completionNotifiedTargetSignature === 'string') {
        state.completionNotifiedTargetSignature = runtime.completionNotifiedTargetSignature;
      }
    } catch (e) {
      console.log('[价差监控] 加载运行状态失败', e);
    }
  }

  // DOM 选择器
  const SELECTORS = {
    // 成交记录容器 - 虚拟滚动列表
    tradeGrid: '[aria-label="grid"].ReactVirtualized__List',
    tradeGridAlt:
      '.ReactVirtualized__List.ReactVirtualized__Grid[aria-label="grid"]',
    // 内部滚动容器
    innerContainer: '.ReactVirtualized__Grid__innerScrollContainer',
    // 当前价格元素
    currentPrice: '[class*="text-[20px]"][class*="font-[500]"]',
  };

  /**
   * 创建浮窗 UI
   */
  function createMonitorUI() {
    // 检查是否已存在
    if (document.getElementById('binance-spread-monitor')) {
      return;
    }

    const container = document.createElement('div');
    container.id = 'binance-spread-monitor';
    container.innerHTML = `
      <div class="monitor-header">
        <div class="monitor-title">价差监控</div>
        <div class="monitor-controls">
          <button class="control-btn" id="monitor-minimize" title="最小化">−</button>
          <button class="control-btn" id="monitor-close" title="关闭">×</button>
        </div>
      </div>
      <div class="monitor-content">
        <div class="loading">正在加载数据...</div>
      </div>
      <div class="monitor-footer">
        <label class="toggle-switch">
          <input type="checkbox" id="auto-fill-toggle">
          <span class="toggle-slider"></span>
          <span class="toggle-label">自动填充反向订单(99%)</span>
        </label>
        <label class="toggle-switch">
          <input type="checkbox" id="auto-trade-toggle">
          <span class="toggle-slider"></span>
          <span class="toggle-label" id="auto-trade-label">自动交易(≤${state.autoTradeWearThreshold.toFixed(2)}U)</span>
        </label>
        <label class="toggle-switch">
          <input type="checkbox" id="full-auto-toggle">
          <span class="toggle-slider"></span>
          <span class="toggle-label">全自动确认(二次弹窗)</span>
        </label>
        <div class="amount-input-row">
          <span class="amount-label">成交额</span>
          <input type="number" id="trade-amount-input" class="amount-input" value="${state.tradeAmount}" min="1" step="1">
          <span class="amount-unit">U</span>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="target-volume-toggle">
          <span class="toggle-slider"></span>
          <span class="toggle-label" id="target-volume-toggle-label">${getTargetModeToggleText()}</span>
        </label>
        <div class="amount-input-row">
          <span class="amount-label" id="target-value-label">${getTargetInputLabelText()}</span>
          <input type="number" id="target-value-input" class="amount-input" value="${getTargetInputValue()}" min="${getTargetInputMinValue()}" step="${getTargetInputStepValue()}">
          <span class="amount-unit" id="target-value-unit">${getTargetInputUnitText()}</span>
        </div>
        <div class="amount-input-row">
          <span class="amount-label">阈值</span>
          <input type="number" id="wear-threshold-input" class="amount-input" value="${state.autoTradeWearThreshold}" min="0" step="0.01">
          <span class="amount-unit">U</span>
        </div>
        <div class="amount-input-row">
          <span class="amount-label">上浮</span>
          <input type="number" id="price-markup-input" class="amount-input" value="${state.priceMarkup}" min="0" step="0.01">
          <span class="amount-unit">%</span>
        </div>
        <div class="amount-input-row">
          <span class="amount-label">冷却</span>
          <input type="number" id="cooldown-input" class="amount-input" value="${state.cooldown}" min="0" step="1">
          <span class="amount-unit">秒</span>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    createWearDetailSidePanel();

    // 绑定事件
    setupDragAndDrop(container);
    setupControls(container);
    setupAutoFillToggle(container);
    setupAutoTradeToggle(container);
    setupFullAutoToggle(container);
    setupTradeAmountInput(container);
    setupTargetModeToggle(container);
    setupTargetValueInput(container);
    setupWearThresholdInput(container);
    setupPriceMarkupInput(container);
    setupCooldownInput(container);
    updateAutoTradeLabel(container);
    syncTargetSettingInputs(container);
    updateWearDetailSidePanel(container);


  }

  function updateAutoTradeLabel(container = document.getElementById('binance-spread-monitor')) {
    if (!container) return;
    const label = container.querySelector('#auto-trade-label');
    if (!label) return;
    label.textContent = `自动交易(≤${Number(state.autoTradeWearThreshold || 0).toFixed(2)}U)`;
  }

  /**
   * 设置拖拽功能
   */
  function setupDragAndDrop(container) {
    const header = container.querySelector('.monitor-header');
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('control-btn')) return;
      isDragging = true;
      offsetX = e.clientX - container.offsetLeft;
      offsetY = e.clientY - container.offsetTop;
      container.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = e.clientX - offsetX;
      const y = e.clientY - offsetY;
      container.style.left = `${Math.max(0, x)}px`;
      container.style.top = `${Math.max(0, y)}px`;
      container.style.right = 'auto';
      positionWearDetailSidePanel(container);
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      container.style.transition = '';
      positionWearDetailSidePanel(container);
    });
  }

  /**
   * 设置控制按钮
   */
  function setupControls(container) {
    // 最小化
    container.querySelector('#monitor-minimize').addEventListener('click', () => {
      state.isMinimized = !state.isMinimized;
      container.classList.toggle('minimized', state.isMinimized);
      container.querySelector('#monitor-minimize').textContent = state.isMinimized
        ? '+'
        : '−';
      updateWearDetailSidePanel(container);
    });

    // 关闭
    container.querySelector('#monitor-close').addEventListener('click', () => {
      const sidePanel = getWearDetailSidePanel();
      if (sidePanel) sidePanel.remove();
      container.remove();
    });
  }

  /**
   * 设置自动填充开关
   */
  function setupAutoFillToggle(container) {
    const toggle = container.querySelector('#auto-fill-toggle');
    if (!toggle) return;

    toggle.checked = state.autoFillReverse;

    // 如果默认开启，立即开始监控
    if (state.autoFillReverse) {
      startReverseOrderAutoFill();
    }

    toggle.addEventListener('change', (e) => {
      state.autoFillReverse = e.target.checked;
      saveSettings();


      if (state.autoFillReverse) {
        startReverseOrderAutoFill();
      }
    });
  }

  /**
   * 设置自动交易开关
   */
  function setupAutoTradeToggle(container) {
    const toggle = container.querySelector('#auto-trade-toggle');
    if (!toggle) return;

    toggle.checked = state.autoTrade;

    toggle.addEventListener('change', (e) => {
      state.autoTrade = e.target.checked;
      saveSettings();
      resetVolumeScanInterval();

      if (state.autoTrade) {
        activateOrderHistoryTabAndRefresh();
      }
    });
  }

  /**
   * 设置全自动确认开关（二次弹窗自动点确认）
   */
  function setupFullAutoToggle(container) {
    const toggle = container.querySelector('#full-auto-toggle');
    if (!toggle) return;
    toggle.checked = state.fullAutoConfirm;
    toggle.addEventListener('change', (e) => {
      state.fullAutoConfirm = e.target.checked;
      saveSettings();
    });
  }

  /**
   * 设置成交额输入框
   */
  function setupTradeAmountInput(container) {
    const input = container.querySelector('#trade-amount-input');
    if (!input) return;

    input.value = state.tradeAmount;

    input.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (!isNaN(value) && value > 0) {
        state.tradeAmount = value;
        saveSettings();

      }
    });

    input.addEventListener('change', (e) => {
      const value = parseFloat(e.target.value);
      if (isNaN(value) || value <= 0) {
        e.target.value = state.tradeAmount;
      }
    });
  }

  /**
   * 设置目标模式开关
   */
  function setupTargetModeToggle(container) {
    const toggle = container.querySelector('#target-volume-toggle');
    if (!toggle) return;

    toggle.checked = isVolumeTargetMode();
    toggle.addEventListener('change', (e) => {
      state.autoTradeTargetMode = e.target.checked ? 'volume' : 'count';
      saveSettings();
      syncTargetSettingInputs(container);
      updateMonitorUI();
      maybeNotifyAutoTargetCompleted();
    });
  }

  /**
   * 设置目标值输入
   */
  function setupTargetValueInput(container) {
    const input = container.querySelector('#target-value-input');
    if (!input) return;
    input.value = getTargetInputValue();

    input.addEventListener('input', (e) => {
      const value = sanitizeTargetInputValue(e.target.value);
      if (value !== null) {
        applyTargetInputValue(value);
        saveSettings();
        updateMonitorUI();
      }
    });

    input.addEventListener('change', (e) => {
      const value = sanitizeTargetInputValue(e.target.value);
      if (value === null) {
        e.target.value = getTargetInputValue();
        return;
      }
      applyTargetInputValue(value);
      saveSettings();
      syncTargetSettingInputs(container);
      updateMonitorUI();
      maybeNotifyAutoTargetCompleted();
    });
  }

  function getTradeCycleRange() {
    const now = new Date();
    const startTime = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    );

    return {
      startTime,
      endTime: startTime + 24 * 60 * 60 * 1000,
      cycleKey: new Date(startTime).toISOString().slice(0, 10),
    };
  }

  function getTradeCycleKey() {
    return getTradeCycleRange().cycleKey;
  }

  function ensureAutoSubmittedCycle() {
    const key = getTradeCycleKey();
    if (state.autoSubmittedCycleKey !== key) {
      state.autoSubmittedCycleKey = key;
      state.autoSubmittedCount = 0;
      state.autoSubmittedBuyAmount = 0;
    }
  }

  function isVolumeTargetMode() {
    return state.autoTradeTargetMode === 'volume';
  }

  function normalizeSymbolText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function getCurrentTokenSymbol() {
    const buyButton = findVisibleBuyButton();
    const buttonText = normalizeSymbolText(buyButton?.innerText || '');
    const buttonMatch = buttonText.match(/^买入\s+(.+)$/);
    if (buttonMatch?.[1]) {
      return normalizeSymbolText(buttonMatch[1]);
    }

    const quantityInput = document.querySelector('input#limitAmount');
    const quantityField = quantityInput?.closest('.bn-textField');
    const suffixText = normalizeSymbolText(quantityField?.querySelector('.bn-textField-suffix')?.innerText || '');
    if (suffixText) {
      const suffixMatch = suffixText.match(/([A-Za-z][A-Za-z0-9]{1,20})$/);
      if (suffixMatch?.[1]) {
        return normalizeSymbolText(suffixMatch[1]);
      }
    }

    const firstCycleSymbol = normalizeSymbolText(state.cycleSymbols?.[0] || '');
    if (firstCycleSymbol) {
      return firstCycleSymbol;
    }

    return '';
  }

  function getTradeVolumeMultiplier() {
    const symbol = getCurrentTokenSymbol();
    return CONFIG.SPECIAL_VOLUME_SYMBOLS_X1.includes(symbol)
      ? 1
      : CONFIG.DEFAULT_TRADE_VOLUME_MULTIPLIER;
  }

  function getTradeVolumeMultiplierText() {
    return `×${getTradeVolumeMultiplier()}`;
  }

  function getAutoProgressCount() {
    // 展示口径：严格与“本周期买入额”一致，避免视觉上超前
    return Number(state.dailyTradeCount || 0);
  }

  function getAutoProgressVolume() {
    return Number(state.dailyVolume || 0) * getTradeVolumeMultiplier();
  }

  function getAutoTargetCount() {
    return Math.max(1, Number(state.autoTradeTargetCount || 16));
  }

  function getAutoTargetVolume() {
    return Math.max(0.01, Number(state.autoTradeTargetVolume || 32768));
  }

  function getAutoTargetValue() {
    return isVolumeTargetMode() ? getAutoTargetVolume() : getAutoTargetCount();
  }

  function getAutoProgressValue() {
    return isVolumeTargetMode() ? getAutoProgressVolume() : getAutoProgressCount();
  }

  function formatAutoMetricNumber(value) {
    const amount = Number(value || 0);
    if (Math.abs(amount - Math.round(amount)) < 0.000001) {
      return String(Math.round(amount));
    }

    return amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function getAutoProgressLabelText() {
    return isVolumeTargetMode() ? `🎯 自动进度(交易量${getTradeVolumeMultiplierText()})` : '🎯 自动进度';
  }

  function getTargetInputLabelText() {
    return isVolumeTargetMode() ? '目标交易量' : '目标笔数';
  }

  function getTargetInputUnitText() {
    return isVolumeTargetMode() ? `U(${getTradeVolumeMultiplierText()})` : '笔/日';
  }

  function getTargetModeToggleText() {
    return `按交易量目标(交易量${getTradeVolumeMultiplierText()})`;
  }

  function getTargetInputStepValue() {
    return isVolumeTargetMode() ? '0.01' : '1';
  }

  function getTargetInputMinValue() {
    return isVolumeTargetMode() ? '0.01' : '1';
  }

  function getTargetInputValue() {
    return isVolumeTargetMode()
      ? formatAutoMetricNumber(getAutoTargetVolume())
      : String(getAutoTargetCount());
  }

  function sanitizeTargetInputValue(rawValue) {
    const parsed = isVolumeTargetMode()
      ? parseFloat(rawValue)
      : parseInt(rawValue, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return isVolumeTargetMode() ? parsed : Math.floor(parsed);
  }

  function applyTargetInputValue(value) {
    if (isVolumeTargetMode()) {
      state.autoTradeTargetVolume = Number(value);
      return;
    }

    state.autoTradeTargetCount = Math.max(1, Math.floor(Number(value)));
  }

  function syncTargetSettingInputs(
    container = document.getElementById('binance-spread-monitor'),
    options = {}
  ) {
    if (!container) return;
    const preserveInputValue = !!options.preserveInputValue;

    const toggle = container.querySelector('#target-volume-toggle');
    const modeLabel = container.querySelector('#target-volume-toggle-label');
    const label = container.querySelector('#target-value-label');
    const input = container.querySelector('#target-value-input');
    const unit = container.querySelector('#target-value-unit');

    if (toggle) {
      toggle.checked = isVolumeTargetMode();
    }
    if (modeLabel) {
      modeLabel.textContent = getTargetModeToggleText();
    }
    if (label) {
      label.textContent = getTargetInputLabelText();
    }
    if (input) {
      if (!preserveInputValue || document.activeElement !== input) {
        input.value = getTargetInputValue();
      }
      input.step = getTargetInputStepValue();
      input.min = getTargetInputMinValue();
    }
    if (unit) {
      unit.textContent = getTargetInputUnitText();
    }
  }

  function getAutoTargetSignature() {
    if (isVolumeTargetMode()) {
      return `volume:${getTradeVolumeMultiplier()}:${formatAutoMetricNumber(getAutoTargetValue())}`;
    }

    return `count:${formatAutoMetricNumber(getAutoTargetValue())}`;
  }

  function formatAutoProgressText(progressValue = getAutoProgressValue(), targetValue = getAutoTargetValue()) {
    if (isVolumeTargetMode()) {
      return `${formatAutoMetricNumber(progressValue)} / ${formatAutoMetricNumber(targetValue)} U`;
    }

    return `${Number(progressValue || 0)} / ${Number(targetValue || 0)} 笔`;
  }

  function isAutoTargetCompleted() {
    return getAutoProgressValue() >= getAutoTargetValue();
  }

  function getCycleWearClassName() {
    if (state.cycleWearAmount > 0.000001) return 'positive';
    if (state.cycleWearAmount < -0.000001) return 'negative';
    return '';
  }

  function formatSignedUsdt(value) {
    const amount = Number(value || 0);
    const prefix = amount > 0 ? '+' : '';
    return `${prefix}${amount.toFixed(4)} U`;
  }

  function formatUsdtDetail(value) {
    return `${Number(value || 0).toFixed(4)} U`;
  }

  function formatSignedUsdtDetail(value) {
    const amount = Number(value || 0);
    const prefix = amount > 0 ? '+' : '';
    return `${prefix}${amount.toFixed(4)} U`;
  }

  function formatSignedPercent(value) {
    const amount = Number(value || 0);
    const prefix = amount > 0 ? '+' : '';
    return `${prefix}${amount.toFixed(4)}%`;
  }

  function formatSignedPrice(value) {
    const amount = Number(value || 0);
    const prefix = amount > 0 ? '+' : '';
    return `${prefix}${formatPrice(amount)}`;
  }

  function getValueTrendClass(value) {
    if (value > 0.000001) return 'positive';
    if (value < -0.000001) return 'negative';
    return '';
  }

  function getLiquidityWarningText() {
    const tradeCount = Number(state.recentTradeCountInWindow || 0);
    const seconds = Math.floor(CONFIG.LIQUIDITY_WINDOW_MS / 1000);
    if (state.autoTrade && state.fullAutoConfirm) {
      return `⚠️ 流动性较差：最近 ${seconds} 秒仅 ${tradeCount} 笔，已拦截自动交易（含全自动确认）`;
    }
    if (state.autoTrade) {
      return `⚠️ 流动性较差：最近 ${seconds} 秒仅 ${tradeCount} 笔，已拦截自动交易`;
    }
    if (state.fullAutoConfirm) {
      return `⚠️ 流动性较差：最近 ${seconds} 秒仅 ${tradeCount} 笔；当前仅开启全自动确认，开启自动交易后也会被拦截`;
    }
    return `⚠️ 流动性较差：最近 ${seconds} 秒仅 ${tradeCount} 笔`;
  }

  function reportAutoTradeBlocked(reason) {
    const normalizedReason = String(reason || '').trim();
    if (!normalizedReason) return;

    const now = Date.now();
    const reasonChanged = state.lastAutoTradeBlockReason !== normalizedReason;
    const intervalReached =
      now - Number(state.lastAutoTradeBlockLogAt || 0) >= CONFIG.AUTO_TRADE_BLOCK_LOG_INTERVAL_MS;

    if (!reasonChanged && !intervalReached) return;

    console.log(`[自动交易] 已拦截：${normalizedReason}`);
    state.lastAutoTradeBlockReason = normalizedReason;
    state.lastAutoTradeBlockLogAt = now;
  }

  function clearAutoTradeBlockedReason() {
    state.lastAutoTradeBlockReason = '';
    state.lastAutoTradeBlockLogAt = 0;
  }

  function getWearLossAmount(value) {
    const amount = Number(value || 0);
    if (amount >= -0.000001) return 0;
    return Math.abs(amount);
  }

  function isWearDetailFlagged(item) {
    return getWearLossAmount(item?.wearAmount) >= Number(CONFIG.WEAR_DETAIL_ALERT_THRESHOLD || 0);
  }

  function getChronologicalCycleWearDetails() {
    if (!Array.isArray(state.cycleWearDetails)) return [];
    return [...state.cycleWearDetails].sort((left, right) => {
      const leftTime = Number(left?.buyTimeMs || 0);
      const rightTime = Number(right?.buyTimeMs || 0);
      if (leftTime !== rightTime) return rightTime - leftTime;
      return Number(right?.sellTimeMs || 0) - Number(left?.sellTimeMs || 0);
    });
  }

  function getCycleWearDetailSummaryText() {
    const details = getChronologicalCycleWearDetails();
    const pairCount = Number(details.length || 0);
    const summaryParts = [`已配对 ${pairCount} 笔`];
    const flaggedCount = details.filter((item) => isWearDetailFlagged(item)).length;
    const cycleSymbols = Array.isArray(state.cycleSymbols)
      ? state.cycleSymbols.map((item) => normalizeSymbolText(item)).filter(Boolean)
      : [];

    if (cycleSymbols.length > 0) {
      summaryParts.push(`币种 ${cycleSymbols.join(' / ')}`);
    }

    if (state.cycleUnmatchedBuyCount || state.cycleUnmatchedSellCount) {
      summaryParts.push(`未配对 买${state.cycleUnmatchedBuyCount}/卖${state.cycleUnmatchedSellCount}`);
    }

    if (flaggedCount > 0) {
      summaryParts.push(`异化 ${flaggedCount} 笔`);
    }

    summaryParts.push('列表从晚到早，序号从早到晚');
    return summaryParts.join(' · ');
  }

  function renderCycleWearDetailItemsHtml() {
    const details = getChronologicalCycleWearDetails();

    if (details.length === 0) {
      if (state.cycleUnmatchedBuyCount || state.cycleUnmatchedSellCount) {
        return `<div class="wear-detail-empty">暂无已完成配对，未配对：买入 ${state.cycleUnmatchedBuyCount} / 卖出 ${state.cycleUnmatchedSellCount}</div>`;
      }

      return '<div class="wear-detail-empty">暂无已配对的磨损明细</div>';
    }

    return details
      .map((item, index) => {
        const wearClass = getValueTrendClass(item.wearAmount);
        const spreadClass = getValueTrendClass(item.priceSpread);
        const flagged = isWearDetailFlagged(item);
        const lossAmount = getWearLossAmount(item.wearAmount);
        const serialNumber = details.length - index;
        const wearAmountClass = ['wear-detail-amount', wearClass];
        const itemClass = ['wear-detail-item'];
        if (flagged) {
          wearAmountClass.push('critical');
          itemClass.push('flagged');
        }

        return `
          <div class="${itemClass.join(' ')}">
            <div class="wear-detail-head">
              <div class="wear-detail-head-main">
                <span class="wear-detail-index">#${serialNumber}</span>
                ${item.symbol ? `<span class="wear-detail-symbol">${item.symbol}</span>` : ''}
                <span class="wear-detail-time">${item.buyTimeText}</span>
                ${flagged ? `<span class="wear-detail-flag" title="该笔磨损达到 ${CONFIG.WEAR_DETAIL_ALERT_THRESHOLD.toFixed(2)} U 以上">异化</span>` : ''}
              </div>
              <span class="${wearAmountClass.join(' ')}">${formatSignedUsdtDetail(item.wearAmount)}</span>
            </div>
            <div class="wear-detail-meta">买入 ${formatUsdtDetail(item.buyAmount)} @ ${formatPrice(item.buyPrice)}</div>
            <div class="wear-detail-meta">卖出 ${formatUsdtDetail(item.sellAmount)} @ ${formatPrice(item.sellPrice)}</div>
            <div class="wear-detail-meta">价差 <span class="wear-detail-inline ${spreadClass}">${formatSignedPrice(item.priceSpread)} (${formatSignedPercent(item.priceSpreadPercent)})</span> · 卖出手续费 ${formatUsdtDetail(item.sellFeeAmount)}</div>
            ${flagged ? `<div class="wear-detail-meta wear-detail-alert-note">磨损绝对值 ${formatUsdtDetail(lossAmount)}，已超过 ${CONFIG.WEAR_DETAIL_ALERT_THRESHOLD.toFixed(2)} U 阈值</div>` : ''}
          </div>
        `;
      })
      .join('');
  }

  function renderCycleWearDetailPanel() {
    return `
      <div class="wear-detail-panel" id="wear-detail-panel">
        <div class="wear-detail-summary" id="cycle-wear-detail-summary">${getCycleWearDetailSummaryText()}</div>
        <div class="wear-detail-list" id="cycle-wear-detail-list">${renderCycleWearDetailItemsHtml()}</div>
      </div>
    `;
  }

  function getWearDetailSidePanel() {
    return document.getElementById('binance-spread-monitor-wear-panel');
  }

  function createWearDetailSidePanel() {
    let panel = getWearDetailSidePanel();
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'binance-spread-monitor-wear-panel';
    panel.className = 'hidden';
    document.body.appendChild(panel);
    return panel;
  }

  function positionWearDetailSidePanel(container = document.getElementById('binance-spread-monitor')) {
    const panel = getWearDetailSidePanel();
    if (!container || !panel || panel.classList.contains('hidden')) return;

    const panelWidth = panel.offsetWidth || 360;
    const gap = 16;
    const rect = container.getBoundingClientRect();
    let left = rect.right + gap;

    if (left + panelWidth > window.innerWidth - 16) {
      left = Math.max(16, rect.left - panelWidth - gap);
    }

    const maxTop = Math.max(16, window.innerHeight - panel.offsetHeight - 16);
    const top = Math.min(Math.max(16, rect.top + 96), maxTop);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function updateWearDetailSidePanel(container = document.getElementById('binance-spread-monitor')) {
    const panel = createWearDetailSidePanel();
    const shouldShow = !!state.wearDetailsExpanded && !state.isMinimized && !!container;

    if (!shouldShow) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }

    const existingList = panel.querySelector('#cycle-wear-detail-list');
    if (existingList) {
      state.wearDetailScrollTop = existingList.scrollTop;
    }

    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="wear-detail-side-header">
        <div class="wear-detail-side-title">磨损明细</div>
        <button type="button" class="wear-detail-side-close" id="wear-detail-side-close">×</button>
      </div>
      ${renderCycleWearDetailPanel()}
    `;

    const closeBtn = panel.querySelector('#wear-detail-side-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.wearDetailsExpanded = false;
        state.wearDetailScrollTop = 0;
        updateMonitorUI();
      });
    }

    const list = panel.querySelector('#cycle-wear-detail-list');
    if (list) {
      list.scrollTop = state.wearDetailScrollTop;
      list.addEventListener(
        'scroll',
        () => {
          state.wearDetailScrollTop = list.scrollTop;
        },
        { passive: true }
      );
    }

    positionWearDetailSidePanel(container);
  }

  function syncCompletionNotificationCycle() {
    const cycleKey = getTradeCycleKey();
    if (!state.completionNotifiedCycleKey || state.completionNotifiedCycleKey === cycleKey) return;
    state.completionNotifiedCycleKey = '';
    state.completionNotifiedTargetSignature = '';
    state.completionNotificationPending = false;
    saveRuntimeState();
  }

  function maybeNotifyAutoTargetCompleted() {
    const cycleKey = getTradeCycleKey();
    const targetValue = getAutoTargetValue();
    const targetSignature = getAutoTargetSignature();

    syncCompletionNotificationCycle();
    if (!isAutoTargetCompleted()) return;

    if (
      state.completionNotifiedCycleKey === cycleKey &&
      state.completionNotifiedTargetSignature === targetSignature
    ) {
      return;
    }

    if (state.completionNotificationPending) {
      return;
    }

    if (!chrome?.runtime?.sendMessage) {
      return;
    }

    state.completionNotificationPending = true;
    chrome.runtime.sendMessage(
      {
        type: 'binance-spread-monitor:auto-target-completed',
        cycleKey,
        targetSignature,
        progressText: formatAutoProgressText(getAutoProgressValue(), targetValue),
      },
      (response) => {
        state.completionNotificationPending = false;

        if (chrome.runtime.lastError) {
          console.log('[价差监控] 发送完成通知失败', chrome.runtime.lastError.message);
          return;
        }

        if (!response?.ok) {
          console.log('[价差监控] 完成通知未成功创建', response?.error || '未知错误');
          return;
        }

        state.completionNotifiedCycleKey = cycleKey;
        state.completionNotifiedTargetSignature = targetSignature;
        saveRuntimeState();
      }
    );
  }

  function applyCycleProgressState(section = document.querySelector('#daily-volume-section')) {
    if (!section) return;

    const completed = isAutoTargetCompleted();
    section.classList.toggle('completed', completed);

    const targetEl = section.querySelector('#auto-target-progress');
    if (targetEl) {
      targetEl.classList.toggle('completed', completed);
    }
  }

  function getAutoTradeGuardCount() {
    // 交易口径：为了防止页面历史统计延迟导致超刷，使用更保守的计数
    ensureAutoSubmittedCycle();
    return Math.max(Number(state.dailyTradeCount || 0), Number(state.autoSubmittedCount || 0));
  }

  function getAutoTradeGuardVolume() {
    ensureAutoSubmittedCycle();
    return Math.max(Number(state.dailyVolume || 0), Number(state.autoSubmittedBuyAmount || 0)) * getTradeVolumeMultiplier();
  }

  function getAutoTradeGuardValue() {
    return isVolumeTargetMode() ? getAutoTradeGuardVolume() : getAutoTradeGuardCount();
  }

  function getAutoTargetBlockedReason() {
    if (isVolumeTargetMode()) {
      return `已达到目标交易量 ${formatAutoMetricNumber(getAutoTargetValue())} U (${getTradeVolumeMultiplierText()})`;
    }

    return `已达到目标笔数 ${getAutoTargetCount()} 笔`;
  }

  function getPendingSubmitCount() {
    ensureAutoSubmittedCycle();
    return Math.max(0, Number(state.autoSubmittedCount || 0) - Number(state.dailyTradeCount || 0));
  }

  /**
   * 设置自动交易磨损阈值输入框
   */
  function setupWearThresholdInput(container) {
    const input = container.querySelector('#wear-threshold-input');
    if (!input) return;

    input.value = state.autoTradeWearThreshold;

    input.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (!isNaN(value) && value >= 0) {
        state.autoTradeWearThreshold = value;
        updateAutoTradeLabel(container);
        saveSettings();
      }
    });

    input.addEventListener('change', (e) => {
      const value = parseFloat(e.target.value);
      if (isNaN(value) || value < 0) {
        e.target.value = state.autoTradeWearThreshold;
        return;
      }
      state.autoTradeWearThreshold = value;
      updateAutoTradeLabel(container);
      saveSettings();
    });
  }

  /**
   * 设置上浮百分比输入框
   */
  function setupPriceMarkupInput(container) {
    const input = container.querySelector('#price-markup-input');
    if (!input) return;

    input.value = state.priceMarkup;

    input.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (!isNaN(value) && value >= 0) {
        state.priceMarkup = value;
        saveSettings();

      }
    });

    input.addEventListener('change', (e) => {
      const value = parseFloat(e.target.value);
      if (isNaN(value) || value < 0) {
        e.target.value = state.priceMarkup;
      }
    });
  }

  /**
   * 设置冷却时间输入框
   */
  function setupCooldownInput(container) {
    const input = container.querySelector('#cooldown-input');
    if (!input) return;

    input.value = state.cooldown;

    input.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      if (!isNaN(value) && value >= 0) {
        state.cooldown = value;
        saveSettings();

      }
    });

    input.addEventListener('change', (e) => {
      const value = parseInt(e.target.value);
      if (isNaN(value) || value < 0) {
        e.target.value = state.cooldown;
      }
    });
  }

  /**
   * 检查是否趋势向上（最近3笔成交金额 > 前3笔成交金额）
   */
  function checkUpwardTrend() {
    if (state.trades.length < 6) {
      return false;
    }

    const recent3Value = state.trades.slice(0, 3)
      .reduce((sum, t) => sum + (t.value || 0), 0);
    const previous3Value = state.trades.slice(3, 6)
      .reduce((sum, t) => sum + (t.value || 0), 0);

    const isUpward = recent3Value > previous3Value;


    return isUpward;
  }

  /**
   * 实时获取最新成交价（从DOM直接读取）
   */
  function getLatestTradePrice() {
    // 找到成交记录的虚拟滚动列表
    const grids = document.querySelectorAll('.ReactVirtualized__Grid.ReactVirtualized__List');

    let grid = null;
    for (const g of grids) {
      if (g.querySelector('[role="gridcell"]')) {
        grid = g;
        break;
      }
    }

    if (!grid) return null;

    // 获取所有交易记录行
    const rows = grid.querySelectorAll('[role="gridcell"]');
    if (rows.length === 0) return null;

    // 遍历找到第一个有效的价格（最新记录）
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const row = rows[i];
      const children = row.children;
      if (children.length < 2) continue;

      // 价格在第二个子元素
      const priceEl = children[1];
      const priceText = priceEl?.innerText?.trim();

      if (!priceText) continue;

      const price = parseFloat(priceText);
      if (isNaN(price) || price <= 0) continue;

      return price;
    }

    return null;
  }

  function normalizeInlineText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isElementVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    return element.getClientRects().length > 0;
  }

  function findVisibleBuyButton(root = document) {
    const buttons = Array.from(root.querySelectorAll('.bn-button.bn-button__buy'));
    return buttons.find(isElementVisible) || null;
  }

  function findBuyOrderFormRoot() {
    const buyButton = findVisibleBuyButton();
    if (!buyButton) {
      return document;
    }

    let current = buyButton.parentElement;
    while (current && current !== document.body) {
      if (current.querySelector('input#limitPrice')) {
        return current;
      }
      current = current.parentElement;
    }

    return document;
  }

  function findFieldInputByLabel(labelText, root = findBuyOrderFormRoot()) {
    const targetText = normalizeInlineText(labelText);
    const labelNodes = Array.from(root.querySelectorAll('div, label, span')).filter((node) => {
      if (!isElementVisible(node)) return false;
      if (node.children.length > 0) return false;
      return normalizeInlineText(node.textContent) === targetText;
    });

    for (const labelNode of labelNodes) {
      let current = labelNode.parentElement;
      while (current && current !== document.body) {
        const candidateInput = Array.from(current.querySelectorAll('input')).find(isElementVisible);
        if (candidateInput) {
          return candidateInput;
        }
        if (current === root) {
          break;
        }
        current = current.parentElement;
      }
    }

    return null;
  }

  function findLimitPriceInput(root = findBuyOrderFormRoot()) {
    const byId = root.querySelector('input#limitPrice');
    if (isElementVisible(byId)) {
      return byId;
    }

    return findFieldInputByLabel('价格', root);
  }

  function findTradeTotalInput(root = findBuyOrderFormRoot()) {
    const labeledInput = findFieldInputByLabel('成交额', root);
    if (labeledInput) {
      return labeledInput;
    }

    const fallbackInput = Array.from(root.querySelectorAll('input[placeholder^="最小 "]')).find(isElementVisible);
    return fallbackInput || null;
  }

  function findTradeQuantityInput(root = findBuyOrderFormRoot()) {
    const labeledInput = findFieldInputByLabel('数量', root);
    if (labeledInput) {
      return labeledInput;
    }

    const byId = root.querySelector('input#limitAmount');
    return isElementVisible(byId) ? byId : null;
  }

  function getInputStepDecimals(input, fallback = 4) {
    const stepText = String(input?.getAttribute('step') || '').trim();
    if (!stepText || stepText === 'any') {
      return fallback;
    }

    const scientificMatch = stepText.match(/e-(\d+)$/i);
    if (scientificMatch) {
      return Math.max(0, Number(scientificMatch[1]));
    }

    const dotIndex = stepText.indexOf('.');
    if (dotIndex >= 0) {
      return Math.max(0, stepText.length - dotIndex - 1);
    }

    return 0;
  }

  function findReverseOrderPriceInput(root = findBuyOrderFormRoot()) {
    const exactSelectors = [
      'input[placeholder="限价卖出"]',
      'input[placeholder="限价买入"]',
      'input[placeholder="限价卖单价格"]',
      'input[placeholder="限价买单价格"]',
    ];

    for (const selector of exactSelectors) {
      const input = root.querySelector(selector);
      if (isElementVisible(input)) {
        return input;
      }
    }

    const excludedInputs = new Set(
      [
        findLimitPriceInput(root),
        findTradeTotalInput(root),
        findTradeQuantityInput(root),
      ].filter(Boolean)
    );

    return Array.from(root.querySelectorAll('input')).find((input) => {
      if (!isElementVisible(input) || excludedInputs.has(input)) {
        return false;
      }

      const placeholder = normalizeInlineText(input.getAttribute('placeholder') || '');
      if (!placeholder) {
        return false;
      }

      if (!placeholder.includes('限价') || !placeholder.includes('价格')) {
        return false;
      }

      return placeholder.includes('卖') || placeholder.includes('买');
    }) || null;
  }

  function formatValueForInput(value, input, fallbackDecimals = 4) {
    if (!Number.isFinite(value)) {
      return '';
    }

    const decimals = Math.min(getInputStepDecimals(input, fallbackDecimals), 8);
    if (decimals <= 0) {
      return String(Math.round(value));
    }

    return value.toFixed(decimals);
  }

  function fillTradeAmountInput(formRoot, buyPrice) {
    const totalInput = findTradeTotalInput(formRoot);
    if (totalInput) {
      setInputValue(totalInput, state.tradeAmount.toString());
      console.log(`[自动交易] 已填充成交额输入框: ${state.tradeAmount}`);
      return true;
    }

    const quantityInput = findTradeQuantityInput(formRoot);
    if (!quantityInput || !Number.isFinite(buyPrice) || buyPrice <= 0) {
      console.log('[自动交易] 未找到成交额输入框，且无法回退填充数量');
      return false;
    }

    const quantityValue = formatValueForInput(state.tradeAmount / buyPrice, quantityInput, 4);
    if (!quantityValue) {
      console.log('[自动交易] 计算数量失败，未执行回退填充');
      return false;
    }

    setInputValue(quantityInput, quantityValue);
    console.log(`[自动交易] 未找到成交额输入框，已回退填充数量: ${quantityValue}`);
    return true;
  }

  function ensureTradeAmountAccepted(formRoot, buyPrice) {
    const buyButton = findVisibleBuyButton(formRoot);
    if (buyButton && !buyButton.disabled) {
      return true;
    }

    const quantityInput = findTradeQuantityInput(formRoot);
    if (!quantityInput || !Number.isFinite(buyPrice) || buyPrice <= 0) {
      return false;
    }

    if (normalizeInlineText(quantityInput.value)) {
      return false;
    }

    const quantityValue = formatValueForInput(state.tradeAmount / buyPrice, quantityInput, 4);
    if (!quantityValue) {
      return false;
    }

    setInputValue(quantityInput, quantityValue);
    console.log(`[自动交易] 买入按钮仍不可用，已补填数量输入框: ${quantityValue}`);
    return true;
  }

  /**
   * 执行自动交易
   */
  function executeAutoTrade() {
    // 1. 检查自动交易开关
    if (!state.autoTrade) return;

    // 1.1 检查流动性保护
    if (state.isLowLiquidity) {
      const blockScope = state.fullAutoConfirm ? '自动交易（含全自动确认）' : '自动交易';
      reportAutoTradeBlocked(`流动性较差，最近 ${Math.floor(CONFIG.LIQUIDITY_WINDOW_MS / 1000)} 秒仅 ${state.recentTradeCountInWindow} 笔，已拦截${blockScope}`);
      return;
    }

    // 2. 检查磨损条件
    if (state.wearCost > state.autoTradeWearThreshold) {
      reportAutoTradeBlocked(`磨损过高，当前 ${state.wearCost.toFixed(2)} U > 阈值 ${Number(state.autoTradeWearThreshold || 0).toFixed(2)} U`);
      return;
    }

    // 3. 检查趋势
    if (!checkUpwardTrend()) {
      reportAutoTradeBlocked('趋势未满足上行条件');
      return;
    }

    // 4. 防抖：距离上次交易至少n秒（可配置）
    const cooldownMs = state.cooldown * 1000;
    if (state.lastTradeTime && Date.now() - state.lastTradeTime < cooldownMs) {
      reportAutoTradeBlocked(`冷却中，等待 ${Math.ceil((cooldownMs - (Date.now() - state.lastTradeTime)) / 1000)} 秒`);
      return;
    }

    // 4.1 检查目标笔数上限（按 08:00 切日）
    const progressCount = getAutoTradeGuardValue();
    if (progressCount >= getAutoTargetValue()) {
      reportAutoTradeBlocked(getAutoTargetBlockedReason());
      return;
    }

    // 4.2 二层保护：若历史成交未及时刷新，不继续叠加下单，避免超刷
    if (getPendingSubmitCount() >= CONFIG.MAX_PENDING_SUBMITS) {
      reportAutoTradeBlocked(`历史成交未同步，当前待确认 ${getPendingSubmitCount()} 笔`);
      return;
    }

    // 5. 实时获取最新成交价（从DOM重新提取确保价格是最新的）
    const latestPrice = getLatestTradePrice();
    if (!latestPrice) {
      reportAutoTradeBlocked('未获取到最新成交价');
      return;
    }

    // 6. 计算买入价格（使用配置的上浮百分比）
    const buyPrice = latestPrice * (1 + state.priceMarkup / 100);

    clearAutoTradeBlockedReason();
    console.log(`[自动交易] ✓ 执行交易: 买入价=${buyPrice.toFixed(8)}, 成交额=${state.tradeAmount}U`);

    // 串行填充，避免React状态冲突
    state.lastTradeTime = Date.now();
    const savedAutoFill = state.autoFillReverse;
    state.autoFillReverse = false;

    setTimeout(() => {
      const formRoot = findBuyOrderFormRoot();
      const priceInput = findLimitPriceInput(formRoot);
      if (!priceInput) {
        console.log('[自动交易] 未找到主价格输入框');
        state.autoFillReverse = savedAutoFill;
        return;
      }
      setInputValue(priceInput, buyPrice.toFixed(8));

      setTimeout(() => {
        fillTradeAmountInput(formRoot, buyPrice);

        setTimeout(() => {
          ensureTradeAmountAccepted(formRoot, buyPrice);

          setTimeout(() => {
            const reversePrice = buyPrice * 0.99;
            fillReverseOrderPrice(reversePrice.toFixed(8));
            state.autoFillReverse = savedAutoFill;

            setTimeout(() => {
              clickBuyButton();
            }, 100);
          }, 80);
        }, 100);
      }, 100);
    }, 100);
  }


  /**
   * 点击买入按钮
   */
  function clickBuyButton() {
    // 查找买入按钮
    const buyButton = findVisibleBuyButton();

    if (!buyButton) {
      console.log('[自动交易] 未找到买入按钮');
      return;
    }

    if (buyButton.disabled) {
      console.log('[自动交易] 买入按钮不可用');
      return;
    }

    buyButton.click();
    ensureAutoSubmittedCycle();
    state.autoSubmittedCount += 1;
    state.autoSubmittedBuyAmount += Number(state.tradeAmount || 0);

    if (state.fullAutoConfirm) {
      autoConfirmOrderModal();
      console.log('[自动交易] ✓ 已点击买入按钮，正在自动确认二次弹窗');
    } else {
      console.log('[自动交易] ✓ 已点击买入按钮，请在确认框中手动确认');
    }

    // 主动拉一次历史成交，尽快同步 dailyTradeCount，减少展示/控制滞后
    setTimeout(() => scanOrderHistory(), 1200);
  }

  /**
   * 自动点击二次确认弹窗（最多重试 8 秒）
   */
  function autoConfirmOrderModal() {
    const startedAt = Date.now();
    const maxWaitMs = 8000;

    const timer = setInterval(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"], .bn-modal-wrap[role="dialog"]');
      let clicked = false;

      dialogs.forEach((dialog) => {
        if (clicked) return;
        const text = (dialog.innerText || '').trim();
        // 仅处理下单确认弹窗，避免误点其他弹窗
        if (!text || (!text.includes('委托价') && !text.includes('成交额') && !text.includes('限价 / 买入'))) {
          return;
        }

        const buttons = dialog.querySelectorAll('button');
        buttons.forEach((btn) => {
          if (clicked) return;
          const label = (btn.innerText || '').trim();
          const disabled = !!btn.disabled || btn.getAttribute('aria-disabled') === 'true';
          if (!disabled && (label === '确认' || label.includes('确认') || label.toLowerCase() === 'confirm')) {
            btn.click();
            clicked = true;
          }
        });
      });

      if (clicked) {
        clearInterval(timer);
        console.log('[自动交易] ✓ 已自动点击二次确认');
        // 自动确认后再拉一次历史，进一步缩短同步延迟
        setTimeout(() => scanOrderHistory(), 1200);
        return;
      }

      if (Date.now() - startedAt > maxWaitMs) {
        clearInterval(timer);
        console.log('[自动交易] ⚠️ 未在8秒内找到二次确认按钮');
      }
    }, 150);
  }


  /**
   * 启动反向订单自动填充监控
   */
  function startReverseOrderAutoFill() {
    // 查找主价格输入框
    const priceInput = findLimitPriceInput();
    if (!priceInput) {
      return;
    }

    // 监听价格输入变化
    priceInput.addEventListener('input', handlePriceChange);
    priceInput.addEventListener('change', handlePriceChange);


  }

  /**
   * 处理价格变化，自动填充反向订单
   */
  function handlePriceChange(e) {
    if (!state.autoFillReverse) return;

    // 检查是否是限价单模式
    const limitTab = document.querySelector('#bn-tab-LIMIT');
    if (!limitTab || !limitTab.classList.contains('active')) {
      return;
    }

    // 查找反向订单复选框（通过文本内容查找）
    const reverseCheckbox = findReverseOrderCheckbox();
    if (!reverseCheckbox || !reverseCheckbox.checked) {
      return;
    }

    // 获取当前价格
    const currentPrice = parseFloat(e.target.value);
    if (isNaN(currentPrice) || currentPrice <= 0) return;

    // 计算 99% 价格
    const reversePrice = (currentPrice * 0.99).toFixed(8);

    // 查找反向订单价格输入框并填充
    fillReverseOrderPrice(reversePrice);
  }

  /**
   * 查找反向订单复选框
   */
  function findReverseOrderCheckbox() {
    // 方法1: 通过文本内容查找
    const labels = document.querySelectorAll('label, span, div');
    for (const label of labels) {
      if (label.innerText && label.innerText.includes('反向订单')) {
        // 查找其内部或相邻的 checkbox
        const checkbox = label.querySelector('input[type="checkbox"]') ||
          label.parentElement?.querySelector('input[type="checkbox"]') ||
          label.previousElementSibling;
        if (checkbox && (checkbox.type === 'checkbox' || checkbox.getAttribute('role') === 'checkbox')) {
          return checkbox;
        }
        // 可能是自定义的 checkbox 组件，检查 aria-checked
        const customCheckbox = label.closest('[role="checkbox"]') ||
          label.parentElement?.querySelector('[role="checkbox"]');
        if (customCheckbox) {
          return {
            checked: customCheckbox.getAttribute('aria-checked') === 'true' ||
              customCheckbox.classList.contains('checked') ||
              customCheckbox.classList.contains('bn-checkbox-checked')
          };
        }
      }
    }

    // 方法2: 通过常见的 ID 或类名查找
    const possibleSelectors = [
      'input[name*="reverse"]',
      'input[id*="reverse"]',
      '[data-testid*="reverse"]',
      '.reverse-order-checkbox'
    ];

    for (const selector of possibleSelectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }

    return null;
  }

  /**
   * 填充反向订单价格
   */
  function fillReverseOrderPrice(price) {
    const formRoot = findBuyOrderFormRoot();
    const reverseInput = findReverseOrderPriceInput(formRoot);

    if (reverseInput) {
      setInputValue(reverseInput, price);
      console.log(`[价差监控] 已填充反向订单价格: ${price}`);
      return;
    }

    console.log('[价差监控] 未找到反向订单价格输入框');
  }

  /**
   * 设置输入框值（React兼容）
   */
  function setInputValue(input, value) {
    input.focus();
    input.select();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;

    const tracker = input._valueTracker;
    if (tracker) {
      tracker.setValue(input.value);
    }

    nativeInputValueSetter.call(input, value);

    if (tracker) {
      tracker.setValue('');
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /**
   * 更新浮窗显示
   */
  function updateMonitorUI() {
    const container = document.getElementById('binance-spread-monitor');
    if (!container) return;
    syncTargetSettingInputs(container, { preserveInputValue: true });

    const content = container.querySelector('.monitor-content');
    if (!content) return;

    if (state.trades.length === 0) {
      content.innerHTML = '<div class="loading">正在加载数据...</div>';
      return;
    }

    // 磨损越高越红，越低越绿
    const wearClass = state.wearCost > 5 ? 'negative' : state.wearCost > 2 ? 'warning' : 'positive';
    const autoTargetCount = getAutoTargetValue();
    const autoProgressCount = getAutoProgressValue();
    const cycleWearClass = getCycleWearClassName();
    const completedClass = isAutoTargetCompleted() ? ' completed' : '';
    const spreadMainClass = state.isLowLiquidity ? ' low-liquidity' : '';
    const spreadPercentClass = state.isLowLiquidity ? ' warning' : '';

    content.innerHTML = `
      <div class="spread-main${spreadMainClass}">
        <div class="spread-label">交易磨损 (每500U)</div>
        <div class="spread-value ${wearClass}">${state.wearCost.toFixed(4)} U</div>
        <div class="spread-percent${spreadPercentClass}">${state.spreadPercent.toFixed(4)}% 价差</div>
        ${state.isLowLiquidity ? `<div class="liquidity-warning">${getLiquidityWarningText()}</div>` : ''}
      </div>

      <div class="daily-volume-section${completedClass}" id="daily-volume-section">
        <div class="daily-volume-row">
          <span class="daily-volume-label">📦 本周期买入额</span>
          <span class="daily-volume-value" id="daily-volume-val">${state.dailyVolume.toFixed(2)} U / ${state.dailyTradeCount}笔</span>
        </div>
        <div class="daily-volume-row">
          <span class="daily-volume-label">${getAutoProgressLabelText()}</span>
          <span class="daily-volume-value${completedClass}" id="auto-target-progress">${formatAutoProgressText(autoProgressCount, autoTargetCount)}</span>
        </div>
        <div class="daily-volume-row">
          <span class="daily-volume-label">📊 交易量(${getTradeVolumeMultiplierText()})</span>
          <span class="daily-volume-value highlight" id="daily-trade-vol">${getAutoProgressVolume().toFixed(2)} U</span>
        </div>
        <div class="daily-volume-row wear-row">
          <div class="daily-volume-label-group">
            <span class="daily-volume-label">💸 磨损</span>
            <button type="button" class="wear-detail-toggle" id="wear-detail-toggle">${state.wearDetailsExpanded ? '收起明细' : '查看明细'}</button>
          </div>
          <span class="daily-volume-value ${cycleWearClass}" id="cycle-wear-amount">${formatSignedUsdt(state.cycleWearAmount)}</span>
        </div>
      </div>
      
      <div class="collapsible-section">
        <div class="collapsible-header" id="details-toggle">
          <span>详细信息</span>
          <span class="collapse-icon">${state.detailsExpanded ? '▼' : '▶'}</span>
        </div>
        <div class="collapsible-content" style="display: ${state.detailsExpanded ? 'block' : 'none'}">
          <div class="price-details">
            <div class="price-item">
              <div class="price-item-label">最高价</div>
              <div class="price-item-value high">${formatPrice(state.highPrice)}</div>
            </div>
            <div class="price-item">
              <div class="price-item-label">最低价</div>
              <div class="price-item-value low">${formatPrice(state.lowPrice)}</div>
            </div>
          </div>
          
          <div class="stats-section">
            <div class="stats-row">
              <span class="stats-label">监控交易数</span>
              <div class="stats-control">
                <button class="config-btn" id="trades-decrease">-</button>
                <span class="stats-value">${state.trades.length} / ${state.maxTrades}</span>
                <button class="config-btn" id="trades-increase">+</button>
              </div>
            </div>
            <div class="stats-row">
              <span class="stats-label">价差绝对值</span>
              <span class="stats-value">${formatPrice(state.spread)}</span>
            </div>
          </div>
        </div>
      </div>
      
      <div class="update-time">最后更新: ${formatTime(state.lastUpdate)}</div>
    `;

    // 绑定折叠按钮
    const detailsToggle = content.querySelector('#details-toggle');
    if (detailsToggle) {
      detailsToggle.addEventListener('click', () => {
        state.detailsExpanded = !state.detailsExpanded;
        updateMonitorUI();
      });
    }

    // 绑定配置按钮事件
    setupConfigButtons(content);

    // 绑定成交量区域点击刷新
    const volSection = content.querySelector('#daily-volume-section');
    if (volSection) {
      volSection.addEventListener('click', (e) => {
        e.stopPropagation();
        scanOrderHistory();
      });
    }

    const wearToggle = content.querySelector('#wear-detail-toggle');
    if (wearToggle) {
      wearToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        state.wearDetailsExpanded = !state.wearDetailsExpanded;
        if (!state.wearDetailsExpanded) {
          state.wearDetailScrollTop = 0;
        }
        updateMonitorUI();
      });
    }

    applyCycleProgressState(volSection);
    updateWearDetailSidePanel(container);
  }

  /**
   * 设置配置按钮事件
   */
  function setupConfigButtons(content) {
    const decreaseBtn = content.querySelector('#trades-decrease');
    const increaseBtn = content.querySelector('#trades-increase');

    if (decreaseBtn) {
      decreaseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.maxTrades > 5) {
          state.maxTrades -= 5;
          saveSettings();
          refreshData();
        }
      });
    }

    if (increaseBtn) {
      increaseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.maxTrades < 100) {
          state.maxTrades += 5;
          saveSettings();
          refreshData();
        }
      });
    }
  }

  /**
   * 刷新数据
   */
  function refreshData() {
    const trades = extractTrades();
    if (trades.length > 0) {
      calculateSpread(trades);
      updateMonitorUI();
    }
  }

  /**
   * 格式化价格
   */
  function formatPrice(price) {
    if (!price || !isFinite(price)) return '0.00000000';
    return price.toFixed(8);
  }

  /**
   * 格式化时间
   */
  function formatTime(date) {
    if (!date) return '--:--:--';
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function parseRecentTradeTimestamp(timeText, now = new Date()) {
    const raw = String(timeText || '').replace(/\n/g, ' ').trim();
    if (!raw) return null;

    const fullDateMatch = raw.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
    );
    if (fullDateMatch) {
      const [, year, month, day, hours, minutes, seconds, milliseconds = '0'] = fullDateMatch;
      const parsed = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds),
        Number(milliseconds.padEnd(3, '0'))
      ).getTime();
      return Number.isFinite(parsed) ? parsed : null;
    }

    const timeOnlyMatch = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (timeOnlyMatch) {
      const [, hours, minutes, seconds, milliseconds = '0'] = timeOnlyMatch;
      const parsed = new Date(now);
      parsed.setHours(
        Number(hours),
        Number(minutes),
        Number(seconds),
        Number(milliseconds.padEnd(3, '0'))
      );

      if (parsed.getTime() - now.getTime() > 60 * 1000) {
        parsed.setDate(parsed.getDate() - 1);
      }

      return parsed.getTime();
    }

    const fallback = new Date(raw).getTime();
    return Number.isFinite(fallback) ? fallback : null;
  }

  function calculateRecentTradeLiquidity(trades) {
    const now = Date.now();
    const recentTradeCount = trades.filter((trade) => {
      const timestamp = Number(trade?.timestampMs);
      return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp <= CONFIG.LIQUIDITY_WINDOW_MS;
    }).length;

    state.recentTradeCountInWindow = recentTradeCount;
    state.isLowLiquidity = recentTradeCount < CONFIG.LIQUIDITY_MIN_TRADES;
  }

  function formatTradeDateTime(timestamp) {
    if (!Number.isFinite(Number(timestamp))) return '--';

    const date = new Date(timestamp);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');

    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }

  function parseNumberFromText(text) {
    const normalized = String(text || '').replace(/,/g, '').trim();
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
  }

  function extractCycleHistoryOrders(historyPane, startTime, endTime) {
    const rows = historyPane.querySelectorAll('tr, [role="row"]');
    const orders = [];

    rows.forEach((row) => {
      const cells = row.querySelectorAll('td, [role="gridcell"]');
      const cellList = cells.length >= 8 ? cells : row.children;
      if (cellList.length < 10) return;

      const cellTexts = Array.from(cellList).map((cell) => cell.innerText?.trim() || '');
      const symbolText = (cellTexts[2] || '').replace(/\s+/g, ' ').trim();
      const timeText = cellTexts[1] || '';
      const typeText = cellTexts[4] || '';
      const amountText = cellTexts[9] || '';
      const statusText = cellTexts[13] || cellTexts[cellTexts.length - 1] || '';

      if (!typeText.includes('买入') && !typeText.includes('卖出')) return;
      if (!statusText.includes('已成交')) return;

      const orderTimeText = timeText.replace(/\n/g, ' ').trim();
      const orderTime = new Date(orderTimeText).getTime();
      if (isNaN(orderTime) || orderTime < startTime || orderTime >= endTime) return;

      const amount = parseNumberFromText(amountText);
      if (!Number.isFinite(amount) || amount <= 0) return;

      const executedQty = parseNumberFromText(cellTexts[7]);
      const orderQty = parseNumberFromText(cellTexts[8]);
      const quantity = Number.isFinite(executedQty) && executedQty > 0 ? executedQty : orderQty;
      const avgPrice = parseNumberFromText(cellTexts[5]);
      const derivedPrice = Number.isFinite(quantity) && quantity > 0 ? amount / quantity : NaN;
      const price = Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : derivedPrice;

      orders.push({
        symbol: symbolText,
        type: typeText.includes('买入') ? 'buy' : 'sell',
        timeMs: orderTime,
        timeText: formatTradeDateTime(orderTime),
        amount,
        quantity: Number.isFinite(quantity) ? quantity : 0,
        price: Number.isFinite(price) ? price : 0,
      });
    });

    return orders;
  }

  function buildCycleWearPairs(orderRecords) {
    const buys = orderRecords.filter((record) => record.type === 'buy').sort((a, b) => a.timeMs - b.timeMs);
    const sells = orderRecords.filter((record) => record.type === 'sell').sort((a, b) => a.timeMs - b.timeMs);
    const usedSellIndexes = new Set();
    const details = [];

    buys.forEach((buy) => {
      let matchedSellIndex = -1;

      for (let index = 0; index < sells.length; index += 1) {
        if (usedSellIndexes.has(index)) continue;
        if (sells[index].timeMs >= buy.timeMs) {
          matchedSellIndex = index;
          break;
        }
      }

      if (matchedSellIndex === -1) {
        let nearestDelta = Infinity;

        for (let index = 0; index < sells.length; index += 1) {
          if (usedSellIndexes.has(index)) continue;

          const delta = Math.abs(sells[index].timeMs - buy.timeMs);
          if (delta < nearestDelta) {
            nearestDelta = delta;
            matchedSellIndex = index;
          }
        }
      }

      if (matchedSellIndex === -1) return;

      const sell = sells[matchedSellIndex];
      const sellFeeAmount = sell.amount * CONFIG.ALPHA_SELL_FEE_RATE;
      const sellNetAmount = sell.amount - sellFeeAmount;
      const priceSpread = sell.price - buy.price;
      const priceSpreadPercent = buy.price > 0 ? (priceSpread / buy.price) * 100 : 0;

      usedSellIndexes.add(matchedSellIndex);
      details.push({
        symbol: buy.symbol || sell.symbol || '',
        buyTimeMs: buy.timeMs,
        buyTimeText: buy.timeText,
        sellTimeMs: sell.timeMs,
        sellTimeText: sell.timeText,
        buyAmount: buy.amount,
        sellAmount: sell.amount,
        sellFeeAmount,
        wearAmount: sellNetAmount - buy.amount,
        buyPrice: buy.price,
        sellPrice: sell.price,
        priceSpread,
        priceSpreadPercent,
      });
    });

    return {
      details: details.sort((a, b) => a.buyTimeMs - b.buyTimeMs || a.sellTimeMs - b.sellTimeMs),
      unmatchedBuyCount: Math.max(0, buys.length - details.length),
      unmatchedSellCount: Math.max(0, sells.length - usedSellIndexes.size),
      totalWearAmount: details.reduce((sum, item) => sum + item.wearAmount, 0),
    };
  }

  /**
   * 从 DOM 提取交易记录
   */
  function extractTrades() {
    // 找到成交记录的虚拟滚动列表
    // 成交记录面板的 grid 通常在右侧
    const grids = document.querySelectorAll('.ReactVirtualized__Grid.ReactVirtualized__List');

    let grid = null;
    for (const g of grids) {
      // 查找包含 gridcell 的 grid（成交记录使用 role="gridcell"）
      if (g.querySelector('[role="gridcell"]')) {
        grid = g;
        break;
      }
    }

    if (!grid) {
      console.log('[价差监控] 未找到交易记录列表');
      return [];
    }

    const trades = [];

    // 查找所有 gridcell 行
    const rows = grid.querySelectorAll('[role="gridcell"]');

    rows.forEach((row) => {
      const children = row.children;
      if (children.length < 3) return;

      // 结构: children[0]=时间, children[1]=价格, children[2]=数量
      const timeEl = children[0];
      const priceEl = children[1];
      const amountEl = children[2];

      if (!priceEl) return;

      const priceText = priceEl.innerText?.trim();
      const timeText = timeEl?.innerText?.trim();
      const amountText = amountEl?.innerText?.trim();

      if (!priceText) return;

      const price = parseFloat(priceText);
      if (isNaN(price) || price <= 0) return;

      // 解析数量
      const amount = parseFloat(amountText) || 0;
      // 计算成交金额
      const value = price * amount;

      // 检测买卖方向（通过颜色）
      const style = priceEl.getAttribute('style') || '';
      const isBuy = style.includes('Buy');
      const timestampMs = parseRecentTradeTimestamp(timeText);

      trades.push({
        price: price,
        time: timeText,
        timestampMs,
        type: isBuy ? 'buy' : 'sell',
        amount: amountText,
        value: value, // 成交金额
      });
    });


    // 只返回最近 N 笔交易
    return trades;
  }

  /**
   * 计算价差
   */
  function calculateSpread(trades) {
    if (trades.length === 0) return;

    const recentTrades = trades.slice(0, Math.max(Number(state.maxTrades || 10), CONFIG.LIQUIDITY_MIN_TRADES));
    calculateRecentTradeLiquidity(recentTrades);

    const analysisTrades = recentTrades.slice(0, state.maxTrades);
    const prices = analysisTrades.map((t) => t.price).filter((p) => p > 0);
    if (prices.length === 0) return;

    state.trades = analysisTrades;
    state.highPrice = Math.max(...prices);
    state.lowPrice = Math.min(...prices);
    state.spread = state.highPrice - state.lowPrice;
    state.avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    // 计算百分比 (相对于平均价格)
    if (state.avgPrice > 0) {
      state.spreadPercent = (state.spread / state.avgPrice) * 100;
      // 计算每500U来回交易的磨损: 价差百分比 × 500
      state.wearCost = (state.spreadPercent / 100) * 500;
    }

    state.lastUpdate = new Date();
  }

  /**
   * 监控成交记录变化
   */
  function startMonitoring() {


    // 定期扫描
    setInterval(() => {
      const trades = extractTrades();
      if (trades.length > 0) {
        calculateSpread(trades);
        updateMonitorUI();
        // 检查自动交易条件
        executeAutoTrade();
      }
    }, CONFIG.MONITOR_INTERVAL);

    // 初始扫描
    setTimeout(() => {
      const trades = extractTrades();
      if (trades.length > 0) {
        calculateSpread(trades);
        updateMonitorUI();
      }
    }, 2000);

    // 使用 MutationObserver 监听 DOM 变化
    setupMutationObserver();
  }

  /**
   * 设置 DOM 变化监听
   */
  function setupMutationObserver() {
    let debounceTimer = null;

    const observer = new MutationObserver((mutations) => {
      // 防抖处理
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const trades = extractTrades();
        if (trades.length > 0) {
          calculateSpread(trades);
          updateMonitorUI();
        }
      }, CONFIG.DEBOUNCE_DELAY);
    });

    // 等待目标元素出现
    const waitForElement = setInterval(() => {
      const grid =
        document.querySelector(SELECTORS.tradeGrid) ||
        document.querySelector('.ReactVirtualized__List');

      if (grid) {
        clearInterval(waitForElement);
        observer.observe(grid, {
          childList: true,
          subtree: true,
          characterData: true,
        });

      }
    }, 500);

    // 10秒后停止等待
    setTimeout(() => clearInterval(waitForElement), 10000);
  }

  function findOrderHistoryTab() {
    const exactTab = document.querySelector('[role="tab"][aria-controls="bn-tab-pane-orderHistory"]');
    if (exactTab) return exactTab;

    const candidates = document.querySelectorAll('[role="tab"], button, [class*="tab"]');
    for (const element of candidates) {
      const text = (element.innerText || '').replace(/\s+/g, '');
      if (!text) continue;
      if (text.includes('历史委托')) {
        return element;
      }
    }

    return null;
  }

  function activateOrderHistoryTabAndRefresh() {
    const historyPane = document.querySelector('#bn-tab-pane-orderHistory');
    const historyTab = findOrderHistoryTab();

    if (!historyTab && historyPane) {
      console.log('[自动交易] 历史委托面板已存在，直接刷新历史成交');
      setTimeout(() => scanOrderHistory(), 300);
      return;
    }

    if (!historyTab) {
      console.log('[自动交易] 未找到“历史委托”Tab，稍后直接尝试刷新历史成交');
      setTimeout(() => scanOrderHistory(), 800);
      return;
    }

    historyTab.click();
    console.log('[自动交易] 已切换到“历史委托”Tab，等待历史数据加载');

    let attempts = 0;
    const maxAttempts = 20;
    const timer = setInterval(() => {
      attempts += 1;
      const pane = document.querySelector('#bn-tab-pane-orderHistory');
      const hasRows = !!pane?.querySelector('tr, [role="row"]');

      if (pane && (hasRows || attempts >= 3)) {
        clearInterval(timer);
        setTimeout(() => scanOrderHistory(), 250);
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        console.log('[自动交易] 历史委托面板加载超时，尝试直接刷新历史成交');
        scanOrderHistory();
      }
    }, 200);
  }

  /**
   * 扫描历史委托，统计本周期已成交的买卖金额
   */
  function scanOrderHistory() {
    const { startTime, endTime, cycleKey } = getTradeCycleRange();

    // 查找历史委托面板
    const historyPane = document.querySelector('#bn-tab-pane-orderHistory');
    if (!historyPane) return;

    const orderRecords = extractCycleHistoryOrders(historyPane, startTime, endTime);
    const totalBuyAmount = orderRecords
      .filter((record) => record.type === 'buy')
      .reduce((sum, record) => sum + record.amount, 0);
    const totalSellAmount = orderRecords
      .filter((record) => record.type === 'sell')
      .reduce((sum, record) => sum + record.amount, 0);
    const tradeCount = orderRecords.filter((record) => record.type === 'buy').length;
    const cycleSymbols = Array.from(
      new Set(
        orderRecords
          .map((record) => normalizeSymbolText(record.symbol))
          .filter(Boolean)
      )
    );
    const pairResult = buildCycleWearPairs(orderRecords);
    const pairedSellAmount = pairResult.details.reduce((sum, item) => sum + item.sellAmount, 0);
    const totalSellFeeAmount = pairResult.details.reduce((sum, item) => sum + item.sellFeeAmount, 0);
    const totalSellNetAmount = pairedSellAmount - totalSellFeeAmount;

    state.dailyVolume = totalBuyAmount;
    state.dailyTradeCount = tradeCount;
    state.cycleSellAmount = totalSellAmount;
    state.cycleSellFeeAmount = totalSellFeeAmount;
    state.cycleWearAmount = pairResult.totalWearAmount;
    state.cycleWearDetails = pairResult.details;
    state.cycleSymbols = cycleSymbols;
    state.cycleUnmatchedBuyCount = pairResult.unmatchedBuyCount;
    state.cycleUnmatchedSellCount = pairResult.unmatchedSellCount;
    state.lastVolumeCheck = new Date();

    console.log(
      `[周期统计] ${cycleKey} 完成: 买入 ${totalBuyAmount.toFixed(2)} USDT, 卖出 ${totalSellAmount.toFixed(2)} USDT, 已配对 ${pairResult.details.length} 笔, 已配对卖出 ${pairedSellAmount.toFixed(2)} USDT, 配对卖出手续费 ${totalSellFeeAmount.toFixed(4)} USDT, 已配对净卖出 ${totalSellNetAmount.toFixed(2)} USDT, 磨损 ${state.cycleWearAmount.toFixed(2)} USDT, 未配对 买${pairResult.unmatchedBuyCount}/卖${pairResult.unmatchedSellCount}, 进度 ${formatAutoProgressText(getAutoProgressValue(), getAutoTargetValue())}`
    );

    updateDailyVolumeBadge();
  }

  /**
   * 更新每日成交量显示
   */
  function updateDailyVolumeBadge() {
    const volEl = document.querySelector('#daily-volume-val');
    const tradeVolEl = document.querySelector('#daily-trade-vol');
    const targetEl = document.querySelector('#auto-target-progress');
    const wearEl = document.querySelector('#cycle-wear-amount');
    if (!volEl || !tradeVolEl) return;

    syncTargetSettingInputs(undefined, { preserveInputValue: true });
    volEl.textContent = `${state.dailyVolume.toFixed(2)} U / ${state.dailyTradeCount}笔`;
    tradeVolEl.textContent = `${getAutoProgressVolume().toFixed(2)} U`;
    if (targetEl) {
      const progress = getAutoProgressValue();
      targetEl.textContent = formatAutoProgressText(progress, getAutoTargetValue());
    }
    if (wearEl) {
      wearEl.textContent = formatSignedUsdt(state.cycleWearAmount);
      wearEl.classList.remove('positive', 'negative');
      const wearClass = getCycleWearClassName();
      if (wearClass) {
        wearEl.classList.add(wearClass);
      }
    }

    // 点击刷新
    const section = document.querySelector('#daily-volume-section');
    if (section) {
      section.onclick = (e) => {
        e.stopPropagation();
        scanOrderHistory();
      };
    }

    applyCycleProgressState(section);
    updateWearDetailSidePanel();
    maybeNotifyAutoTargetCompleted();
  }

  let _volumeScanTimer = null;

  /**
   * 重置成交量扫描间隔（自动交易开启: 10s, 关闭: 2min）
   */
  function resetVolumeScanInterval() {
    if (_volumeScanTimer) clearInterval(_volumeScanTimer);
    const interval = state.autoTrade ? CONFIG.AUTO_TRADE_HISTORY_SCAN_INTERVAL : 120000;
    _volumeScanTimer = setInterval(() => scanOrderHistory(), interval);
  }

  /**
   * 启动每日成交量跟踪
   */
  function startDailyVolumeTracking() {
    // 初次扫描（延迟3秒等待页面加载）
    setTimeout(() => scanOrderHistory(), 3000);
    resetVolumeScanInterval();
  }

  /**
   * 初始化
   */
  function init() {
    loadSettings();
    loadRuntimeState();


    // 等待页面加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        waitForReactReady();
      });
    } else {
      waitForReactReady();
    }
  }

  /**
   * 等待React完全渲染
   */
  function waitForReactReady() {
    // 等待关键DOM元素出现（买入价输入框）
    let attempts = 0;
    const maxAttempts = 30; // 最多等待15秒

    const checkReady = setInterval(() => {
      attempts++;
      const priceInput = findLimitPriceInput();
      const tradeList = document.querySelector('.ReactVirtualized__Grid');

      if (priceInput && tradeList) {
        clearInterval(checkReady);
        setTimeout(bootstrap, 500); // 再等500ms确保稳定
      } else if (attempts >= maxAttempts) {
        clearInterval(checkReady);
        bootstrap();
      }
    }, 500);
  }

  function bootstrap() {
    // 确保在 Binance Alpha 页面
    if (!window.location.href.includes('/alpha/')) {
      return;
    }

    createMonitorUI();
    startMonitoring();
    startDailyVolumeTracking();
  }

  // 启动
  init();
})();
