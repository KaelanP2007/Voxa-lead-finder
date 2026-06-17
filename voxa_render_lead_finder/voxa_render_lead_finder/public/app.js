let currentSearchId = null;
let leads = [];
let hideCalled = true;

const $ = id => document.getElementById(id);

function setProgress(text, show = true) {
  const p = $('progress');
  p.textContent = text;
  p.classList.toggle('hidden', !show);
}

function render() {
  const rows = $('leadRows');
  rows.innerHTML = '';
  const visible = hideCalled ? leads.filter(l => l.called !== 'Yes') : leads;
  const called = leads.filter(l => l.called === 'Yes').length;
  $('stats').textContent = `Total: ${leads.length} | Remaining: ${leads.length - called} | Called: ${called}`;
  $('hideCalledBtn').textContent = `Hide Called: ${hideCalled ? 'ON' : 'OFF'}`;

  for (const lead of visible) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="biz">${escapeHtml(lead.businessName || '')}</div><div class="muted">${escapeHtml(lead.googleMaps || '')}</div></td>
      <td>${escapeHtml(lead.phone || '')}</td>
      <td>${lead.website ? `<a class="link" href="${escapeAttr(lead.website)}" target="_blank">Website</a>` : ''}</td>
      <td>${escapeHtml(lead.address || '')}</td>
      <td>${escapeHtml(String(lead.rating || ''))}</td>
      <td><select class="mini" data-id="${lead.id}" data-field="called"><option>No</option><option ${lead.called==='Yes'?'selected':''}>Yes</option></select></td>
      <td><select class="mini" data-id="${lead.id}" data-field="status">
        ${['New','No Answer','Interested','Follow Up','Booked Demo','Not Interested'].map(s => `<option ${lead.status===s?'selected':''}>${s}</option>`).join('')}
      </select></td>
      <td><textarea class="notes" data-id="${lead.id}" data-field="notes">${escapeHtml(lead.notes || '')}</textarea></td>
    `;
    rows.appendChild(tr);
  }

  document.querySelectorAll('select, textarea').forEach(el => {
    el.onchange = async () => {
      const id = el.dataset.id;
      const field = el.dataset.field;
      const value = el.value;
      const lead = leads.find(l => l.id === id);
      if (lead) lead[field] = value;
      await fetch(`/api/search/${currentSearchId}/lead/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value })
      });
      render();
    };
  });
}

$('searchBtn').onclick = async () => {
  const niche = $('niche').value.trim();
  const location = $('location').value.trim();
  const maxLeads = $('maxLeads').value;
  if (!niche || !location) return alert('Enter both niche and area.');

  $('searchBtn').disabled = true;
  setProgress('Searching Google Places... this can take 30-90 seconds.');
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ niche, location, maxLeads })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    currentSearchId = data.searchId;
    leads = data.leads || [];
    $('exportBtn').href = `/api/search/${currentSearchId}/export`;
    $('resultsCard').classList.remove('hidden');
    setProgress(`Done. Found ${leads.length} businesses.`, true);
    render();
  } catch (err) {
    setProgress(`Error: ${err.message}`, true);
  } finally {
    $('searchBtn').disabled = false;
  }
};

$('hideCalledBtn').onclick = () => { hideCalled = !hideCalled; render(); };

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
