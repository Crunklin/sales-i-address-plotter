const fileInput = document.getElementById('file');
const parseBtn = document.getElementById('parseBtn');
const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const resultsSection = document.getElementById('resultsSection');
const tableHead = document.getElementById('tableHead');
const tableBody = document.getElementById('tableBody');
const exportKml = document.getElementById('exportKml');
const addToMyMaps = document.getElementById('addToMyMaps');
const exportCsv = document.getElementById('exportCsv');
const mymapsFlow = document.getElementById('mymapsFlow');
const loadMapsBtn = document.getElementById('loadMapsBtn');
const createMapBtn = document.getElementById('createMapBtn');
const mymapsStatus = document.getElementById('mymapsStatus');
const mymapsSelectWrap = document.getElementById('mymapsSelectWrap');
const mymapsSelect = document.getElementById('mymapsSelect');
const importToMapBtn = document.getElementById('importToMapBtn');
const mymapsNewMap = document.getElementById('mymapsNewMap');
const newMapNameInput = document.getElementById('newMapName');
const confirmCreateMapBtn = document.getElementById('confirmCreateMapBtn');
const layerNameInput = document.getElementById('layerNameInput');
const importManualBtn = document.getElementById('importManualBtn');

let parsed = { headers: [], rows: [], filename: '' };
let geocodedRows = [];
let mapInstance = null;
let mapMarkers = [];

fileInput.addEventListener('change', () => {
  parseBtn.disabled = !fileInput.files?.length;
});

parseBtn.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  parseBtn.disabled = true;
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/parse', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || 'Parse failed');
    parsed = { headers: data.headers, rows: data.rows, filename: data.filename || '' };
    runCleanAndGeocode();
  } catch (e) {
    alert(e.message || 'Failed to parse CSV');
  } finally {
    parseBtn.disabled = false;
  }
});

async function runCleanAndGeocode() {
  progressSection.classList.remove('hidden');
  progressBar.value = 0;
  progressText.textContent = `Cleaning & geocoding ${parsed.rows.length} rows…`;
  resultsSection.classList.add('hidden');

  try {
    const res = await fetch('/api/clean-and-geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: parsed.rows }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Geocode failed');
    geocodedRows = data.rows;
    progressSection.classList.add('hidden');
    const sheetEl = document.getElementById('sheetName');
    if (sheetEl) sheetEl.textContent = parsed.filename ? `Sheet: ${parsed.filename}` : '';
    renderTable(geocodedRows);
    drawMap(geocodedRows);
    resultsSection.classList.remove('hidden');
  } catch (e) {
    progressSection.classList.add('hidden');
    alert(e.message || 'Clean & geocode failed');
  }
}

function renderTable(rows) {
  if (!rows.length) return;
  const prefer = ['Customer - Parent  Account', 'Address1', 'cleanedAddress', 'Town', 'Postcode', 'lat', 'lng', 'display_name'];
  const allKeys = Object.keys(rows[0]);
  const headers = [...new Set([...prefer.filter((k) => allKeys.includes(k)), ...allKeys.filter((k) => !prefer.includes(k))])];
  tableHead.innerHTML = '<tr>' + headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
  tableBody.innerHTML = rows
    .map(
      (row) =>
        '<tr>' +
        headers
          .map((h) => {
            const v = row[h];
            const isLatLng = h === 'lat' || h === 'lng';
            const ok = isLatLng && v != null && v !== '';
            const cls = isLatLng ? (ok ? 'lat-lng-ok' : 'lat-lng-miss') : '';
            return `<td class="${cls}">${escapeHtml(String(v ?? ''))}</td>`;
          })
          .join('') +
        '</tr>'
    )
    .join('');
}

