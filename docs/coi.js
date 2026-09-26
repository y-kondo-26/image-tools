// sw.js を登録して cross-origin isolation を有効にする（マルチスレッド WebAssembly 用）。
// ヘッダーは Service Worker が制御するページにしか付かないため、初回訪問時だけ 1 回リロードする。
(() => {
  if (window.crossOriginIsolated || !window.isSecureContext || !("serviceWorker" in navigator)) return;

  const KEY = "image-tools-coi-reloaded";
  let alreadyReloaded = false;
  try {
    alreadyReloaded = sessionStorage.getItem(KEY) === "1";
  } catch {
    return; // リロード済みか記録できない環境では、無限リロードを避けて何もしない
  }

  navigator.serviceWorker
    .register("sw.js")
    .then(() => {
      // 1 度リロードしても有効にならないブラウザでは、そのまま（シングルスレッドで動く）
      if (alreadyReloaded) return;
      const reload = () => {
        sessionStorage.setItem(KEY, "1");
        location.reload();
      };
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
    })
    .catch(() => {});
})();
