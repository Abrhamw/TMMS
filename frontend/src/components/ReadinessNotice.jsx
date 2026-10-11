import { useState } from 'react';
import { t } from '../i18n';
import { readinessSummary } from '../readinessNotice';

export default function ReadinessNotice({ gate, busy = false, onStart }) {
  const summary = readinessSummary(gate);
  const [reason, setReason] = useState('');
  if (summary.ready) return null;
  const trimmed = reason.trim();
  return (
    <div className="alert tone-warn mt">
      <b>{t('notReadyToStart')}</b>
      <ul style={{ margin: '6px 0 0 18px' }}>
        {summary.blockers.map((b, i) => (
          <li key={`${b.code}-${i}`}>
            {b.message}
            {summary.recommendations[i] ? (
              <div className="muted" style={{ fontSize: 12 }}>{summary.recommendations[i]}</div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="field mt">
        <label>{t('startReasonLabel')}</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('startReasonPlaceholder')}
        />
        <div className="muted" style={{ fontSize: 12 }}>{t('startReasonRequired')}</div>
      </div>
      <button
        className="btn btn-primary"
        disabled={busy || !trimmed}
        onClick={() => onStart(trimmed)}
      >
        {t('startAnyway')}
      </button>
    </div>
  );
}
