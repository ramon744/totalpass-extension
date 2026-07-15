const managerUrlEl = document.getElementById("managerUrl");
const bridgeSecretEl = document.getElementById("bridgeSecret");
const output = document.getElementById("output");

function setOutput(value) {
  output.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

chrome.storage.local.get(["managerUrl", "bridgeSecret"]).then((data) => {
  managerUrlEl.value = data.managerUrl || "http://localhost:3000";
  bridgeSecretEl.value = data.bridgeSecret || "";
});

document.getElementById("btnSave").addEventListener("click", async () => {
  const managerUrl = managerUrlEl.value.trim().replace(/\/$/, "");
  const bridgeSecret = bridgeSecretEl.value.trim();
  await chrome.storage.local.set({ managerUrl, bridgeSecret });
  setOutput({
    ok: true,
    saved: true,
    managerUrl,
    hasBridgeSecret: Boolean(bridgeSecret),
  });
});
