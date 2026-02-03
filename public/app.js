const fileInput = document.getElementById('file');
const parseBtn = document.getElementById('parseBtn');
const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const sheetsSection = document.getElementById('sheetsSection');
const sheetsList = document.getElementById('sheetsList');
const resultsSection = document.getElementById('resultsSection');
const tableHead = document.getElementById('tableHead');
const tableBody = document.getElementById('tableBody');
const exportKml = document.getElementById('exportKml');
const exportCsv = document.getElementById('exportCsv');

let sheets = []; // Array of { filename, headers, rows, geocodedRows, selected, layerName }
let activeSheetIndex = 0; // Which sheet is being viewed
let mapInstance = null;
let mapMarkers = [];
let lastMapBounds = null;

const filesSelected = document.getElementById('filesSelected');

fileInput.addEventListener('change', () => {
  const files = fileInput.files;
  parseBtn.disabled = !files?.length;
  
  // Show selected file names
  if (files?.length) {
    const names = Array.from(files).map(f => f.name);
    if (names.length === 1) {
      filesSelected.textContent = names[0];
    } else {
      filesSelected.textContent = `${names.length} files: ${names.join(', ')}`;
    }
  } else {
    filesSelected.textContent = '';
  }
});

parseBtn.addEventListener('click', async () => {
  const files = fileInput.files;
  if (!files?.length) return;
  parseBtn.disabled = true;
  sheets = [];
  
  try {
    // Parse all files
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/parse', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `Parse failed for ${file.name}`);
      const baseName = (data.filename || file.name).replace(/\.csv$/i, '');
      sheets.push({
        filename: data.filename || file.name,
        headers: data.headers,
        rows: data.rows,
        geocodedRows: [],
        selected: true, // All selected by default
        layerName: baseName, // Default layer name from filename
      });
    }
    
    // Geocode all sheets
    await geocodeAllSheets();
    
  } catch (e) {
    alert(e.message || 'Failed to parse CSV(s)');
  } finally {
    parseBtn.disabled = false;
  }
});

async function geocodeAllSheets() {
  progressSection.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  sheetsSection.classList.add('hidden');
  
  const totalRows = sheets.reduce((sum, s) => sum + s.rows.length, 0);
  let processedRows = 0;
  
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    progressText.textContent = `Geocoding ${sheet.filename} (${sheet.rows.length} rows)…`;
    progressBar.value = (processedRows / totalRows) * 100;
    
    try {
      const res = await fetch('/api/clean-and-geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: sheet.rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Geocode failed');
      sheet.geocodedRows = data.rows;
    } catch (e) {
      alert(`Geocoding failed for ${sheet.filename}: ${e.message}`);
      sheet.geocodedRows = sheet.rows; // Use original rows as fallback
    }
    
    processedRows += sheet.rows.length;
    progressBar.value = (processedRows / totalRows) * 100;
  }
  
  progressSection.classList.add('hidden');
  
  // Show sheets list and results
  activeSheetIndex = 0;
  renderSheetsList();
  sheetsSection.classList.remove('hidden');
  resultsSection.classList.remove('hidden');
  showActiveSheet();
}

function renderSheetsList() {
  sheetsList.innerHTML = sheets.map((sheet, i) => {
    const color = getSheetColor(i);
    return `
    <div class="sheet-item ${i === activeSheetIndex ? 'active' : ''}" data-index="${i}">
      <input type="checkbox" class="sheet-checkbox" ${sheet.selected ? 'checked' : ''} data-index="${i}" />
      <span class="sheet-color-indicator" style="background: ${color};"></span>
      <span class="sheet-item-name">${escapeHtml(sheet.filename)}</span>
      <input type="text" class="sheet-layer-name" data-index="${i}" value="${escapeHtml(sheet.layerName)}" placeholder="Layer name" />
      <span class="sheet-item-count">${sheet.geocodedRows.length} rows</span>
    </div>
  `;
  }).join('');
  
  // Click on sheet item to view it (but not on inputs)
  sheetsList.querySelectorAll('.sheet-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.type === 'checkbox' || e.target.type === 'text') return;
      activeSheetIndex = parseInt(el.dataset.index);
      renderSheetsList();
      showActiveSheet();
    });
  });
  
  // Checkbox toggle - refresh view when selection changes
  sheetsList.querySelectorAll('.sheet-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index);
      sheets[idx].selected = e.target.checked;
      showActiveSheet(); // Refresh table and map
    });
  });
  
  // Layer name input
  sheetsList.querySelectorAll('.sheet-layer-name').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.index);
      sheets[idx].layerName = e.target.value;
    });
    // Stop click propagation to prevent view switch
    input.addEventListener('click', (e) => e.stopPropagation());
  });
}

// Color palette for sheets
const SHEET_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#84cc16', // lime
  '#6366f1', // indigo
];

function getSheetColor(index) {
  return SHEET_COLORS[index % SHEET_COLORS.length];
}

function showActiveSheet() {
  const selected = getSelectedSheets();
  
  const sheetEl = document.getElementById('sheetName');
  if (sheetEl) {
    if (selected.length === 0) {
      sheetEl.textContent = 'No sheets selected';
    } else if (selected.length === 1) {
      sheetEl.textContent = `Viewing: ${selected[0].filename}`;
    } else {
      sheetEl.textContent = `Viewing ${selected.length} sheets`;
    }
  }
  
  renderAllSheetsTables(selected);
  drawAllSheetsMap(selected);
}

function getSelectedSheets() {
  return sheets.filter(s => s.selected);
}

