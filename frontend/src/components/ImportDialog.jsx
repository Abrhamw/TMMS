import { useState } from 'react';
import { api } from '../api';
import { Modal, ErrorNote } from '../components';
import { t } from '../i18n';

function detectFormat(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.kmz')) return 'kmz';
  if (n.endsWith('.kml')) return 'kml';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.geojson') || n.endsWith('.json')) return 'geojson';
  return null;
}

function readFile(file, format) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    if (format === 'kmz') {
      reader.onload = () => {
        const s = String(reader.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(file);
    }
  });
}

// Two-step bulk import backed by /infrastructure/import/*. The same dialog
// serves substations and lines; `columns` describes the preview table and
// `endpoint` the API base. Preview is mandatory so every candidate (and the
// reason it would be skipped) is reviewed before anything is written.
export default function ImportDialog({ title, endpoint, templatePath, templateName, columns, regions, onClose, onDone }) {
  const [fileName, setFileName] = useState('');
  const [format, setFormat] = useState('');
  const [content, setContent] = useState(null);
  const [defaultRegionId, setDefaultRegionId] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function pickFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fmt = detectFormat(file.name);
    setError(null);
    setResult(null);
    setPreview(null);
    setNotice(null);
    if (!fmt) {
      setFileName(file.name);
      setFormat('');
      setContent(null);
      setError(t('importHint'));
      return;
    }
    try {
      const text = await readFile(file, fmt);
      setFileName(file.name);
      setFormat(fmt);
      setContent(text);
    } catch (err) {
      setError(err.message);
    }
  }

  async function downloadTemplate() {
    try {
      setError(null);
      await api.download(templatePath, templateName);
    } catch (err) {
      setError(err.message);
    }
  }

  async function runPreview() {
    if (!content || !format) {
      setError(t('importNeedFile'));
      return;
    }
    try {
      setBusy(true);
      setError(null);
      setResult(null);
      setNotice(null);
      const body = { format, content };
      if (defaultRegionId !== '') body.default_region_id = Number(defaultRegionId);
      const res = await api.post(`${endpoint}/preview`, body);
      setPreview(res);
      if (!res.will_create) setNotice(res.will_skip ? `${res.will_skip} ${t('importWillSkip')}` : null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    try {
      setBusy(true);
      setError(null);
      const res = await api.post(`${endpoint}/commit`, { token: preview.token });
      setResult(res);
      setPreview(null);
      if (onDone) onDone(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canCommit = !!preview && preview.will_create > 0 && !busy;

  return (
    <Modal title={title} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={downloadTemplate}>{t('importDownloadTemplate')}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        {!result && <button className="btn" disabled={busy || !content} onClick={runPreview}>{busy ? '…' : t('importPreview')}</button>}
        {!result && <button className="btn btn-primary" disabled={!canCommit} onClick={commit}>{t('importConfirm')}</button>}
        {result && <button className="btn btn-primary" onClick={onClose}>Close</button>}
      </>}>
      {error && <ErrorNote error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}

      {result ? (
        <div>
          <div className="grid grid-2 mb">
            <div className="card card-pad"><b>{t('importDone')}</b><div className="value" style={{ fontSize: 24 }}>{result.created}</div></div>
            <div className="card card-pad"><b>{t('importSkipped')}</b><div className="value" style={{ fontSize: 24 }}>{(result.skipped || []).length}</div></div>
          </div>
          {result.towers_created != null && <p className="muted">{result.towers_created} tower(s) created.</p>}
          {(result.skipped || []).length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Item</th><th>{t('importReason')}</th></tr></thead>
                <tbody>
                  {result.skipped.map((s, i) => (
                    <tr key={i}><td className="mono">{s.substation_id || s.line_id || '—'}</td><td>{s.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="form-grid">
            <div className="field"><label>{t('importChooseFile')}</label>
              <input type="file" accept=".csv,.kml,.kmz,.geojson,.json" onChange={pickFile} />
              <div className="muted" style={{ fontSize: 12 }}>{fileName || t('importHint')}</div>
            </div>
            {regions && regions.length > 0 && (
              <div className="field"><label>{t('importDefaultRegion')}</label>
                <select value={defaultRegionId} onChange={(e) => { setDefaultRegionId(e.target.value); setPreview(null); }}>
                  <option value="">—</option>
                  {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {preview && (
            <div className="mt">
              <div className="mb">
                <b>{t('importWillCreate')}: <span className="ok">{preview.will_create}</span></b>
                {' · '}<b>{t('importWillSkip')}: <span className="bad">{preview.will_skip}</span></b>
              </div>
              <div className="tbl-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => <th key={c.key}>{c.label}</th>)}
                      <th>{t('importReason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.candidates.map((row, i) => (
                      <tr key={i} style={row.will_skip ? { background: '#fef2f2' } : undefined}>
                        {columns.map((c) => <td key={c.key} className={c.mono ? 'mono' : undefined}>{formatCell(row[c.key])}</td>)}
                        <td>{row.will_skip ? row.reason : <span className="ok">OK</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function formatCell(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
