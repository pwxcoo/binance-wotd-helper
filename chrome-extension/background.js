chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'binance-spread-monitor:auto-target-completed') {
    return false;
  }

  const cycleKey = String(message.cycleKey || '');
  const progressText = String(message.progressText || '').trim();
  const targetSignature = String(message.targetSignature || '').replace(/[^\w.-]+/g, '_');
  const targetCount = Number(message.targetCount || 0);
  const progressCount = Number(message.progressCount || 0);
  const notificationId = `auto-target-completed-${cycleKey}-${targetSignature || targetCount}`;
  const notificationMessage = progressText
    ? `自动进度已达 ${progressText}，本周期目标已完成。`
    : `自动进度已达 ${progressCount}/${targetCount} 笔，本周期目标已完成。`;

  chrome.notifications.create(
    notificationId,
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Binance Alpha 本周期目标已完成',
      message: notificationMessage,
      priority: 2,
    },
    () => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }

      sendResponse({ ok: true });
    }
  );

  return true;
});
