let currentSearchId = null;
let leads = [];
let hideCalled = true;

const $ = id => document.getElementById(id);

function setProgress(text, show = true) {
  const progress = $('progress');
  progress.textContent = text;
  progress.classList.toggle('hidden', !show);
}

async function loadUsage() {
  try {
    const res = await fetch('/api/usage');
    const data = await res.json();
    renderUsage(data);
  } catch (err) {
    $('usageText').textContent = 'Usage estimate unavailable.';
  }
}

function renderUsage(usage) {
  const percent = Math.max(
    0,
    Math.min(100, Number(usage.percentUsed || 0))
  );

  $('usageFill').style.width = `${percent}%`;

  $('usageText').textContent =
    `${usage.totalGoogleRequests} estimated Google API requests used this month. ` +
    `${usage.estimatedRemaining} remaining out of your local ${usage.monthlyBudget} request budget. ` +
    `Text Search: ${usage.textSearchRequests}. Details: ${usage.placeDetailsRequests}.`;
}

function render() {
  const rows = $('leadRows');
  rows.innerHTML = '';

  const visibleLeads = hideCalled
    ? leads.filter(lead => lead.called !== 'Yes')
    : leads;

  const calledCount = leads.filter(lead => lead.called === 'Yes').length;

  $('stats').textContent =
    `Total: ${leads.length} | Remaining: ${leads.length - calledCount} | Called: ${calledCount}`;

  $('hideCalledBtn').textContent = `Hide Called: ${hideCalled ? 'ON' : 'OFF'}`;

  for (const lead of visibleLeads) {
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>
        <div class="biz">${escapeHtml(lead.businessName || '')}</div>
        <div class="muted">
          ${
            lead.googleMaps
              ? `<a class="link" href="${escapeAttr(lead.googleMaps)}" target="_blank">Google Maps</a>`
              : ''
          }
        </div>
      </td>

      <td>${escapeHtml(lead.phone || '')}</td>

      <td>
        ${
          lead.website
            ? `<a class="link" href="${escapeAttr(lead.website)}" target="_blank">Website</a>`
            : ''
        }
      </td>

      <td>${escapeHtml(lead.address || '')}</td>

      <td>${escapeHtml(String(lead.rating || ''))}</td>

      <td>
        <select class="mini" data-id="${escapeAttr(lead.id)}" data-field="called">
          <option ${lead.called === 'No' ? 'selected' : ''}>No</option>
          <option ${lead.called === 'Yes' ? 'selected' : ''}>Yes</option>
        </select>
      </td>

      <td>
        <select class="mini" data-id="${escapeAttr(lead.id)}" data-field="status">
          ${[
            'New',
            'No Answer',
            'Interested',
            'Follow Up',
            'Booked Demo',
            'Not Interested'
          ]
            .map(status => `<option ${lead.status === status ? 'selected' : ''}>${status}</option>`)
            .join('')}
        </select>
      </td>

      <td>
        <textarea class="notes" data-id="${escapeAttr(lead.id)}" data-field="notes">${escapeHtml(
          lead.notes || ''
        )}</textarea>
      </td>
    `;

    rows.appendChild(tr);
  }

  document.querySelectorAll('select, textarea').forEach(element => {
    element.onchange = async () => {
      const leadId = element.dataset.id;
      const field = element.dataset.field;
      const value = element.value;

      const lead = leads.find(item => item.id === leadId);

      if (lead) {
        lead[field] = value;
      }

      try {
        if (currentSearchId) {
          await fetch(`/api/search/${currentSearchId}/lead/${encodeURIComponent(leadId)}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              [field]: value
            })
          });
        }
      } catch (err) {
        console.warn('Could not save lead update to backend:', err);
      }

      render();
    };
  });
}

$('searchBtn').onclick = async () => {
  const niche = $('niche').value.trim();
  const location = $('location').value.trim();
  const maxLeads = $('maxLeads').value;

  if (!niche || !location) {
    alert('Enter both niche and area.');
    return;
  }

  $('searchBtn').disabled = true;

  setProgress('Searching Google Places... 100 leads can take 1-3 minutes.');

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        niche,
        location,
        maxLeads
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Search failed.');
    }

    currentSearchId = data.searchId;
    leads = data.leads || [];

    /*
      Important:
      We are no longer using /api/search/:searchId/export for the button.
      That old way caused "Search not found" on Render.
      The button now exports the leads currently loaded on the screen.
    */
    $('exportBtn').href = '#';

    $('resultsCard').classList.remove('hidden');

    setProgress(`Done. Found ${leads.length} businesses.`, true);

    if (data.usage) {
      renderUsage(data.usage);
    }

    render();
  } catch (err) {
    setProgress(`Error: ${err.message}`, true);
    loadUsage();
  } finally {
    $('searchBtn').disabled = false;
  }
};

$('hideCalledBtn').onclick = () => {
  hideCalled = !hideCalled;
  render();
};

$('refreshUsageBtn').onclick = loadUsage;

$('exportBtn').onclick = async event => {
  event.preventDefault();

  if (!leads || leads.length === 0) {
    alert('No leads to export yet.');
    return;
  }

  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        niche: $('niche').value.trim(),
        location: $('location').value.trim(),
        leads
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Export failed.');
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;

    const safeNiche = $('niche')
      .value
      .trim()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();

    const safeLocation = $('location')
      .value
      .trim()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();

    a.download = `voxa_leads_${safeNiche}_${safeLocation}.xlsx`;

    document.body.appendChild(a);
    a.click();
    a.remove();

    window.URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Excel export error: ${err.message}`);
  }
};

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, char => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[char];
  });
}

function escapeAttr(str) {
  return escapeHtml(str);
}

loadUsage();
