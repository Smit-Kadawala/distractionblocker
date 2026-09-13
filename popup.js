function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function cleanHost(input) {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  return s;
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h > 0) return `${h}h ${rem}m`;
  return `${m}m`;
}

async function getSites() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_LIVE_SITES" }, (resp) => {
      resolve(resp?.sites || {});
    });
  });
}

async function saveSites(sites) {
  await chrome.storage.local.set({ sites });
}

async function render() {
  const sites = await getSites();
  const listEl = document.getElementById("siteList");
  listEl.innerHTML = "";

  const keys = Object.keys(sites);
  if (keys.length === 0) {
    listEl.innerHTML = `<div class="empty">No sites added yet.</div>`;
    return;
  }

  const template = document.getElementById("siteRowTemplate");

  keys.forEach((key) => {
    const site = sites[key];
    const node = template.content.cloneNode(true);

    const nameEl = node.querySelector(".site-name");
    nameEl.textContent = key;
    if (site.blocked) {
      const badge = document.createElement("span");
      badge.className = "badge-blocked";
      badge.textContent = "BLOCKED TODAY";
      nameEl.appendChild(badge);
    }

    const pct = Math.min(100, Math.round((site.usedSeconds / (site.limitMinutes * 60)) * 100));
    const fill = node.querySelector(".site-progress-fill");
    fill.style.width = pct + "%";
    if (site.blocked) fill.classList.add("over");

    node.querySelector(".site-stats").textContent =
      `${fmtTime(site.usedSeconds)} used of ${site.limitMinutes}m today`;

    const limitInput = node.querySelector(".limit-edit");
    limitInput.value = site.limitMinutes;

    const saveBtn = node.querySelector(".save-btn");
    saveBtn.addEventListener("click", async () => {
      const newLimit = parseInt(limitInput.value, 10);
      if (!newLimit || newLimit < 1) {
        alert("Enter a valid number of minutes.");
        return;
      }
      const current = await getSites();
      const currentLimit = current[key].limitMinutes;
      if (newLimit >= currentLimit) {
        alert("You can only lower the limit, not raise it. That's the whole point.");
        limitInput.value = currentLimit;
        return;
      }
      current[key].limitMinutes = newLimit;
      // lowering can push you over the new limit immediately - that's intentional
      if (current[key].usedSeconds >= newLimit * 60) {
        current[key].blocked = true;
      }
      await saveSites(current);
      render();
    });

    const removeBtn = node.querySelector(".remove-btn");
    if (site.usedSeconds > 0) {
      removeBtn.disabled = true;
      removeBtn.title = "Can't remove - you've already used time on this site today.";
      removeBtn.textContent = "Locked";
    } else {
      removeBtn.addEventListener("click", async () => {
        const current = await getSites();
        delete current[key];
        await saveSites(current);
        render();
      });
    }

    listEl.appendChild(node);
  });
}

document.getElementById("addBtn").addEventListener("click", async () => {
  const siteInput = document.getElementById("siteInput");
  const limitInput = document.getElementById("limitInput");

  const host = cleanHost(siteInput.value);
  const limit = parseInt(limitInput.value, 10);

  if (!host || !limit || limit < 1) {
    alert("Enter a valid site and a limit in minutes.");
    return;
  }

  const sites = await getSites();

  // Block re-adding a site that's already tracked - this used to reset
  // usedSeconds/blocked back to zero, which bypassed the daily limit entirely.
  const existingKey = Object.keys(sites).find(
    (k) => k === host || host.endsWith("." + k) || k.endsWith("." + host)
  );
  if (existingKey) {
    alert(
      `${existingKey} is already on your list. You can only lower its limit (below, via Save) - re-adding it isn't allowed.`
    );
    return;
  }

  sites[host] = {
    limitMinutes: limit,
    usedSeconds: 0,
    dateKey: todayKey(),
    blocked: false,
  };
  await saveSites(sites);

  siteInput.value = "";
  limitInput.value = "";
  render();
});

render();
// Refresh view every few seconds while popup is open so usage feels live
setInterval(render, 3000);