function drawMap(rows) {
  const withCoords = rows.filter((r) => r.lat != null && r.lng != null);
  if (mapInstance) {
    mapMarkers.forEach((m) => m.remove());
    mapMarkers = [];
  } else {
    mapInstance = window.L.map('map').setView([42.73, -84.55], 7);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
    }).addTo(mapInstance);
  }
  withCoords.forEach((r) => {
    const name = r['Customer - Parent  Account'] ?? r.cleanedAddress ?? '';
    const marker = window.L.marker([r.lat, r.lng])
      .bindPopup(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(r.cleanedAddress || '')}`)
      .addTo(mapInstance);
    mapMarkers.push(marker);
  });
  if (withCoords.length) {
    const bounds = window.L.latLngBounds(withCoords.map((r) => [r.lat, r.lng]));
    mapInstance.fitBounds(bounds, { padding: [24, 24] });
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const id = 'panel-' + btn.dataset.tab;
    document.getElementById(id).classList.add('active');
    if (btn.dataset.tab === 'map' && mapInstance) mapInstance.invalidateSize();
  });
});

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function kmlPlacemark(row) {
  const name = escapeXml(String(row['Customer - Parent  Account'] ?? row.cleanedAddress ?? ''));
  const desc = escapeXml(String(row.cleanedAddress ?? ''));
  if (row.lat == null || row.lng == null) return '';
  return `
  <Placemark>
    <name>${name}</name>
    <description>${desc}</description>
    <Point><coordinates>${row.lng},${row.lat},0</coordinates></Point>
  </Placemark>`;
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildKml() {
  const placemarks = geocodedRows.map(kmlPlacemark).filter(Boolean).join('');
  const docName = parsed.filename ? escapeXml(parsed.filename.replace(/\.csv$/i, '')) : 'Address Plotter Export';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${docName}</name>
    ${placemarks}
  </Document>
</kml>`;
}

exportKml.addEventListener('click', () => {
  download('addresses.kml', 'application/vnd.google-earth.kml+xml', buildKml());
});

addToMyMaps.addEventListener('click', async () => {
  const kml = buildKml();
  try {
    const res = await fetch('/api/save-kml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kml }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save KML');
    mymapsFlow.classList.remove('hidden');
    mymapsSelectWrap.classList.add('hidden');
    mymapsNewMap.classList.add('hidden');
    mymapsSelect.innerHTML = '';
    mymapsStatus.textContent = '';
    // Set default layer name from filename
    const defaultLayerName = parsed.filename ? parsed.filename.replace(/\.csv$/i, '') : '';
    layerNameInput.value = defaultLayerName;
    layerNameInput.placeholder = defaultLayerName || '(defaults to filename)';
  } catch (e) {
    alert(e.message || 'Failed to save KML for My Maps.');
  }
});

loadMapsBtn.addEventListener('click', async () => {
  loadMapsBtn.disabled = true;
  mymapsStatus.textContent = 'Opening browser to load your maps… (browser will close automatically; pick a map below)';
  try {
    const res = await fetch('/api/mymaps-list');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load maps');
    const maps = data.maps || [];
    mymapsStatus.textContent = maps.length ? `${maps.length} map(s) found.` : 'No maps found.';
    mymapsSelect.innerHTML = maps.length
      ? maps.map((m) => `<option value="${escapeHtml(m.mid)}">${escapeHtml(m.title || m.mid)}</option>`).join('')
      : '';
    mymapsSelectWrap.classList.toggle('hidden', !maps.length);
  } catch (e) {
    mymapsStatus.textContent = '';
    alert(e.message || 'Failed to load maps.');
  } finally {
    loadMapsBtn.disabled = false;
  }
});

// Helper: get layer name from input or default to filename
function getLayerName() {
  const custom = layerNameInput.value.trim();
  if (custom) return custom;
  return parsed.filename ? parsed.filename.replace(/\.csv$/i, '') : '';
}

// Helper: import KML to a map
async function importToMap(mid) {
  const layerName = getLayerName();
  mymapsStatus.textContent = 'Opening browser and importing…';
  try {
    const res = await fetch('/api/mymaps-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mid, layerName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    mymapsStatus.textContent = 'Done! Layer added to map.';
    return true;
  } catch (e) {
    mymapsStatus.textContent = '';
    alert(e.message || 'Import failed.');
    return false;
  }
}

importToMapBtn.addEventListener('click', async () => {
  const mid = mymapsSelect.value.trim();
  if (!mid) {
    alert('Pick a map from the list.');
    return;
  }
  importToMapBtn.disabled = true;
  await importToMap(mid);
  importToMapBtn.disabled = false;
});

// Import using manually entered map ID
importManualBtn.addEventListener('click', async () => {
  const mid = document.getElementById('mymapsMapId').value.trim();
  if (!mid) {
    alert('Enter a map ID (from the URL when you open a map in My Maps: .../edit?mid=XXXXX).');
    return;
  }
  importManualBtn.disabled = true;
  await importToMap(mid);
  importManualBtn.disabled = false;
});

// Show "create new map" form
createMapBtn.addEventListener('click', () => {
  mymapsNewMap.classList.remove('hidden');
  mymapsSelectWrap.classList.add('hidden');
  // Default new map name to layer name or filename
  const defaultName = getLayerName() || 'My new map';
  newMapNameInput.value = defaultName;
  newMapNameInput.focus();
});

// Create new map and add layer
confirmCreateMapBtn.addEventListener('click', async () => {
  const mapName = newMapNameInput.value.trim() || 'Untitled map';
  confirmCreateMapBtn.disabled = true;
  createMapBtn.disabled = true;
  mymapsStatus.textContent = 'Creating new map…';

  try {
    const res = await fetch('/api/mymaps-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: mapName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create map');

    mymapsStatus.textContent = `Map "${data.title || mapName}" created. Adding layer…`;

    // Now import the layer to the new map
    await importToMap(data.mid);
  } catch (e) {
    mymapsStatus.textContent = '';
    alert(e.message || 'Failed to create map.');
  } finally {
    confirmCreateMapBtn.disabled = false;
    createMapBtn.disabled = false;
  }
});

exportCsv.addEventListener('click', () => {
  const headers = [...Object.keys(geocodedRows[0] || {}).filter((h) => h !== '_cleanedAddress')];
  const line = (row) => headers.map((h) => csvCell(row[h])).join(',');
  const csv = [headers.join(','), ...geocodedRows.map(line)].join('\r\n');
  download('addresses-with-lat-lng.csv', 'text/csv', csv);
});

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function download(filename, type, content) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
