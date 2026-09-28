import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { getStoredUser } from '../auth';

export default function Comments({ entityType, entityId }) {
  const [comments, setComments] = useState([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const me = getStoredUser();
  const canWrite = !!me && me.role !== 'VIEWER';

  async function load() {
    if (!entityId) return;
    try {
      const data = await api.get(`/comments?entity_type=${entityType}&entity_id=${entityId}`);
      setComments(Array.isArray(data) ? data : (data.comments || []));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [entityType, entityId]);

  async function submit(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/comments', { entity_type: entityType, entity_id: entityId, body: body.trim() });
      setBody('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    try {
      await api.del(`/comments/${id}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="comments">
      <div className="spread mb">
        <b>Comments ({comments.length})</b>
      </div>
      {error && <div className="alert alert-error" style={{ fontSize: 12 }}>{error}</div>}
      <div className="comment-list">
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <div className="comment-head">
              <b>{c.author?.first_name || c.author?.username || 'user'}</b>
              <span className="muted">{fmtDateTime(c.created_at)}</span>
              {(me && (me.role === 'ADMIN' || me.id === c.user_id)) && (
                <button className="btn btn-ghost btn-xs" onClick={() => remove(c.id)}>✕</button>
              )}
            </div>
            <div className="comment-body">{c.body}</div>
          </div>
        ))}
        {comments.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No comments yet.</div>}
      </div>
      {canWrite && (
        <form className="comment-form" onSubmit={submit}>
          <textarea
            rows={2}
            placeholder="Add a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button className="btn btn-sm btn-primary" disabled={busy || !body.trim()}>{busy ? '…' : 'Comment'}</button>
        </form>
      )}
    </div>
  );
}
