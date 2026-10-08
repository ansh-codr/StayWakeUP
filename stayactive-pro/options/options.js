/**
 * options.js — StayActive Pro Options Page
 */

'use strict';

/* ── Helpers ── */
const $ = id => document.getElementById(id);

function showBanner(type, msg) {
  const el   = $(`${type}-banner`);
  const text = $(`${type}-text`);
  if (!el || !text) return;
  text.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function showError(msg)   { showBanner('error',   msg); }
function showSuccess(msg) { showBanner('success', msg); }

async function sendMsg(data) {
  try {
    return await chrome.runtime.sendMessage(data);
  } catch (err) {
    showError(err.message || String(err));
    return { ok: false, error: err.message };
  }
}

/* ── Load & render sites table ── */
async function loadSites() {
  const resp = await sendMsg({ type: 'GET_ALL_HOSTS' });
  if (!resp || !resp.ok) {
    showError(resp?.error || 'Could not load sites.');
    return;
  }

  const { hosts, settings } = resp;
  const tbody   = $('sites-tbody');
  const empty   = $('sites-empty');
  const wrapper = $('table-wrapper');

  tbody.innerHTML = '';

  if (!hosts || hosts.length === 0) {
    empty.classList.remove('hidden');
    wrapper.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  wrapper.classList.remove('hidden');

  for (const hostname of hosts) {
    const s   = settings[hostname] || {};
    const row = document.createElement('tr');
    row.dataset.hostname = hostname;

    row.innerHTML = `
      <td>
        <div class="hostname-cell">
          ${escapeHtml(hostname)}
          ${s.includeSubdomains ? '<span class="hostname-badge">+subdomains</span>' : ''}
        </div>
      </td>
      <td class="center">${checkIcon(s.includeSubdomains)}</td>
      <td class="center">${checkIcon(s.antiIdle)}</td>
      <td class="center">${checkIcon(s.keepAliveAudio)}</td>
      <td class="center">${checkIcon(s.autoRefresh)}${s.autoRefresh ? ` <small style="color:var(--clr-text-3)">(${s.autoRefreshSeconds || 60}s)</small>` : ''}</td>
      <td class="center">
        <button class="btn btn--icon remove-btn" data-hostname="${escapeHtml(hostname)}" aria-label="Remove ${escapeHtml(hostname)}">
          Remove
        </button>
      </td>
    `;

    tbody.appendChild(row);
  }

  // Bind remove buttons.
  tbody.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hostname = btn.dataset.hostname;
      if (!confirm(`Remove StayActive Pro for "${hostname}"?`)) return;

      btn.disabled = true;

      // Find any tab with this hostname to pass tabId (best-effort).
      let tabId = null;
      try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if (!t.url) continue;
          try {
            const u = new URL(t.url);
            if (u.hostname === hostname) { tabId = t.id; break; }
          } catch (_) {}
        }
      } catch (_) {}

      const resp = await sendMsg({ type: 'REMOVE_SITE', hostname, tabId });
      if (resp && resp.ok) {
        showSuccess(`${hostname} removed.`);
        await loadSites();
      } else {
        btn.disabled = false;
        showError(resp?.error || 'Failed to remove site.');
      }
    });
  });
}

function checkIcon(val) {
  return val
    ? '<span class="check-on" aria-label="enabled">✓</span>'
    : '<span class="check-off" aria-label="disabled">–</span>';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Disable all ── */
$('btn-disable-all').addEventListener('click', async () => {
  if (!confirm('Disable StayActive Pro for ALL sites? This cannot be undone.')) return;
  const resp = await sendMsg({ type: 'DISABLE_ALL' });
  if (resp && resp.ok) {
    showSuccess('All sites disabled.');
    await loadSites();
  } else {
    showError(resp?.error || 'Failed to disable all sites.');
  }
});

/* ── Export ── */
$('btn-export').addEventListener('click', async () => {
  const resp = await sendMsg({ type: 'GET_ALL_HOSTS' });
  if (!resp || !resp.ok) {
    showError('Could not fetch settings for export.');
    return;
  }

  const data = {
    exportedAt:   new Date().toISOString(),
    version:      '1.0.0',
    enabledHosts: resp.hosts,
    hostSettings: resp.settings,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `stayactive-pro-settings-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showSuccess('Settings exported.');
});

/* ── Import ── */
$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!Array.isArray(data.enabledHosts)) {
      showError('Invalid file: missing "enabledHosts" array.');
      return;
    }

    const resp = await sendMsg({
      type: 'IMPORT_SETTINGS',
      data: {
        enabledHosts: data.enabledHosts,
        hostSettings: data.hostSettings || {},
      },
    });

    if (resp && resp.ok) {
      showSuccess(`Imported ${data.enabledHosts.length} site(s).`);
      await loadSites();
    } else {
      showError(resp?.error || 'Import failed.');
    }
  } catch (err) {
    showError('Could not parse file: ' + (err.message || String(err)));
  }

  // Reset so same file can be re-imported.
  e.target.value = '';
});

/* ── Sidebar nav smooth scroll ── */
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const targetId = link.getAttribute('href').slice(1);
    const target   = document.getElementById(targetId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
  });
});

/* ── Init ── */
document.addEventListener('DOMContentLoaded', loadSites);