function renderAllSheetsTables(selectedSheets) {
  if (!selectedSheets.length) {
    tableHead.innerHTML = '';
    tableBody.innerHTML = '<tr><td>No sheets selected</td></tr>';
    return;
  }

  // Build combined table with section headers for each sheet
  let bodyHtml = '';
  const prefer = ['Customer - Parent  Account', 'Address1', 'cleanedAddress', 'Town', 'Postcode', 'lat', 'lng', 'display_name'];
  
  // Get all possible headers from all sheets
  const allKeys = new Set();
  selectedSheets.forEach(sheet => {
    if (sheet.geocodedRows.length) {
      Object.keys(sheet.geocodedRows[0]).forEach(k => allKeys.add(k));
    }
  });
  const headers = [...new Set([...prefer.filter((k) => allKeys.has(k)), ...Array.from(allKeys).filter((k) => !prefer.includes(k))])];
  
  tableHead.innerHTML = '<tr>' + headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';

  selectedSheets.forEach((sheet, sheetIndex) => {
    const color = getSheetColor(sheets.indexOf(sheet));
    const layerName = sheet.layerName || sheet.filename.replace(/\.csv$/i, '');
    
    // Sheet separator row
    bodyHtml += `<tr class="sheet-separator" style="background: ${color}20; border-left: 4px solid ${color};">
      <td colspan="${headers.length}" style="font-weight: 600; color: ${color};">
        <span class="sheet-color-dot" style="background: ${color};"></span>
        ${escapeHtml(layerName)} (${sheet.geocodedRows.length} rows)
      </td>
    </tr>`;
    
    // Sheet rows
    sheet.geocodedRows.forEach((row) => {
      bodyHtml += '<tr style="border-left: 4px solid ' + color + '20;">' +
        headers.map((h) => {
          const v = row[h];
          const isLatLng = h === 'lat' || h === 'lng';
          const ok = isLatLng && v != null && v !== '';
          const cls = isLatLng ? (ok ? 'lat-lng-ok' : 'lat-lng-miss') : '';
          return `<td class="${cls}">${escapeHtml(String(v ?? ''))}</td>`;
        }).join('') +
        '</tr>';
    });
  });

  tableBody.innerHTML = bodyHtml;
}

function drawAllSheetsMap(selectedSheets) {
  if (mapInstance) {
    mapMarkers.forEach((m) => m.remove());
    mapMarkers = [];
  } else {
    mapInstance = window.L.map('map').setView([42.73, -84.55], 7);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
    }).addTo(mapInstance);
  }

  const allCoords = [];

  selectedSheets.forEach((sheet) => {
    const color = getSheetColor(sheets.indexOf(sheet));
    const layerName = sheet.layerName || sheet.filename.replace(/\.csv$/i, '');
    const withCoords = sheet.geocodedRows.filter((r) => r.lat != null && r.lng != null);
    
    withCoords.forEach((r) => {
      const name = r['Customer - Parent  Account'] ?? r.cleanedAddress ?? '';
      // Use circle markers with sheet-specific color
      const marker = window.L.circleMarker([r.lat, r.lng], {
        radius: 8,
        fillColor: color,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9,
      })
        .bindPopup(`<strong style="color: ${color};">[${escapeHtml(layerName)}]</strong><br><strong>${escapeHtml(name)}</strong><br>${escapeHtml(r.cleanedAddress || '')}`)
        .addTo(mapInstance);
      mapMarkers.push(marker);
      allCoords.push([r.lat, r.lng]);
    });
  });

  if (allCoords.length) {
    const bounds = window.L.latLngBounds(allCoords);
    lastMapBounds = bounds;
    mapInstance.fitBounds(bounds, { padding: [24, 24] });
  } else {
    lastMapBounds = null;
  }

  // Ensure tiles render after container becomes visible
  setTimeout(() => {
    mapInstance.invalidateSize();
    if (lastMapBounds) {
      mapInstance.fitBounds(lastMapBounds, { padding: [24, 24] });
    }
  }, 0);
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const id = 'panel-' + btn.dataset.tab;
    document.getElementById(id).classList.add('active');
    if (btn.dataset.tab === 'map' && mapInstance) {
      mapInstance.invalidateSize();
      if (lastMapBounds) {
        mapInstance.fitBounds(lastMapBounds, { padding: [24, 24] });
      }
    }
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

function buildKmlForSheet(sheet) {
  const placemarks = sheet.geocodedRows.map(kmlPlacemark).filter(Boolean).join('');
  const rawName = (sheet.layerName || '').trim() || sheet.filename.replace(/\.csv$/i, '');
  const docName = escapeXml(rawName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${docName}</name>
    ${placemarks}
  </Document>
</kml>`;
}

exportKml.addEventListener('click', () => {
  const selected = getSelectedSheets();
  if (!selected.length) {
    alert('No sheets selected. Check at least one sheet to export.');
    return;
  }
  // Download each sheet as separate KML file
  selected.forEach(sheet => {
    const kml = buildKmlForSheet(sheet);
    const filename = (sheet.layerName || sheet.filename.replace(/\.csv$/i, '')) + '.kml';
    download(filename, 'application/vnd.google-earth.kml+xml', kml);
  });
});

exportCsv.addEventListener('click', () => {
  const selected = getSelectedSheets();
  if (!selected.length) {
    alert('No sheets selected.');
    return;
  }
  selected.forEach(sheet => {
    if (!sheet.geocodedRows.length) return;
    const headers = [...Object.keys(sheet.geocodedRows[0]).filter((h) => h !== '_cleanedAddress')];
    const line = (row) => headers.map((h) => csvCell(row[h])).join(',');
    const csv = [headers.join(','), ...sheet.geocodedRows.map(line)].join('\r\n');
    const filename = (sheet.layerName || sheet.filename.replace(/\.csv$/i, '')) + '-with-lat-lng.csv';
    download(filename, 'text/csv', csv);
  });
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
