import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { createDebouncer } from '../debounce';

const DRAFT_DELAY = 700;

function buildItems(chosen) {
  const draftByItem = new Map((chosen.draft?.items || []).map((d) => [Number(d.template_item_id), d]));
  const items = {};
  chosen.items.forEach((it) => {
    const d = draftByItem.get(it.id);
    items[it.id] = { value: d ? d.response_value ?? null : null, comment: d?.comment || '' };
  });
  return { items, resumed: !!chosen.draft };
}

// Owns one checklist run: loads the task's templates, restores the server draft,
// and debounce-saves every answer change to POST /tasks/:id/checklist/draft.
// Autosave is skipped while `enabled` is false (task locked or no run open) and is
// flushed on unmount, template switch and explicit flush().
export default function useChecklistDraft({ taskId, enabled = true } = {}) {
  const [templates, setTemplates] = useState([]);
  const [tpl, setTpl] = useState(null);
  const [items, setItems] = useState(null);
  const [resumed, setResumed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);

  const latest = useRef({ taskId, enabled, tpl: null, items: null });
  latest.current = { taskId, enabled, tpl, items };

  const save = useCallback(async () => {
    const { taskId: id, enabled: on, tpl: template, items: current } = latest.current;
    if (!on || !template || !current) return;
    setSaving(true);
    try {
      const payload = Object.entries(current).map(([itemId, v]) => ({
        template_item_id: Number(itemId),
        response_value: v.value,
        comment: v.comment || '',
      }));
      await api.post(`/tasks/${id}/checklist/draft`, { template_id: template.id, items: payload });
      setSavedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, []);

  const debouncer = useRef(null);
  if (!debouncer.current) debouncer.current = createDebouncer(save, DRAFT_DELAY);

  const flush = useCallback(() => {
    if (debouncer.current) debouncer.current.flush();
  }, []);

  useEffect(() => () => { if (debouncer.current) debouncer.current.flush(); }, []);

  const load = useCallback(async (templateId) => {
    const data = await api.get(`/tasks/${taskId}/checklist`);
    const list = data.templates || (data.template ? [data.template] : []);
    const chosen = list.find((x) => x.id === templateId) || list[0];
    if (!chosen) throw new Error('Task has no checklist template');
    const built = buildItems(chosen);
    setTemplates(list);
    setTpl(chosen);
    setItems(built.items);
    setResumed(built.resumed);
    setSavedAt(null);
    setError(null);
    return { chosen, editable: data.editable !== false, resumed: built.resumed };
  }, [taskId]);

  const reset = useCallback(() => {
    if (debouncer.current) debouncer.current.cancel();
    setTpl(null);
    setItems(null);
    setResumed(false);
    setSavedAt(null);
    setError(null);
  }, []);

  const setItem = useCallback((itemId, next) => {
    setItems((prev) => (prev ? { ...prev, [itemId]: next } : prev));
    if (enabled) debouncer.current();
  }, [enabled]);

  return { templates, tpl, items, resumed, saving, savedAt, error, load, reset, setItem, setItems, flush };
}
